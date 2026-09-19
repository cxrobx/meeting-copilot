import { Router, type Response } from 'express';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import type { WorkerRegistry } from '../workers/registry.js';
import type { ActionLifecycle, WorkerResult } from '../workers/types.js';
import { ReviewWorker, buildReviewParams } from '../workers/review.js';
import { isOpenAiApiAvailable, openaiFastResearchStream } from '../api/openai.js';
import { isAnthropicApiAvailable, anthropicTriageJson } from '../api/anthropic.js';
import { claudeSuggest } from '../claude-cli.js';
import { buildSignalRegexSources, QUESTION_STARTS } from './signals.js';
import { applyVaultLook, getVaultLook } from './vault-look.js';

// ─── Highlight-to-ask prompts ───────────────────────────────────────────────
const ASK_SYSTEM: Record<string, string> = {
  factcheck:
    'You fact-check a single claim highlighted from a live meeting transcript. ' +
    'Start with the verdict in bold (**Correct**, **Likely incorrect**, **Disputed**, or **Unverifiable**), ' +
    'then 2-4 sentences: what is right or wrong and the corrected fact. ' +
    'Use web search for anything current or specific. Be conservative — this is read mid-meeting.',
  explain:
    'You explain a term, concept, or excerpt highlighted from a live meeting transcript. ' +
    '2-5 sentences, plain language, for a smart reader who is mid-meeting. ' +
    'If the excerpt is ambiguous, explain the most likely meaning in this context.',
  custom:
    'Answer the user\'s question about an excerpt highlighted from a live meeting transcript. ' +
    'Be direct and concise — under 150 words unless the question genuinely demands more.',
  summarize:
    'You condense an AI-generated result card from a live meeting copilot into its essentials. ' +
    'Return 3-6 tight bullet points (or a 2-3 sentence recap if the content is short). ' +
    'Preserve concrete facts, numbers, names, decisions, and action items; drop filler. No preamble.',
};

function buildAskUserContent(params: { selection: string; context: string; question: string }): string {
  const parts = [`Highlighted text:\n"${params.selection}"`];
  if (params.context) parts.push(`Surrounding transcript:\n${params.context}`);
  if (params.question) parts.push(`Question: ${params.question}`);
  return parts.join('\n\n');
}

/**
 * Persist a freshly generated self-review into the session's own `action` table
 * so it is saved with the meeting and re-viewable without regenerating. Upserts
 * the existing review row when present (so a re-run overwrites rather than piling
 * up duplicates). Best-effort — never throws to the request handler.
 */
function persistReview(dbPath: string, sessionId: string, title: string, result: WorkerResult): void {
  try {
    const db = new Database(dbPath);
    const resultJson = JSON.stringify(result);
    const now = Date.now();
    const existing = db
      .prepare("SELECT id FROM action WHERE type = 'review' ORDER BY createdAt DESC LIMIT 1")
      .get() as { id?: string } | undefined;
    if (existing?.id) {
      db.prepare('UPDATE action SET result = ?, state = ?, completedAt = ? WHERE id = ?').run(
        resultJson,
        'completed',
        now,
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO action (id, sessionId, type, title, description, triggerQuote, state, params, result, createdAt, completedAt)
         VALUES (?, ?, 'review', ?, ?, '', 'completed', '{}', ?, ?, ?)`,
      ).run(`review-${sessionId}-${now}`, sessionId, `Self-Review: ${title}`, 'On-demand self-review', resultJson, now, now);
    }
    db.close();
  } catch (err) {
    console.warn('[Present] Failed to persist review:', err instanceof Error ? err.message : String(err));
  }
}

export function createPresentRouter(registry: WorkerRegistry): Router {
  const router = Router();
  const sseClients = new Set<Response>();

  // ─── SSE Bridge: registry events → browser ────────────────────────────
  const onActionStatus = (action: ActionLifecycle) => {
    let eventName: string;
    if (action.state === 'suggested') {
      eventName = 'action.suggested';
    } else if (action.state === 'running') {
      eventName = 'action.running';
    } else if (action.state === 'completed' || action.state === 'failed') {
      eventName = 'action.completed';
    } else {
      return;
    }

    const payload = JSON.stringify({
      id: action.id,
      type: action.type,
      title: action.title,
      description: action.description,
      state: action.state,
      result: action.result ?? null,
      completedAt: action.completedAt ? new Date(action.completedAt).toISOString() : null,
    });

    for (const res of sseClients) {
      res.write(`event: ${eventName}\ndata: ${payload}\n\n`);
    }
  };

  registry.on('action.status', onActionStatus);

  // ─── GET /present — HTML dashboard ──────────────────────────────────
  // The vault palette is spliced in before the page is sent, so the dashboard
  // arrives already in the vault's colours (see present/vault-look.ts). No-store
  // because the palette can change between loads and WKWebView caches happily.
  router.get('/present', async (_req, res) => {
    const look = await getVaultLook();
    res.set('Cache-Control', 'no-store');
    res.type('html').send(applyVaultLook(PRESENT_HTML, look));
  });

  // ─── GET /present/vault-look — the live palette ──────────────────────
  // The page re-takes this on reconnect and on becoming visible again, so
  // changing the Obsidian theme mid-meeting reaches an open dashboard.
  router.get('/present/vault-look', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await getVaultLook());
  });

  // ─── GET /mock — design exploration page (dev only, static data) ─────
  // Read from disk on every request so edits show on refresh. mock.html is
  // not compiled or bundled, so under dist/ we fall back to the src copy;
  // in the packaged app neither exists and this 404s, which is fine.
  router.get('/mock', (_req, res) => {
    const candidates = [
      fileURLToPath(new URL('./mock.html', import.meta.url)),
      join(process.cwd(), 'src', 'present', 'mock.html'),
    ];
    const file = candidates.find((p) => existsSync(p));
    if (!file) {
      res.status(404).send('mock.html not found — dev-only page, run from server/ via npm run dev');
      return;
    }
    res.type('html').send(readFileSync(file, 'utf8'));
  });

  // ─── GET /present/actions — JSON snapshot (live or stored session) ───
  router.get('/present/actions', (req, res) => {
    const sessionId = req.query.session as string | undefined;

    if (sessionId) {
      const sessionDir = join(homedir(), '.meeting-copilot', 'sessions', sessionId);
      const dbPath = join(sessionDir, 'session.db');
      if (!existsSync(dbPath)) {
        res.status(404).json({ error: 'Session not found', sessionId });
        return;
      }

      try {
        const db = new Database(dbPath, { readonly: true });
        const rows = db.prepare(
          `SELECT id, type, title, description, state, result, completedAt FROM action ORDER BY createdAt ASC`,
        ).all() as Array<{ id: string; type: string; title: string; description: string; state: string; result: string | null; completedAt: number | null }>;
        db.close();

        const actions = rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          description: r.description,
          state: r.state,
          result: r.result ? JSON.parse(r.result) : null,
          completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
        }));

        res.json({ actions, sessionId });
      } catch (err) {
        res.status(500).json({ error: 'Failed to read session', detail: String(err) });
      }
      return;
    }

    // Default: live actions from in-memory registry
    const completed = registry.getActionsByState('completed');
    const failed = registry.getActionsByState('failed');
    const running = registry.getActionsByState('running');
    const suggested = registry.getActionsByState('suggested');

    const actions = [...completed, ...failed, ...running, ...suggested].map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      description: a.description,
      state: a.state,
      result: a.result ?? null,
      completedAt: a.completedAt ? new Date(a.completedAt).toISOString() : null,
    }));

    res.json({ actions });
  });

  // ─── GET /present/transcript — transcript segments for stored session ─
  router.get('/present/transcript', (req, res) => {
    const sessionId = req.query.session as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'session query param required' });
      return;
    }

    const dbPath = join(homedir(), '.meeting-copilot', 'sessions', sessionId, 'session.db');
    if (!existsSync(dbPath)) {
      res.status(404).json({ error: 'Session not found', sessionId });
      return;
    }

    try {
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(
        `SELECT id, text, source, label, timestamp, duration, wordCount FROM transcript ORDER BY timestamp ASC`,
      ).all() as Array<{ id: string; text: string; source: string; label: string; timestamp: number; duration: number; wordCount: number }>;

      // Get session start time for relative timestamps
      const session = db.prepare('SELECT startedAt FROM session LIMIT 1').get() as { startedAt?: number } | undefined;
      db.close();

      res.json({ segments: rows, sessionId, startedAt: session?.startedAt ?? null });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read transcript', detail: String(err) });
    }
  });

  // ─── GET /present/sessions — list available sessions ────────────────
  // ?all=1 includes empty/orphan sessions (for cleanup)
  router.get('/present/sessions', (req, res) => {
    const sessionsDir = join(homedir(), '.meeting-copilot', 'sessions');
    const includeAll = req.query.all === '1';
    try {
      const allDirs = existsSync(sessionsDir)
        ? readdirSync(sessionsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
        : [];

      const sessions = allDirs.map((id: string) => {
        const hasDb = existsSync(join(sessionsDir, id, 'session.db'));
        if (!hasDb) {
          return { id, title: '(Empty session)', startedAt: null, endedAt: null, actionCount: 0, segmentCount: 0, empty: true };
        }
        try {
          const db = new Database(join(sessionsDir, id, 'session.db'), { readonly: true });
          const row = db.prepare('SELECT title, startedAt, endedAt FROM session LIMIT 1').get() as { title?: string; startedAt?: number; endedAt?: number } | undefined;
          const actionCount = (db.prepare('SELECT count(*) as c FROM action').get() as { c: number })?.c ?? 0;
          const segmentCount = (db.prepare('SELECT count(*) as c FROM transcript').get() as { c: number })?.c ?? 0;
          db.close();
          return {
            id,
            title: row?.title || 'Untitled',
            startedAt: row?.startedAt ? new Date(row.startedAt).toISOString() : null,
            endedAt: row?.endedAt ? new Date(row.endedAt).toISOString() : null,
            actionCount,
            segmentCount,
            empty: false,
          };
        } catch {
          return { id, title: 'Untitled', startedAt: null, endedAt: null, actionCount: 0, segmentCount: 0, empty: false };
        }
      }).filter((s: any) => includeAll || s.actionCount > 0 || s.segmentCount > 0)
        .sort((a: any, b: any) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── POST /present/review — self-review for a PAST (ended) meeting ────────
  // Returns the review SAVED with the meeting (in its `action` table) when one
  // exists, so reopening a past review is instant and stable. With {refresh:true}
  // it regenerates: runs the ReviewWorker on the stored transcript and persists
  // the new scorecard back to the session's own DB. A fresh run is never subject
  // to the session.stop grace window that can cancel the auto-review.
  router.post('/present/review', async (req, res) => {
    const sessionId = String((req.body?.sessionId ?? '')).trim();
    const refresh = req.body?.refresh === true;
    // sessionIds are directory names — guard against path traversal.
    if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      res.status(400).json({ error: 'valid sessionId required' });
      return;
    }
    const dbPath = join(homedir(), '.meeting-copilot', 'sessions', sessionId, 'session.db');
    if (!existsSync(dbPath)) {
      res.status(404).json({ error: 'session not found' });
      return;
    }

    // One read-only open: title, any previously saved review, and (only if we
    // actually need to regenerate) the transcript.
    let records: Array<{ source: string; label: string; text: string; wordCount: number }> = [];
    let title = 'Untitled';
    let saved: { markdown: string; data: unknown } | null = null;
    try {
      const db = new Database(dbPath, { readonly: true });
      const srow = db.prepare('SELECT title FROM session LIMIT 1').get() as { title?: string } | undefined;
      title = srow?.title || 'Untitled';
      if (!refresh) {
        const rrow = db
          .prepare(
            "SELECT result FROM action WHERE type = 'review' AND result IS NOT NULL " +
              'ORDER BY completedAt DESC, createdAt DESC LIMIT 1',
          )
          .get() as { result?: string } | undefined;
        if (rrow?.result) {
          try {
            const parsed = JSON.parse(rrow.result);
            const md = parsed?.artifacts?.[0]?.content || parsed?.summary || '';
            if (md) saved = { markdown: md, data: parsed?.data ?? null };
          } catch {
            /* fall through to regenerate */
          }
        }
      }
      if (!saved) {
        records = db
          .prepare('SELECT source, label, text, wordCount FROM transcript ORDER BY timestamp ASC, rowid ASC')
          .all() as Array<{ source: string; label: string; text: string; wordCount: number }>;
      }
      db.close();
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }

    if (saved) {
      res.json({ ok: true, title, markdown: saved.markdown, data: saved.data, cached: true });
      return;
    }

    if (records.length === 0) {
      res.status(400).json({ error: 'No transcript stored for this meeting — nothing to review.' });
      return;
    }

    const params = buildReviewParams({ transcriptRecords: records, title, sessionId });
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const result = await new ReviewWorker().execute(params, controller.signal);
      if (!result.success) {
        res.status(422).json({ error: result.error || result.summary });
        return;
      }
      // Save it with the meeting so future opens are instant and don't re-spend.
      persistReview(dbPath, sessionId, title, result);
      const markdown = result.artifacts?.[0]?.content || result.summary || '';
      res.json({ ok: true, title, markdown, data: result.data ?? null, cached: false });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── POST /present/ask — highlight-to-ask (fact check / explain / custom) ─
  // Streams SSE-style lines over the POST response, same protocol the
  // ask-widget uses: `event: token|error|done` + `data: {...}`.
  router.post('/present/ask', async (req, res) => {
    const body = (req.body ?? {}) as { mode?: string; selection?: string; context?: string; question?: string };
    const mode = body.mode && ASK_SYSTEM[body.mode] ? body.mode : null;
    const selection = (body.selection ?? '').toString().slice(0, 1_500).trim();
    // Roomy context budget: whole-card Summarize/Custom passes the full card text
    // (capped ~6000 client-side) here, so 4000 would silently drop long cards.
    const context = (body.context ?? '').toString().slice(0, 8_000).trim();
    const question = (body.question ?? '').toString().slice(0, 1_000).trim();

    if (!mode || !selection) {
      res.status(400).json({ error: 'mode (factcheck|explain|custom) and selection are required' });
      return;
    }
    if (mode === 'custom' && !question) {
      res.status(400).json({ error: 'question is required for custom mode' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Abort the upstream LLM call when the browser disconnects mid-stream.
    // NB: must watch the RESPONSE, not the request — on a POST whose body
    // express.json() already consumed, `req` emits 'close' immediately after
    // the message is read, which would abort the call before it starts.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const systemPrompt = ASK_SYSTEM[mode]!;
    const userContent = buildAskUserContent({ selection, context, question });

    try {
      if (isOpenAiApiAvailable()) {
        const result = await openaiFastResearchStream({
          systemPrompt,
          userContent,
          signal: controller.signal,
          onDelta: (text) => send('token', { text }),
          label: `present-ask-${mode}`,
        });
        if (result.sources.length > 0) {
          const links = result.sources.slice(0, 4)
            .map((s) => `[${s.title || s.url}](${s.url})`)
            .join(' · ');
          send('token', { text: `\n\n**Sources:** ${links}` });
        }
      } else if (isAnthropicApiAvailable()) {
        const text = await anthropicTriageJson(userContent, systemPrompt, {
          signal: controller.signal,
          maxTokens: 800,
          timeoutMs: 30_000,
          label: `present-ask-${mode}`,
        });
        send('token', { text: `${text}\n\n_(model knowledge only — no web search without OPENAI_API_KEY)_` });
      } else {
        // No paid API (no keys, or COPILOT_DISABLE_PAID_API cost-safe mode) —
        // fall back to the CLI subscription with web search so highlight-to-ask
        // still works for free, just slower (CLI spawn).
        await claudeSuggest(
          userContent,
          systemPrompt,
          controller.signal,
          ['WebSearch', 'WebFetch'],
          { onDelta: (text) => send('token', { text }) },
        );
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        send('error', { message: err instanceof Error ? err.message : String(err) });
      }
    }
    send('done', {});
    res.end();
  });

  // ─── GET /present/events — SSE stream (fallback for replay) ─────────
  router.get('/present/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    res.write(':\n\n');
    sseClients.add(res);

    const heartbeat = setInterval(() => {
      res.write(':\n\n');
    }, 30_000);

    req.on('close', () => {
      sseClients.delete(res);
      clearInterval(heartbeat);
    });
  });

  return router;
}

// ─── Inline HTML Template ─────────────────────────────────────────────────

const PRESENT_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Meeting Copilot</title>
<script src="/vendor/js/marked.min.js"><\/script>
<script src="/vendor/js/purify.min.js"><\/script>
<script src="/vendor/js/highlight.min.js"><\/script>
<link rel="stylesheet" href="/vendor/css/fonts.css">
<link rel="stylesheet" id="hljsLight" href="/vendor/css/gruvbox-light.min.css">
<link rel="stylesheet" id="hljsDark" href="/vendor/css/gruvbox-dark.min.css">
<script>
  // Applied before first paint so a light-theme user never sees a dark flash.
  // Inline and dependency-free for that reason, and placed after the two hljs
  // stylesheets so it can disable the one that doesn't match.
  //
  // When the server has dressed the page in the vault's palette it has already
  // written the vault's mode onto <html>; the stored preference does not get to
  // override it, or a cream dashboard would load with the dark hljs sheet.
  (function () {
    var root = document.documentElement;
    var vault = root.classList.contains('vault-look');
    var t = vault ? root.getAttribute('data-theme') : 'dark';
    if (!vault) {
      try {
        var stored = localStorage.getItem('mc-theme');
        if (stored === 'light' || stored === 'dark') t = stored;
      } catch (e) { /* private mode — keep the dark default */ }
    }
    document.documentElement.setAttribute('data-theme', t);
    var light = document.getElementById('hljsLight');
    var dark = document.getElementById('hljsDark');
    if (light) light.disabled = (t !== 'light');
    if (dark) dark.disabled = (t === 'light');
  })();
<\/script>
<style>
  /* ─── CX family design tokens ────────────────────────────────
     Shared with cxmail, cxtasks and cxnotes: warm charcoal / warm
     off-white surfaces, Apple-blue accent, sage-amber-terracotta
     semantics, SF system sans with mono reserved for data, small
     radii, thin scrollbars. Token NAMES and VALUES are copied from
     those apps verbatim so the four read as one family.

     Values are space-separated RGB triplets (the family convention)
     so any rule can take an alpha: rgb(var(--accent) / 0.12).

     Dark is the default, matching cxnotes; the header toggle flips
     data-theme on <html> and is remembered in localStorage.         */
  :root {
    --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 10px;
    --radius-xl: 12px;
    --radius-full: 999px;
    --transition: 150ms ease;
  }

  [data-theme="dark"] {
    color-scheme: dark;
    --bg-primary:  28 26 23;
    --bg-sidebar:  35 32 28;
    --bg-surface:  42 39 34;
    --bg-elevated: 53 49 43;
    --bg-input:    35 32 28;

    --border-default: 74 68 57;
    --border-subtle:  53 49 43;

    --text-primary:   255 255 255;
    --text-secondary: 210 208 205;
    --text-muted:     155 153 150;
    --text-faint:     115 113 110;

    --accent:       10 132 255;
    --accent-hover:  8 106 204;
    /* Text drawn ON an accent fill. White on both family themes; the vault look
       recomputes it, because a vault's accent is only held to 3:1 on its ground
       and need not carry white text. */
    --accent-ink:  255 255 255;

    --success: 143 179 136;
    --error:   212 118 106;
    --warning: 212 168 90;

    --ai-accent: 160 140 120;
    --shadow-color: 0 0 0;
  }

  [data-theme="light"] {
    color-scheme: light;
    --bg-primary:  248 247 245;
    --bg-sidebar:  243 242 240;
    --bg-surface:  255 255 254;
    --bg-elevated: 251 250 248;
    --bg-input:    255 255 254;

    --border-default: 225 222 218;
    --border-subtle:  238 236 232;

    --text-primary:    30 25 15;
    --text-secondary:  75 70 60;
    --text-muted:     130 125 115;
    --text-faint:     170 165 155;

    --accent:       10 132 255;
    --accent-hover:  8 106 204;
    --accent-ink:  255 255 255;

    --success: 125 155 118;
    --error:   196 92 74;
    --warning: 196 146 58;

    --ai-accent: 139 115 85;
    --shadow-color: 44 31 14;
  }

  /* ─── Legacy --gb-* aliases ──────────────────────────────────
     The 1,000+ rules below were written against these names. Rather
     than rename every one (and risk missing some), each alias now
     resolves to a family token, so the whole dashboard follows the
     active theme for free. Do not add new --gb-* names — use the
     family tokens directly in new rules.                            */
  :root {
    --gb-base:     rgb(var(--bg-primary));
    --gb-mantle:   rgb(var(--bg-sidebar));
    --gb-crust:    rgb(var(--bg-sidebar));
    --gb-surface0: rgb(var(--bg-surface));
    --gb-surface1: rgb(var(--bg-elevated));
    --gb-surface2: rgb(var(--border-default));
    --gb-overlay0: rgb(var(--border-default));
    --gb-overlay1: rgb(var(--text-faint));
    --gb-overlay2: rgb(var(--text-muted));
    --gb-text:     rgb(var(--text-primary));
    --gb-subtext0: rgb(var(--text-secondary));
    --gb-subtext1: rgb(var(--text-muted));

    --gb-red:      rgb(var(--error));
    --gb-maroon:   rgb(var(--error));
    --gb-yellow:   rgb(var(--warning));
    --gb-peach:    rgb(var(--warning));
    --gb-green:    rgb(var(--success));
    --gb-blue:     rgb(var(--accent));
    --gb-teal:     rgb(var(--accent));
    --gb-sky:      rgb(var(--accent));
    --gb-sapphire: rgb(var(--accent));
    --gb-lavender: rgb(var(--ai-accent));
    --gb-mauve:    rgb(var(--ai-accent));
    --gb-pink:     rgb(var(--ai-accent));
    --gb-rosewater:rgb(var(--ai-accent));
    --gb-flamingo: rgb(var(--ai-accent));

    --accent-soft:  rgb(var(--accent) / 0.12);
    --focus-ring:   rgb(var(--accent) / 0.6);
    --shadow-macos: 0 2px 8px rgb(var(--shadow-color) / 0.3), 0 1px 3px rgb(var(--shadow-color) / 0.2);
    --shadow-macos-lg: 0 8px 32px rgb(var(--shadow-color) / 0.4), 0 2px 8px rgb(var(--shadow-color) / 0.3);
  }


  * { margin:0; padding:0; box-sizing:border-box; }

  /* Mono is reserved for content where character alignment carries meaning —
     figures you compare down a column, clock time, and verbatim transcript.
     Everything else is system sans, matching cxmail/cxtasks/cxnotes. */
  .stat-value,
  .session-timer,
  .seg-time,
  .seg-text,
  .card-trigger,
  .stage-timer,
  .stage-live,
  .stage-hist,
  .agenda-evidence,
  code, pre, kbd,
  .tabular { font-family: var(--font-mono); }

  .stat-value,
  .session-timer,
  .seg-time,
  .stage-timer { font-variant-numeric: tabular-nums; }

  input, textarea, select, button { font-family: inherit; font-size: inherit; color: inherit; }
  input:focus-visible, textarea:focus-visible,
  select:focus-visible, button:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 1px;
  }

  body {
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    background: var(--gb-base);
    color: var(--gb-text);
    line-height: 1.6;
    min-height: 100vh;
    font-size: 13px;
    overflow-x: hidden;
    max-width: 100vw;
  }

  /* ─── Header ───────────────────────────────────────────────── */
  .header {
    padding: 10px 20px;
    border-bottom: 1px solid var(--gb-surface2);
    display: flex;
    align-items: center;
    gap: 12px;
    position: sticky;
    top: 0;
    background: var(--gb-base);
    z-index: 100;
    height: 50px;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .header-left h1 {
    font-size: 15px;
    font-weight: 700;
    color: var(--gb-text);
  }

  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--gb-overlay0);
    flex-shrink: 0;
  }
  .status-dot.connected { background: rgb(var(--accent)); animation: pulse 2s ease-in-out infinite; }
  .status-dot.disconnected { background: var(--gb-red); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  .header-center {
    flex: 1;
    text-align: center;
    font-size: 14px;
    font-weight: 600;
    color: var(--gb-subtext1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .state-pill {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 10px;
    border-radius: 10px;
    color: white;
  }
  .state-pill.idle { background: var(--gb-overlay2); }
  .state-pill.live { background: var(--gb-blue); color: rgb(var(--accent-ink)); }
  .state-pill.priming, .state-pill.ending {
    background: var(--accent-soft);
    color: rgb(var(--accent));
    border: 1px solid rgb(var(--accent));
  }
  .state-pill.degraded { background: var(--gb-yellow); }
  .state-pill.error { background: var(--gb-red); }
  .state-pill.archived { background: var(--gb-subtext0); }

  /* Progress hint shown next to the state pill while the meeting is wrapping up
     (post-meeting summary + self-review running). */
  .ending-hint {
    font-size: 11px;
    color: var(--gb-subtext0);
    font-style: italic;
    margin-right: 4px;
    white-space: nowrap;
  }

  /* Audio activity indicator: a small red dot that pulses when audio chunks
     arrive, so the user can see the mic/system audio is actually flowing. */
  .audio-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--gb-red);
    margin-right: 10px;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .audio-indicator.visible { opacity: 1; }
  .audio-indicator .audio-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--gb-red);
    animation: rec-pulse 1.4s ease-in-out infinite;
  }
  .audio-indicator .audio-dot.flash {
    animation: rec-flash 0.25s ease-out;
  }
  @keyframes rec-pulse {
    0%, 100% { opacity: 0.4; transform: scale(0.9); }
    50% { opacity: 1; transform: scale(1.1); }
  }
  @keyframes rec-flash {
    0% { transform: scale(1.6); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }

  /* Waveform beside REC. Decorative — it rides the same .visible flag as the
     dot (audio is flowing) rather than real amplitude, so it must never be
     the only evidence that capture is working; app.log peak= is the truth. */
  .audio-wave {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 11px;
    margin-left: 1px;
  }
  .audio-wave i {
    width: 2px;
    border-radius: 1px;
    background: var(--gb-red);
    opacity: 0.75;
    animation: audio-wv 1.1s ease-in-out infinite;
  }
  .audio-wave i:nth-child(1) { height: 40%; animation-delay: 0s; }
  .audio-wave i:nth-child(2) { height: 85%; animation-delay: 0.15s; }
  .audio-wave i:nth-child(3) { height: 55%; animation-delay: 0.3s; }
  .audio-wave i:nth-child(4) { height: 100%; animation-delay: 0.45s; }
  .audio-wave i:nth-child(5) { height: 65%; animation-delay: 0.6s; }
  @keyframes audio-wv { 0%,100% { transform: scaleY(0.45); } 50% { transform: scaleY(1); } }
  @media (prefers-reduced-motion: reduce) {
    .audio-wave i { animation: none; }
  }

  .session-timer {
    font-size: 16px;
    font-weight: 600;
    color: var(--gb-subtext0);
    font-variant-numeric: tabular-nums;
    min-width: 60px;
    text-align: right;
  }

  /* ─── Buttons ──────────────────────────────────────────────── */
  .btn {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background-color 120ms, filter 120ms, border-color 120ms;
  }
  .btn:hover { filter: brightness(1.08); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

  /* Primary affirmative action. Blue (accent), not sage: the family spends
     accent on the thing it wants clicked and keeps --success for STATE. */
  .btn-green { background: rgb(var(--accent)); color: rgb(var(--accent-ink)); }
  .btn-red { background: var(--gb-red); color: white; }
  .btn-blue { background: var(--gb-blue); color: rgb(var(--accent-ink)); }
  .btn-ghost { background: transparent; border: 1px solid var(--gb-surface2); color: var(--gb-subtext0); }
  .btn-ghost:hover { background: var(--gb-surface1); }
  .btn-ghost-red { background: transparent; border: 1px solid var(--gb-surface2); color: var(--gb-red); }

  /* ─── Stats Bar ────────────────────────────────────────────── */
  .stats-bar {
    display: none;
    padding: 8px 24px;
    gap: 12px;
    border-bottom: 1px solid var(--gb-surface2);
    background: var(--gb-base);
  }
  .stats-bar.visible { display: flex; }

  .stat-tile {
    flex: 1;
    background: var(--gb-base);
    border: 1px solid var(--gb-surface2);
    border-radius: 8px;
    padding: 7px 13px;
    text-align: left;
    min-width: 0;
  }
  .stat-label {
    font-size: 8.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--gb-overlay2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stat-value {
    font-size: 17px;
    font-weight: 700;
    color: var(--gb-text);
    line-height: 1.3;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
  /* Secondary figure inside a tile ("6 · 4 approved") — carries context
     without spending a whole tile on it. */
  .stat-value small {
    font-size: 10px;
    font-weight: 600;
    color: var(--gb-overlay1);
    letter-spacing: 0;
  }

  /* ─── Layout ───────────────────────────────────────────────── */
  .layout {
    display: grid;
    grid-template-columns: 1fr;
    height: calc(100vh - 50px);
    overflow: hidden;
  }
  .layout .transcript-col,
  .layout .toc {
    display: none;
  }
  .layout.three-col {
    grid-template-columns: 260px minmax(0, 1fr) 280px;
  }
  .layout.three-col .transcript-col,
  .layout.three-col .toc {
    display: flex;
  }

  /* Narrow: drop the TOC (right col) first — the live transcript is the most
     important view during a session and must stay visible. */
  @media (max-width: 1400px) {
    .layout.three-col { grid-template-columns: 260px minmax(0, 1fr); }
    .layout.three-col .toc { display: none; }
  }
  /* Very narrow: stack — keep transcript at the top so it's always reachable. */
  @media (max-width: 900px) {
    .layout.three-col {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(220px, 35vh) 1fr;
    }
    .layout.three-col .transcript-col {
      border-right: none;
      border-bottom: 1px solid var(--gb-overlay0);
    }
  }

  /* ─── Transcript Column ────────────────────────────────────── */
  .transcript-col {
    background: var(--gb-mantle);
    border-right: 1px solid var(--gb-surface2);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }

  .transcript-header {
    padding: 12px 14px 8px;
    border-bottom: 1px solid var(--gb-surface2);
    flex-shrink: 0;
  }

  .transcript-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .transcript-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--gb-overlay2);
  }

  .segment-count {
    font-size: 10px;
    font-weight: 600;
    color: var(--gb-overlay1);
    background: var(--gb-surface1);
    padding: 1px 7px;
    border-radius: 8px;
  }

  .filter-row {
    display: flex;
    gap: 4px;
    margin-bottom: 6px;
  }

  .filter-btn {
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid var(--gb-surface2);
    background: transparent;
    color: var(--gb-subtext0);
    cursor: pointer;
    transition: all 0.15s;
  }
  .filter-btn.active {
    background: var(--gb-surface2);
    color: var(--gb-text);
  }
  .filter-btn:hover:not(.active) {
    background: var(--gb-surface1);
  }

  .transcript-search {
    width: 100%;
    font-family: var(--font-sans);
    font-size: 11px;
    padding: 5px 10px;
    border: 1px solid var(--gb-surface2);
    border-radius: 4px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
  }
  .transcript-search:focus { border-color: var(--gb-blue); }
  .transcript-search::placeholder { color: var(--gb-overlay1); }

  .transcript-feed {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
    scrollbar-width: thin;
    scrollbar-color: var(--gb-overlay0) transparent;
  }
  .transcript-feed::-webkit-scrollbar { width: 4px; }
  .transcript-feed::-webkit-scrollbar-thumb { background: var(--gb-overlay0); border-radius: 2px; }

  .show-older-btn {
    display: block;
    width: 100%;
    margin: 6px 0;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 10px;
    font-weight: 600;
    color: var(--gb-subtext0);
    background: var(--gb-surface0);
    border: 1px dashed var(--gb-overlay0);
    border-radius: 6px;
    cursor: pointer;
  }
  .show-older-btn:hover { background: var(--gb-surface1); }

  /* "N new" pill — appears when the user scrolls away from the live edge */
  .new-seg-pill {
    align-self: center;
    margin: 4px auto 0;
    padding: 3px 12px;
    font-family: inherit;
    font-size: 10px;
    font-weight: 600;
    color: var(--gb-base);
    background: var(--gb-text);
    border: none;
    border-radius: 999px;
    cursor: pointer;
    box-shadow: 0 4px 12px -6px rgb(var(--shadow-color) / 0.5);
  }
  .new-seg-pill:hover { opacity: 0.85; }

  .seg {
    padding: 5px 8px;
    border-left: 3px solid transparent;
    margin-bottom: 4px;
    border-radius: 0 4px 4px 0;
    transition: background 0.1s;
  }
  .seg:hover { background: var(--gb-surface0); }
  .seg.mic { border-left-color: rgb(var(--accent)); }
  .seg.meeting { border-left-color: var(--gb-peach); }

  /* The newest segment is the live edge: full-strength ink plus a caret, so
     you can tell at a glance that transcription is still flowing. Set by
     markLatestSegment() on every insert. */
  .seg.latest .seg-text { color: var(--gb-text); }
  .seg.latest .seg-text::after {
    content: "▍";
    color: rgb(var(--accent));
    margin-left: 1px;
    animation: seg-caret 1.05s steps(1) infinite;
  }
  @keyframes seg-caret { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .seg.latest .seg-text::after { animation: none; }
  }

  .seg-top {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
  }
  .seg-source {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .seg-source.mic { background: rgb(var(--text-primary) / 0.09); color: var(--gb-subtext0); }
  .seg-source.meeting { background: rgb(var(--warning) / 0.18); color: rgb(var(--warning)); }

  .seg-time {
    font-size: 10px;
    color: var(--gb-overlay2);
    margin-left: auto;
  }

  .seg-text {
    font-size: 12px;
    color: var(--gb-subtext1);
    line-height: 1.5;
  }

  .signal-tag {
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 1px 4px;
    border-radius: 2px;
    letter-spacing: 0.04em;
  }
  .signal-tag.action { background: rgb(var(--text-primary) / 0.08); color: var(--gb-green); }
  .signal-tag.decision { background: rgb(var(--accent) / 0.12); color: var(--gb-blue); }
  .signal-tag.question { background: rgb(var(--ai-accent) / 0.12); color: var(--gb-lavender); }
  .signal-tag.risk { background: rgb(var(--error) / 0.12); color: var(--gb-red); }

  /* ─── Main Column ──────────────────────────────────────────── */
  .main {
    padding: 24px 32px;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--gb-overlay2);
    font-size: 14px;
  }

  /* ─── Idle State ───────────────────────────────────────────── */
  .idle-overlay {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
  }

  .idle-card {
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-radius: 10px;
    padding: 40px;
    text-align: center;
    max-width: 440px;
    width: 100%;
  }

  .idle-card h2 {
    font-size: 18px;
    font-weight: 700;
    color: var(--gb-text);
    margin-bottom: 6px;
  }
  .idle-card p {
    color: var(--gb-subtext0);
    font-size: 12px;
    margin-bottom: 20px;
  }

  .idle-form { text-align: left; margin-bottom: 16px; }
  .idle-form label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-overlay2);
    display: block;
    margin-bottom: 4px;
    margin-top: 10px;
  }
  .idle-form input, .idle-form textarea {
    font-family: var(--font-sans);
    font-size: 12px;
    width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--gb-surface2);
    border-radius: 6px;
    background: var(--gb-surface0);
    color: var(--gb-text);
    outline: none;
    resize: vertical;
    transition: border-color 120ms, box-shadow 120ms;
  }
  .idle-form input:focus, .idle-form textarea:focus {
    border-color: rgb(var(--accent));
    box-shadow: 0 0 0 3px var(--focus-ring);
  }

  /* ─── Agenda extraction editor ─────────────────────────────── */
  .agenda-helper {
    font-size: 10px;
    color: var(--gb-subtext0);
    margin-top: 4px;
    line-height: 1.4;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }
  .agenda-edit-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .agenda-edit-actions .btn {
    font-size: 11px;
    padding: 4px 10px;
  }
  .agenda-edit-status {
    font-size: 10px;
    color: var(--gb-subtext0);
    line-height: 1.4;
  }
  .agenda-edit-status.error { color: var(--gb-red); }
  .agenda-edit-status.empty { color: var(--gb-peach); }
  .agenda-edit-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 1.5px solid var(--gb-overlay1);
    border-top-color: var(--gb-blue);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: middle;
    margin-right: 5px;
  }
  /* Self-review modal: processing spinner + time-estimated progress bar. */
  .review-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    border: 2px solid var(--gb-overlay1);
    border-top-color: var(--gb-blue);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    margin-right: 9px;
  }
  .review-progress {
    margin-top: 14px;
    height: 6px;
    width: 100%;
    background: var(--gb-surface1);
    overflow: hidden;
  }
  .review-progress-bar {
    height: 100%;
    width: 0%;
    background: var(--gb-blue);
    transition: width 0.25s linear;
  }
  /* Self-review rendered markdown — readable hierarchy + breathing room. */
  .review-md { color: var(--gb-text); font-size: 13px; line-height: 1.62; }
  .review-md > :first-child { margin-top: 0; }
  .review-md h2 { display: none; } /* title duplicates the modal header */
  .review-md h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    font-weight: 700;
    color: rgb(var(--accent));
    margin: 26px 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--gb-surface2);
  }
  .review-md p { margin: 11px 0; }
  .review-md ul { margin: 8px 0; padding-left: 4px; list-style: none; }
  .review-md ul > li {
    position: relative;
    margin: 11px 0;
    padding-left: 18px;
  }
  .review-md ul > li::before {
    content: "";
    position: absolute;
    left: 2px;
    top: 0.62em;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: rgb(var(--accent));
  }
  .review-md ol { margin: 8px 0; padding-left: 22px; }
  .review-md ol > li { margin: 8px 0; padding-left: 4px; }
  .review-md li::marker { color: rgb(var(--accent)); font-weight: 700; }
  .review-md strong { color: var(--gb-text); font-weight: 700; }
  .review-md em { color: var(--gb-subtext1); font-style: italic; }
  .review-md blockquote {
    margin: 0 0 20px;
    padding: 9px 14px;
    background: var(--gb-surface0);
    border-left: 3px solid rgb(var(--accent));
    color: var(--gb-subtext1);
    font-size: 12px;
  }
  .review-md blockquote p { margin: 0; }
  .agenda-editor-list {
    border: 1px solid var(--gb-surface2);
    border-radius: 5px;
    background: var(--gb-surface1);
    padding: 4px;
    max-height: 260px;
    overflow-y: auto;
  }
  .agenda-editor-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 2px;
  }
  .agenda-editor-row + .agenda-editor-row { margin-top: 2px; }
  .agenda-editor-input {
    flex: 1 1 auto;
    font-family: var(--font-sans);
    font-size: 11px;
    padding: 5px 8px;
    border: 1px solid var(--gb-surface2);
    border-radius: 4px;
    background: var(--gb-base);
    color: var(--gb-text);
    outline: none;
  }
  .agenda-editor-input:focus { border-color: var(--gb-blue); }
  .agenda-editor-remove {
    flex: 0 0 auto;
    width: 22px; height: 22px;
    border: none; background: transparent;
    color: var(--gb-overlay2);
    cursor: pointer;
    font-size: 14px;
    border-radius: 3px;
  }
  .agenda-editor-remove:hover { color: var(--gb-red); background: var(--gb-surface0); }
  .agenda-editor-count {
    font-size: 10px;
    font-weight: 600;
    color: var(--gb-overlay2);
  }

  .proj-grid {
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid var(--gb-surface2);
    border-radius: 5px;
    padding: 8px 10px;
    background: var(--gb-surface1);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px 16px;
  }
  .proj-item {
    display: flex !important;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 12px !important;
    font-weight: 400 !important;
    text-transform: none !important;
    letter-spacing: 0 !important;
    cursor: pointer;
    color: var(--gb-text) !important;
    overflow: hidden;
  }
  .proj-item input[type="checkbox"] {
    accent-color: var(--gb-green);
    flex-shrink: 0;
    width: 14px;
    height: 14px;
  }
  .proj-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--gb-text);
  }
  .proj-badge {
    font-size: 8px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    flex-shrink: 0;
    margin-left: auto;
  }
  .proj-badge.ios {
    background: rgb(var(--accent) / 0.12);
    color: var(--gb-blue);
  }

  /* Context manager */
  .ctx-section { margin-top: 10px; }
  .ctx-list {
    max-height: 140px;
    overflow-y: auto;
    border: 1px solid var(--gb-surface2);
    border-radius: 5px;
    padding: 4px 8px;
    background: var(--gb-surface1);
  }
  .ctx-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    font-size: 12px;
    border-bottom: 1px solid var(--gb-surface2);
  }
  .ctx-item:last-child { border-bottom: none; }
  .ctx-item input[type="checkbox"] {
    accent-color: var(--gb-green);
    flex-shrink: 0;
    width: 14px;
    height: 14px;
  }
  .ctx-icon {
    font-size: 11px;
    color: var(--gb-overlay2);
    flex-shrink: 0;
    width: 14px;
    text-align: center;
  }
  .ctx-name {
    color: var(--gb-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .ctx-path {
    color: var(--gb-overlay1);
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 140px;
    flex-shrink: 1;
  }
  .ctx-remove {
    background: none;
    border: none;
    color: var(--gb-overlay1);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
    flex-shrink: 0;
    border-radius: 3px;
  }
  .ctx-remove:hover { color: var(--gb-red); background: rgb(var(--error) / 0.08); }
  .ctx-add-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .ctx-add-btn {
    font-family: var(--font-sans);
    font-size: 11px;
    padding: 4px 10px;
    border: 1px dashed var(--gb-surface2);
    border-radius: 5px;
    background: transparent;
    color: var(--gb-overlay2);
    cursor: pointer;
    flex: 1;
  }
  .ctx-add-btn:hover { border-color: var(--gb-blue); color: var(--gb-blue); }
  .ctx-input-row {
    display: flex;
    gap: 4px;
    margin-top: 6px;
  }
  .ctx-input-row input {
    flex: 1;
    font-family: var(--font-sans);
    font-size: 11px;
    padding: 5px 8px;
    border: 1px solid var(--gb-blue);
    border-radius: 5px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
  }
  .ctx-input-row button {
    font-family: var(--font-sans);
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 5px;
    border: none;
    cursor: pointer;
  }
  .ctx-input-row .ctx-submit { background: var(--gb-green); color: var(--gb-bg); }
  .ctx-input-row .ctx-cancel { background: var(--gb-surface2); color: var(--gb-text); }
  .ctx-empty {
    color: var(--gb-overlay1);
    font-size: 11px;
    font-style: italic;
    padding: 8px 0;
    text-align: center;
  }
  .ctx-error {
    color: var(--gb-red);
    font-size: 11px;
    margin-top: 4px;
  }
  .ctx-input-row input.drag-over {
    border-color: var(--gb-green);
    background: rgb(var(--text-primary) / 0.04);
  }

  .consent-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: 14px;
    font-size: 11px;
    color: var(--gb-subtext0);
    text-align: left;
    cursor: pointer;
    line-height: 1.4;
  }
  .consent-row input { margin-top: 1px; accent-color: var(--gb-green); }

  /* Upcoming-meeting auto-fill chips (fed by cxmail invites) */
  .cal-chips {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 10px 0 4px;
    text-align: left;
  }
  .cal-chips-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-subtext0);
  }
  .cal-chip {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--gb-surface1);
    background: var(--gb-surface0);
    font-family: inherit;
    font-size: 12px;
    color: var(--gb-text);
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
  }
  .cal-chip:hover { border-color: var(--gb-green); }
  .cal-chip.soon { border-color: var(--gb-green); box-shadow: 0 0 0 1px var(--gb-green); }
  .cal-chip.applied { opacity: 0.55; cursor: default; }
  .cal-chip-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .cal-chip-time { color: var(--gb-subtext0); font-size: 11px; white-space: nowrap; }
  .cal-chip-fill { color: var(--gb-green); font-size: 11px; font-weight: 600; white-space: nowrap; }

  .idle-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    margin-top: 16px;
  }

  /* ─── Settings modal ───────────────────────────────────────── */
  .settings-field { margin-bottom: 14px; }
  .settings-field label {
    display: block;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-subtext0);
    margin-bottom: 4px;
  }
  .settings-field input[type="number"] {
    width: 110px;
    font-family: var(--font-sans);
    font-size: 12px;
    padding: 6px 8px;
    border: 1px solid var(--gb-surface2);
    border-radius: 5px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
  }
  .settings-field .settings-hint { font-size: 10px; color: var(--gb-overlay1); margin-top: 3px; }
  .settings-check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--gb-text); cursor: pointer; }
  .settings-check input { accent-color: var(--gb-green); }

  .sessions-link {
    color: var(--gb-blue);
    font-size: 12px;
    cursor: pointer;
    margin-top: 14px;
    display: inline-block;
  }
  .sessions-link:hover { text-decoration: underline; }

  /* ─── Session History ──────────────────────────────────────── */
  .session-list {
    max-width: 560px;
    margin: 0 auto;
    padding: 24px 0;
  }
  .session-list h3 {
    font-size: 14px;
    font-weight: 700;
    color: var(--gb-text);
    margin-bottom: 14px;
  }
  .session-item {
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-left: 2px solid transparent;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: background-color 120ms, border-color 120ms;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .session-item:hover { background: var(--gb-surface1); border-left-color: rgb(var(--accent)); }
  .session-item-title { font-weight: 600; color: var(--gb-text); font-size: 13px; }
  .session-item-meta { font-size: 11px; color: var(--gb-subtext0); }
  .session-item-stats { font-size: 10px; color: var(--gb-overlay2); text-align: right; }
  .session-delete-btn {
    background: none; border: none; color: var(--gb-overlay2); cursor: pointer;
    font-size: 14px; padding: 4px 8px; border-radius: 4px; transition: all 0.15s;
    flex-shrink: 0; margin-left: 8px;
  }
  .session-delete-btn:hover { background: var(--gb-red); color: #fff; }
  .session-review-btn {
    flex-shrink: 0;
    margin-left: 16px;
    font-size: 11px;
    padding: 5px 12px;
    border-radius: 4px;
  }
  .session-toolbar {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
  }
  .session-toolbar .btn-sm {
    font-size: 11px; padding: 4px 10px; border-radius: 4px;
  }
  .session-select-cb { margin-right: 10px; flex-shrink: 0; cursor: pointer; accent-color: var(--gb-blue); }
  .session-bulk-bar {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    background: var(--gb-surface1); border-radius: 6px; margin-bottom: 10px; font-size: 12px;
  }
  .session-confirm-bar {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: #fbeaea; border: 1px solid var(--gb-red); border-radius: 6px;
    margin-bottom: 10px; font-size: 12px; color: var(--gb-text);
  }
  .session-confirm-bar .btn { font-size: 11px; padding: 4px 12px; }

  /* ─── Quick Actions ──────────────────────────────────────────
     Sticks to the top of the .main scroll container so the user
     can kick off a research/search without scrolling back up as
     the card feed grows. The subtle shadow reads as "elevated"
     once cards start flowing underneath. */
  .quick-actions {
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 16px;
    position: sticky;
    top: 0;
    z-index: 20;
    box-shadow: 0 6px 14px -12px rgb(var(--shadow-color) / 0.45);
  }
  .quick-actions-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-overlay2);
    margin-bottom: 8px;
  }
  .quick-actions-input {
    font-family: var(--font-sans);
    font-size: 11px;
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--gb-surface2);
    border-radius: 4px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
    margin-bottom: 8px;
  }
  .quick-actions-input:focus { border-color: var(--gb-blue); }
  .quick-actions-input::placeholder { color: var(--gb-overlay1); }
  .quick-actions-row { display: flex; gap: 6px; }

  /* ─── Cards ────────────────────────────────────────────────── */
  .card {
    background: var(--gb-base);
    border: 1px solid var(--gb-surface2);
    border-radius: 10px;
    padding: 16px 18px;
    margin-bottom: 14px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  /* A pending suggestion is the only thing on screen asking for a decision,
     so it earns the accent border + lift rather than a colour wash. */
  .card.suggested {
    border-color: rgb(var(--accent));
    background: var(--gb-base);
    box-shadow: 0 2px 14px -6px rgb(var(--shadow-color) / 0.35);
  }
  /* Running cards sweep instead of pulsing their border: a blinking outline
     next to live transcript text reads as an error state. */
  .card.running {
    border-color: var(--gb-surface2);
    position: relative;
    overflow: hidden;
  }
  .card.running::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(105deg, transparent 40%, rgb(var(--text-primary) / 0.05) 50%, transparent 60%);
    background-size: 250% 100%;
    animation: card-sweep 2.4s linear infinite;
  }
  @keyframes card-sweep { from { background-position: 200% 0 } to { background-position: -50% 0 } }
  @media (prefers-reduced-motion: reduce) {
    .card.running::after { animation: none; }
  }
  .card.fade-out {
    opacity: 0;
    transform: translateY(-4px);
    transition: opacity 0.35s ease-out, transform 0.35s ease-out;
    pointer-events: none;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  .card-type {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 7px;
    border-radius: 4px;
  }
  /* Worker chips: tinted background + same-hue text, the family's chip
     pattern. Seven types have to stay tellable apart from the four semantic
     hues the family defines, so neutrals carry the two least urgent kinds
     (codegen, summary) and the rest take a hue each. Every value is a token,
     so the whole set inverts correctly in dark mode. */
  .card-type.research { background: rgb(var(--accent) / 0.16);    color: rgb(var(--accent)); }
  .card-type.analysis { background: rgb(var(--warning) / 0.18);   color: rgb(var(--warning)); }
  .card-type.mockup   { background: rgb(var(--ai-accent) / 0.20); color: rgb(var(--ai-accent)); }
  .card-type.review   { background: rgb(var(--success) / 0.18);   color: rgb(var(--success)); }
  .card-type.failed   { background: rgb(var(--error) / 0.18);     color: rgb(var(--error)); }
  .card-type.codegen  { background: rgb(var(--text-primary) / 0.09); color: var(--gb-subtext0); }
  .card-type.summary  { background: rgb(var(--text-primary) / 0.06); color: var(--gb-subtext1); }

  .card-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--gb-text);
    flex: 1;
    min-width: 0;
  }
  .card-time {
    font-size: 10px;
    color: var(--gb-overlay2);
    flex-shrink: 0;
  }

  .card-body {
    font-size: 13px;
    color: var(--gb-subtext1);
  }
  /* Headings carry rank through size and weight, not hue — the old palette
     gave h1-h4 four different colours, which read as a rainbow inside a card
     and fought the accent for attention. The family keeps prose monochrome
     and spends colour on chips, links and state. */
  .card-body h1 { color: var(--gb-text); font-size: 18px; font-weight: 700; margin-top: 16px; margin-bottom: 6px; }
  .card-body h2 { color: var(--gb-text); font-size: 15px; font-weight: 700; margin-top: 14px; margin-bottom: 6px; }
  .card-body h3 { color: var(--gb-text); font-size: 14px; font-weight: 600; margin-top: 12px; margin-bottom: 4px; }
  .card-body h4 { color: var(--gb-subtext0); font-size: 13px; font-weight: 600; margin-top: 10px; margin-bottom: 4px; }
  .card-body p { margin-bottom: 8px; }
  .card-body ul, .card-body ol { padding-left: 18px; margin-bottom: 8px; }
  .card-body li { margin-bottom: 3px; }
  .card-body strong { color: var(--gb-text); }
  /* Fixed-height, scrollable, user-resizable result/stream region (like the ask
     widget). Keeps long worker output from ballooning the card; drag the bottom
     edge to make it taller/shorter. */
  .card-scroll {
    height: 340px;        /* default size; drag the bottom edge to grow/shrink */
    min-height: 80px;
    max-height: 88vh;     /* ceiling for expansion (was a hard 340px cap) */
    overflow-y: auto;
    overflow-x: hidden;
    resize: vertical;
  }
  .card-body a { color: var(--gb-blue); text-decoration: none; }
  .card-body a:hover { text-decoration: underline; }
  .card-body pre { background: var(--gb-surface1); border: 1px solid var(--gb-surface2); border-radius: 5px; padding: 12px; overflow-x: auto; margin: 10px 0; font-size: 12px; line-height: 1.5; }
  .card-body code { font-family: var(--font-mono); font-size: 12px; }
  .card-body :not(pre) > code { background: var(--gb-surface1); color: var(--gb-text); padding: 1px 5px; border-radius: 3px; }
  .card-body hr { border: none; border-top: 1px solid var(--gb-surface2); margin: 12px 0; }
  .card-body blockquote { border-left: 3px solid var(--gb-overlay0); padding-left: 12px; color: var(--gb-subtext0); margin: 8px 0; }
  .card-body table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12px; }
  .card-body th, .card-body td { border: 1px solid var(--gb-surface2); padding: 5px 10px; text-align: left; }
  .card-body th { background: var(--gb-surface1); font-weight: 600; color: var(--gb-text); }
  .card-body input[type="checkbox"] { accent-color: var(--gb-green); margin-right: 5px; }

  .card-trigger {
    font-size: 11px;
    font-style: italic;
    color: var(--gb-overlay2);
    margin: 8px 0;
    padding-left: 10px;
    border-left: 2px solid var(--gb-surface2);
  }

  .card-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .artifact-divider { border-top: 1px solid var(--gb-surface2); margin: 14px 0; padding-top: 10px; }
  .artifact-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--gb-overlay2); margin-bottom: 6px; }

  /* ─── Mockup ASCII/HTML toggle ─────────────────────────────── */
  .mockup-toggle { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .mockup-toggle .btn { font-size: 11px; padding: 3px 10px; }
  .mockup-toggle .btn.active { background: var(--gb-blue); color: rgb(var(--accent-ink)); }
  .mockup-pane { margin: 0; }
  .mockup-frame {
    width: 100%;
    height: 440px;
    border: 1px solid var(--gb-surface2);
    background: #fff;
  }

  .spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid var(--gb-surface2);
    border-top-color: var(--gb-blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }
  @keyframes spin { to{transform:rotate(360deg)} }

  /* ─── Intelligence status row ──────────────────────────────── */
  .intel-status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--gb-subtext0);
    padding: 2px 4px 14px;
  }
  .intel-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--gb-overlay0);
    flex-shrink: 0;
  }
  .intel-status.evaluating .intel-dot,
  .intel-status.generating .intel-dot {
    background: var(--gb-yellow);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .intel-warn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 1px solid var(--gb-yellow);
    color: var(--gb-yellow);
    border-radius: 5px;
    font-size: 10px;
    font-family: inherit;
    padding: 1px 7px;
    cursor: pointer;
    margin-left: 4px;
  }
  .intel-warn.degraded {
    border-color: var(--gb-red, #cc241d);
    color: var(--gb-red, #cc241d);
  }
  .intel-pop {
    position: fixed;
    z-index: 1001;
    background: var(--gb-base, #fff);
    border: 1px solid var(--gb-surface1, #ddd);
    border-radius: 8px;
    box-shadow: 0 10px 24px -12px rgb(var(--shadow-color) / 0.4);
    padding: 10px 12px;
    font-size: 11px;
    max-width: 380px;
  }
  .intel-pop .pop-row { margin: 4px 0; line-height: 1.4; }
  .intel-pop .pop-src {
    font-weight: 700;
    text-transform: uppercase;
    font-size: 9px;
    letter-spacing: 0.05em;
    margin-right: 6px;
    color: var(--gb-subtext0, #777);
  }

  /* ─── Toasts ───────────────────────────────────────────────── */
  .toast-stack {
    position: fixed;
    right: 20px;
    bottom: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 1000;
    width: 320px;
  }
  .toast {
    position: relative;
    overflow: hidden;
    background: var(--gb-text);
    color: var(--gb-base);
    border-radius: 8px;
    padding: 10px 12px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    box-shadow: 0 10px 24px -12px rgb(var(--shadow-color) / 0.6);
    animation: toast-in 0.25s ease-out;
  }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .toast-msg { flex: 1; line-height: 1.4; min-width: 0; }
  .toast-undo {
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--gb-base) 40%, transparent);
    color: var(--gb-base);
    border-radius: 5px;
    padding: 3px 10px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .toast-undo:hover { background: color-mix(in srgb, var(--gb-base) 12%, transparent); }
  .toast-close {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--gb-base) 60%, transparent);
    font-size: 13px;
    cursor: pointer;
    padding: 0 2px;
    flex-shrink: 0;
  }
  .toast-bar { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--gb-yellow); }
  .toast-error { background: var(--gb-red, #cc241d); color: #fff; }
  .toast-error .toast-close { color: rgba(255,255,255,0.7); }
  .toast-error .toast-bar { background: rgba(255,255,255,0.5); }
  @keyframes drain { from { width: 100%; } to { width: 0%; } }

  /* ─── Monitor toggles (fact-check / coach) ─────────────────── */
  .qa-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    gap: 8px;
  }
  .qa-title-row .quick-actions-title { margin-bottom: 0; }
  .monitor-toggles { display: flex; gap: 4px; flex-shrink: 0; }
  .monitor-toggle {
    font-family: var(--font-sans);
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 8px;
    border-radius: 8px;
    border: 1px solid var(--gb-surface2);
    background: transparent;
    color: var(--gb-overlay2);
    cursor: pointer;
    transition: all 0.15s;
  }
  .monitor-toggle:hover { background: var(--gb-surface1); }
  .monitor-toggle.on {
    background: var(--gb-green);
    border-color: var(--gb-green);
    color: white;
  }

  /* ─── Coach strip ("say next") ─────────────────────────────── */
  .coach-strip {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    background: rgb(var(--warning) / 0.08);
    border: 1px solid var(--gb-yellow);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 16px;
    animation: toast-in 0.25s ease-out;
  }
  .coach-kind {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--gb-yellow);
    color: #fff;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .coach-kind.pressure, .coach-kind.objection { background: var(--gb-red); }
  .coach-kind.bad_answer, .coach-kind.confusion, .coach-kind.contradiction { background: var(--gb-blue); }
  .coach-kind.overcommitment, .coach-kind.agenda_risk { background: var(--gb-peach); }
  .coach-kind.decision, .coach-kind.commitment, .coach-kind.question { background: var(--gb-green); }
  .coach-body { flex: 1; min-width: 0; }
  .coach-phrasing { font-size: 13px; font-weight: 600; color: var(--gb-text); line-height: 1.45; }
  .coach-why { font-size: 11px; color: var(--gb-subtext0); margin-top: 2px; }
  .coach-close {
    background: none;
    border: none;
    color: var(--gb-overlay2);
    cursor: pointer;
    font-size: 14px;
    flex-shrink: 0;
    padding: 0 2px;
  }
  .coach-close:hover { color: var(--gb-text); }

  /* ─── Fact-check flag cards ────────────────────────────────── */
  .card.factflag { border-color: var(--gb-red); background: rgb(var(--error) / 0.04); }
  .card-type.factcheck { background: rgb(var(--error) / 0.12); color: var(--gb-red); }
  .toc-badge.factcheck { background: rgb(var(--error) / 0.15); color: var(--gb-red); }
  .fact-verdict {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 7px;
    border-radius: 4px;
    color: #fff;
  }
  .fact-verdict.likely_incorrect { background: var(--gb-red); }
  .fact-verdict.disputed { background: var(--gb-yellow); }
  .fact-sources { font-size: 10px; margin-top: 6px; }
  .fact-sources a { color: var(--gb-blue); }

  /* ─── Highlight-to-ask (selection menu + floating panel) ───── */
  .askmenu {
    position: fixed;
    z-index: 1200;
    display: none;
    background: var(--gb-base);
    border: 1px solid var(--gb-surface2);
    border-radius: 8px;
    box-shadow: 0 10px 28px -10px rgb(var(--shadow-color) / 0.4);
    padding: 4px;
    min-width: 190px;
  }
  .askmenu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    font-weight: 600;
    padding: 6px 10px;
    border-radius: 5px;
    cursor: pointer;
    color: var(--gb-text);
  }
  .askmenu-item:hover { background: var(--gb-surface1); }
  .askmenu-ico { color: var(--gb-overlay2); width: 12px; text-align: center; flex-shrink: 0; }
  .askmenu-input-row { display: none; padding: 4px; gap: 4px; align-items: flex-end; }
  .askmenu-input-row.open { display: flex; }
  .askmenu-input-row textarea {
    flex: 1;
    font-family: var(--font-sans);
    font-size: 11px;
    padding: 6px 8px;
    border: 1px solid var(--gb-surface2);
    border-radius: 5px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
    min-width: 0;
    min-height: 54px;
    resize: vertical;
    line-height: 1.5;
  }
  .askmenu-input-row textarea:focus { border-color: rgb(var(--accent)); }

  /* Selection mini-toolbar — visible affordance for highlight-to-ask */
  .selbar {
    position: fixed;
    z-index: 1200;
    display: none;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    background: var(--gb-base);
    border: 1px solid var(--gb-surface2);
    border-radius: 8px;
    box-shadow: 0 10px 28px -10px rgb(var(--shadow-color) / 0.4);
    padding: 3px;
  }
  .selbar-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    padding: 5px 9px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--gb-text);
    cursor: pointer;
    white-space: nowrap;
  }
  .selbar-btn:hover { background: var(--gb-surface1); }
  .selbar-input-row { display: none; padding: 2px; flex-basis: 100%; }
  .selbar-input-row.open { display: flex; }
  .selbar-input-row input {
    flex: 1;
    font-family: var(--font-sans);
    font-size: 11px;
    padding: 5px 8px;
    border: 1px solid var(--gb-surface2);
    border-radius: 5px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
    min-width: 220px;
  }
  .selbar-input-row input:focus { border-color: rgb(var(--accent)); }

  .askpanel {
    position: fixed;
    z-index: 1100;
    display: none;
    width: 400px;
    height: auto;
    min-width: 300px;
    min-height: 160px;
    max-width: 96vw;
    max-height: 92vh;
    background: var(--gb-base);
    border: 1px solid var(--gb-surface2);
    border-radius: 10px;
    box-shadow: 0 18px 44px -16px rgb(var(--shadow-color) / 0.5);
    flex-direction: column;
    resize: both;
    overflow: hidden;
  }
  .askpanel.open { display: flex; }
  .askpanel-head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px 6px;
    cursor: grab;
    user-select: none;
  }
  .askpanel-head:active { cursor: grabbing; }
  .askpanel-eyebrow {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-overlay2);
    margin-bottom: 2px;
  }
  .askpanel-quote { font-size: 11px; font-style: italic; color: var(--gb-subtext0); line-height: 1.4; }
  .askpanel-x {
    background: none;
    border: none;
    color: var(--gb-overlay2);
    font-size: 14px;
    cursor: pointer;
    flex-shrink: 0;
    padding: 0 2px;
  }
  .askpanel-x:hover { color: var(--gb-text); }
  .askpanel-body { padding: 4px 14px 10px; overflow-y: auto; flex: 1; min-height: 0; max-height: 42vh; font-size: 12px; }
  /* Once the user resizes/drags (pinned), the panel owns its height — let the
     body fill it instead of capping at the initial 42vh. */
  .askpanel.pinned .askpanel-body { max-height: none; }
  .askpanel-foot {
    display: flex;
    justify-content: flex-end;
    padding: 6px 12px 10px;
    border-top: 1px solid var(--gb-surface1);
  }

  /* ─── Newest-first transcript ──────────────────────────────── */
  .seg.newest { background: rgb(var(--warning) / 0.09); }
  .transcript-order {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 1px 7px;
    border-radius: 8px;
    margin-left: 6px;
    background: rgb(var(--text-primary) / 0.08);
    color: var(--gb-green);
  }

  /* ─── TOC Sidebar ──────────────────────────────────────────── */
  .toc {
    min-width: 0;
    border-left: 1px solid var(--gb-surface2);
    overflow-y: auto;
    overflow-x: hidden;
    padding: 14px 16px 14px 12px;
    background: var(--gb-mantle);
    scrollbar-width: thin;
    scrollbar-color: var(--gb-overlay0) transparent;
    word-break: break-word;
    display: flex;
    flex-direction: column;
  }
  .toc::-webkit-scrollbar { width: 4px; }
  .toc::-webkit-scrollbar-thumb { background: var(--gb-overlay0); border-radius: 2px; }

  .toc-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-overlay2);
    margin-bottom: 10px;
    padding: 0 4px;
    white-space: nowrap;
  }

  .toc-section { margin-bottom: 2px; overflow: hidden; }

  .toc-card-title {
    padding: 4px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--gb-subtext1);
    cursor: pointer;
    transition: background 0.12s;
    line-height: 1.4;
  }
  .toc-card-title:hover { background: var(--gb-surface1); }
  .toc-card-title.active { background: var(--gb-surface1); color: var(--gb-text); }

  .toc-badge {
    font-size: 8px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 1px 4px; border-radius: 3px;
    display: inline; vertical-align: middle; margin-right: 3px;
  }
  /* Same hue per worker type as .card-type above — a card and its outline
     entry must agree, or the badge stops being a wayfinding cue. */
  .toc-badge.research { background: rgb(var(--accent) / 0.16);    color: rgb(var(--accent)); }
  .toc-badge.analysis { background: rgb(var(--warning) / 0.18);   color: rgb(var(--warning)); }
  .toc-badge.mockup   { background: rgb(var(--ai-accent) / 0.20); color: rgb(var(--ai-accent)); }
  .toc-badge.review   { background: rgb(var(--success) / 0.18);   color: rgb(var(--success)); }
  .toc-badge.codegen  { background: rgb(var(--text-primary) / 0.09); color: var(--gb-subtext0); }
  .toc-badge.summary  { background: rgb(var(--text-primary) / 0.06); color: var(--gb-subtext1); }

  .toc-heading {
    display: block;
    padding: 2px 4px 2px 20px;
    font-size: 11px;
    color: var(--gb-subtext0);
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
    border-radius: 3px;
    text-decoration: none;
    line-height: 1.4;
  }
  .toc-heading.depth-3 { padding-left: 28px; }
  .toc-heading:hover { color: var(--gb-subtext1); background: var(--gb-surface1); }
  .toc-heading.active { color: var(--gb-text); background: rgb(var(--accent) / 0.1); border-left: 2px solid var(--gb-blue); padding-left: 16px; }
  .toc-heading.active.depth-3 { padding-left: 26px; }

  /* ─── Agenda Tracker Panel ─────────────────────────────────── */
  .agenda-panel {
    padding: 8px 4px 12px;
    border-bottom: 1px solid var(--gb-surface2);
    margin-bottom: 12px;
  }
  .agenda-panel.hidden { display: none; }
  .agenda-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    padding: 0 4px;
  }
  .agenda-title {
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-overlay2);
    white-space: nowrap;
  }
  .agenda-progress {
    min-width: 0;
    font-size: 10px;
    color: var(--gb-subtext0);
    font-weight: 600;
    line-height: 1.4;
    text-align: right;
  }
  .agenda-progress.all-covered { color: var(--gb-green); }
  .agenda-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 4px 4px;
    font-size: 11px;
    line-height: 1.4;
    border-radius: 3px;
  }
  .agenda-item + .agenda-item { margin-top: 2px; }
  .agenda-dot {
    flex: 0 0 auto;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    margin-top: 2px;
    border: 1.5px solid var(--gb-overlay1);
    background: transparent;
    position: relative;
  }
  .agenda-item.state-covered .agenda-dot {
    border-color: var(--gb-green);
    background: var(--gb-green);
  }
  .agenda-item.state-covered .agenda-dot::after {
    content: '';
    position: absolute;
    left: 2px;
    top: -1px;
    width: 4px;
    height: 7px;
    border: solid #fff;
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
  }
  .agenda-item.state-partial .agenda-dot {
    border-color: var(--gb-yellow);
    background: linear-gradient(90deg, var(--gb-yellow) 50%, transparent 50%);
  }
  .agenda-text {
    flex: 1 1 auto;
    color: var(--gb-subtext1);
    word-break: break-word;
  }
  .agenda-item.state-covered .agenda-text {
    color: var(--gb-overlay2);
    text-decoration: line-through;
    text-decoration-color: var(--gb-overlay0);
  }
  .agenda-item.state-partial .agenda-text { color: var(--gb-text); }
  .agenda-item.state-pending .agenda-text { color: var(--gb-text); }
  .agenda-evidence {
    font-size: 10px;
    color: var(--gb-overlay2);
    margin-top: 2px;
    padding-left: 18px;
    font-style: italic;
    line-height: 1.35;
  }
  .agenda-warnings {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 4px;
    background: rgb(var(--error) / 0.08);
    border-left: 2px solid var(--gb-red);
    font-size: 11px;
    color: var(--gb-red);
    line-height: 1.4;
  }
  .agenda-warnings-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 4px;
  }
  .agenda-warning-item + .agenda-warning-item { margin-top: 4px; }

  /* ─── Stage View ───────────────────────────────────────────────
     A full-screen, warm-dark presentation mode: agenda dots, a large
     teleprompter of what was just said, and the two things worth
     interrupting for (a suggestion, a coach line).

     Deliberately trails the speaker: chunks are 4s with 1s overlap and
     whisper adds ~1-2s, so this is a "read what was just said" view, not
     live captioning. The stitcher grows an open segment in place under a
     stable id, which is what makes the word-by-word reveal real rather
     than decorative — each new word is a word that actually arrived.     */
  .stage-view {
    /* Always dark, like cxnotes — a lit presentation surface reads wrong in a
       meeting. Values are the family's DARK palette verbatim, so Stage looks
       identical to cxnotes regardless of the dashboard's current theme. */
    --stage-base:    rgb(28,26,23);
    --stage-surface: rgb(42,39,34);
    --stage-line:    rgb(74,68,57);
    --stage-ink:     rgb(255,255,255);
    --stage-dim:     rgb(155,153,150);
    position: fixed;
    inset: 0;
    z-index: 400;
    display: none;
    flex-direction: column;
    background: var(--stage-base);
    color: var(--stage-ink);
  }
  .stage-view.active { display: flex; }

  .stage-top {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 18px 26px;
    flex-shrink: 0;
  }
  .stage-rec {
    width: 9px; height: 9px;
    border-radius: 50%;
    background: var(--gb-red);
    flex-shrink: 0;
    animation: rec-pulse 1.4s ease-in-out infinite;
  }
  .stage-rec.off { background: var(--stage-line); animation: none; }

  .stage-agenda { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0; }
  .stage-step {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
    color: var(--stage-dim);
    max-width: 190px;
  }
  .stage-step .sdot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--stage-line);
    flex-shrink: 0;
  }
  .stage-step .stext { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stage-step.state-covered .sdot { background: var(--stage-dim); }
  .stage-step.state-partial .sdot { background: var(--stage-dim); opacity: 0.6; }
  .stage-step.state-partial { color: var(--stage-ink); }
  .stage-step.state-pending .sdot { background: var(--stage-line); }

  .stage-clock {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  .stage-pill {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 3px 9px;
    border-radius: 9px;
    background: var(--stage-ink);
    color: var(--stage-base);
  }
  .stage-timer { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stage-exit {
    font-family: var(--font-sans);
    font-size: 10.5px;
    font-weight: 600;
    padding: 5px 11px;
    border-radius: 6px;
    border: 1px solid var(--stage-line);
    background: transparent;
    color: var(--stage-dim);
    cursor: pointer;
  }
  .stage-exit:hover { color: var(--stage-ink); border-color: var(--stage-dim); }

  /* Two modes share one feed element:
       mode-live    — the default prompter: three lines, centred, fading into
                      the past. Nothing to scroll; it is a glance, not a doc.
       mode-history — the reader scrolled up, so the full back-transcript
                      opens, bottom-anchored and fully legible.
     Jump-to-live (or scrolling back to the bottom) returns to mode-live.    */
  .stage-prompter {
    position: relative;
    flex: 1;
    min-height: 0;
    padding: 0 clamp(28px, 7vw, 110px);
    scrollbar-width: thin;
    scrollbar-color: var(--stage-line) transparent;
    overscroll-behavior: contain;
  }
  .stage-prompter.mode-live { overflow: hidden; }
  .stage-prompter.mode-history { overflow-y: auto; }
  .stage-prompter::-webkit-scrollbar { width: 5px; }
  .stage-prompter::-webkit-scrollbar-thumb { background: var(--stage-line); border-radius: 3px; }

  .stage-feed {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 100%;
  }
  .mode-live .stage-feed { justify-content: center; gap: 18px; }
  .mode-history .stage-feed { justify-content: flex-end; padding: 40px 0 24px; }

  .stage-hist {
    font-size: clamp(12px, 1.15vw, 15px);
    line-height: 1.6;
    color: var(--stage-dim);
  }
  .stage-hist .who { font-weight: 700; }
  .stage-hist.mic .who { color: rgb(255 255 255 / 0.78); }
  /* The fade is a live-mode effect only. In history mode it would be actively
     hostile — fading out the very lines the reader scrolled back to read. */
  .mode-live .stage-hist { opacity: 0.55; }
  .mode-live .stage-hist.older { opacity: 0.3; }

  .stage-older-btn {
    align-self: center;
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    padding: 5px 14px;
    border-radius: 999px;
    border: 1px dashed var(--stage-line);
    background: transparent;
    color: var(--stage-dim);
    cursor: pointer;
  }
  .stage-older-btn:hover { color: var(--stage-ink); }

  /* Shown only when the reader has scrolled off the live edge. Positioned
     against .stage-view (not the prompter) — an absolute child of a scrolling
     container scrolls away with the content. Sits above the waveform, and
     centred so it never collides with the right-hand toast stack. */
  .stage-jump {
    position: absolute;
    left: 50%;
    bottom: 52px;
    transform: translateX(-50%);
    display: none;
    align-items: center;
    gap: 6px;
    font-family: var(--font-sans);
    font-size: 10.5px;
    font-weight: 600;
    padding: 5px 14px;
    border-radius: 999px;
    border: none;
    background: var(--stage-ink);
    color: var(--stage-base);
    cursor: pointer;
    box-shadow: 0 6px 18px rgba(0,0,0,0.45);
    z-index: 2;
  }
  .stage-jump.visible { display: inline-flex; }
  .stage-live {
    font-size: clamp(17px, 2vw, 25px);
    line-height: 1.5;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .stage-live .who {
    display: block;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--stage-dim);
    margin-bottom: 9px;
  }
  .stage-live .w { animation: stage-word 0.3s ease-out both; }
  @keyframes stage-word { from { opacity: 0; filter: blur(2px); } to { opacity: 1; filter: none; } }
  .stage-empty { color: var(--stage-dim); font-size: 13px; }

  .stage-wave {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 22px;
    padding: 0 26px 20px;
    flex-shrink: 0;
  }
  .stage-wave i {
    flex: 1;
    border-radius: 1px;
    background: rgb(255 255 255 / 0.22);
    animation: stage-wv 1.3s ease-in-out infinite;
  }
  @keyframes stage-wv { 0%,100% { transform: scaleY(0.45); } 50% { transform: scaleY(1); } }
  .stage-view.paused .stage-wave i { animation: none; opacity: 0.4; }

  /* Interruptions — bottom-right, stacked */
  .stage-toasts {
    position: absolute;
    right: 26px;
    bottom: 56px;
    width: 330px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .stage-toast {
    background: var(--stage-surface);
    border: 1px solid var(--stage-line);
    border-radius: 12px;
    padding: 13px 15px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.45);
    animation: stage-toast-in 0.35s cubic-bezier(.2,.8,.2,1) both;
  }
  @keyframes stage-toast-in { from { opacity: 0; transform: translateY(14px); } }
  .stage-toast .head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--stage-dim);
  }
  .stage-toast .title { font-size: 13px; font-weight: 700; margin-top: 7px; line-height: 1.4; }
  .stage-toast .why { font-size: 10.5px; color: var(--stage-dim); margin-top: 4px; line-height: 1.5; }
  .stage-toast .row { display: flex; align-items: center; gap: 8px; margin-top: 11px; }
  .stage-btn {
    font-family: var(--font-sans);
    font-size: 10.5px;
    font-weight: 600;
    padding: 5px 13px;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .stage-btn.primary { background: var(--stage-ink); color: var(--stage-base); }
  .stage-btn.ghost { background: transparent; border-color: var(--stage-line); color: var(--stage-dim); }
  .stage-btn.ghost:hover { color: var(--stage-ink); }

  /* Coach TTL ring — driven by the real expiresAt the coach payload carries.
     Suggestions deliberately have no ring: no expiry reaches the client, and
     a countdown that isn't backed by one would be a lie about a deadline. */
  .stage-ttl { margin-left: auto; position: relative; width: 26px; height: 26px; flex-shrink: 0; }
  .stage-ttl svg { transform: rotate(-90deg); display: block; }
  .stage-ttl .track { stroke: var(--stage-line); }
  .stage-ttl .arc { stroke: var(--stage-ink); transition: stroke-dashoffset 0.9s linear; }
  .stage-ttl b {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 8.5px; font-weight: 600; font-variant-numeric: tabular-nums;
  }

  @media (prefers-reduced-motion: reduce) {
    .stage-wave i, .stage-live .w, .stage-toast, .stage-rec { animation: none; }
  }
</style>
</head>
<body>

<!-- ─── Header ─────────────────────────────────────────────── -->
<div class="header">
  <div class="header-left">
    <div class="status-dot" id="statusDot"></div>
    <h1>Meeting Copilot</h1>
  </div>
  <div class="header-center" id="headerTitle"></div>
  <div class="header-right">
    <span class="audio-indicator" id="audioIndicator">
      <span class="audio-dot" id="audioDot"></span>
      <span>REC</span>
      <span class="audio-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
    </span>
    <span class="ending-hint" id="endingHint" style="display:none"></span>
    <span class="state-pill idle" id="statePill">Idle</span>
    <span class="session-timer" id="sessionTimer"></span>
    <button class="btn btn-ghost" id="newMeetingBtn" style="display:none" onclick="newMeeting()">&larr; New Meeting</button>
    <button class="btn btn-green" id="startStopBtn" style="display:none" onclick="toggleSession()">Start</button>
    <button class="btn btn-ghost btn-sm" id="themeBtn" onclick="toggleTheme()" aria-label="Toggle light and dark theme" title="Toggle theme"></button>
    <button class="btn btn-ghost btn-sm" id="stageBtn" onclick="toggleStage()" aria-label="Stage view" title="Stage view (declutters to transcript + prompts)">Stage</button>
    <button class="btn btn-ghost btn-sm" id="settingsBtn" onclick="openSettings()" aria-label="Settings" title="Settings">&#9881;</button>
  </div>
</div>

<!-- ─── Stage View (full-screen presentation mode) ──────────── -->
<div class="stage-view" id="stageView" role="region" aria-label="Stage view">
  <div class="stage-top">
    <span class="stage-rec" id="stageRec"></span>
    <div class="stage-agenda" id="stageAgenda"></div>
    <div class="stage-clock">
      <span class="stage-pill" id="stagePill">Live</span>
      <span class="stage-timer" id="stageTimer"></span>
      <button class="stage-exit" onclick="toggleStage()" title="Exit stage view (Esc)">Exit</button>
    </div>
  </div>
  <div class="stage-prompter" id="stagePrompter">
    <div class="stage-feed" id="stageFeed"></div>
  </div>
  <button class="stage-jump" id="stageJump" onclick="stageJumpToLive()">Jump to live &#8595;</button>
  <div class="stage-wave" id="stageWave" aria-hidden="true"></div>
  <div class="stage-toasts" id="stageToasts"></div>
</div>

<!-- ─── Stats Bar ──────────────────────────────────────────── -->
<div class="stats-bar" id="statsBar">
  <div class="stat-tile"><div class="stat-label">Segments</div><div class="stat-value" id="statSegments">0</div></div>
  <div class="stat-tile"><div class="stat-label">Words</div><div class="stat-value" id="statWords">0</div></div>
  <div class="stat-tile"><div class="stat-label">Pace</div><div class="stat-value" id="statPace">0/m</div></div>
  <div class="stat-tile"><div class="stat-label">You</div><div class="stat-value" id="statYou">0</div></div>
  <div class="stat-tile"><div class="stat-label">Meeting</div><div class="stat-value" id="statMeeting">0</div></div>
  <div class="stat-tile"><div class="stat-label">Suggestions</div><div class="stat-value" id="statActions">0</div></div>
</div>

<!-- ─── Layout ─────────────────────────────────────────────── -->
<div class="layout" id="layout">

  <!-- Transcript Column -->
  <div class="transcript-col" id="transcriptCol">
    <div class="transcript-header">
      <div class="transcript-title-row">
        <span class="transcript-title">Transcript<span class="transcript-order" id="transcriptOrder" style="display:none">Newest first</span></span>
        <span class="segment-count" id="segCount">0</span>
      </div>
      <div class="filter-row">
        <button class="filter-btn active" onclick="setFilter('all',this)">All</button>
        <button class="filter-btn" onclick="setFilter('mic',this)">You</button>
        <button class="filter-btn" onclick="setFilter('meeting',this)">Meeting</button>
      </div>
      <input class="transcript-search" id="transcriptSearch" placeholder="Search transcript..." oninput="filterTranscript()">
    </div>
    <button class="new-seg-pill" id="newSegPill" style="display:none"></button>
    <div class="transcript-feed" id="transcriptFeed"></div>
  </div>

  <!-- Main Column -->
  <div class="main" id="mainCol">
    <div id="idleOverlay"></div>
    <div id="quickActionsSlot"></div>
    <div class="intel-status" id="intelStatus" style="display:none">
      <span class="intel-dot"></span>
      <span id="intelStatusText">Listening</span>
      <button class="intel-warn" id="intelWarn" style="display:none" aria-label="Recent intelligence errors" title="Recent intelligence errors">&#9888; <span id="intelWarnCount"></span></button>
    </div>
    <div id="coachSlot"></div>
    <div id="results"></div>
  </div>

  <!-- TOC Sidebar -->
  <nav class="toc" id="toc">
    <div class="agenda-panel hidden" id="agendaPanel">
      <div class="agenda-header">
        <span class="agenda-title">Agenda</span>
        <span class="agenda-progress" id="agendaProgress">0 / 0</span>
      </div>
      <div id="agendaItems"></div>
      <div id="agendaWarnings"></div>
    </div>
    <div class="toc-title">Outline</div>
    <div id="tocEntries"></div>
  </nav>
</div>

<div class="toast-stack" id="toastStack" role="status" aria-live="polite"></div>
<div id="srAnnouncer" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap"></div>

<script>
(function() {
  // ─── DOM Refs ───────────────────────────────────────────────
  var statusDot = document.getElementById('statusDot');
  var headerTitle = document.getElementById('headerTitle');
  var statePill = document.getElementById('statePill');
  var endingHintEl = document.getElementById('endingHint');
  var sessionTimerEl = document.getElementById('sessionTimer');
  var startStopBtn = document.getElementById('startStopBtn');
  var newMeetingBtn = document.getElementById('newMeetingBtn');
  var statsBar = document.getElementById('statsBar');
  var layout = document.getElementById('layout');
  var transcriptCol = document.getElementById('transcriptCol');
  var transcriptFeed = document.getElementById('transcriptFeed');
  var segCountEl = document.getElementById('segCount');
  var mainCol = document.getElementById('mainCol');
  var idleOverlay = document.getElementById('idleOverlay');
  var quickActionsSlot = document.getElementById('quickActionsSlot');
  var resultsEl = document.getElementById('results');
  var tocEntries = document.getElementById('tocEntries');
  var agendaPanel = document.getElementById('agendaPanel');
  var agendaItemsEl = document.getElementById('agendaItems');
  var agendaWarningsEl = document.getElementById('agendaWarnings');
  var agendaProgressEl = document.getElementById('agendaProgress');
  var intelStatusEl = document.getElementById('intelStatus');
  var intelStatusTextEl = document.getElementById('intelStatusText');
  var toastStackEl = document.getElementById('toastStack');
  var transcriptOrderEl = document.getElementById('transcriptOrder');
  var coachSlot = document.getElementById('coachSlot');

  // Opt-in monitor state — authoritative copy lives on the server and is
  // synced via feature.state broadcasts.
  var featureState = { factcheck: false, coach: false };
  var factFlagCards = new Map();
  var coachExpireTimer = null;
  var pendingGoals = '';

  // ─── State ──────────────────────────────────────────────────
  var params = new URLSearchParams(window.location.search);
  var replaySessionId = params.get('session');
  var isReplay = !!replaySessionId;

  var ws = null;
  var sessionState = 'idle';
  var sessionId = null;
  var sessionTitle = '';
  var sessionStartTime = null;
  // Progress text + safety watchdog for the 'ending' state. The server runs
  // post-meeting workers (summary + self-review) before broadcasting 'archived';
  // if that terminal event never arrives (server error, dropped socket), the
  // watchdog flips the UI to 'archived' so it can never strand on "Ending…".
  var endingMessage = '';
  var endingWatchdog = null;
  // > the server's 240s worker grace window (END_GRACE_MS) so this only fires on
  // a true hang (server froze before the terminal broadcast), not a slow-but-
  // legitimate Opus wrap-up that's about to settle on its own.
  var ENDING_WATCHDOG_MS = 300000; // 5 min
  var timerInterval = null;
  var totalWords = 0;
  var micWords = 0;
  var meetingWords = 0;
  var segments = [];
  // seg id -> { el, wordCount, source } for the stitcher's in-place growth.
  var segById = new Map();
  var currentFilter = 'all';
  var autoScroll = true;
  var actionCards = new Map();
  var announcedSuggestions = new Set(); // screen-reader announcements, once per card
  // actionId -> generated HTML mockup string, for Open-in-tab / Download.
  var mockupHtml = new Map();
  var headingIdCounter = 0;
  var availableProjects = [];
  var availableContextSources = [];

  // Pre-fetch projects and context sources for the start form
  fetch('/projects').then(function(r) { return r.json(); }).then(function(d) {
    availableProjects = d.projects || [];
  }).catch(function() {});
  fetch('/context-sources').then(function(r) { return r.json(); }).then(function(d) {
    availableContextSources = d.items || [];
  }).catch(function() {});

  // ─── Agenda Editor (session setup) ─────────────────────────
  // State machine for the agenda input area on the idle screen.
  // kind: 'raw'         — textarea visible, Extract available, Start active
  //       'extracting'  — textarea read-only, spinner, Start DISABLED
  //       'extracted'   — editable list replaces textarea, Start active
  //       'empty'       — textarea + notice "no items found", Start active (uses raw)
  //       'error'       — textarea + red notice, Start active (uses raw)
  var agendaState = { kind: 'raw' };
  var agendaRawSnapshot = ''; // preserves the original paste across revert
  var agendaAbortController = null;
  var agendaExtractGen = 0;

  function setAgendaState(next) {
    agendaState = next;
    renderAgendaEditor();
    refreshStartButton();
  }

  function refreshStartButton() {
    var btn = document.getElementById('startBtn');
    if (!btn) return;
    var wsConnected = ws && ws.readyState === WebSocket.OPEN;
    var consent = document.getElementById('consentCheck');
    var consentOk = !consent || consent.checked;
    btn.disabled = !wsConnected || agendaState.kind === 'extracting' || !consentOk;
    btn.title = consentOk ? '' : 'Confirm the consent checkbox to start';
  }
  window.refreshStartButton = refreshStartButton;

  function currentTextareaValue() {
    var ta = document.getElementById('startAgenda');
    return ta ? ta.value : '';
  }

  function snapshotEditorItems() {
    var inputs = document.querySelectorAll('.agenda-editor-input');
    var out = [];
    for (var i = 0; i < inputs.length; i++) {
      var v = inputs[i].value.trim();
      if (v) out.push(v);
    }
    return out;
  }

  function renderAgendaEditor() {
    var host = document.getElementById('agendaEditor');
    if (!host) return;

    if (agendaState.kind === 'extracted') {
      var items = agendaState.items || [];
      var listHtml = '<div class="agenda-editor-list" id="agendaItemList">';
      for (var i = 0; i < items.length; i++) {
        listHtml += '<div class="agenda-editor-row">' +
          '<input type="text" class="agenda-editor-input" value="' + escapeHtml(items[i]) + '">' +
          '<button type="button" class="agenda-editor-remove" onclick="removeAgendaItem(' + i + ')" title="Remove">×</button>' +
        '</div>';
      }
      listHtml += '</div>';
      host.innerHTML = listHtml +
        '<div class="agenda-edit-actions">' +
          '<button type="button" class="btn btn-ghost" onclick="addAgendaItem()">+ Add item</button>' +
          '<button type="button" class="btn btn-ghost" onclick="revertToRawAgenda()">Start over with raw text</button>' +
          '<span class="agenda-editor-count">' + items.length + ' item' + (items.length === 1 ? '' : 's') + '</span>' +
        '</div>';
      return;
    }

    // raw / extracting / empty / error — all show the textarea.
    var readonly = agendaState.kind === 'extracting' ? ' readonly' : '';
    var value = agendaRawSnapshot || '';
    var textarea = '<textarea id="startAgenda" rows="5" placeholder="Paste rough notes and click Build agenda&#10;&#10;…or type one agenda item per line" oninput="onAgendaTextareaInput()"' + readonly + '>' + escapeHtml(value) + '</textarea>';
    var helper = '<div class="agenda-helper">Rough notes are fine — it turns them into tracked agenda items. Or type one item per line.</div>';

    var buttonLabel, disabled = '';
    if (agendaState.kind === 'extracting') {
      buttonLabel = '<span class="agenda-edit-spinner"></span>Building agenda…';
      disabled = ' disabled';
    } else {
      buttonLabel = 'Build agenda from notes';
      if (!(agendaRawSnapshot && agendaRawSnapshot.trim())) disabled = ' disabled';
    }

    var status = '';
    if (agendaState.kind === 'empty') {
      status = '<span class="agenda-edit-status empty">' + escapeHtml(agendaState.message || 'No items found — edit and try again, or start with the raw text.') + '</span>';
    } else if (agendaState.kind === 'error') {
      status = '<span class="agenda-edit-status error">' + escapeHtml(agendaState.message || 'Could not build an agenda — edit the notes and try again.') + '</span>';
    }

    host.innerHTML = textarea + helper +
      '<div class="agenda-edit-actions">' +
        '<button type="button" class="btn btn-ghost" id="extractAgendaBtn" onclick="extractAgendaFromNotes()"' + disabled + '>' + buttonLabel + '</button>' +
        status +
      '</div>';
  }

  window.onAgendaTextareaInput = function() {
    agendaRawSnapshot = currentTextareaValue();
    // Only flip to 'raw' when we're exiting a terminal state. When already
    // 'raw' we just update the button's disabled flag without a full re-render
    // so focus and caret are preserved.
    if (agendaState.kind === 'raw') {
      var btn = document.getElementById('extractAgendaBtn');
      if (btn) btn.disabled = !agendaRawSnapshot.trim();
      return;
    }
    if (agendaState.kind === 'empty' || agendaState.kind === 'error') {
      setAgendaState({ kind: 'raw' });
    }
  };

  window.extractAgendaFromNotes = function() {
    var raw = currentTextareaValue().trim();
    if (!raw) return;
    agendaRawSnapshot = raw;

    // Abort any prior in-flight extract, bump the generation token
    if (agendaAbortController) {
      try { agendaAbortController.abort(); } catch (e) {}
    }
    agendaAbortController = new AbortController();
    var gen = ++agendaExtractGen;

    setAgendaState({ kind: 'extracting' });

    fetch('/agenda/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: raw }),
      signal: agendaAbortController.signal,
    }).then(function(r) {
      return r.json().then(function(d) { return { ok: r.ok, data: d }; });
    }).then(function(res) {
      if (gen !== agendaExtractGen) return; // stale result — ignore
      if (!res.ok || res.data.error) {
        setAgendaState({ kind: 'error', message: res.data.error || 'Could not build an agenda' });
        return;
      }
      var items = (res.data.items || []).filter(function(s) { return typeof s === 'string' && s.trim(); });
      if (items.length === 0) {
        setAgendaState({ kind: 'empty', message: 'No items found — edit and try again, or start with the raw text.' });
        return;
      }
      setAgendaState({ kind: 'extracted', items: items });
    }).catch(function(err) {
      if (gen !== agendaExtractGen) return; // aborted or superseded
      if (err && err.name === 'AbortError') return;
      setAgendaState({ kind: 'error', message: 'Network error — is the server running?' });
    });
  };

  window.addAgendaItem = function() {
    if (agendaState.kind !== 'extracted') return;
    var current = snapshotEditorItems();
    current.push('');
    setAgendaState({ kind: 'extracted', items: current });
    // Focus the newly added input
    setTimeout(function() {
      var inputs = document.querySelectorAll('.agenda-editor-input');
      if (inputs.length > 0) inputs[inputs.length - 1].focus();
    }, 0);
  };

  window.removeAgendaItem = function(idx) {
    if (agendaState.kind !== 'extracted') return;
    var current = snapshotEditorItems();
    current.splice(idx, 1);
    setAgendaState({ kind: 'extracted', items: current });
  };

  window.revertToRawAgenda = function() {
    if (agendaAbortController) {
      try { agendaAbortController.abort(); } catch (e) {}
    }
    agendaExtractGen++;
    setAgendaState({ kind: 'raw' });
  };

  function collectAgendaString() {
    if (agendaState.kind === 'extracted') {
      return snapshotEditorItems().join('\\n');
    }
    return currentTextareaValue();
  }

  // ─── Context Source Management ─────────────────────────────
  var ctxAddingType = null; // 'file' or 'folder' when input is visible
  var ctxError = ''; // error message to display

  window.refreshContextSources = function() {
    return fetch('/context-sources').then(function(r) { return r.json(); }).then(function(d) {
      availableContextSources = d.items || [];
      if (sessionState === 'idle' && !isReplay) renderContextList();
    }).catch(function() {});
  };

  function addContextPath(path, type) {
    fetch('/context-sources/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path, type: type })
    }).then(function(r) {
      return r.json().then(function(d) { return { ok: r.ok, data: d }; });
    }).then(function(res) {
      if (!res.ok || res.data.error) {
        ctxError = res.data.error || 'Failed to add — check that the path exists';
        renderContextList();
        return;
      }
      if (res.data.items) availableContextSources = res.data.items;
      ctxAddingType = null;
      ctxError = '';
      renderContextList();
    }).catch(function() {
      ctxError = 'Network error — is the server running?';
      renderContextList();
    });
  }

  window.showAddContext = function(type) {
    // When running inside the Meeting Copilot app, use the native Finder
    // picker instead of the manual path input.
    if (hasNativeBridge() && window.__copilotNativeBridge.pickPath) {
      ctxError = '';
      window.__copilotNativeBridge.pickPath({
        kind: type,
        title: type === 'folder' ? 'Choose a context folder' : 'Choose a context file'
      }).then(function(path) {
        if (!path) return; // user cancelled
        addContextPath(path, type);
      });
      return;
    }

    ctxAddingType = type;
    ctxError = '';
    renderContextList();
    var input = document.getElementById('ctxPathInput');
    if (input) {
      input.focus();
      // Drag-and-drop: extract file path from dragged Finder items
      input.addEventListener('dragover', function(e) { e.preventDefault(); input.classList.add('drag-over'); });
      input.addEventListener('dragleave', function() { input.classList.remove('drag-over'); });
      input.addEventListener('drop', function(e) {
        e.preventDefault();
        input.classList.remove('drag-over');
        // Try to get file path from drag data
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) {
          // In WKWebView/Electron, file.path gives the full path; in browsers, file.name is all we get
          var path = files[0].path || files[0].name;
          if (path) input.value = path;
        } else {
          var text = e.dataTransfer && e.dataTransfer.getData('text/plain');
          if (text) input.value = text.trim();
        }
      });
    }
  };

  window.cancelAddContext = function() {
    ctxAddingType = null;
    ctxError = '';
    renderContextList();
  };

  window.submitContextSource = function() {
    var input = document.getElementById('ctxPathInput');
    if (!input) return;
    var path = input.value.trim();
    // Client-side validation
    if (!path) { ctxError = 'Please enter a path'; renderContextList(); return; }
    if (!path.startsWith('/') && !path.startsWith('~')) { ctxError = 'Path must be absolute (start with / or ~)'; renderContextList(); return; }
    ctxError = '';
    fetch('/context-sources/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path, type: ctxAddingType || 'folder' })
    }).then(function(r) {
      return r.json().then(function(d) { return { ok: r.ok, data: d }; });
    }).then(function(res) {
      if (!res.ok || res.data.error) {
        ctxError = res.data.error || 'Failed to add — check that the path exists';
        renderContextList();
        return;
      }
      if (res.data.items) availableContextSources = res.data.items;
      ctxAddingType = null;
      ctxError = '';
      renderContextList();
    }).catch(function() {
      ctxError = 'Network error — is the server running?';
      renderContextList();
    });
  };

  window.removeContextSource = function(path) {
    fetch('/context-sources', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.items) availableContextSources = d.items;
      renderContextList();
    }).catch(function() {});
  };

  function renderContextList() {
    var container = document.getElementById('ctxContainer');
    if (!container) return;

    var html = '';
    if (availableContextSources.length > 0) {
      html += '<div class="ctx-list">';
      availableContextSources.forEach(function(s) {
        var icon = s.type === 'folder' ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
        var name = s.label || s.path.split('/').pop();
        var shortPath = s.path.replace(/^\\/Users\\/[^\\/]+/, '~');
        html += '<div class="ctx-item">' +
          '<input type="checkbox" class="ctx-cb" value="' + escapeHtml(s.path) + '">' +
          '<span class="ctx-icon">' + icon + '</span>' +
          '<span class="ctx-name">' + escapeHtml(name) + '</span>' +
          '<span class="ctx-path" title="' + escapeHtml(s.path) + '">' + escapeHtml(shortPath) + '</span>' +
          '<button class="ctx-remove" onclick="removeContextSource(\\'' + escapeHtml(s.path).replace(/'/g, "\\\\'") + '\\')" title="Remove">\u00D7</button>' +
        '</div>';
      });
      html += '</div>';
    } else if (!ctxAddingType) {
      html += '<div class="ctx-empty">No context sources added yet</div>';
    }

    if (ctxAddingType) {
      html += '<div class="ctx-input-row">' +
        '<input id="ctxPathInput" placeholder="' + (ctxAddingType === 'folder' ? '/path/to/folder — or drag from Finder' : '/path/to/file.md — or drag from Finder') + '" onkeydown="if(event.key===\\'Enter\\')submitContextSource();if(event.key===\\'Escape\\')cancelAddContext()">' +
        '<button class="ctx-submit" onclick="submitContextSource()">Add</button>' +
        '<button class="ctx-cancel" onclick="cancelAddContext()">Cancel</button>' +
      '</div>';
      if (ctxError) html += '<div class="ctx-error">' + escapeHtml(ctxError) + '</div>';
    } else {
      html += '<div class="ctx-add-row">' +
        '<button class="ctx-add-btn" onclick="showAddContext(\\'folder\\')">+ Add Folder</button>' +
        '<button class="ctx-add-btn" onclick="showAddContext(\\'file\\')">+ Add File</button>' +
      '</div>';
    }

    container.innerHTML = html;
  }

  // ─── Signal Detection ──────────────────────────────────────
  // Regex sources come from src/present/signals.ts (word-boundary anchored —
  // 'risk' must not tag 'brisk', 'action' must not tag 'transaction').
  var signalRegexSources = ${JSON.stringify(buildSignalRegexSources())};
  var signalRegexes = {
    action: new RegExp(signalRegexSources.action, 'i'),
    decision: new RegExp(signalRegexSources.decision, 'i'),
    risk: new RegExp(signalRegexSources.risk, 'i'),
  };
  var questionStarts = ${JSON.stringify(QUESTION_STARTS)};

  function detectSignals(text) {
    var signals = [];
    if (signalRegexes.action.test(text)) signals.push('action');
    if (signalRegexes.decision.test(text)) signals.push('decision');
    if (signalRegexes.risk.test(text)) signals.push('risk');
    if (text.includes('?')) {
      var lower = text.toLowerCase();
      for (var i = 0; i < questionStarts.length; i++) { if (lower.startsWith(questionStarts[i]) || lower.includes(' ' + questionStarts[i] + ' ')) { signals.push('question'); break; } }
    }
    return signals;
  }

  // ─── Agenda Tracker ────────────────────────────────────────
  function renderAgendaStatus(status) {
    stageLastAgenda = status;
    if (stageActive) stageRenderAgenda();
    if (!status || !status.items || status.items.length === 0) {
      agendaPanel.className = 'agenda-panel hidden';
      return;
    }

    agendaPanel.className = 'agenda-panel';

    var covered = 0;
    var partial = 0;
    var html = '';
    for (var i = 0; i < status.items.length; i++) {
      var item = status.items[i];
      var state = item.state || 'pending';
      if (state === 'covered') covered++;
      else if (state === 'partial') partial++;

      html += '<div class="agenda-item state-' + state + '" title="' + escapeHtml(state) + '">' +
        '<span class="agenda-dot"></span>' +
        '<span class="agenda-text">' + escapeHtml(item.text) + '</span>' +
      '</div>';
      if (item.evidence && state !== 'pending') {
        html += '<div class="agenda-evidence">“' + escapeHtml(item.evidence) + '”</div>';
      }
    }
    agendaItemsEl.innerHTML = html;

    var total = status.items.length;
    var progressText = covered + ' / ' + total + ' covered';
    if (partial > 0) progressText += ' · ' + partial + ' partial';
    if (status.lastEvalAt) {
      var secs = Math.max(1, Math.round((Date.now() - status.lastEvalAt) / 1000));
      progressText += ' · checked ' + (secs < 60 ? secs + 's' : Math.round(secs / 60) + 'm') + ' ago';
    }
    agendaProgressEl.textContent = progressText;
    agendaProgressEl.className = 'agenda-progress' + (covered === total ? ' all-covered' : '');

    if (status.missing && status.missing.length > 0) {
      var warnHtml = '<div class="agenda-warnings">' +
        '<div class="agenda-warnings-title">Might be missing</div>';
      for (var j = 0; j < status.missing.length; j++) {
        warnHtml += '<div class="agenda-warning-item">' + escapeHtml(status.missing[j]) + '</div>';
      }
      warnHtml += '</div>';
      agendaWarningsEl.innerHTML = warnHtml;
    } else {
      agendaWarningsEl.innerHTML = '';
    }
  }

  function clearAgenda() {
    agendaPanel.className = 'agenda-panel hidden';
    agendaItemsEl.innerHTML = '';
    agendaWarningsEl.innerHTML = '';
    agendaProgressEl.textContent = '0 / 0';
    agendaProgressEl.className = 'agenda-progress';
  }

  // ─── Utilities ─────────────────────────────────────────────
  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return '<pre>' + escapeHtml(text) + '</pre>';
    var html = marked.parse(text);
    // Sanitize before this HTML hits any innerHTML sink (streaming worker output,
    // ask/summarize panel, review). Modern marked passes raw HTML through, and
    // streamed research/analysis can echo web-derived markup — strip scripts and
    // event handlers so a hostile page can't run JS in the localhost dashboard.
    if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(html);
    return html;
  }

  function highlightCode() {
    if (typeof hljs !== 'undefined') {
      document.querySelectorAll('.card-body pre code:not(.hljs)').forEach(function(b) { hljs.highlightElement(b); });
    }
  }

  // Live markdown rendering for streaming worker output. Raw markdown accumulates
  // on each .streaming-text element (el._md); we re-render to formatted HTML at
  // most once per animation frame (coalescing token deltas), following the stream
  // to the bottom unless the user has scrolled up to read.
  var streamPending = new Set();
  var streamRenderScheduled = false;
  function scheduleStreamRender() {
    if (streamRenderScheduled) return;
    streamRenderScheduled = true;
    requestAnimationFrame(function() {
      streamRenderScheduled = false;
      streamPending.forEach(function(el) {
        var nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        el.innerHTML = renderMarkdown(el._md || '');
        if (nearBottom) el.scrollTop = el.scrollHeight;
      });
      streamPending.clear();
      highlightCode();
    });
  }

  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  }

  function formatDuration(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    if (m >= 60) {
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    }
    return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }

  function formatTimestamp(epochMs, baseMs) {
    if (baseMs) {
      var rel = Math.max(0, epochMs - baseMs);
      return formatDuration(rel);
    }
    return new Date(epochMs).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }

  // ─── Timer ─────────────────────────────────────────────────
  function startTimer() {
    stopTimer();
    timerInterval = setInterval(function() {
      if (sessionStartTime) {
        sessionTimerEl.textContent = formatDuration(Date.now() - sessionStartTime);
        if (stageActive) stageTimerEl.textContent = sessionTimerEl.textContent;
      }
    }, 1000);
  }
  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  // ─── Ending watchdog ───────────────────────────────────────
  // Safety net so the UI can never strand on "Ending…". If the server's terminal
  // 'archived' broadcast never arrives within ENDING_WATCHDOG_MS, force the
  // archived view locally. Worker results still stream in via action.status, and
  // any later reconnect re-syncs the real state from the server.
  function armEndingWatchdog() {
    disarmEndingWatchdog();
    endingWatchdog = setTimeout(function() {
      endingWatchdog = null;
      if (sessionState === 'ending') {
        endingMessage = '';
        sessionState = 'archived';
        stopTimer();
        clearAgenda();
        updateUI();
      }
    }, ENDING_WATCHDOG_MS);
  }
  function disarmEndingWatchdog() {
    if (endingWatchdog) { clearTimeout(endingWatchdog); endingWatchdog = null; }
  }

  // ─── Stats ─────────────────────────────────────────────────
  function updateStats() {
    document.getElementById('statSegments').textContent = segments.length;
    document.getElementById('statWords').textContent = totalWords;
    document.getElementById('statYou').textContent = micWords;
    document.getElementById('statMeeting').textContent = meetingWords;
    var elapsed = sessionStartTime ? (Date.now() - sessionStartTime) / 60000 : 1;
    var pace = elapsed > 0.5 ? Math.round(totalWords / elapsed) : 0;
    document.getElementById('statPace').textContent = pace + '/m';
    updateActionStat();
  }

  // Suggestions tile: total cards the copilot has put up this session, with
  // the still-pending count as the secondary figure. Counted off the rendered
  // cards so no extra state has to be kept in sync with the SSE stream.
  function updateActionStat() {
    var el = document.getElementById('statActions');
    if (!el) return;
    // Fact-check flags render as .card too but were never suggestions — the
    // copilot raises them unprompted, so they must not inflate this count.
    var total = resultsEl.querySelectorAll('.card:not(.factflag)').length;
    var pending = resultsEl.querySelectorAll('.card.suggested').length;
    el.innerHTML = total + (pending > 0 ? ' <small>' + pending + ' pending</small>' : '');
  }

  // ─── Intelligence Status ───────────────────────────────────
  var INTEL_PHASE_TEXT = {
    idle: 'Listening',
    evaluating: 'Evaluating recent conversation\\u2026',
    generating: 'Drafting a suggestion\\u2026',
  };

  function setIntelPhase(phase) {
    if (!INTEL_PHASE_TEXT[phase]) phase = 'idle';
    intelStatusEl.className = 'intel-status ' + phase;
    intelStatusTextEl.textContent = INTEL_PHASE_TEXT[phase];
  }

  // ─── Intelligence error badge ──────────────────────────────
  // Realtime failures (triage/suggest/agenda/coach/factcheck/CLI tier) used
  // to vanish into server.log; now they count into a small ⚠ badge next to
  // the status row. A degraded tier pins the badge until recovery.
  var intelErrors = [];
  var intelDegraded = false;
  var intelWarnEl = document.getElementById('intelWarn');
  var intelWarnCountEl = document.getElementById('intelWarnCount');
  var intelPopEl = null;
  var INTEL_ERR_WINDOW_MS = 5 * 60 * 1000;

  function recentIntelErrors() {
    var cutoff = Date.now() - INTEL_ERR_WINDOW_MS;
    return intelErrors.filter(function(e) { return e.at >= cutoff; });
  }

  function refreshIntelWarn() {
    if (!intelWarnEl) return;
    var recent = recentIntelErrors();
    if (intelDegraded || recent.length > 0) {
      intelWarnEl.style.display = '';
      intelWarnEl.className = intelDegraded ? 'intel-warn degraded' : 'intel-warn';
      intelWarnCountEl.textContent = intelDegraded ? 'degraded' : String(recent.length);
    } else {
      intelWarnEl.style.display = 'none';
      hideIntelPop();
    }
  }
  setInterval(refreshIntelWarn, 30000); // decay old errors off the badge

  function noteIntelError(msg) {
    if (msg.recovered) {
      intelDegraded = false;
    } else {
      intelErrors.push({ source: msg.source || 'triage', message: msg.message || 'error', at: msg.at || Date.now() });
      if (intelErrors.length > 20) intelErrors.shift();
      if (msg.degraded) intelDegraded = true;
    }
    refreshIntelWarn();
  }

  function hideIntelPop() {
    if (intelPopEl) { intelPopEl.remove(); intelPopEl = null; }
  }

  if (intelWarnEl) intelWarnEl.onclick = function(e) {
    e.stopPropagation();
    if (intelPopEl) { hideIntelPop(); return; }
    var recent = recentIntelErrors().slice(-5).reverse();
    intelPopEl = document.createElement('div');
    intelPopEl.className = 'intel-pop';
    if (recent.length === 0) {
      intelPopEl.textContent = intelDegraded
        ? 'A triage tier is degraded \\u2014 suggestions still flow via the fallback model.'
        : 'No recent errors.';
    } else {
      recent.forEach(function(err) {
        var row = document.createElement('div');
        row.className = 'pop-row';
        var src = document.createElement('span');
        src.className = 'pop-src';
        src.textContent = err.source;
        var ago = Math.max(0, Math.round((Date.now() - err.at) / 1000));
        var txt = document.createElement('span');
        txt.textContent = err.message + ' (' + (ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm') + ' ago)';
        row.appendChild(src);
        row.appendChild(txt);
        intelPopEl.appendChild(row);
      });
    }
    var rect = intelWarnEl.getBoundingClientRect();
    intelPopEl.style.left = Math.max(8, rect.left - 40) + 'px';
    intelPopEl.style.top = (rect.bottom + 6) + 'px';
    document.body.appendChild(intelPopEl);
    var onDocDown = function(ev) {
      if (intelPopEl && !intelPopEl.contains(ev.target) && ev.target !== intelWarnEl) {
        hideIntelPop();
        document.removeEventListener('mousedown', onDocDown);
      }
    };
    document.addEventListener('mousedown', onDocDown);
  };

  // ─── UI State Transitions ─────────────────────────────────
  function updateUI() {
    // State pill
    statePill.className = 'state-pill ' + sessionState;
    statePill.textContent = sessionState.charAt(0).toUpperCase() + sessionState.slice(1);

    // The live-edge caret is a claim that transcription is still flowing —
    // retract it the moment the session stops being live.
    if (sessionState !== 'live') clearLatestSegment();
    if (stageActive) stageSyncState();

    // Wrap-up progress hint (only while ending, and only if the server sent one)
    if (endingHintEl) {
      if (sessionState === 'ending' && endingMessage) {
        endingHintEl.textContent = endingMessage;
        endingHintEl.style.display = '';
      } else {
        endingHintEl.style.display = 'none';
      }
    }

    // Show REC indicator while a session is live or degraded
    var audioIndicator = document.getElementById('audioIndicator');
    if (audioIndicator) {
      var recActive = (sessionState === 'live' || sessionState === 'degraded') && !isReplay;
      audioIndicator.className = 'audio-indicator' + (recActive ? ' visible' : '');
    }

    // Header title
    headerTitle.textContent = sessionTitle || '';

    // Start/Stop button + New Meeting button
    if (!isReplay) {
      if (sessionState === 'archived') {
        // After a session ends, the setup form is no longer in the DOM, so the
        // header Start would launch a session with empty metadata. Hide it and
        // show "← New Meeting" instead, which resets back to the idle setup screen.
        startStopBtn.style.display = 'none';
        newMeetingBtn.style.display = '';
      } else {
        newMeetingBtn.style.display = 'none';
        startStopBtn.style.display = '';
        if (sessionState === 'live' || sessionState === 'degraded') {
          startStopBtn.textContent = 'Stop';
          startStopBtn.className = 'btn btn-red';
          startStopBtn.disabled = false;
        } else if (sessionState === 'ending') {
          startStopBtn.textContent = 'Ending…';
          startStopBtn.className = 'btn btn-ghost';
          startStopBtn.disabled = true;
        } else {
          startStopBtn.textContent = 'Start';
          startStopBtn.className = 'btn btn-green';
          startStopBtn.disabled = false;
        }
      }
    }

    // Stats bar
    var showStats = sessionState === 'live' || sessionState === 'degraded' || isReplay;
    statsBar.className = 'stats-bar' + (showStats ? ' visible' : '');

    // Layout columns
    var showCols = sessionState !== 'idle' || isReplay;
    layout.className = 'layout' + (showCols ? ' three-col' : '');

    // Idle overlay
    if (sessionState === 'idle' && !isReplay) {
      showIdleState();
    } else {
      idleOverlay.innerHTML = '';
    }

    // Quick actions
    if ((sessionState === 'live' || sessionState === 'degraded') && !isReplay) {
      showQuickActions();
    } else {
      quickActionsSlot.innerHTML = '';
    }

    // Intelligence status row + transcript order chip — live sessions only
    var showIntel = (sessionState === 'live' || sessionState === 'degraded') && !isReplay;
    intelStatusEl.style.display = showIntel ? '' : 'none';
    if (!showIntel) {
      setIntelPhase('idle');
      // A "say next" tip is meaningless once the meeting is over.
      if (window.dismissCoach) window.dismissCoach();
    }
    if (transcriptOrderEl) transcriptOrderEl.style.display = (showCols && !isReplay) ? '' : 'none';
  }
  window.updateUI = updateUI;

  // Briefly flash the REC indicator to show audio is actively being transcribed.
  function flashAudioIndicator() {
    var dot = document.getElementById('audioDot');
    if (!dot) return;
    dot.classList.remove('flash');
    // Force reflow so the animation can restart on rapid chunks
    void dot.offsetWidth;
    dot.classList.add('flash');
  }

  // ─── Upcoming-Meeting Auto-fill (cxmail invites) ──────────
  // GET /calendar/upcoming reads cxmail's local invite DB. One click
  // prefills the start form from the event; the invite description goes
  // through the normal agenda-extract path (CLI/subscription, click-only).
  var upcomingMeetings = [];
  var appliedMeetingUid = null;

  function refreshCalendarChips() {
    var host = document.getElementById('calChips');
    if (!host || isReplay) return;
    fetch('/calendar/upcoming').then(function(r) {
      return r.json();
    }).then(function(data) {
      upcomingMeetings = (data && data.meetings) || [];
      renderCalendarChips();
    }).catch(function() {
      upcomingMeetings = [];
      renderCalendarChips();
    });
  }

  function formatMeetingTime(iso) {
    var d = new Date(iso);
    var now = new Date();
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'Today ' + time;
    if (d.toDateString() === new Date(now.getTime() + 86400000).toDateString()) return 'Tomorrow ' + time;
    return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  }

  function renderCalendarChips() {
    var host = document.getElementById('calChips');
    if (!host) return;
    if (!upcomingMeetings.length) { host.innerHTML = ''; return; }

    var html = '<div class="cal-chips"><span class="cal-chips-label">Upcoming on your calendar</span>';
    var count = Math.min(upcomingMeetings.length, 3);
    for (var i = 0; i < count; i++) {
      var m = upcomingMeetings[i];
      var startMs = Date.parse(m.startsAt);
      // "soon" = starts within 10 min (or already started, within lookback)
      var soon = startMs - Date.now() < 10 * 60 * 1000;
      var applied = appliedMeetingUid !== null && appliedMeetingUid === (m.eventUid || m.title);
      var cls = 'cal-chip' + (soon ? ' soon' : '') + (applied ? ' applied' : '');
      html += '<button type="button" class="' + cls + '" onclick="applyCalendarMeeting(' + i + ')">' +
        '<span aria-hidden="true">\\uD83D\\uDCC5</span>' +
        '<span class="cal-chip-title">' + escapeHtml(m.title) + '</span>' +
        '<span class="cal-chip-time">' + escapeHtml(formatMeetingTime(m.startsAt)) + '</span>' +
        '<span class="cal-chip-fill">' + (applied ? 'Filled' : 'Auto-fill') + '</span>' +
      '</button>';
    }
    html += '</div>';
    host.innerHTML = html;
  }

  window.applyCalendarMeeting = function(i) {
    var m = upcomingMeetings[i];
    if (!m) return;

    var titleInput = document.getElementById('startTitle');
    if (titleInput) titleInput.value = m.title;

    var attendeesInput = document.getElementById('startAttendees');
    if (attendeesInput && m.attendees && m.attendees.length) {
      attendeesInput.value = m.attendees.map(function(a) { return a.name; }).join(', ');
    }

    // Invite description → agenda notes → the normal extract flow. Skip
    // when empty (many invites are just a Meet link).
    if (m.description && m.description.trim()) {
      agendaRawSnapshot = m.description.trim();
      setAgendaState({ kind: 'raw' });
      window.extractAgendaFromNotes();
    }

    appliedMeetingUid = m.eventUid || m.title;
    renderCalendarChips();
    showToast('Prefilled from \\u201C' + m.title + '\\u201D');
  };

  function showIdleState() {
    var wsConnected = ws && ws.readyState === WebSocket.OPEN;
    var btnDisabled = wsConnected ? '' : ' disabled';
    var statusMsg = wsConnected ? '' : '<p style="color:var(--gb-red);font-size:11px;margin-top:8px">Connecting to server...</p>';

    // Build project checkboxes
    var projectsHtml = '';
    if (availableProjects.length > 0) {
      projectsHtml = '<label>Projects <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>' +
        '<div class="proj-grid">';
      availableProjects.forEach(function(p) {
        var badge = p.category === 'xcode' ? ' <span class="proj-badge ios">iOS</span>' : '';
        projectsHtml += '<label class="proj-item">' +
          '<input type="checkbox" class="proj-cb" value="' + escapeHtml(p.name) + '">' +
          '<span class="proj-name">' + escapeHtml(p.name) + '</span>' + badge +
        '</label>';
      });
      projectsHtml += '</div>';
    }

    // Context sources section — always visible with add/remove UI
    var contextHtml = '<div class="ctx-section">' +
      '<label>Context Files &amp; Folders <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>' +
      '<div id="ctxContainer"></div>' +
    '</div>';

    idleOverlay.innerHTML = '<div class="idle-overlay"><div class="idle-card" style="max-width:500px">' +
      '<h2>No Active Meeting</h2>' +
      '<p>Start a session to begin capturing and analyzing your meeting.</p>' +
      '<div id="calChips"></div>' +
      '<div class="idle-form">' +
        '<label>Title</label><input id="startTitle" placeholder="Weekly sync, 1:1, etc.">' +
        '<label>Agenda <span style="font-weight:400;text-transform:none;letter-spacing:0">(tracked live)</span></label>' +
        '<div id="agendaEditor"></div>' +
        '<label>Attendees</label><input id="startAttendees" placeholder="Chris, Alex, Sam">' +
        '<label>Your Goals <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional · private, coach only)</span></label>' +
        '<textarea id="startGoals" rows="2" placeholder="What do you want out of this meeting? Positions, asks, red lines…"></textarea>' +
        projectsHtml +
        contextHtml +
      '</div>' +
      // Consent affirmation (architecture invariant #3: consent per session).
      // Resets with every fresh form; Start stays disabled until checked.
      '<label class="consent-row"><input type="checkbox" id="consentCheck" onchange="refreshStartButton()"> ' +
        'I\\u2019ve informed participants this meeting uses an AI copilot</label>' +
      '<div class="idle-actions">' +
        '<button class="btn btn-green" id="startBtn" onclick="startSession()" disabled>Start Session</button>' +
      '</div>' +
      statusMsg +
      '<span class="sessions-link" onclick="showSessionHistory()">View Past Sessions</span>' +
    '</div></div>';

    // Populate context list and agenda editor after DOM is built
    renderContextList();
    renderAgendaEditor();
    refreshCalendarChips();
  }

  function showQuickActions() {
    quickActionsSlot.innerHTML = '<div class="quick-actions">' +
      '<div class="qa-title-row">' +
        '<div class="quick-actions-title">Quick Actions</div>' +
        '<div class="monitor-toggles">' +
          '<button class="monitor-toggle' + (featureState.factcheck ? ' on' : '') + '" onclick="toggleFeature(\\'factcheck\\')" title="Live fact-checking of claims \u2014 extra API cost while on">Fact-check: ' + (featureState.factcheck ? 'On' : 'Off') + '</button>' +
          '<button class="monitor-toggle' + (featureState.coach ? ' on' : '') + '" onclick="toggleFeature(\\'coach\\')" title="Real-time recovery advice for pressure, objections, and weak answers">Coach: ' + (featureState.coach ? 'On' : 'Off') + '</button>' +
        '</div>' +
      '</div>' +
      '<input class="quick-actions-input" id="quickPrompt" placeholder="Topic or prompt (optional)...">' +
      '<div class="quick-actions-row">' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'fast-research\\')" title="Haiku, streaming">\u26A1 Fast</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'research\\')">Research</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'summary\\')">Summary</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'analysis\\')">Analysis</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'mockup\\')" title="UI wireframe from the discussion (type a screen in the box first)">Mockup</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'codegen\\')" title="Generate code from the discussion">Code</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'review\\')" title="Self-review: how you did so far">Review</button>' +
      '</div>' +
    '</div>';
  }

  // Re-render the quick actions card (e.g., after a feature.state broadcast)
  // without losing whatever the user typed in the prompt box.
  function refreshQuickActions() {
    if (!((sessionState === 'live' || sessionState === 'degraded') && !isReplay)) return;
    var input = document.getElementById('quickPrompt');
    var saved = input ? input.value : '';
    showQuickActions();
    var fresh = document.getElementById('quickPrompt');
    if (fresh && saved) fresh.value = saved;
  }

  window.toggleFeature = function(name) {
    if (name !== 'factcheck' && name !== 'coach') return;
    wsSend({ type: 'feature.toggle', feature: name, enabled: !featureState[name] });
  };

  // ─── Session Controls ─────────────────────────────────────
  window.newMeeting = function() {
    // Reset client-side state from archived → idle so the setup form re-renders.
    // Server is already idle/archived; the next session.start will move it forward.
    disarmEndingWatchdog();
    endingMessage = '';
    sessionState = 'idle';
    sessionTitle = '';
    sessionStartTime = null;
    actionCards.clear();
    factFlagCards.clear();
    window.dismissCoach();
    resultsEl.innerHTML = '';
    tocEntries.innerHTML = '';
    transcriptFeed.innerHTML = '';
    segments = [];
    segById.clear();
    totalWords = 0; micWords = 0; meetingWords = 0;
    segCountEl.textContent = '0';
    sessionTimerEl.textContent = '';
    clearAgenda();
    updateUI();
  };

  // When running inside the Meeting Copilot app, WKWebView injects
  // window.__copilotNativeBridge so session start/stop routes through the
  // Swift SessionManager (which wires up audio capture). Outside the app
  // (plain browser for debugging), we fall back to direct WebSocket messages.
  function hasNativeBridge() {
    return typeof window.__copilotNativeBridge !== 'undefined';
  }

  // Called by Swift when a native error occurs (e.g., missing Screen Recording
  // permission). Renders as a persistent banner the user can dismiss.
  window.__copilotShowNativeError = function(message) {
    var existing = document.getElementById('nativeErrorBanner');
    if (existing) existing.remove();
    var banner = document.createElement('div');
    banner.id = 'nativeErrorBanner';
    banner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
      'z-index:9999;background:var(--gb-red,#cc241d);color:#fff;padding:12px 18px;' +
      'border-radius:6px;font-family:inherit;font-size:12px;max-width:620px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.2);line-height:1.5;';
    var close = document.createElement('span');
    close.textContent = '\u00d7';
    close.style.cssText = 'float:right;margin-left:14px;cursor:pointer;font-weight:700;font-size:14px;';
    close.onclick = function() { banner.remove(); };
    banner.appendChild(close);
    var text = document.createElement('span');
    text.textContent = message;
    banner.appendChild(text);
    document.body.appendChild(banner);
  };

  window.toggleSession = function() {
    if (sessionState === 'live' || sessionState === 'degraded') {
      // Send FIRST (browser path) — if the socket is down the stop never
      // reached the server, so flipping to "ending" would be a lie.
      if (hasNativeBridge()) {
        window.__copilotNativeBridge.stopSession();
      } else if (!wsSend({ type: 'session.stop' })) {
        showToast('Not connected \\u2014 could not end the session. Try again in a moment.', { error: true });
        return;
      }
      // Optimistic UI: the server may take several seconds to finish stopping
      // (auto-summary, action completion, etc.) before it broadcasts
      // session.state=archived. Flip to "ending" immediately so the user
      // sees their click register; the authoritative broadcast will settle
      // the final state when the server catches up.
      sessionState = 'ending';
      endingMessage = 'Wrapping up — generating summary & self-review…';
      // Arm the safety watchdog immediately on the optimistic flip — even if the
      // server's authoritative 'ending'/'archived' broadcasts never arrive, the
      // UI will recover instead of stranding on "Ending…".
      armEndingWatchdog();
      // Freeze the displayed duration at end-press. The server may take
      // many seconds (auto-summary + up to 60s worker grace period) before
      // it broadcasts session.state=archived, and the meeting is logically
      // over the moment the user clicks End.
      stopTimer();
      updateUI();
    } else {
      // Start with values from form if available, otherwise empty
      startSession();
    }
  };

  window.startSession = function() {
    // Block start while an extraction is in flight — Start Session must not
    // race against an about-to-settle extract.
    if (agendaState.kind === 'extracting') return;

    // Consent affirmation is required per session (invariant #3). The button
    // should already be disabled, but guard the programmatic path too.
    var consentEl = document.getElementById('consentCheck');
    if (consentEl && !consentEl.checked) {
      showToast('Confirm the consent checkbox to start the session.', { error: true });
      return;
    }

    var title = (document.getElementById('startTitle') || {}).value || '';
    var agenda = collectAgendaString();
    var attendees = (document.getElementById('startAttendees') || {}).value || '';
    // Goals ride a separate meeting.goals message once the session is live, so
    // the same path works whether start goes through the native bridge or WS.
    pendingGoals = ((document.getElementById('startGoals') || {}).value || '').trim();

    // Collect selected projects
    var selectedProjects = [];
    document.querySelectorAll('.proj-cb:checked').forEach(function(cb) {
      selectedProjects.push(cb.value);
    });

    // Collect selected context paths
    var selectedContextPaths = [];
    document.querySelectorAll('.ctx-cb:checked').forEach(function(cb) {
      selectedContextPaths.push(cb.value);
    });

    if (hasNativeBridge()) {
      window.__copilotNativeBridge.startSession({
        title: title,
        agenda: agenda,
        attendees: attendees,
        projectNames: selectedProjects,
        contextPaths: selectedContextPaths,
        consent: consentEl ? consentEl.checked : true,
      });
      return;
    }

    // Browser-only fallback (no audio capture — for dashboard debugging)
    var msg = {
      type: 'session.start',
      title: title || undefined,
      agenda: agenda || undefined,
      attendees: attendees || undefined,
      projectNames: selectedProjects.length ? selectedProjects : undefined,
      contextPaths: selectedContextPaths.length ? selectedContextPaths : undefined,
    };
    wsSend(msg);
  };

  // ─── Toasts ───────────────────────────────────────────────
  function showToast(message, opts) {
    opts = opts || {};
    var duration = opts.duration || 4000;
    var t = document.createElement('div');
    t.className = opts.error ? 'toast toast-error' : 'toast';

    var msgEl = document.createElement('span');
    msgEl.className = 'toast-msg';
    msgEl.textContent = message;
    t.appendChild(msgEl);

    var removed = false;
    function removeToast() {
      if (removed) return;
      removed = true;
      t.remove();
    }

    if (opts.onUndo) {
      var undoBtn = document.createElement('button');
      undoBtn.className = 'toast-undo';
      undoBtn.textContent = 'Undo';
      undoBtn.onclick = function() { opts.onUndo(); removeToast(); };
      t.appendChild(undoBtn);
    }

    var closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '\\u00d7';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.onclick = removeToast;
    t.appendChild(closeBtn);

    var bar = document.createElement('span');
    bar.className = 'toast-bar';
    bar.style.animation = 'drain ' + duration + 'ms linear forwards';
    t.appendChild(bar);

    toastStackEl.appendChild(t);
    setTimeout(removeToast, duration);
    return removeToast;
  }

  var ACTION_LABELS = { 'fast-research': 'Fast research', research: 'Research', summary: 'Summary', analysis: 'Analysis', review: 'Self-review' };

  window.triggerAction = function(type) {
    var promptEl = document.getElementById('quickPrompt');
    var prompt = (promptEl || {}).value || '';
    if (!wsSend({ type: 'action.trigger', actionType: type, prompt: prompt || undefined })) {
      // Keep the prompt text so the user can retry without retyping.
      showToast('Not connected \\u2014 could not queue ' + (ACTION_LABELS[type] || type) + '. Try again in a moment.', { error: true });
      return;
    }
    if (promptEl) promptEl.value = '';
    showToast((ACTION_LABELS[type] || type) + ' queued');
  };

  // ─── Optimistic card feedback ──────────────────────────────
  // Approve/Cancel disable the card's buttons and show a busy label until the
  // server echoes an action.status for that id. If no echo arrives (server
  // silently dropped it, or the socket died right after send), revert and say
  // so — never leave the user believing a click worked when it didn't.
  var OPTIMISTIC_REVERT_MS = 6000;
  var optimisticCards = new Map(); // actionId -> { timer }

  function clearOptimistic(id) {
    var entry = optimisticCards.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    optimisticCards.delete(id);
    var card = actionCards.get(id);
    if (card) delete card.dataset.optimistic;
  }

  function markOptimistic(id, kind, busySelector, busyLabel) {
    var card = actionCards.get(id);
    if (!card) return;
    card.dataset.optimistic = kind;
    var touched = [];
    card.querySelectorAll('.card-actions .btn').forEach(function(b) {
      touched.push({ btn: b, text: b.textContent });
      b.disabled = true;
    });
    var busyBtn = card.querySelector('.card-actions ' + busySelector);
    if (busyBtn) busyBtn.textContent = busyLabel;
    var timer = setTimeout(function() {
      optimisticCards.delete(id);
      if (card.dataset.optimistic !== kind) return;
      delete card.dataset.optimistic;
      touched.forEach(function(t) { t.btn.disabled = false; t.btn.textContent = t.text; });
      showToast('No response from server \\u2014 try again', { error: true });
    }, OPTIMISTIC_REVERT_MS);
    optimisticCards.set(id, { timer: timer });
  }

  window.approveAction = function(id) {
    var card = actionCards.get(id);
    if (card && card.dataset.optimistic) return; // click already in flight
    if (!wsSend({ type: 'action.approve', actionId: id })) {
      showToast('Not connected \\u2014 approve did not go through. Try again in a moment.', { error: true });
      return;
    }
    markOptimistic(id, 'approve', '.btn-green', 'Approving\\u2026');
  };

  // Dismissal is irreversible once the server hears about it, so hide the
  // card locally first and only send action.dismiss after the undo window.
  var DISMISS_UNDO_MS = 5000;
  var pendingDismissals = new Map(); // actionId -> { timer }

  window.dismissAction = function(id) {
    stageClearSuggestion(id);
    var card = actionCards.get(id);
    if (!card || pendingDismissals.has(id)) {
      if (!card) wsSend({ type: 'action.dismiss', actionId: id });
      return;
    }
    var titleEl = card.querySelector('.card-title');
    var label = titleEl ? titleEl.textContent : 'suggestion';

    card.classList.add('fade-out');
    setTimeout(function() {
      if (pendingDismissals.has(id)) card.style.display = 'none';
    }, 350);

    var timer = setTimeout(function() {
      pendingDismissals.delete(id);
      if (!wsSend({ type: 'action.dismiss', actionId: id })) {
        // Server never heard the dismiss — restore the card instead of
        // silently desyncing (it would reappear on reload anyway).
        card.style.display = '';
        card.classList.remove('fade-out');
        showToast('Not connected \\u2014 dismiss did not go through; suggestion restored.', { error: true });
        return;
      }
      card.remove();
      actionCards.delete(id);
      rebuildToc();
    }, DISMISS_UNDO_MS);
    pendingDismissals.set(id, { timer: timer });

    showToast('Dismissed \\u201C' + label + '\\u201D', {
      duration: DISMISS_UNDO_MS,
      onUndo: function() {
        var pending = pendingDismissals.get(id);
        if (!pending) return; // already finalized or expired server-side
        clearTimeout(pending.timer);
        pendingDismissals.delete(id);
        card.style.display = '';
        card.classList.remove('fade-out');
      },
    });
  };

  window.cancelAction = function(id) {
    var card = actionCards.get(id);
    if (card && card.dataset.optimistic) return; // click already in flight
    if (!wsSend({ type: 'action.cancel', actionId: id })) {
      showToast('Not connected \\u2014 cancel did not go through. Try again in a moment.', { error: true });
      return;
    }
    markOptimistic(id, 'cancel', '.btn-ghost-red', 'Cancelling\\u2026');
  };

  // ─── Mockup ASCII/HTML toggle + open/download ──────────────
  // Escape a full HTML document for use inside an iframe srcdoc="" attribute.
  function escapeSrcdoc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

  window.toggleMockupView = function(id, which, btn) {
    var card = document.getElementById('action-' + id);
    if (!card) return;
    card.querySelectorAll('.mockup-pane').forEach(function(p) {
      p.style.display = (p.dataset.pane === which) ? '' : 'none';
    });
    btn.parentNode.querySelectorAll('button[data-view]').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
  };

  window.openMockupHtml = function(id) {
    var html = mockupHtml.get(id);
    if (!html) return;
    var url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank');
    setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
  };

  window.downloadMockupHtml = function(id) {
    var html = mockupHtml.get(id);
    if (!html) return;
    var url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'mockup-' + String(id).slice(0, 8) + '.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  };

  // ─── Highlight-to-Ask (transcript selection) ──────────────
  // Highlight transcript text → right-click → Fact check / Explain / Custom
  // prompt. Opens a floating panel anchored to the selection that streams
  // the answer from POST /present/ask. Same interaction as ask-widget.
  var askSel = null;
  var askAbort = null;
  var askMenuEl, askMenuInputRow, askMenuInput;
  var askPanelEl, askPanelEyebrow, askPanelQuote, askPanelBody;
  var ASK_LABELS = { factcheck: 'Fact check', explain: 'Explain', custom: 'Your question', summarize: 'Summarize' };

  // Card-level right-click menu (Summarize / Custom prompt / Mockup). Distinct
  // from the transcript ask menu above; shares the .askmenu styles + ask panel.
  var cardSel = null; // { el, actionId, title, text, context, rect, isMock, baseWireframe, baseHtml }
  var cardMenuEl, cardMenuInput, cardMenuInputRow, cardMenuMode;
  var cardMenuCustom, cardMenuMockup;

  function buildAskUi() {
    askMenuEl = document.createElement('div');
    askMenuEl.className = 'askmenu';
    [
      { mode: 'factcheck', ico: '\\u2713', label: 'Fact check' },
      { mode: 'explain', ico: '?', label: 'Explain' },
    ].forEach(function(it) {
      var d = document.createElement('div');
      d.className = 'askmenu-item';
      d.innerHTML = '<span class="askmenu-ico">' + it.ico + '</span>' + it.label;
      d.addEventListener('click', function() { startAsk(it.mode, ''); });
      askMenuEl.appendChild(d);
    });
    var custom = document.createElement('div');
    custom.className = 'askmenu-item';
    custom.innerHTML = '<span class="askmenu-ico">\\u2026</span>Custom prompt\\u2026';
    custom.addEventListener('click', function() {
      askMenuInputRow.classList.add('open');
      askMenuInput.focus();
    });
    askMenuEl.appendChild(custom);

    askMenuInputRow = document.createElement('div');
    askMenuInputRow.className = 'askmenu-input-row';
    askMenuInput = document.createElement('textarea');
    askMenuInput.rows = 2;
    askMenuInput.placeholder = 'Ask about the highlighted text\\u2026';
    askMenuInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitCustomAsk(); }
      if (e.key === 'Escape') hideAskMenu();
      e.stopPropagation();
    });
    var go = document.createElement('button');
    go.className = 'btn btn-green';
    go.textContent = 'Go';
    go.addEventListener('click', submitCustomAsk);
    askMenuInputRow.appendChild(askMenuInput);
    askMenuInputRow.appendChild(go);
    askMenuEl.appendChild(askMenuInputRow);
    document.body.appendChild(askMenuEl);

    askPanelEl = document.createElement('div');
    askPanelEl.className = 'askpanel';
    askPanelEl.innerHTML = '<div class="askpanel-head">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="askpanel-eyebrow"></div>' +
          '<div class="askpanel-quote"></div>' +
        '</div>' +
        '<button class="askpanel-x" title="Close">\\u00d7</button>' +
      '</div>' +
      '<div class="card-body askpanel-body"></div>' +
      '<div class="askpanel-foot"><button class="btn btn-ghost askpanel-copy">Copy</button></div>';
    askPanelEyebrow = askPanelEl.querySelector('.askpanel-eyebrow');
    askPanelQuote = askPanelEl.querySelector('.askpanel-quote');
    askPanelBody = askPanelEl.querySelector('.askpanel-body');
    askPanelEl.querySelector('.askpanel-x').addEventListener('click', closeAskPanel);
    askPanelEl.querySelector('.askpanel-copy').addEventListener('click', function() {
      var t = askPanelBody.innerText || '';
      if (navigator.clipboard && t) {
        navigator.clipboard.writeText(t).then(function() { showToast('Copied to clipboard'); }).catch(function() {});
      }
    });
    makeAskDragResize(askPanelEl, askPanelEl.querySelector('.askpanel-head'));
    document.body.appendChild(askPanelEl);
  }

  // Drag the panel by its header; resize from the corner (CSS resize:both).
  // Either gesture "pins" it so auto-positioning stops fighting the user —
  // same behavior as ask-widget's makeDragResize.
  var askPinned = false;
  function makeAskDragResize(panel, handle) {
    handle.addEventListener('mousedown', function(e) {
      if (e.target.closest('.askpanel-x')) return; // close button isn't a drag grip
      e.preventDefault();
      askPinned = true;
      panel.classList.add('pinned');
      var startX = e.clientX, startY = e.clientY;
      var rect = panel.getBoundingClientRect();
      // Freeze the current auto height so dragging doesn't reflow it.
      panel.style.height = rect.height + 'px';
      function mv(ev) {
        panel.style.left = Math.max(0, rect.left + ev.clientX - startX) + 'px';
        panel.style.top = Math.max(0, rect.top + ev.clientY - startY) + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    // A grab on the bottom-right resize corner also pins.
    panel.addEventListener('mousedown', function(e) {
      var r = panel.getBoundingClientRect();
      if (e.clientX > r.right - 22 && e.clientY > r.bottom - 22) {
        askPinned = true;
        panel.classList.add('pinned');
      }
    });
  }

  function captureTranscriptSelection() {
    var s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0) return null;
    var text = s.toString().replace(/\\s+/g, ' ').trim();
    if (!text) return null;
    var range = s.getRangeAt(0);
    var node = range.commonAncestorContainer;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node || !transcriptFeed.contains(node)) return null;
    // Context: the selected segment row plus its DOM neighbors. Feed is
    // newest-first in live mode, but ordering barely matters for an LLM
    // context blob.
    var seg = node.closest ? node.closest('.seg') : null;
    var ctxParts = [];
    if (seg) {
      [seg.previousElementSibling, seg, seg.nextElementSibling].forEach(function(el) {
        if (el && el.classList && el.classList.contains('seg')) {
          var t = el.querySelector('.seg-text');
          if (t) ctxParts.push(t.textContent);
        }
      });
    }
    return {
      text: text.slice(0, 1500),
      context: ctxParts.join('\\n').slice(0, 4000),
      rect: range.getBoundingClientRect(),
    };
  }

  function showAskMenu(x, y) {
    askMenuInputRow.classList.remove('open');
    askMenuInput.value = '';
    askMenuEl.style.display = 'block';
    var mw = askMenuEl.offsetWidth || 190;
    var mh = askMenuEl.offsetHeight || 120;
    askMenuEl.style.left = Math.max(6, Math.min(x, window.innerWidth - mw - 8)) + 'px';
    askMenuEl.style.top = Math.max(6, Math.min(y, window.innerHeight - mh - 8)) + 'px';
  }
  function hideAskMenu() { if (askMenuEl) askMenuEl.style.display = 'none'; }

  function submitCustomAsk() {
    var q = askMenuInput.value.trim();
    if (!q) return;
    startAsk('custom', q);
  }

  function positionAskPanel() {
    if (askPinned) return; // user placed it — leave it alone
    if (!askSel || !askSel.rect) return;
    var m = 12, vw = window.innerWidth, vh = window.innerHeight;
    var w = askPanelEl.offsetWidth || 400;
    var h = askPanelEl.offsetHeight || 220;
    var left = askSel.rect.left + askSel.rect.width / 2 - w / 2;
    left = Math.max(m, Math.min(left, vw - w - m));
    var top = askSel.rect.bottom + 8;
    if (top + h > vh - m) top = Math.max(m, askSel.rect.top - 8 - h);
    askPanelEl.style.left = left + 'px';
    askPanelEl.style.top = Math.max(m, Math.min(top, vh - h - m)) + 'px';
  }

  function closeAskPanel() {
    askPanelEl.classList.remove('open');
    if (askAbort) { askAbort.abort(); askAbort = null; }
  }

  function startAsk(mode, question) {
    hideAskMenu();
    if (!askSel) return;
    if (askAbort) askAbort.abort();
    askAbort = new AbortController();
    var myAbort = askAbort;

    askPanelEyebrow.textContent = mode === 'custom' ? question : ASK_LABELS[mode];
    askPanelQuote.textContent = '\\u201C' + askSel.text.slice(0, 160) + (askSel.text.length > 160 ? '\\u2026' : '') + '\\u201D';
    askPanelBody.innerHTML = '<p style="color:var(--gb-overlay2)"><span class="spinner"></span>' +
      (mode === 'factcheck' ? 'Checking\\u2026' : 'Thinking\\u2026') + '</p>';
    askPanelEl.classList.add('open');
    positionAskPanel();

    var acc = '';
    fetch('/present/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode, selection: askSel.text, context: askSel.context, question: question || '' }),
      signal: myAbort.signal,
    }).then(function(resp) {
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function pump() {
        return reader.read().then(function(r) {
          if (r.done) return;
          buffer += decoder.decode(r.value, { stream: true });
          var lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          var evt = '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('event: ') === 0) {
              evt = line.slice(7).trim();
            } else if (line.indexOf('data: ') === 0 && evt) {
              var data;
              try { data = JSON.parse(line.slice(6)); } catch (e) { evt = ''; continue; }
              if (evt === 'token') {
                acc += data.text;
                askPanelBody.innerHTML = renderMarkdown(acc);
                askPanelBody.scrollTop = askPanelBody.scrollHeight;
              } else if (evt === 'error') {
                askPanelBody.innerHTML = '<p style="color:var(--gb-red)">' + escapeHtml(data.message || 'Something went wrong.') + '</p>';
                acc = '';
              }
              evt = '';
            }
          }
          return pump();
        });
      }
      return pump();
    }).then(function() {
      highlightCode();
      positionAskPanel();
    }).catch(function(err) {
      if (err && err.name === 'AbortError') return;
      askPanelBody.innerHTML = '<p style="color:var(--gb-red)">Could not reach the server: ' + escapeHtml(String((err && err.message) || err)) + '</p>';
    });
  }

  // ─── Card right-click menu (Summarize / Custom / Mockup) ───
  // Mirrors the ask widget: right-click a result card with no text selected to
  // act on the WHOLE card. Highlighting text inside a card instead opens the
  // same ask menu the transcript uses (handled in the resultsEl listener below).
  function buildCardMenu() {
    cardMenuEl = document.createElement('div');
    cardMenuEl.className = 'askmenu';

    var summarize = document.createElement('div');
    summarize.className = 'askmenu-item';
    summarize.innerHTML = '<span class="askmenu-ico">\\u2261</span>Summarize';
    summarize.addEventListener('click', function() { startCardPanelAsk('summarize', ''); });
    cardMenuEl.appendChild(summarize);

    cardMenuCustom = document.createElement('div');
    cardMenuCustom.className = 'askmenu-item';
    cardMenuCustom.addEventListener('click', function() { openCardInput('custom'); });
    cardMenuEl.appendChild(cardMenuCustom);

    cardMenuMockup = document.createElement('div');
    cardMenuMockup.className = 'askmenu-item';
    cardMenuMockup.innerHTML = '<span class="askmenu-ico">\\u25A5</span>Mockup\\u2026';
    cardMenuMockup.addEventListener('click', function() { openCardInput('mockup'); });
    cardMenuEl.appendChild(cardMenuMockup);

    cardMenuInputRow = document.createElement('div');
    cardMenuInputRow.className = 'askmenu-input-row';
    cardMenuInput = document.createElement('textarea');
    cardMenuInput.rows = 2;
    cardMenuInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitCardInput(); }
      if (e.key === 'Escape') hideCardMenu();
      e.stopPropagation();
    });
    var go = document.createElement('button');
    go.className = 'btn btn-green';
    go.textContent = 'Go';
    go.addEventListener('click', submitCardInput);
    cardMenuInputRow.appendChild(cardMenuInput);
    cardMenuInputRow.appendChild(go);
    cardMenuEl.appendChild(cardMenuInputRow);
    document.body.appendChild(cardMenuEl);
  }

  // Snapshot the card under the cursor: its text (title + body), whether it's a
  // mockup, and — if so — the base wireframe/HTML to revise.
  function buildCardSel(cardEl) {
    var actionId = (cardEl.id || '').replace('action-', '');
    var titleEl = cardEl.querySelector('.card-title');
    var bodyEl = cardEl.querySelector('.card-body');
    var title = titleEl ? (titleEl.innerText || '') : '';
    var bodyText = bodyEl ? (bodyEl.innerText || '') : '';
    var text = (title + (bodyText ? '\\n\\n' + bodyText : '')).trim().slice(0, 6000);
    var isMock = !!cardEl.querySelector('.mockup-pane');
    var baseWireframe = '', baseHtml = '';
    if (isMock) {
      var asciiEl = cardEl.querySelector('.mockup-pane[data-pane="ascii"] code');
      if (asciiEl) baseWireframe = (asciiEl.innerText || '').slice(0, 8000);
      baseHtml = (mockupHtml.get(actionId) || '').slice(0, 16000);
    }
    return {
      el: cardEl, actionId: actionId, title: title,
      text: text || title || 'this card',
      context: text,
      rect: cardEl.getBoundingClientRect(),
      isMock: isMock, baseWireframe: baseWireframe, baseHtml: baseHtml,
    };
  }

  function showCardMenu(x, y) {
    cardMenuInputRow.classList.remove('open');
    cardMenuInput.value = '';
    cardMenuMode = null;
    var mockLive = cardSel && cardSel.isMock && !isReplay;
    // On a live mock card, "Custom prompt" revises the mock into a new card
    // (per request); otherwise it's a plain ask-about-this-card.
    cardMenuCustom.innerHTML = mockLive
      ? '<span class="askmenu-ico">\\u270E</span>Revise mock\\u2026'
      : '<span class="askmenu-ico">\\u2026</span>Custom prompt\\u2026';
    // Generate-a-new-mockup only makes sense on non-mock cards in a live session.
    cardMenuMockup.style.display = (cardSel && !cardSel.isMock && !isReplay) ? '' : 'none';
    cardMenuEl.style.display = 'block';
    var mw = cardMenuEl.offsetWidth || 200;
    var mh = cardMenuEl.offsetHeight || 130;
    cardMenuEl.style.left = Math.max(6, Math.min(x, window.innerWidth - mw - 8)) + 'px';
    cardMenuEl.style.top = Math.max(6, Math.min(y, window.innerHeight - mh - 8)) + 'px';
  }
  function hideCardMenu() { if (cardMenuEl) cardMenuEl.style.display = 'none'; }

  function openCardInput(mode) {
    cardMenuMode = mode;
    var mockLive = cardSel && cardSel.isMock && !isReplay;
    if (mode === 'mockup') {
      cardMenuInput.placeholder = 'Describe the screen to mock (optional)\\u2026';
    } else {
      cardMenuInput.placeholder = mockLive
        ? 'Describe changes \\u2014 renders a new mock card\\u2026'
        : 'Ask about this card\\u2026';
    }
    cardMenuInputRow.classList.add('open');
    cardMenuInput.focus();
  }

  function submitCardInput() {
    var q = cardMenuInput.value.trim();
    if (cardMenuMode === 'mockup') {
      spawnMockup(q, false); // new mockup from this card's content (desc optional)
    } else { // custom
      if (cardSel && cardSel.isMock && !isReplay) {
        if (!q) return;            // a revision needs a concrete change to apply
        spawnMockup(q, true);      // revise base → new card
      } else {
        if (!q) return;
        startCardPanelAsk('custom', q);
      }
    }
  }

  // Reuse the transcript ask panel for card Summarize/Custom (streamed answer).
  // Selection carries only a short headline (the card title) so the server's
  // 1500-char selection clamp can't truncate it; the full card text rides in
  // context (no duplication) where it's clamped at a roomier budget.
  function startCardPanelAsk(mode, question) {
    if (!cardSel) return;
    var headline = (cardSel.title || cardSel.text || 'this card').slice(0, 300);
    askSel = { text: headline, context: cardSel.text, rect: cardSel.rect };
    hideCardMenu();
    startAsk(mode, question);
  }

  // Spawn a real mockup worker card. withBase=true sends the existing
  // wireframe/HTML so the worker revises rather than starting from scratch.
  function spawnMockup(instruction, withBase) {
    if (isReplay) { showToast('Mockup needs a live session'); hideCardMenu(); return; }
    if (!cardSel) { hideCardMenu(); return; }
    var msg = { type: 'action.trigger', actionType: 'mockup' };
    if (instruction) msg.prompt = instruction;
    if (cardSel.text) msg.cardContent = cardSel.text.slice(0, 6000);
    if (withBase) {
      if (cardSel.baseWireframe) msg.baseWireframe = cardSel.baseWireframe;
      if (cardSel.baseHtml) msg.baseHtml = cardSel.baseHtml;
    }
    wsSend(msg);
    showToast(withBase ? 'Mockup revision queued' : 'Mockup queued');
    hideCardMenu();
  }

  // Text highlighted inside a result card → same Fact check/Explain/Custom menu
  // the transcript uses. Returns null unless the selection is inside a card body.
  function captureCardSelection() {
    var s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0) return null;
    var text = s.toString().replace(/\\s+/g, ' ').trim();
    if (!text) return null;
    var range = s.getRangeAt(0);
    var node = range.commonAncestorContainer;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node || !resultsEl.contains(node)) return null;
    var bodyEl = node.closest ? node.closest('.card-body') : null;
    if (!bodyEl) return null;
    var cardEl = node.closest('.card');
    var ctx = '';
    if (cardEl) {
      var t = cardEl.querySelector('.card-title');
      ctx = ((t ? t.innerText + '\\n' : '') + (bodyEl.innerText || '')).slice(0, 4000);
    }
    return { text: text.slice(0, 1500), context: ctx, rect: range.getBoundingClientRect() };
  }

  // ─── Selection mini-toolbar ────────────────────────────────
  // Highlight-to-ask used to be reachable ONLY via right-click — zero
  // affordance. A floating toolbar now appears over any text selection in
  // the transcript or result cards, offering the same startAsk actions.
  // The right-click menus still work and take precedence when opened.
  var selBarEl = null;
  var selBarInputRow = null;
  var selBarInput = null;
  var selChangeTimer = null;

  function buildSelBar() {
    selBarEl = document.createElement('div');
    selBarEl.className = 'selbar';

    function mkBtn(label, ico, onClick) {
      var b = document.createElement('button');
      b.className = 'selbar-btn';
      b.innerHTML = '<span class="askmenu-ico">' + ico + '</span>' + label;
      // Keep the text selection alive while clicking the toolbar.
      b.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener('click', function(e) { e.stopPropagation(); onClick(); });
      selBarEl.appendChild(b);
    }

    mkBtn('Fact check', '\\u2713', function() { hideSelBar(); startAsk('factcheck', ''); });
    mkBtn('Explain', '?', function() { hideSelBar(); startAsk('explain', ''); });
    mkBtn('Ask\\u2026', '\\u270E', function() {
      selBarInputRow.classList.add('open');
      selBarInput.value = '';
      selBarInput.focus();
    });

    selBarInputRow = document.createElement('div');
    selBarInputRow.className = 'selbar-input-row';
    selBarInput = document.createElement('input');
    selBarInput.placeholder = 'Ask about the selection\\u2026';
    selBarInput.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    selBarInput.addEventListener('keydown', function(e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        var q = selBarInput.value.trim();
        if (q) { hideSelBar(); startAsk('custom', q); }
      } else if (e.key === 'Escape') {
        hideSelBar();
      }
    });
    selBarInputRow.appendChild(selBarInput);
    selBarEl.appendChild(selBarInputRow);
    document.body.appendChild(selBarEl);
  }

  function hideSelBar() {
    if (selBarEl) {
      selBarEl.style.display = 'none';
      selBarInputRow.classList.remove('open');
    }
  }

  function maybeShowSelBar() {
    var captured = captureTranscriptSelection() || captureCardSelection();
    if (!captured) { hideSelBar(); return; }
    askSel = captured;
    if (!selBarEl) buildSelBar();
    selBarInputRow.classList.remove('open');
    selBarEl.style.display = 'flex';
    var w = selBarEl.offsetWidth || 240;
    var h = selBarEl.offsetHeight || 34;
    var left = captured.rect.left + captured.rect.width / 2 - w / 2;
    selBarEl.style.left = Math.max(8, Math.min(left, window.innerWidth - w - 8)) + 'px';
    var top = captured.rect.top - h - 8;
    if (top < 8) top = captured.rect.bottom + 8;
    selBarEl.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + 'px';
  }

  document.addEventListener('mouseup', function(e) {
    if (selBarEl && selBarEl.contains(e.target)) return;
    // Defer one tick — the selection settles after mouseup.
    setTimeout(maybeShowSelBar, 10);
  });
  // Covers keyboard selection + collapse; debounced so drags don't flicker.
  document.addEventListener('selectionchange', function() {
    clearTimeout(selChangeTimer);
    selChangeTimer = setTimeout(function() {
      var s = window.getSelection();
      if (!s || s.isCollapsed) hideSelBar();
    }, 150);
  });

  // Keyboard access for the popup menus — the items are divs, not buttons,
  // so give them menu semantics + Enter/Space/arrow-key handling.
  function makeMenuAccessible(menuEl) {
    if (!menuEl) return;
    menuEl.setAttribute('role', 'menu');
    menuEl.querySelectorAll('.askmenu-item').forEach(function(item) {
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '0');
      item.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          var list = Array.prototype.slice.call(menuEl.querySelectorAll('.askmenu-item'));
          var i = list.indexOf(item);
          var next = e.key === 'ArrowDown' ? list[(i + 1) % list.length] : list[(i - 1 + list.length) % list.length];
          if (next) next.focus();
        }
      });
    });
  }

  buildAskUi();
  buildCardMenu();
  makeMenuAccessible(askMenuEl);
  makeMenuAccessible(cardMenuEl);
  transcriptFeed.addEventListener('contextmenu', function(e) {
    var captured = captureTranscriptSelection();
    if (!captured) { hideAskMenu(); return; }
    askSel = captured;
    hideSelBar(); // context menu takes precedence over the selection toolbar
    e.preventDefault();
    showAskMenu(e.clientX, e.clientY);
  });
  resultsEl.addEventListener('contextmenu', function(e) {
    // Text selected inside a card body → highlight-to-ask (reuse ask menu).
    var sel = captureCardSelection();
    if (sel) {
      askSel = sel;
      hideCardMenu();
      hideSelBar();
      e.preventDefault();
      showAskMenu(e.clientX, e.clientY);
      return;
    }
    // Otherwise, right-click an action card → the card-level menu.
    var cardEl = e.target.closest ? e.target.closest('.card') : null;
    if (!cardEl || (cardEl.id || '').indexOf('action-') !== 0) { hideCardMenu(); return; }
    cardSel = buildCardSel(cardEl);
    hideAskMenu();
    e.preventDefault();
    showCardMenu(e.clientX, e.clientY);
  });
  document.addEventListener('mousedown', function(e) {
    if (askMenuEl && askMenuEl.style.display === 'block' && !askMenuEl.contains(e.target)) hideAskMenu();
    if (cardMenuEl && cardMenuEl.style.display === 'block' && !cardMenuEl.contains(e.target)) hideCardMenu();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    // Modals sit on top of everything — close them first. Route through their
    // Close buttons so modal-local cleanup (progress timers, focus restore) runs.
    var modalClose = document.querySelector('#settingsModal #settingsClose, #reviewModal #reviewModalClose');
    if (modalClose) { modalClose.click(); return; }
    if (selBarEl && selBarEl.style.display === 'flex') hideSelBar();
    else if (cardMenuEl && cardMenuEl.style.display === 'block') hideCardMenu();
    else if (askMenuEl && askMenuEl.style.display === 'block') hideAskMenu();
    else if (askPanelEl && askPanelEl.classList.contains('open')) closeAskPanel();
  });

  // Focus handling for modal overlays: focus the close button on open, keep
  // Tab inside the card, hand focus back where it was on close.
  function wireModalFocus(modal, card, closeBtn) {
    var prior = document.activeElement;
    if (closeBtn) closeBtn.focus();
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.addEventListener('keydown', function(e) {
      if (e.key !== 'Tab') return;
      var focusables = card.querySelectorAll('button, input, [tabindex="0"], a[href], select, textarea');
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    return function restoreFocus() {
      if (prior && typeof prior.focus === 'function') { try { prior.focus(); } catch (err) {} }
    };
  }

  // ─── Transcript ───────────────────────────────────────────
  // ─── Pausable auto-scroll ──────────────────────────────────
  // Live mode is newest-first (pinned edge = top); replay is chronological
  // (pinned edge = bottom). Scrolling away suspends the auto-scroll so the
  // feed stops yanking mid-read; new segments count into a pill instead.
  var newSegPill = document.getElementById('newSegPill');
  var unseenSegments = 0;

  function atPinnedEdge() {
    if (isReplay) {
      return transcriptFeed.scrollHeight - transcriptFeed.scrollTop - transcriptFeed.clientHeight <= 8;
    }
    return transcriptFeed.scrollTop <= 8;
  }

  function updateNewSegPill() {
    if (!newSegPill) return;
    if (autoScroll || unseenSegments === 0) {
      newSegPill.style.display = 'none';
    } else {
      newSegPill.style.display = '';
      newSegPill.textContent = (isReplay ? '\\u2193 ' : '\\u2191 ') + unseenSegments + ' new';
    }
  }

  transcriptFeed.addEventListener('scroll', function() {
    hideSelBar(); // fixed-position toolbar would drift from its selection
    var pinned = atPinnedEdge();
    if (pinned && !autoScroll) {
      autoScroll = true;
      unseenSegments = 0;
    } else if (!pinned && autoScroll) {
      autoScroll = false;
    }
    updateNewSegPill();
  }, { passive: true });

  if (newSegPill) newSegPill.onclick = function() {
    autoScroll = true;
    unseenSegments = 0;
    transcriptFeed.scrollTop = isReplay ? transcriptFeed.scrollHeight : 0;
    updateNewSegPill();
  };

  function addSegment(seg) {
    var wc = seg.wordCount || (seg.text ? seg.text.split(/\\s+/).filter(Boolean).length : 0);
    var prior = (seg.id != null && seg.replace) ? segById.get(seg.id) : null;

    if (prior) {
      // Stitcher in-place growth: the open segment grew/closed under the same
      // stable id. Adjust the running counts by the word-count delta and
      // update the rendered line's text rather than inserting a new one.
      var delta = wc - prior.wordCount;
      totalWords += delta;
      if (seg.source === 'mic') micWords += delta;
      else meetingWords += delta;
      prior.wordCount = wc;
      updateStats();
      updateSegmentEl(prior.el, seg);
      stageOnSegment(seg);
      return;
    }

    segments.push(seg);
    totalWords += wc;
    if (seg.source === 'mic') micWords += wc;
    else meetingWords += wc;

    segCountEl.textContent = segments.length;
    updateStats();
    var el = renderSegment(seg);
    if (el && seg.id != null) segById.set(seg.id, { el: el, wordCount: wc, source: seg.source });
    if (el && !isReplay) markLatestSegment(el);
    stageOnSegment(seg);
  }

  // Live-edge marker. Only one segment carries it, so moving it is a clear +
  // set rather than a class toggle across the whole feed.
  var latestSegEl = null;
  function markLatestSegment(el) {
    if (latestSegEl === el) return;
    if (latestSegEl) latestSegEl.classList.remove('latest');
    el.classList.add('latest');
    latestSegEl = el;
  }
  function clearLatestSegment() {
    if (latestSegEl) latestSegEl.classList.remove('latest');
    latestSegEl = null;
  }

  // Update an already-rendered segment line in place as its text grows.
  function updateSegmentEl(el, seg) {
    if (!el) return;
    el.dataset.text = (seg.text || '').toLowerCase();
    var textEl = el.querySelector('.seg-text');
    if (textEl) textEl.textContent = seg.text || '';
    // Re-evaluate signal tags as the sentence fills in.
    var top = el.querySelector('.seg-top');
    if (top) {
      var existingTags = top.querySelectorAll('.signal-tag');
      existingTags.forEach(function(t) { t.remove(); });
      var srcSpan = top.querySelector('.seg-source');
      detectSignals(seg.text || '').forEach(function(s) {
        var tag = document.createElement('span');
        tag.className = 'signal-tag ' + s;
        tag.textContent = s;
        if (srcSpan && srcSpan.nextSibling) top.insertBefore(tag, srcSpan.nextSibling);
        else top.appendChild(tag);
      });
    }
  }

  // Build a segment row element (no insertion — renderSegment and the
  // show-older re-render both use this).
  function buildSegmentEl(seg) {
    var srcClass = seg.source === 'mic' ? 'mic' : 'meeting';
    var srcLabel = seg.source === 'mic' ? 'You' : 'Meeting';
    var signals = detectSignals(seg.text);
    var ts = formatTimestamp(typeof seg.timestamp === 'string' ? new Date(seg.timestamp).getTime() : seg.timestamp, sessionStartTime);

    var el = document.createElement('div');
    el.className = 'seg ' + srcClass;
    el.dataset.source = seg.source;
    el.dataset.text = seg.text.toLowerCase();
    if (seg.id != null) el.dataset.segId = seg.id;

    var signalHtml = signals.map(function(s) { return '<span class="signal-tag ' + s + '">' + s + '</span>'; }).join('');

    el.innerHTML = '<div class="seg-top">' +
      '<span class="seg-source ' + srcClass + '">' + srcLabel + '</span>' +
      signalHtml +
      '<span class="seg-time">' + ts + '</span>' +
    '</div>' +
    '<div class="seg-text">' + escapeHtml(seg.text) + '</div>';

    // Apply current filter
    if (currentFilter !== 'all' && seg.source !== currentFilter) {
      el.style.display = 'none';
    }
    return el;
  }

  // ─── Transcript DOM cap ────────────────────────────────────
  // Long meetings accumulate thousands of rows; keep at most 400 in the DOM
  // (data stays in segments[]). A "Show N older" button at the oldest edge
  // re-renders everything on demand, and a text search does so automatically
  // so search never silently misses trimmed rows.
  var MAX_RENDERED_SEGMENTS = 400;
  var showAllSegments = false;
  var showOlderBtn = null;

  function ensureShowOlderBtn() {
    if (!showOlderBtn) {
      showOlderBtn = document.createElement('button');
      showOlderBtn.className = 'show-older-btn';
      showOlderBtn.onclick = function() { renderAllSegments(); };
    }
    return showOlderBtn;
  }

  function enforceSegmentCap() {
    if (showAllSegments) return;
    var rows = transcriptFeed.querySelectorAll('.seg');
    var overflow = rows.length - MAX_RENDERED_SEGMENTS;
    if (overflow <= 0) return;
    // Oldest rows sit at the bottom in live (newest-first) mode, at the top
    // in replay (chronological) mode.
    for (var i = 0; i < overflow; i++) {
      var victim = isReplay ? rows[i] : rows[rows.length - 1 - i];
      victim.remove();
    }
    var hidden = segments.length - MAX_RENDERED_SEGMENTS;
    var btn = ensureShowOlderBtn();
    btn.textContent = 'Show ' + hidden + ' older segment' + (hidden === 1 ? '' : 's');
    if (isReplay) transcriptFeed.insertBefore(btn, transcriptFeed.firstChild);
    else transcriptFeed.appendChild(btn);
  }

  function renderAllSegments() {
    showAllSegments = true;
    if (showOlderBtn) showOlderBtn.remove();
    // Full rebuild from data — one-time cost on an explicit user ask.
    transcriptFeed.innerHTML = '';
    var ordered = isReplay ? segments : segments.slice().reverse();
    ordered.forEach(function(seg) {
      if (!seg.text || seg.text.trim() === '') return;
      var el = buildSegmentEl(seg);
      transcriptFeed.appendChild(el);
      if (seg.id != null) {
        var entry = segById.get(seg.id);
        if (entry) entry.el = el;
      }
    });
    filterTranscript();
  }

  function renderSegment(seg) {
    if (!seg.text || seg.text.trim() === '') return null;

    var el = buildSegmentEl(seg);

    if (isReplay) {
      // Replay reads top-down like a document — keep chronological order.
      transcriptFeed.appendChild(el);
      if (autoScroll) transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
      else { unseenSegments++; updateNewSegPill(); }
    } else {
      // Live: newest-first so the latest line is always visible without scrolling.
      var prevNewest = transcriptFeed.querySelector('.seg.newest');
      if (prevNewest) prevNewest.classList.remove('newest');
      el.classList.add('newest');
      transcriptFeed.insertBefore(el, transcriptFeed.firstChild);
      if (autoScroll) transcriptFeed.scrollTop = 0;
      else { unseenSegments++; updateNewSegPill(); }
    }
    enforceSegmentCap();
    return el;
  }

  window.setFilter = function(filter, btn) {
    currentFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.toggle('active', b === btn); });
    filterTranscript();
  };

  window.filterTranscript = function() {
    var search = (document.getElementById('transcriptSearch') || {}).value || '';
    search = search.toLowerCase();
    // Searching must cover DOM-trimmed rows too — render everything once.
    if (search && !showAllSegments && segments.length > MAX_RENDERED_SEGMENTS) {
      renderAllSegments(); // calls back into filterTranscript with all rows present
      return;
    }
    transcriptFeed.querySelectorAll('.seg').forEach(function(el) {
      var matchSource = currentFilter === 'all' || el.dataset.source === currentFilter;
      var matchSearch = !search || el.dataset.text.includes(search);
      el.style.display = (matchSource && matchSearch) ? '' : 'none';
    });
  };

  // ─── Action Card Rendering ────────────────────────────────
  // Render a result's artifacts as card-body inner HTML (no wrapper div).
  // Handles markdown / code / text and, for mockups, an ASCII⇄HTML toggle
  // (ASCII <pre><code> + a sandboxed HTML iframe) plus open/download. When
  // both a 'code' (ASCII) and 'html' artifact are present they share one
  // toggle; otherwise artifacts render as a stacked list. Generalizes to any
  // worker that emits an 'html' artifact (e.g. CodeGen previews later).
  function renderArtifactsInner(action) {
    var arts = action.result.artifacts;
    var asciiArt = null, htmlArt = null;
    arts.forEach(function(a) {
      if (a.type === 'code' && !asciiArt) asciiArt = a;
      if (a.type === 'html' && !htmlArt) htmlArt = a;
    });

    if (asciiArt && htmlArt) {
      mockupHtml.set(action.id, htmlArt.content);
      return '<div class="mockup-toggle">' +
          '<button class="btn btn-ghost active" data-view onclick="toggleMockupView(\\'' + action.id + '\\',\\'ascii\\',this)">ASCII</button>' +
          '<button class="btn btn-ghost" data-view onclick="toggleMockupView(\\'' + action.id + '\\',\\'html\\',this)">HTML</button>' +
          '<button class="btn btn-ghost" onclick="openMockupHtml(\\'' + action.id + '\\')">Open in new tab</button>' +
          '<button class="btn btn-ghost" onclick="downloadMockupHtml(\\'' + action.id + '\\')">Download .html</button>' +
        '</div>' +
        '<div class="mockup-pane" data-pane="ascii"><pre><code>' + escapeHtml(asciiArt.content) + '</code></pre></div>' +
        '<div class="mockup-pane" data-pane="html" style="display:none"><iframe class="mockup-frame" sandbox="allow-same-origin" srcdoc="' + escapeSrcdoc(htmlArt.content) + '"></iframe></div>';
    }

    var inner = '';
    arts.forEach(function(artifact, i) {
      if (i > 0) inner += '<div class="artifact-divider"></div>';
      if (artifact.title) inner += '<div class="artifact-label">' + escapeHtml(artifact.title) + '</div>';
      if (artifact.type === 'markdown') inner += renderMarkdown(artifact.content);
      else if (artifact.type === 'code') inner += '<pre><code>' + escapeHtml(artifact.content) + '</code></pre>';
      else if (artifact.type === 'html') {
        mockupHtml.set(action.id, artifact.content);
        inner += '<div class="mockup-toggle">' +
            '<button class="btn btn-ghost" onclick="openMockupHtml(\\'' + action.id + '\\')">Open in new tab</button>' +
            '<button class="btn btn-ghost" onclick="downloadMockupHtml(\\'' + action.id + '\\')">Download .html</button>' +
          '</div>' +
          '<div class="mockup-pane" data-pane="html"><iframe class="mockup-frame" sandbox="allow-same-origin" srcdoc="' + escapeSrcdoc(artifact.content) + '"></iframe></div>';
      }
      else inner += '<pre>' + escapeHtml(artifact.content) + '</pre>';
    });
    return inner;
  }

  // Update a still-streaming suggested card in place — never replaces the card
  // element, so the Approve button stays clickable while the description grows.
  function updateStreamingCardInPlace(action) {
    var card = actionCards.get(action.id);
    if (!card) return;
    var titleEl = card.querySelector('.card-title');
    if (titleEl) titleEl.textContent = action.title || '';
    var descEl = card.querySelector('.card-desc');
    if (descEl) descEl.textContent = action.description || '';
    var trigEl = card.querySelector('.card-trigger');
    if (trigEl) {
      if (action.triggerQuote) {
        trigEl.style.display = '';
        trigEl.textContent = '"' + action.triggerQuote.slice(0, 120) + (action.triggerQuote.length > 120 ? '...' : '') + '"';
      } else {
        trigEl.style.display = 'none';
      }
    }
    var cta = card.querySelector('.card-cta');
    if (cta && action.pendingApproval && !cta.querySelector('.pending-approve')) {
      cta.innerHTML = '<span class="pending-approve" style="color:rgb(var(--accent));font-size:13px;font-weight:600">\\u2713 Approved \\u2014 starting when ready\\u2026</span>';
    }
    if (!action.streaming) {
      var pill = card.querySelector('.streaming-pill');
      if (pill) pill.style.display = 'none';
    }
  }

  function renderAction(action) {
    var existing = actionCards.get(action.id);

    var card = document.createElement('div');
    card.className = 'card' + (action.state === 'running' && !isReplay ? ' running' : action.state === 'suggested' ? ' suggested' : '');
    card.id = 'action-' + action.id;

    var typeClass = action.state === 'failed' ? 'failed' : action.type;
    var header = '<div class="card-header">' +
      '<span class="card-type ' + typeClass + '">' + escapeHtml(action.type) + '</span>' +
      '<span class="card-title">' + escapeHtml(action.title) + '</span>' +
      '<span class="card-time">' + formatTime(action.completedAt) + '</span>' +
    '</div>';

    var body = '';

    if (action.state === 'suggested') {
      var pill = action.streaming
        ? '<span class="streaming-pill" style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--gb-overlay2);margin-bottom:6px"><span class="spinner"></span>generating\\u2026</span>'
        : '';
      body = '<div class="card-body">' + pill + '<p class="card-desc">' + escapeHtml(action.description || '') + '</p>';
      body += '<div class="card-trigger"' + (action.triggerQuote ? '' : ' style="display:none"') + '>' +
        (action.triggerQuote ? '"' + escapeHtml(action.triggerQuote.slice(0, 120)) + (action.triggerQuote.length > 120 ? '...' : '') + '"' : '') + '</div>';
      if (!isReplay) {
        body += '<div class="card-actions card-cta">';
        if (action.pendingApproval) {
          body += '<span class="pending-approve" style="color:rgb(var(--accent));font-size:13px;font-weight:600">\\u2713 Approved \\u2014 starting when ready\\u2026</span>';
        } else {
          // Approve is live even while streaming: pre-approve and the worker
          // launches the instant params finish (no need to read the whole card).
          body += '<button class="btn btn-green" onclick="approveAction(\\'' + action.id + '\\')">Approve</button>' +
            '<button class="btn btn-ghost" onclick="dismissAction(\\'' + action.id + '\\')">Dismiss</button>';
        }
        body += '</div>';
      }
      body += '</div>';
    } else if (action.state === 'running') {
      if (isReplay) {
        body = '<div class="card-body"><p style="color:var(--gb-overlay2)">Did not complete during session.</p></div>';
      } else if (action.result && action.result.artifacts && action.result.artifacts.length > 0) {
        // Partial result already streamed in (e.g. mockup ASCII before the
        // HTML phase finishes). Render it as a first-class result with a
        // "still working" footer so the fast output shows immediately.
        body = '<div class="card-body">' +
          renderArtifactsInner(action) +
          '<div class="streaming-placeholder"><span class="spinner"></span> Rendering HTML\\u2026</div>' +
          '<div class="card-actions"><button class="btn btn-ghost-red" onclick="cancelAction(\\'' + action.id + '\\')">Cancel</button></div>' +
        '</div>';
      } else {
        // Streaming-ready running body: placeholder shown until first delta,
        // then the streaming-text div is appended to by the action.stream handler.
        body = '<div class="card-body">' +
          '<div class="streaming-placeholder"><span class="spinner"></span> Running...</div>' +
          '<div class="streaming-text card-scroll" style="font-size:13px;line-height:1.55;color:var(--gb-text)"></div>' +
          '<div class="card-actions"><button class="btn btn-ghost-red" onclick="cancelAction(\\'' + action.id + '\\')">Cancel</button></div>' +
        '</div>';
      }
    } else if (action.state !== 'failed' && action.result && action.result.artifacts && action.result.artifacts.length > 0) {
      body = '<div class="card-body card-scroll">' + renderArtifactsInner(action) + '</div>';
    } else if (action.state !== 'failed' && action.result && action.result.summary) {
      body = '<div class="card-body card-scroll"><p>' + escapeHtml(action.result.summary) + '</p></div>';
    } else if (action.state === 'failed') {
      // Failed results carry a descriptive summary ("Research failed: …") — show
      // it, and ALWAYS render Retry (this branch must win over the summary branch
      // above, hence the explicit !== 'failed' guards there).
      var errMsg = (action.result && (action.result.summary || action.result.error)) || 'Unknown error';
      body = '<div class="card-body"><p style="color:var(--gb-red)">' + escapeHtml(errMsg) + '</p>';
      // Failed/timed-out workers are re-runnable: action.approve resets the
      // failed action and re-executes it (registry.approve handles the reset).
      if (!isReplay) {
        body += '<div class="card-actions">' +
          '<button class="btn btn-green" onclick="approveAction(\\'' + action.id + '\\')">Retry</button>' +
        '</div>';
      }
      body += '</div>';
    }

    card.innerHTML = header + body;
    if (existing) {
      // State update — re-render in place so cards don't jump mid-read.
      existing.replaceWith(card);
    } else if (isReplay) {
      // Replay reads top-down like a document — keep chronological order.
      resultsEl.appendChild(card);
    } else {
      // Live: newest card first, always visible under the sticky Quick Actions.
      resultsEl.insertBefore(card, resultsEl.firstChild);
    }
    actionCards.set(action.id, card);
    highlightCode();
    rebuildToc();
    updateActionStat();
    // Stage shows only what needs a decision: raise on suggest, retract the
    // moment it starts running, completes, or fails.
    if (action.state === 'suggested' && !isReplay) stageSetSuggestion(action);
    else stageClearSuggestion(action.id);
  }

  // ─── Fact-check Flags ─────────────────────────────────────
  function renderFactFlag(flag) {
    if (factFlagCards.has(flag.id)) return; // replayed on reconnect
    var card = document.createElement('div');
    card.className = 'card factflag';
    card.id = 'factflag-' + flag.id;

    var verdictLabel = flag.verdict === 'disputed' ? 'Disputed' : 'Likely incorrect';
    var saidBy = flag.speaker === 'you' ? 'you' : 'meeting';
    var basis = flag.webSearched ? '' : ' \\u00b7 model knowledge only';
    var srcHtml = '';
    if (flag.sources && flag.sources.length > 0) {
      srcHtml = '<div class="fact-sources">' + flag.sources.slice(0, 3).map(function(s) {
        return '<a href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">' + escapeHtml(s.title || s.url) + '</a>';
      }).join(' &middot; ') + '</div>';
    }

    card.innerHTML = '<div class="card-header">' +
      '<span class="card-type factcheck">factcheck</span>' +
      '<span class="card-title">' + escapeHtml(flag.claim) + '</span>' +
      '<span class="card-time">' + formatTime(new Date(flag.checkedAt).toISOString()) + '</span>' +
    '</div>' +
    '<div class="card-body">' +
      '<p><span class="fact-verdict ' + escapeHtml(flag.verdict) + '">' + verdictLabel + '</span> ' +
        '<span style="color:var(--gb-overlay2);font-size:11px">said by ' + saidBy + basis + '</span></p>' +
      (flag.correction ? '<p><strong>Correction:</strong> ' + escapeHtml(flag.correction) + '</p>' : '') +
      (flag.explanation ? '<p>' + escapeHtml(flag.explanation) + '</p>' : '') +
      '<div class="card-trigger">"' + escapeHtml(flag.quote) + '"</div>' +
      srcHtml +
    '</div>';

    resultsEl.insertBefore(card, resultsEl.firstChild);
    factFlagCards.set(flag.id, card);
    rebuildToc();
  }

  // ─── Coach Strip ("say next") ─────────────────────────────
  function renderCoachSuggestion(s) {
    if (coachExpireTimer) { clearTimeout(coachExpireTimer); coachExpireTimer = null; }
    var expiresAt = Number(s.expiresAt || 0);
    var remainingMs = expiresAt ? expiresAt - Date.now() : 15000;
    if (remainingMs <= 0) {
      window.dismissCoach();
      return;
    }
    var incident = s.incidentType || s.kind || 'address';
    var labels = {
      pressure: 'Pressure',
      objection: 'Objection',
      bad_answer: 'Recover',
      overcommitment: 'Qualify',
      confusion: 'Clarify',
      contradiction: 'Correct',
      agenda_risk: 'Agenda',
      decision: 'Decision',
      commitment: 'Commitment',
      question: 'Answer',
    };
    var label = labels[incident] || 'Coach';
    stageSetCoach(s, label);
    coachSlot.innerHTML = '<div class="coach-strip">' +
      '<span class="coach-kind ' + escapeHtml(incident) + '">' + escapeHtml(label) + '</span>' +
      '<div class="coach-body">' +
        '<div class="coach-phrasing">' + escapeHtml(s.phrasing) + '</div>' +
        '<div class="coach-why">' + escapeHtml(s.headline) + (s.why ? ' \\u2014 ' + escapeHtml(s.why) : '') + '</div>' +
      '</div>' +
      '<button class="coach-close" onclick="dismissCoach()" title="Dismiss">\\u00d7</button>' +
    '</div>';
    coachExpireTimer = setTimeout(function() { window.dismissCoach(); }, Math.min(30000, remainingMs));
  }

  window.dismissCoach = function() {
    if (coachExpireTimer) { clearTimeout(coachExpireTimer); coachExpireTimer = null; }
    coachSlot.innerHTML = '';
    stageClearCoach();
  };

  // ─── Theme ────────────────────────────────────────────────
  // data-theme on <html> drives every token; the pre-paint script in <head>
  // has already applied the stored choice, so this only has to keep the
  // button label in sync and write changes back.
  function wearingVault() {
    return document.documentElement.classList.contains('vault-look');
  }

  // Syntax highlighting is a separate stylesheet pair — swap which is live.
  function syncHljs(mode) {
    var light = document.getElementById('hljsLight');
    var dark = document.getElementById('hljsDark');
    if (light) light.disabled = (mode !== 'light');
    if (dark) dark.disabled = (mode === 'light');
  }

  function syncThemeBtn() {
    var btn = document.getElementById('themeBtn');
    if (!btn) return;
    var vault = wearingVault();
    var dark = document.documentElement.getAttribute('data-theme') !== 'light';
    // Label shows the destination, not the current state.
    btn.textContent = vault ? 'Vault' : (dark ? 'Light' : 'Dark');
    btn.disabled = vault;
    btn.title = vault
      ? 'Following the Obsidian vault\\u2019s appearance \\u2014 turn off Match vault appearance in Settings to choose'
      : 'Switch between light and dark';
  }

  window.toggleTheme = function() {
    // While the vault drives the palette there is nothing to toggle; the switch
    // for that lives in Settings, as it does in Onyx.
    if (wearingVault()) return;
    var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    syncHljs(next);
    try { localStorage.setItem('mc-theme', next); } catch (e) { /* non-fatal */ }
    syncThemeBtn();
  };
  syncThemeBtn();

  // ─── Vault look ───────────────────────────────────────────
  // The server dressed this page at first paint. This only has to notice a
  // LATER change — the Obsidian theme flipped, or Match vault appearance was
  // switched — and swap the palette in place, keyed on the revision so an
  // unchanged look costs nothing. Called on (re)connect and on regaining
  // visibility; never on a timer, because nothing here changes on its own.
  function applyVaultLook(look) {
    var root = document.documentElement;
    var style = document.getElementById('mcVaultLook');
    var meta = document.querySelector('meta[name="mc-vault-revision"]');
    if (look && look.css && look.mode) {
      if (!style) {
        style = document.createElement('style');
        style.id = 'mcVaultLook';
        document.head.appendChild(style);
      }
      style.textContent = look.css;
      root.classList.add('vault-look');
      root.setAttribute('data-theme', look.mode);
      syncHljs(look.mode);
    } else {
      if (style) style.remove();
      root.classList.remove('vault-look');
      // Back to the remembered preference, or the dark default.
      var stored = 'dark';
      try {
        var saved = localStorage.getItem('mc-theme');
        if (saved === 'light' || saved === 'dark') stored = saved;
      } catch (e) { /* private mode */ }
      root.setAttribute('data-theme', stored);
      syncHljs(stored);
    }
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'mc-vault-revision';
      document.head.appendChild(meta);
    }
    meta.content = (look && look.revision) || '';
    syncThemeBtn();
  }

  window.refreshVaultLook = function() {
    return fetch('/present/vault-look').then(function(r) { return r.json(); }).then(function(look) {
      var meta = document.querySelector('meta[name="mc-vault-revision"]');
      var current = meta ? meta.content : '';
      if (((look && look.revision) || '') === current) return;
      applyVaultLook(look);
    }).catch(function() { /* server unreachable — keep the palette we have */ });
  };

  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) window.refreshVaultLook();
  });

  // ─── Stage View ───────────────────────────────────────────
  // Full-screen presentation mode: agenda dots, a large teleprompter, and
  // only the two things worth interrupting for (a suggestion, a coach line).
  //
  // It is a pure VIEW over state the dashboard already maintains — it never
  // fetches, subscribes, or keeps its own copy of the transcript, so it
  // cannot drift from the panel behind it. Every hook below is a one-liner
  // called from the existing render path.
  var stageEl = document.getElementById('stageView');
  var stagePrompterEl = document.getElementById('stagePrompter');
  var stageFeedEl = document.getElementById('stageFeed');
  var stageJumpEl = document.getElementById('stageJump');
  var stageAgendaEl = document.getElementById('stageAgenda');
  var stageToastsEl = document.getElementById('stageToasts');
  var stageTimerEl = document.getElementById('stageTimer');
  var stagePillEl = document.getElementById('stagePill');
  var stageRecEl = document.getElementById('stageRec');
  var stageBtnEl = document.getElementById('stageBtn');
  var stageActive = false;
  var stageLastAgenda = null;
  var stageLiveKey = null;   // which segment the big line is showing
  var stageLiveWords = 0;    // words already painted, so growth only adds
  var stageSuggestion = null;
  var stageCoach = null;

  // Ambient bars — decorative, built once. Not amplitude-driven; the REC dot
  // is the honest signal and app.log peak= is the truth (gotcha #12).
  (function buildStageWave() {
    var waveEl = document.getElementById('stageWave');
    if (!waveEl) return;
    var html = '';
    for (var i = 0; i < 44; i++) {
      var h = 20 + Math.round(60 * Math.abs(Math.sin(i * 0.9)));
      html += '<i style="height:' + h + '%;animation-delay:' + ((i % 8) * 0.12).toFixed(2) + 's"></i>';
    }
    waveEl.innerHTML = html;
  })();

  window.toggleStage = function() {
    stageActive = !stageActive;
    stageEl.classList.toggle('active', stageActive);
    if (stageBtnEl) {
      stageBtnEl.classList.toggle('btn-blue', stageActive);
      stageBtnEl.classList.toggle('btn-ghost', !stageActive);
    }
    if (stageActive) stageSyncAll();
  };

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && stageActive) {
      e.preventDefault();
      window.toggleStage();
    }
  });

  function stageSyncAll() {
    // Entering always lands on the calm prompter, whatever the reader had
    // scrolled back to last time.
    stageMode = 'live';
    stageJumpEl.classList.remove('visible');
    stageRenderAgenda();
    stageRenderPrompter(false);
    stageRenderToasts();
    stageSyncState();
    stageTimerEl.textContent = sessionTimerEl.textContent;
  }

  // Mirrors the header's live/idle state so the stage never implies a meeting
  // is running when it has stopped.
  function stageSyncState() {
    var live = sessionState === 'live';
    stageEl.classList.toggle('paused', !live);
    stageRecEl.className = 'stage-rec' + (live ? '' : ' off');
    stagePillEl.textContent = sessionState.charAt(0).toUpperCase() + sessionState.slice(1);
  }

  function stageKeyFor(seg) {
    return seg.id != null ? 's' + seg.id : 't' + seg.timestamp;
  }
  function stageSpeaker(seg) {
    return seg.source === 'mic' ? 'You' : 'Meeting';
  }

  function stageRenderAgenda() {
    if (!stageLastAgenda || !stageLastAgenda.items || stageLastAgenda.items.length === 0) {
      stageAgendaEl.innerHTML = '';
      return;
    }
    var html = '';
    for (var i = 0; i < stageLastAgenda.items.length; i++) {
      var item = stageLastAgenda.items[i];
      var state = item.state || 'pending';
      html += '<span class="stage-step state-' + state + '" title="' + escapeHtml(item.text) + '">' +
        '<span class="sdot"></span><span class="stext">' + escapeHtml(item.text) + '</span></span>';
    }
    stageAgendaEl.innerHTML = html;
  }

  // History is capped like the main panel — a long meeting is thousands of
  // rows. "Show older" lifts the cap for the rest of the view's lifetime.
  var STAGE_MAX_RENDERED = 200;
  var stageShowAll = false;
  var stageMode = 'live'; // 'live' (centred prompter) | 'history' (scrollback)

  function stageHistHtml(seg, older) {
    return '<p class="stage-hist ' + (seg.source === 'mic' ? 'mic' : 'meeting') +
      (older ? ' older' : '') + '"><span class="who">' + escapeHtml(stageSpeaker(seg)) +
      '</span> \\u2014 ' + escapeHtml(seg.text) + '</p>';
  }

  function stageLiveBlockHtml(seg) {
    return '<div class="stage-live" id="stageLiveBlock"><span class="who">' +
      escapeHtml(stageSpeaker(seg)) + ' \\u00b7 speaking</span><span id="stageLiveText"></span></div>';
  }

  function stageRenderPrompter(animateLive) {
    if (stageMode === 'history') return stageRenderHistory();
    stagePrompterEl.className = 'stage-prompter mode-live';
    if (segments.length === 0) {
      stageFeedEl.innerHTML = '<div class="stage-empty">Waiting for the first words\\u2026</div>';
      stageLiveKey = null;
      stageLiveWords = 0;
      return;
    }
    var live = segments[segments.length - 1];
    var prev = segments[segments.length - 2];
    var older = segments[segments.length - 3];
    var html = '';
    if (older) html += stageHistHtml(older, true);
    if (prev) html += stageHistHtml(prev, false);
    html += stageLiveBlockHtml(live);
    stageFeedEl.innerHTML = html;
    stageLiveKey = stageKeyFor(live);
    stageLiveWords = 0;
    stagePaintWords(live.text, !!animateLive);
  }

  function stageRenderHistory() {
    stagePrompterEl.className = 'stage-prompter mode-history';
    if (segments.length === 0) {
      stageFeedEl.innerHTML = '<div class="stage-empty">Waiting for the first words\\u2026</div>';
      return;
    }
    var start = stageShowAll ? 0 : Math.max(0, segments.length - STAGE_MAX_RENDERED);
    var html = '';
    if (start > 0) {
      html += '<button class="stage-older-btn" onclick="stageShowOlder()">Show ' + start +
        ' older segment' + (start === 1 ? '' : 's') + '</button>';
    }
    for (var i = start; i < segments.length - 1; i++) html += stageHistHtml(segments[i], false);
    var live = segments[segments.length - 1];
    html += stageLiveBlockHtml(live);
    stageFeedEl.innerHTML = html;
    stageLiveKey = stageKeyFor(live);
    stageLiveWords = 0;
    stagePaintWords(live.text, false);
    stagePrompterEl.scrollTop = stagePrompterEl.scrollHeight;
  }

  // Suppresses the auto-return while a PROGRAMMATIC scrollTop assignment's
  // scroll event lands. Without it, entering history sets scrollTop to the
  // bottom, the resulting event reads "you're caught up", and the view snaps
  // straight back to live — history would flash for one frame and vanish.
  var stageIgnoreScrollUntil = 0;

  function stageEnterHistory() {
    if (stageMode === 'history') return;
    stageMode = 'history';
    stageRenderHistory();
    stageJumpEl.classList.add('visible');
    // The reader pushed UP — actually move up a notch, so the gesture visibly
    // does something and we don't sit pinned to the auto-return threshold.
    var step = 160;
    stageIgnoreScrollUntil = Date.now() + 400;
    stagePrompterEl.scrollTop = Math.max(
      0,
      stagePrompterEl.scrollHeight - stagePrompterEl.clientHeight - step
    );
  }

  window.stageJumpToLive = function() {
    stageMode = 'live';
    stageJumpEl.classList.remove('visible');
    stageRenderPrompter(false);
  };

  window.stageShowOlder = function() {
    stageShowAll = true;
    stageRenderHistory();
  };

  // A new segment demotes the current live block to history and opens a fresh
  // one, rather than rebuilding the feed — in history mode that also keeps the
  // reader's scroll position from jumping under them.
  function stageAppendSegment(seg) {
    var block = document.getElementById('stageLiveBlock');
    if (!block) { stageRenderPrompter(true); return; }
    if (stageMode === 'live') {
      // Only three lines live here, so a re-render is the cheapest way to
      // roll the fade ramp forward (prev becomes older, live becomes prev).
      stageRenderPrompter(true);
      return;
    }
    var prevIdx = segments.length - 2;
    if (prevIdx >= 0) {
      var holder = document.createElement('div');
      holder.innerHTML = stageHistHtml(segments[prevIdx], false);
      stageFeedEl.insertBefore(holder.firstChild, block);
    }
    block.innerHTML = '<span class="who">' + escapeHtml(stageSpeaker(seg)) +
      ' \\u00b7 speaking</span><span id="stageLiveText"></span>';
    stageLiveKey = stageKeyFor(seg);
    stageLiveWords = 0;
    stagePaintWords(seg.text, true);
    stageTrimFeed();
  }

  // Trimming removes rows from the TOP, which would shift the page under
  // someone reading the middle of it. While history is open the cap is left
  // alone; returning to live re-renders from segments[] anyway, so nothing
  // accumulates permanently.
  function stageTrimFeed() {
    if (stageShowAll || stageMode === 'history') return;
    var rows = stageFeedEl.querySelectorAll('.stage-hist');
    for (var i = 0; i < rows.length - STAGE_MAX_RENDERED; i++) rows[i].remove();
  }

  // Live mode has nothing to scroll, so reaching for history is expressed as
  // scroll INTENT — a wheel/trackpad push upward, or the usual back-up keys.
  stagePrompterEl.addEventListener('wheel', function(e) {
    if (stageMode === 'live' && e.deltaY < 0) stageEnterHistory();
  }, { passive: true });

  document.addEventListener('keydown', function(e) {
    if (!stageActive || stageMode !== 'live') return;
    if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') stageEnterHistory();
  });

  // Scrolling back down to the bottom means "I'm caught up" — return to the
  // prompter so the default view is always the calm one.
  stagePrompterEl.addEventListener('scroll', function() {
    if (stageMode !== 'history') return;
    if (Date.now() < stageIgnoreScrollUntil) return;
    var dist = stagePrompterEl.scrollHeight - stagePrompterEl.scrollTop - stagePrompterEl.clientHeight;
    if (dist <= 2) window.stageJumpToLive();
  });

  // Paints only the words that are new since the last call, so an open
  // segment growing under a stable id reveals word-by-word instead of
  // re-animating the whole line on every stitcher update.
  function stagePaintWords(text, animate) {
    var host = document.getElementById('stageLiveText');
    if (!host) return;
    var words = String(text || '').split(/\\s+/).filter(Boolean);
    if (words.length < stageLiveWords) {
      // The stitcher re-cut the sentence shorter — repaint from scratch.
      host.innerHTML = '';
      stageLiveWords = 0;
    }
    for (var i = stageLiveWords; i < words.length; i++) {
      var span = document.createElement('span');
      if (animate) {
        span.className = 'w';
        span.style.animationDelay = ((i - stageLiveWords) * 55) + 'ms';
      }
      span.textContent = words[i] + ' ';
      host.appendChild(span);
    }
    stageLiveWords = words.length;
  }

  function stageOnSegment(seg) {
    if (!stageActive) return;
    if (stageKeyFor(seg) === stageLiveKey) {
      // Same open segment growing under a stable id — reveal the new words.
      // Note there is deliberately no auto-scroll in history mode: the reader
      // opened it to read, and yanking them to the bottom on every stitcher
      // update would both fight them and trip the caught-up auto-return.
      stagePaintWords(seg.text, true);
    } else {
      stageAppendSegment(seg);
    }
  }

  function stageRenderToasts() {
    if (!stageActive) return;
    var html = '';
    if (stageCoach) {
      html += '<div class="stage-toast">' +
        '<div class="head">Coach \\u00b7 ' + escapeHtml(stageCoach.label) +
          '<span class="stage-ttl"><svg width="26" height="26" viewBox="0 0 26 26">' +
            '<circle class="track" cx="13" cy="13" r="10" fill="none" stroke-width="2.5"></circle>' +
            '<circle class="arc" id="stageTtlArc" cx="13" cy="13" r="10" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="62.83"></circle>' +
          '</svg><b id="stageTtlNum"></b></span>' +
        '</div>' +
        '<div class="title">' + escapeHtml(stageCoach.phrasing) + '</div>' +
        (stageCoach.why ? '<div class="why">' + escapeHtml(stageCoach.why) + '</div>' : '') +
        '<div class="row"><button class="stage-btn ghost" onclick="dismissCoach()">Dismiss</button></div>' +
      '</div>';
    }
    if (stageSuggestion) {
      html += '<div class="stage-toast">' +
        '<div class="head">Suggested \\u00b7 ' + escapeHtml(stageSuggestion.type) + '</div>' +
        '<div class="title">' + escapeHtml(stageSuggestion.title) + '</div>' +
        (stageSuggestion.description ? '<div class="why">' + escapeHtml(stageSuggestion.description) + '</div>' : '') +
        '<div class="row">' +
          '<button class="stage-btn primary" onclick="approveAction(\\'' + stageSuggestion.id + '\\')">Approve</button>' +
          '<button class="stage-btn ghost" onclick="dismissAction(\\'' + stageSuggestion.id + '\\')">Skip</button>' +
        '</div>' +
      '</div>';
    }
    stageToastsEl.innerHTML = html;
    stageTickCoach();
  }

  function stageSetSuggestion(action) {
    stageSuggestion = { id: action.id, type: action.type, title: action.title, description: action.description || '' };
    stageRenderToasts();
  }
  function stageClearSuggestion(id) {
    if (stageSuggestion && stageSuggestion.id === id) {
      stageSuggestion = null;
      stageRenderToasts();
    }
  }
  function stageSetCoach(s, label) {
    var expiresAt = Number(s.expiresAt || 0) || (Date.now() + 15000);
    stageCoach = {
      label: label,
      phrasing: s.phrasing,
      why: s.headline || '',
      expiresAt: expiresAt,
      totalMs: Math.max(1, expiresAt - Date.now()),
    };
    stageRenderToasts();
  }
  function stageClearCoach() {
    if (!stageCoach) return;
    stageCoach = null;
    stageRenderToasts();
  }

  // Ring is updated in place — re-rendering the toast each second would
  // restart its entry animation and steal focus from the buttons.
  function stageTickCoach() {
    if (!stageCoach || !stageActive) return;
    var arc = document.getElementById('stageTtlArc');
    var num = document.getElementById('stageTtlNum');
    if (!arc || !num) return;
    var left = Math.max(0, stageCoach.expiresAt - Date.now());
    num.textContent = String(Math.ceil(left / 1000));
    arc.style.strokeDashoffset = (62.83 * (1 - left / stageCoach.totalMs)).toFixed(2);
  }
  setInterval(stageTickCoach, 1000);

  // Debug hooks: render monitor output without a live meeting (local-only
  // dashboard, so exposing these is harmless and useful for UI testing).
  window.__copilotDebug = {
    renderFactFlag: renderFactFlag,
    renderCoachSuggestion: renderCoachSuggestion,
  };

  // ─── TOC ──────────────────────────────────────────────────
  function rebuildToc() {
    tocEntries.innerHTML = '';
    resultsEl.querySelectorAll('.card').forEach(function(card) {
      var titleEl = card.querySelector('.card-title');
      var typeEl = card.querySelector('.card-type');
      if (!titleEl) return;

      var section = document.createElement('div');
      section.className = 'toc-section';

      var cardLink = document.createElement('div');
      cardLink.className = 'toc-card-title';
      cardLink.dataset.target = card.id;
      if (typeEl) {
        var badge = document.createElement('span');
        badge.className = 'toc-badge ' + (typeEl.textContent || '').trim().toLowerCase();
        badge.textContent = (typeEl.textContent || '').trim().slice(0, 3);
        cardLink.appendChild(badge);
      }
      var label = document.createElement('span');
      label.textContent = titleEl.textContent;
      label.style.cssText = '';
      cardLink.appendChild(label);
      cardLink.addEventListener('click', function() {
        document.getElementById(card.id).scrollIntoView({ behavior:'smooth', block:'start' });
      });
      section.appendChild(cardLink);

      card.querySelectorAll('.card-body h1, .card-body h2, .card-body h3').forEach(function(h) {
        if (!h.id) h.id = 'toc-h-' + (++headingIdCounter);
        var depth = parseInt(h.tagName.charAt(1), 10);
        var link = document.createElement('a');
        link.className = 'toc-heading' + (depth >= 3 ? ' depth-3' : '');
        link.textContent = h.textContent;
        link.href = '#' + h.id;
        link.addEventListener('click', function(e) {
          e.preventDefault();
          h.scrollIntoView({ behavior:'smooth', block:'start' });
        });
        section.appendChild(link);
      });

      tocEntries.appendChild(section);
    });
  }

  // Scroll spy for TOC
  var scrollRaf = null;
  // Scroll-spy listens on .main — the actual scroll container (the window
  // never scrolls in this fixed-height layout, so a window listener was dead
  // code and the TOC highlight never updated).
  var mainColEl = document.querySelector('.main');
  if (mainColEl) mainColEl.addEventListener('scroll', function() {
    hideSelBar(); // fixed-position toolbar would drift from its selection
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function() {
      scrollRaf = null;
      // A heading/card is "active" when it has scrolled up to within 120px
      // of the top of the visible main column.
      var threshold = mainColEl.getBoundingClientRect().top + 120;
      var activeHeadingId = null;
      var activeCardId = null;

      resultsEl.querySelectorAll('.card-body h1[id], .card-body h2[id], .card-body h3[id]').forEach(function(h) {
        if (h.getBoundingClientRect().top <= threshold) activeHeadingId = h.id;
      });
      resultsEl.querySelectorAll('.card').forEach(function(c) {
        if (c.getBoundingClientRect().top <= threshold) activeCardId = c.id;
      });

      tocEntries.querySelectorAll('.toc-heading').forEach(function(l) {
        l.classList.toggle('active', l.getAttribute('href') === '#' + activeHeadingId);
      });
      tocEntries.querySelectorAll('.toc-card-title').forEach(function(l) {
        l.classList.toggle('active', l.dataset.target === activeCardId);
      });
    });
  }, { passive: true });

  // ─── Session History ──────────────────────────────────────
  var sessionManageMode = false;

  window.showSessionHistory = function() {
    sessionManageMode = false;
    idleOverlay.innerHTML = '<div class="idle-overlay"><div class="idle-card" style="max-width:560px">' +
      '<h2>Past Sessions</h2>' +
      '<div class="session-toolbar">' +
        '<p style="margin:0">Review or manage previous meetings.</p>' +
        '<button class="btn btn-ghost btn-sm" id="manageToggle" onclick="toggleManageMode()">Manage</button>' +
      '</div>' +
      '<div id="sessionBulkBar" style="display:none"></div>' +
      '<div id="sessionListItems" style="margin:8px 0"><p style="color:var(--gb-overlay2)">Loading...</p></div>' +
      '<button class="btn btn-ghost" onclick="updateUI()">Back</button>' +
    '</div></div>';

    loadSessionList();
  };

  function loadSessionList() {
    var sessUrl = '/present/sessions' + (sessionManageMode ? '?all=1' : '');
    fetch(sessUrl).then(function(r) { return r.json(); }).then(function(data) {
      var el = document.getElementById('sessionListItems');
      if (!el) return;
      if (!data.sessions || data.sessions.length === 0) {
        el.innerHTML = '<p style="color:var(--gb-overlay2);text-align:center;padding:20px">No sessions found.</p>';
        var bulkBar = document.getElementById('sessionBulkBar');
        if (bulkBar) bulkBar.style.display = 'none';
        var manageBtn = document.getElementById('manageToggle');
        if (manageBtn) manageBtn.style.display = 'none';
        return;
      }
      el.innerHTML = '';
      data.sessions.forEach(function(s) {
        var date = s.startedAt ? new Date(s.startedAt) : null;
        var endDate = s.endedAt ? new Date(s.endedAt) : null;
        var duration = '';
        if (date && endDate) {
          var mins = Math.round((endDate - date) / 60000);
          duration = mins >= 60 ? Math.floor(mins/60) + 'h ' + (mins%60) + 'm' : mins + ' min';
        }

        var item = document.createElement('div');
        item.className = 'session-item';
        item.dataset.sessionId = s.id;

        if (!sessionManageMode) {
          item.onclick = function() { window.location.href = '/present?session=' + s.id; };
        } else {
          item.style.cursor = 'default';
        }

        var titleStyle = s.empty ? 'color:var(--gb-overlay2);font-style:italic' : '';
        item.innerHTML =
          (sessionManageMode ? '<input type="checkbox" class="session-select-cb" data-id="' + s.id + '">' : '') +
          '<div style="min-width:0;flex:1">' +
            '<div class="session-item-title" style="' + titleStyle + '">' + escapeHtml(s.title) + '</div>' +
            '<div class="session-item-meta">' +
              (date ? date.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'}) + ' at ' +
                date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : 'Unknown date') +
              (duration ? '  &middot;  ' + duration : '') +
            '</div>' +
          '</div>' +
          '<div class="session-item-stats">' +
            '<div>' + (s.actionCount || 0) + ' actions</div>' +
            '<div>' + (s.segmentCount || 0) + ' segments</div>' +
          '</div>' +
          (!sessionManageMode && (s.segmentCount || 0) > 0
            ? '<button class="btn btn-ghost btn-sm session-review-btn" title="Review this meeting — how you did">Review</button>'
            : '') +
          (sessionManageMode ? '<button class="session-delete-btn" title="Delete">&#x2715;</button>' : '');

        // Attach event listeners via DOM instead of inline onclick
        if (sessionManageMode) {
          var cb = item.querySelector('.session-select-cb');
          if (cb) cb.addEventListener('click', function(e) { e.stopPropagation(); updateBulkBar(); });
          var delBtn = item.querySelector('.session-delete-btn');
          if (delBtn) {
            (function(sid, stitle) {
              delBtn.addEventListener('click', function(e) { e.stopPropagation(); deleteSession(sid, stitle); });
            })(s.id, s.title);
          }
        } else {
          var revBtn = item.querySelector('.session-review-btn');
          if (revBtn) {
            (function(sid, stitle) {
              revBtn.addEventListener('click', function(e) { e.stopPropagation(); reviewSession(sid, stitle); });
            })(s.id, s.title);
          }
        }

        el.appendChild(item);
      });
      updateBulkBar();
    });
  }

  // ─── Settings ──────────────────────────────────────────────
  // Gear in the header → modal backed by GET/POST /settings. The server
  // persists to ~/.meeting-copilot/settings.json and applies changes live
  // (eval cadence, suggestion TTL, retention, monitor defaults, summary
  // auto-save).
  window.openSettings = function() {
    var existing = document.getElementById('settingsModal');
    if (existing) { existing.remove(); return; }

    var modal = document.createElement('div');
    modal.id = 'settingsModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px';
    var card = document.createElement('div');
    card.style.cssText = 'background:var(--gb-base);color:var(--gb-text);max-width:460px;width:100%;max-height:85vh;overflow:auto;border:1px solid var(--gb-surface2);box-shadow:0 10px 40px rgba(0,0,0,.3)';
    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--gb-overlay0)">' +
        '<strong style="font-size:14px">Settings</strong>' +
        '<button class="btn btn-ghost btn-sm" id="settingsClose">Close</button>' +
      '</div>' +
      '<div id="settingsBody" style="padding:16px 20px;font-size:12px">Loading\\u2026</div>';
    modal.appendChild(card);
    document.body.appendChild(modal);
    var restoreFocus = wireModalFocus(modal, card, card.querySelector('#settingsClose'));
    var close = function() { modal.remove(); restoreFocus(); };
    card.querySelector('#settingsClose').onclick = close;
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });

    fetch('/settings').then(function(r) { return r.json(); }).then(function(d) {
      var s = d.settings || {};
      var body = document.getElementById('settingsBody');
      if (!body) return;
      body.innerHTML =
        '<div class="settings-field"><label>Suggestion cadence (seconds)</label>' +
          '<input type="number" id="setCadence" min="10" max="60" step="5" value="' + Math.round((s.evalCadenceMs || 15000) / 1000) + '">' +
          '<div class="settings-hint">How often the transcript is evaluated for suggestions (10\\u201360s). Backoff doubles this when nothing is actionable.</div></div>' +
        '<div class="settings-field"><label>Suggestion lifetime (seconds)</label>' +
          '<input type="number" id="setTtl" min="30" max="300" step="15" value="' + Math.round((s.suggestionTtlMs || 60000) / 1000) + '">' +
          '<div class="settings-hint">Unapproved suggestions expire after this long (30\\u2013300s).</div></div>' +
        '<div class="settings-field"><label>Session retention (days)</label>' +
          '<input type="number" id="setRetention" min="7" max="3650" value="' + (s.retentionDays || 90) + '">' +
          '<div class="settings-hint">Sessions older than this are deleted at startup and on save.</div></div>' +
        '<div class="settings-field"><label>Live assistance on by default</label>' +
          '<label class="settings-check"><input type="checkbox" id="setCoach"' + (s.monitorDefaults && s.monitorDefaults.coach ? ' checked' : '') + '> Recovery coach (recommended)</label>' +
          '<label class="settings-check" style="margin-top:4px"><input type="checkbox" id="setFactcheck"' + (s.monitorDefaults && s.monitorDefaults.factcheck ? ' checked' : '') + '> Fact-check (extra cost while on)</label></div>' +
        '<div class="settings-field"><label>Summaries</label>' +
          '<label class="settings-check"><input type="checkbox" id="setAutoWrite"' + (s.summaryAutoWrite ? ' checked' : '') + '> Auto-save summaries to ~/Documents/CX/Meetings</label></div>' +
        '<div class="settings-field"><label>Appearance</label>' +
          '<label class="settings-check"><input type="checkbox" id="setVaultLook"' + (s.matchVaultAppearance ? ' checked' : '') + '> Match vault appearance (the Obsidian theme, via Onyx)</label>' +
          '<div class="settings-hint">Wears the palette Onyx derives from your vault\\u2019s theme. Off, or with Onyx not running and nothing cached, the dashboard uses its own light/dark themes.</div></div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">' +
          '<button class="btn btn-green" id="settingsSave">Save</button>' +
        '</div>';
      document.getElementById('settingsSave').onclick = function() {
        var payload = {
          evalCadenceMs: (parseInt(document.getElementById('setCadence').value, 10) || 15) * 1000,
          suggestionTtlMs: (parseInt(document.getElementById('setTtl').value, 10) || 60) * 1000,
          retentionDays: parseInt(document.getElementById('setRetention').value, 10) || 90,
          monitorDefaults: {
            coach: document.getElementById('setCoach').checked,
            factcheck: document.getElementById('setFactcheck').checked,
          },
          summaryAutoWrite: document.getElementById('setAutoWrite').checked,
          matchVaultAppearance: document.getElementById('setVaultLook').checked,
        };
        fetch('/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function(r) { return r.json(); }).then(function(res) {
          if (res && res.success) {
            // Appearance is the one setting you can see change — apply it now
            // rather than on the next load.
            if (window.refreshVaultLook) window.refreshVaultLook();
            showToast('Settings saved'); close();
          }
          else { showToast('Could not save settings', { error: true }); }
        }).catch(function() {
          showToast('Could not save settings \\u2014 server unreachable', { error: true });
        });
      };
    }).catch(function() {
      var body = document.getElementById('settingsBody');
      if (body) body.innerHTML = '<p style="color:var(--gb-red)">Could not load settings \\u2014 server unreachable.</p>';
    });
  };

  // Review a PAST (ended) meeting on demand — POSTs to /present/review, which
  // runs the ReviewWorker on that session's stored transcript and returns the
  // scorecard markdown. Rendered in a self-contained overlay (no alert/confirm —
  // those are blocked in WKWebView).
  window.reviewSession = function(id, title) {
    var existing = document.getElementById('reviewModal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'reviewModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px';
    var card = document.createElement('div');
    card.style.cssText = 'background:var(--gb-base);color:var(--gb-text);max-width:760px;width:100%;max-height:85vh;overflow:auto;border:1px solid var(--gb-surface2);box-shadow:0 10px 40px rgba(0,0,0,.3)';
    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--gb-overlay0);position:sticky;top:0;background:var(--gb-base)">' +
        '<strong style="font-size:14px">Self-Review &mdash; ' + escapeHtml(title || 'Meeting') + '</strong>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-ghost btn-sm" id="reviewModalRerun" style="display:none">&#8635; Re-run</button>' +
          '<button class="btn btn-ghost btn-sm" id="reviewModalClose">Close</button>' +
        '</div>' +
      '</div>' +
      '<div id="reviewModalBody" style="padding:16px 20px;font-size:13px;line-height:1.55"></div>';
    modal.appendChild(card);
    document.body.appendChild(modal);

    var rerunBtn = card.querySelector('#reviewModalRerun');
    var progressTimer = null;
    function stopProgress() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }

    var restoreFocus = wireModalFocus(modal, card, card.querySelector('#reviewModalClose'));
    var close = function() { stopProgress(); modal.remove(); restoreFocus(); };
    card.querySelector('#reviewModalClose').onclick = close;
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });

    // The review is a single blocking call (no streaming), so the bar is a
    // time-based estimate: it eases toward ~92% over the expected window and
    // snaps to 100% when the response lands. Never claims done before it is.
    function showProcessing(refresh) {
      var body = document.getElementById('reviewModalBody');
      if (!body) return;
      body.innerHTML =
        '<div style="display:flex;align-items:flex-start;color:var(--gb-overlay2)">' +
          '<span class="review-spinner"></span>' +
          '<span>' + (refresh ? 'Regenerating the review' : 'Loading the review') +
          '&hellip; a fresh run uses Opus on the full transcript and can take ~30&ndash;120s.</span>' +
        '</div>' +
        '<div class="review-progress"><div class="review-progress-bar" id="reviewProgressBar"></div></div>';
      var bar = document.getElementById('reviewProgressBar');
      var start = Date.now();
      var ESTIMATE_MS = 45000; // easing time-constant
      stopProgress();
      progressTimer = setInterval(function() {
        var pct = 92 * (1 - Math.exp(-(Date.now() - start) / ESTIMATE_MS));
        if (bar) bar.style.width = pct.toFixed(1) + '%';
      }, 200);
    }
    // Snap the bar to 100%, then run cb after the fill transition so the
    // completed bar is briefly visible before the result replaces it.
    function finishProgress(cb) {
      stopProgress();
      var bar = document.getElementById('reviewProgressBar');
      if (bar) { bar.style.width = '100%'; setTimeout(cb, 200); } else { cb(); }
    }

    // refresh=false → return the review saved with the meeting if one exists
    // (instant); refresh=true → regenerate with Opus and re-save.
    function loadReview(refresh) {
      rerunBtn.style.display = 'none';
      showProcessing(refresh);
      fetch('/present/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id, refresh: !!refresh }),
      })
        .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
        .then(function(res) {
          finishProgress(function() {
            var b = document.getElementById('reviewModalBody');
            if (!b) return;
            if (!res.ok || !res.j || res.j.error) {
              b.innerHTML = '<p style="color:var(--gb-red)">Review failed: ' + escapeHtml((res.j && res.j.error) || 'unknown error') + '</p>';
              rerunBtn.style.display = '';
              return;
            }
            var footer = res.j.cached
              ? '<p style="color:var(--gb-overlay2);font-size:11px;margin-top:18px;padding-top:10px;border-top:1px solid var(--gb-overlay0)">Saved review &middot; press &#8635; Re-run to regenerate with Opus.</p>'
              : '';
            b.innerHTML = '<div class="review-md">' + renderMarkdown(res.j.markdown || '(empty review)') + '</div>' + footer;
            rerunBtn.style.display = '';
          });
        })
        .catch(function(err) {
          stopProgress();
          var b = document.getElementById('reviewModalBody');
          if (b) b.innerHTML = '<p style="color:var(--gb-red)">Review failed: ' + escapeHtml(String(err)) + '</p>';
          rerunBtn.style.display = '';
        });
    }

    rerunBtn.onclick = function() { loadReview(true); };
    loadReview(false);
  };

  window.toggleManageMode = function() {
    sessionManageMode = !sessionManageMode;
    var btn = document.getElementById('manageToggle');
    if (btn) btn.textContent = sessionManageMode ? 'Done' : 'Manage';
    loadSessionList();
  };

  window.updateBulkBar = function() {
    var bar = document.getElementById('sessionBulkBar');
    if (!bar) return;
    if (!sessionManageMode) { bar.style.display = 'none'; return; }

    var checked = document.querySelectorAll('.session-select-cb:checked');
    if (checked.length === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    bar.innerHTML = '<span>' + checked.length + ' selected</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="selectAllSessions()">Select All</button>' +
      '<button class="btn btn-sm" style="background:var(--gb-red);color:#fff;border:none;margin-left:auto" onclick="deleteSelectedSessions()">Delete Selected</button>';
  };

  window.selectAllSessions = function() {
    var cbs = document.querySelectorAll('.session-select-cb');
    var allChecked = Array.from(cbs).every(function(cb) { return cb.checked; });
    cbs.forEach(function(cb) { cb.checked = !allChecked; });
    updateBulkBar();
  };

  // Inline confirmation (WKWebView blocks confirm()/alert())
  function showConfirmBar(message, onConfirm) {
    var bar = document.getElementById('sessionBulkBar');
    if (!bar) return;
    bar.style.display = 'flex';
    bar.className = 'session-confirm-bar';
    bar.innerHTML = '<span style="flex:1">' + escapeHtml(message) + '</span>' +
      '<button class="btn btn-ghost btn-sm" id="confirmCancel">Cancel</button>' +
      '<button class="btn btn-sm" style="background:var(--gb-red);color:#fff;border:none" id="confirmYes">Delete</button>';
    document.getElementById('confirmCancel').onclick = function() {
      bar.className = 'session-bulk-bar';
      updateBulkBar();
    };
    document.getElementById('confirmYes').onclick = function() {
      bar.className = 'session-bulk-bar';
      onConfirm();
    };
  }

  window.deleteSession = function(id, title) {
    showConfirmBar('Delete "' + title + '"?', function() {
      fetch('/sessions/' + id, { method: 'DELETE' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            var item = document.querySelector('[data-session-id="' + id + '"]');
            if (item) item.remove();
            var remaining = document.querySelectorAll('.session-item');
            if (remaining.length === 0) {
              var el = document.getElementById('sessionListItems');
              if (el) el.innerHTML = '<p style="color:var(--gb-overlay2);text-align:center;padding:20px">No sessions found.</p>';
              var manageBtn = document.getElementById('manageToggle');
              if (manageBtn) manageBtn.style.display = 'none';
            }
            updateBulkBar();
          }
        });
    });
  };

  window.deleteSelectedSessions = function() {
    var checked = document.querySelectorAll('.session-select-cb:checked');
    var ids = Array.from(checked).map(function(cb) { return cb.dataset.id; });
    if (ids.length === 0) return;

    showConfirmBar('Delete ' + ids.length + ' session(s)? This cannot be undone.', function() {
      fetch('/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids }),
      }).then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.deleted && data.deleted.length > 0) {
            loadSessionList();
          }
        });
    });
  };

  // ─── WebSocket ────────────────────────────────────────────
  var wsRetries = 0;
  var maxRetries = 20;

  // Returns true only when the message was actually handed to an OPEN socket —
  // callers use this to give honest feedback instead of pretending it sent.
  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
        return true;
      } catch (e) {
        console.warn('[WS] Send failed:', msg.type, e);
        return false;
      }
    }
    console.warn('[WS] Not connected, cannot send:', msg.type);
    // Try reconnecting
    if (!ws || ws.readyState === WebSocket.CLOSED) connectWS();
    return false;
  }

  // Fetch the server's current action set and (re)render — renderAction is
  // idempotent by id, so this is safe on initial load AND on WS reconnect
  // (cards suggested while the socket was down would otherwise be lost).
  function refreshActions() {
    fetch('/present/actions')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.actions && data.actions.length > 0) {
          data.actions.forEach(renderAction);
        }
      })
      .catch(function() {});
  }

  function connectWS() {
    if (isReplay) return;

    var port = window.location.port || '17890';
    ws = new WebSocket('ws://localhost:' + port);

    ws.onopen = function() {
      wsRetries = 0;
      statusDot.className = 'status-dot connected';
      // A reconnect means the server may have restarted, or been away long
      // enough for the vault's theme to have moved. Cheap when nothing changed.
      if (window.refreshVaultLook) window.refreshVaultLook();
      // Enable start button if on idle screen (respects agenda extraction state)
      refreshStartButton();
      var connMsg = idleOverlay.querySelector('p[style*="red"]');
      if (connMsg) connMsg.remove();
      // Check current session state. The session.state snapshot the server
      // sends on connect carries the authoritative startedAt — no client-side
      // Date.now() guessing (a refresh used to reset the timer + skew Pace).
      fetch('/health').then(function(r) { return r.json(); }).then(function(d) {
        if (d.session) {
          sessionState = 'live';
          sessionId = d.session;
          // Load existing transcript from server so refresh doesn't lose history
          fetch('/transcript').then(function(r) { return r.json(); }).then(function(t) {
            if (t.segments && t.segments.length > 0) {
              // Clear any duplicates from WS messages received during fetch
              transcriptFeed.innerHTML = '';
              segments = [];
              segById.clear();
              totalWords = 0; micWords = 0; meetingWords = 0;
              t.segments.forEach(function(seg) { addSegment(seg); });
              // Segments prepend in live mode, so newest is already at the top.
              setTimeout(function() { transcriptFeed.scrollTop = 0; }, 100);
            }
          }).catch(function() {});
          // Re-fetch action cards — anything suggested/completed while the
          // socket was down would otherwise be lost until a full reload.
          refreshActions();
        }
        updateUI();
      }).catch(function() { updateUI(); });
    };

    ws.onclose = function() {
      statusDot.className = 'status-dot disconnected';
      if (wsRetries < maxRetries) {
        wsRetries++;
        var delay = Math.min(1000 * Math.pow(1.5, wsRetries), 30000);
        setTimeout(connectWS, delay);
      }
    };

    ws.onerror = function() {};

    ws.onmessage = function(evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      switch (msg.type) {
        case 'session.state':
          sessionState = msg.state;
          sessionId = msg.sessionId || sessionId;
          // Adopt the server's authoritative start time whenever it sends one.
          if (typeof msg.startedAt === 'number' && msg.startedAt > 0) {
            sessionStartTime = msg.startedAt;
          }
          // Manage the wrap-up watchdog: arm it on 'ending', disarm on any
          // terminal/other state so it can't fire after the session resolves.
          if (msg.state === 'ending') {
            endingMessage = msg.message || 'Wrapping up…';
            armEndingWatchdog();
          } else {
            endingMessage = '';
            disarmEndingWatchdog();
          }
          if (msg.state === 'live' && !sessionStartTime) {
            // Fallback for old servers that don't send startedAt.
            sessionStartTime = Date.now();
          }
          if (msg.state === 'live') {
            startTimer();
            if (pendingGoals) {
              wsSend({ type: 'meeting.goals', goals: pendingGoals });
              pendingGoals = '';
            }
          } else if (msg.state === 'archived') {
            // Session just ended — keep transcript visible so the user can
            // review what was said. Only stop the running clock. Agenda
            // tracking is live-only; clear the panel so stale coverage
            // doesn't sit in the TOC after the meeting ends.
            stopTimer();
            clearAgenda();
          } else if (msg.state === 'idle') {
            // Hard reset for a new meeting (user clicked "New Meeting").
            stopTimer();
            sessionStartTime = null;
            totalWords = 0; micWords = 0; meetingWords = 0;
            segments = [];
            segById.clear();
            transcriptFeed.innerHTML = '';
            segCountEl.textContent = '0';
            clearAgenda();
            resultsEl.innerHTML = '';
            optimisticCards.forEach(function(entry) { clearTimeout(entry.timer); });
            optimisticCards.clear();
            actionCards.clear();
            factFlagCards.clear();
            autoScroll = true;
            unseenSegments = 0;
            updateNewSegPill();
            showAllSegments = false;
            window.dismissCoach();
          }
          updateUI();
          break;

        case 'transcript.update':
          if (msg.segment) addSegment(msg.segment);
          flashAudioIndicator();
          break;

        case 'action.suggested':
          if (msg.action) {
            // Announce genuinely-new suggestions to screen readers (streaming
            // updates re-fire this message with the same id — announce once).
            if (!actionCards.has(msg.action.id) && !announcedSuggestions.has(msg.action.id)) {
              announcedSuggestions.add(msg.action.id);
              var srEl = document.getElementById('srAnnouncer');
              if (srEl) srEl.textContent = 'New suggestion: ' + (msg.action.title || msg.action.type);
            }
            var sa = {
              id: msg.action.id,
              type: msg.action.type,
              title: msg.action.title,
              description: msg.action.description,
              triggerQuote: msg.action.triggerQuote,
              estimatedDurationSec: msg.action.estimatedDurationSec,
              state: msg.action.state || 'suggested',
              completedAt: null,
              result: null,
              streaming: msg.action.streaming,
              paramsReady: msg.action.paramsReady,
              pendingApproval: msg.action.pendingApproval,
            };
            // While streaming, grow the existing card in place (stable Approve
            // button); for a new card or the final settle, do a full render.
            if (sa.streaming && actionCards.get(sa.id)) updateStreamingCardInPlace(sa);
            else renderAction(sa);
          }
          break;

        case 'intelligence.status':
          setIntelPhase(msg.phase);
          break;

        case 'feature.state':
          if (msg.features) {
            featureState = msg.features;
            refreshQuickActions();
          }
          break;

        case 'factcheck.flag':
          if (msg.flag) renderFactFlag(msg.flag);
          break;

        case 'coach.suggestion':
          if (msg.suggestion) renderCoachSuggestion(msg.suggestion);
          break;

        case 'intelligence.error':
          noteIntelError(msg);
          break;

        case 'action.status':
          // Server echoed a state change — the optimistic click (if any) is
          // reconciled; renderAction below repaints the card authoritatively.
          clearOptimistic(msg.actionId);
          if (msg.state === 'expired') {
            // Server expired it — a pending local dismissal is now moot.
            var pendingExpired = pendingDismissals.get(msg.actionId);
            if (pendingExpired) {
              clearTimeout(pendingExpired.timer);
              pendingDismissals.delete(msg.actionId);
            }
            var expiredCard = actionCards.get(msg.actionId);
            if (expiredCard) {
              expiredCard.classList.add('fade-out');
              setTimeout(function () {
                expiredCard.remove();
                actionCards.delete(msg.actionId);
                rebuildToc();
              }, 350); // match the CSS transition
            }
            break;
          }
          // 'suggested' (incl. streaming + pre-approval) updates arrive via
          // action.suggested, which preserves the growing card text. Skip here
          // so this DOM-derived re-render doesn't wipe the streamed description.
          if (msg.state === 'suggested') break;
          var existing = actionCards.get(msg.actionId);
          if (existing) {
            // Re-render with updated state
            renderAction({
              id: msg.actionId,
              type: existing.querySelector('.card-type') ? existing.querySelector('.card-type').textContent : '',
              title: existing.querySelector('.card-title') ? existing.querySelector('.card-title').textContent : '',
              description: '',
              state: msg.state,
              result: msg.result || null,
              completedAt: msg.state === 'completed' || msg.state === 'failed' ? new Date().toISOString() : null,
            });
          }
          break;

        case 'agenda.status':
          if (msg.status) renderAgendaStatus(msg.status);
          break;

        case 'action.stream':
          var streamCard = actionCards.get(msg.actionId);
          if (streamCard) {
            var streamText = streamCard.querySelector('.streaming-text');
            if (streamText) {
              // Hide the "Running..." placeholder on the first delta.
              var placeholder = streamCard.querySelector('.streaming-placeholder');
              if (placeholder && !streamText._md) placeholder.style.display = 'none';
              // Accumulate raw markdown on the element; render it formatted,
              // throttled to one paint per frame (the box stays fixed-height +
              // scrollable, following the stream unless the user scrolls up).
              streamText._md = (streamText._md || '') + msg.delta;
              streamPending.add(streamText);
              scheduleStreamRender();
            }
          }
          break;
      }
    };
  }

  // ─── SSE Fallback (for replay or if WS unavailable) ───────
  function connectSSE() {
    var source = new EventSource('/present/events');
    source.addEventListener('action.suggested', function(e) { renderAction(JSON.parse(e.data)); });
    source.addEventListener('action.completed', function(e) { renderAction(JSON.parse(e.data)); });
    source.addEventListener('action.running', function(e) { renderAction(JSON.parse(e.data)); });
    source.onopen = function() { statusDot.className = 'status-dot connected'; };
    source.onerror = function() { statusDot.className = 'status-dot disconnected'; };
  }

  // ─── Init ─────────────────────────────────────────────────
  if (isReplay) {
    // Replay mode: load from stored session
    sessionState = 'archived';
    statePill.className = 'state-pill archived';
    statePill.textContent = 'Replay';
    startStopBtn.style.display = 'none';

    // Load actions
    fetch('/present/actions?session=' + encodeURIComponent(replaySessionId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.actions && data.actions.length > 0) {
          data.actions.forEach(renderAction);
        }
        headerTitle.innerHTML = '<span style="cursor:pointer;color:var(--gb-blue);margin-right:8px" onclick="window.location.href=\\'/present\\'">&larr; Back</span> Session Replay';
      });

    // Load transcript
    fetch('/present/transcript?session=' + encodeURIComponent(replaySessionId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.segments) {
          sessionStartTime = data.startedAt || (data.segments.length > 0 ? data.segments[0].timestamp : null);
          data.segments.forEach(function(seg) { addSegment(seg); });
          // Scroll transcript to bottom for replay (delay for DOM render)
          setTimeout(function() { transcriptFeed.scrollTop = transcriptFeed.scrollHeight; }, 100);
          sessionTimerEl.textContent = segments.length > 0 ? formatDuration(
            (segments[segments.length-1].timestamp || 0) - (sessionStartTime || 0)
          ) : '';
        }
      });

    layout.className = 'layout three-col';
    statsBar.className = 'stats-bar visible';
    connectSSE();
  } else {
    // Live mode
    updateUI();
    connectWS();

    // Also load any existing live actions
    refreshActions();
  }
})();
<\/script>
</body>
</html>`;
