import { Router, type Response } from 'express';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import type { WorkerRegistry } from '../workers/registry.js';
import type { ActionLifecycle } from '../workers/types.js';
import { isOpenAiApiAvailable, openaiFastResearchStream } from '../api/openai.js';
import { isAnthropicApiAvailable, anthropicTriageJson } from '../api/anthropic.js';

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
};

function buildAskUserContent(params: { selection: string; context: string; question: string }): string {
  const parts = [`Highlighted text:\n"${params.selection}"`];
  if (params.context) parts.push(`Surrounding transcript:\n${params.context}`);
  if (params.question) parts.push(`Question: ${params.question}`);
  return parts.join('\n\n');
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
  router.get('/present', (_req, res) => {
    res.type('html').send(PRESENT_HTML);
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

  // ─── POST /present/ask — highlight-to-ask (fact check / explain / custom) ─
  // Streams SSE-style lines over the POST response, same protocol the
  // ask-widget uses: `event: token|error|done` + `data: {...}`.
  router.post('/present/ask', async (req, res) => {
    const body = (req.body ?? {}) as { mode?: string; selection?: string; context?: string; question?: string };
    const mode = body.mode && ASK_SYSTEM[body.mode] ? body.mode : null;
    const selection = (body.selection ?? '').toString().slice(0, 1_500).trim();
    const context = (body.context ?? '').toString().slice(0, 4_000).trim();
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
        send('error', { message: 'No API key configured — set OPENAI_API_KEY or ANTHROPIC_API_KEY in ~/.meeting-copilot/.env' });
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Meeting Copilot</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"><\/script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/gruvbox-light.min.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>
  /* ─── CXMail palette (warm neutrals + iOS-blue accent) ───────
     Light-only by design. 'color-scheme: light' pins native UA
     surfaces (scrollbars, form controls, highlight.js fallback)
     even when the OS is in dark mode.
     Variable names kept as --gb-* so the 1,000+ CSS rules below
     don't need renaming.
     Note: --gb-green is repointed to iOS blue so "LIVE/connected/
     success" semantics use blue accents instead of green.          */
  :root {
    color-scheme: light;
    /* Backgrounds (warm cream, light) */
    --gb-base:     rgb(251,248,243);
    --gb-mantle:   rgb(248,243,235);
    --gb-crust:    rgb(241,234,223);
    --gb-surface0: rgb(245,239,228);
    --gb-surface1: rgb(241,234,223);
    --gb-surface2: rgb(213,205,189);
    /* Overlays / muted text ramp */
    --gb-overlay0: rgb(213,205,189);
    --gb-overlay1: rgb(155,148,135);
    --gb-overlay2: rgb(115,108,95);
    --gb-text:     rgb(30,25,15);
    --gb-subtext0: rgb(70,60,45);
    --gb-subtext1: rgb(100,90,75);
    /* Semantic (constant across modes) */
    --gb-red:      rgb(212,118,106); /* warm coral error    */
    --gb-maroon:   rgb(190,90,80);
    --gb-peach:    rgb(212,150,110);
    --gb-yellow:   rgb(212,168,90);  /* warm gold warning   */
    --gb-green:    rgb(20,18,14);    /* success → near-black (no blue/green in UI) */
    --gb-teal:     rgb(30,25,15);
    --gb-sky:      rgb(30,25,15);
    --gb-sapphire: rgb(20,18,14);
    --gb-blue:     rgb(20,18,14);    /* accent → near-black */
    /* Warm-neutral variants of CXMail ai-accent for signal colors */
    --gb-lavender: rgb(180,160,140);
    --gb-mauve:    rgb(200,150,130);
    --gb-pink:     rgb(210,160,150);
    --gb-rosewater:rgb(200,170,150);
    --gb-flamingo: rgb(210,170,160);
    /* Accent polish tokens */
    --accent:       var(--gb-blue);
    --accent-hover: rgb(60,55,45);
    --accent-soft:  color-mix(in srgb, var(--gb-blue) 10%, transparent);
    --focus-ring:   color-mix(in srgb, var(--gb-blue) 28%, transparent);
  }


  * { margin:0; padding:0; box-sizing:border-box; }

  body {
    font-family: 'JetBrains Mono', monospace;
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
  .status-dot.connected { background: var(--gb-green); animation: pulse 2s ease-in-out infinite; }
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
  .state-pill.live { background: var(--gb-blue); }
  .state-pill.priming, .state-pill.ending {
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent);
  }
  .state-pill.degraded { background: var(--gb-yellow); }
  .state-pill.error { background: var(--gb-red); }
  .state-pill.archived { background: var(--gb-subtext0); }

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
    font-family: 'JetBrains Mono', monospace;
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

  .btn-green { background: var(--gb-green); color: white; }
  .btn-red { background: var(--gb-red); color: white; }
  .btn-blue { background: var(--gb-blue); color: white; }
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
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-radius: 6px;
    padding: 8px 14px;
    text-align: center;
  }
  .stat-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--gb-overlay2);
  }
  .stat-value {
    font-size: 18px;
    font-weight: 700;
    color: var(--gb-text);
    line-height: 1.2;
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
    font-family: 'JetBrains Mono', monospace;
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
    font-family: 'JetBrains Mono', monospace;
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

  .seg {
    padding: 5px 8px;
    border-left: 3px solid transparent;
    margin-bottom: 4px;
    border-radius: 0 4px 4px 0;
    transition: background 0.1s;
  }
  .seg:hover { background: var(--gb-surface0); }
  .seg.mic { border-left-color: var(--gb-blue); }
  .seg.meeting { border-left-color: var(--gb-yellow); }

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
  .seg-source.mic { background: rgba(69,133,136,0.12); color: var(--gb-blue); }
  .seg-source.meeting { background: rgba(215,153,33,0.12); color: var(--gb-yellow); }

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
  .signal-tag.action { background: rgba(20,18,14,0.08); color: var(--gb-green); }
  .signal-tag.decision { background: rgba(69,133,136,0.12); color: var(--gb-blue); }
  .signal-tag.question { background: rgba(146,111,175,0.12); color: var(--gb-lavender); }
  .signal-tag.risk { background: rgba(204,36,29,0.12); color: var(--gb-red); }

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
    font-family: 'JetBrains Mono', monospace;
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
    border-color: var(--accent);
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
    font-family: 'JetBrains Mono', monospace;
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
    background: rgba(69,133,136,0.12);
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
  .ctx-remove:hover { color: var(--gb-red); background: rgba(204,36,29,0.08); }
  .ctx-add-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .ctx-add-btn {
    font-family: 'JetBrains Mono', monospace;
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
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 5px 8px;
    border: 1px solid var(--gb-blue);
    border-radius: 5px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
  }
  .ctx-input-row button {
    font-family: 'JetBrains Mono', monospace;
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
    background: rgba(20,18,14,0.04);
  }

  .idle-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    margin-top: 16px;
  }

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
  .session-item:hover { background: var(--gb-surface1); border-left-color: var(--accent); }
  .session-item-title { font-weight: 600; color: var(--gb-text); font-size: 13px; }
  .session-item-meta { font-size: 11px; color: var(--gb-subtext0); }
  .session-item-stats { font-size: 10px; color: var(--gb-overlay2); text-align: right; }
  .session-delete-btn {
    background: none; border: none; color: var(--gb-overlay2); cursor: pointer;
    font-size: 14px; padding: 4px 8px; border-radius: 4px; transition: all 0.15s;
    flex-shrink: 0; margin-left: 8px;
  }
  .session-delete-btn:hover { background: var(--gb-red); color: #fff; }
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
    box-shadow: 0 6px 14px -12px rgba(20,18,14,0.45);
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
    font-family: 'JetBrains Mono', monospace;
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
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 16px;
    transition: border-color 0.2s;
  }
  .card.suggested { border-color: var(--gb-yellow); background: rgba(215,153,33,0.05); }
  .card.running { border-color: var(--gb-blue); animation: border-pulse 1.5s ease-in-out infinite; }
  @keyframes border-pulse { 0%,100%{border-color:var(--gb-blue)} 50%{border-color:var(--gb-surface2)} }
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
  .card-type.research { background: rgba(20,18,14,0.08); color: var(--gb-green); }
  .card-type.summary { background: rgba(215,153,33,0.12); color: var(--gb-yellow); }
  .card-type.mockup { background: rgba(177,98,134,0.12); color: var(--gb-mauve); }
  .card-type.codegen { background: rgba(69,133,136,0.12); color: var(--gb-blue); }
  .card-type.analysis { background: rgba(214,93,14,0.12); color: var(--gb-peach); }
  .card-type.failed { background: rgba(204,36,29,0.12); color: var(--gb-red); }

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
  .card-body h1 { color: var(--gb-red); font-size: 18px; font-weight: 700; margin-top: 16px; margin-bottom: 6px; }
  .card-body h2 { color: var(--gb-peach); font-size: 15px; font-weight: 700; margin-top: 14px; margin-bottom: 6px; }
  .card-body h3 { color: var(--gb-sky); font-size: 14px; font-weight: 600; margin-top: 12px; margin-bottom: 4px; }
  .card-body h4 { color: var(--gb-blue); font-size: 13px; font-weight: 600; margin-top: 10px; margin-bottom: 4px; }
  .card-body p { margin-bottom: 8px; }
  .card-body ul, .card-body ol { padding-left: 18px; margin-bottom: 8px; }
  .card-body li { margin-bottom: 3px; }
  .card-body strong { color: var(--gb-text); }
  .card-body a { color: var(--gb-blue); text-decoration: none; }
  .card-body a:hover { text-decoration: underline; }
  .card-body pre { background: var(--gb-surface1); border: 1px solid var(--gb-surface2); border-radius: 5px; padding: 12px; overflow-x: auto; margin: 10px 0; font-size: 12px; line-height: 1.5; }
  .card-body code { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .card-body :not(pre) > code { background: var(--gb-surface1); color: var(--gb-peach); padding: 1px 5px; border-radius: 3px; }
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
    box-shadow: 0 10px 24px -12px rgba(20,18,14,0.6);
    animation: toast-in 0.25s ease-out;
  }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .toast-msg { flex: 1; line-height: 1.4; min-width: 0; }
  .toast-undo {
    font-family: 'JetBrains Mono', monospace;
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
    font-family: 'JetBrains Mono', monospace;
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
    background: rgba(215,153,33,0.08);
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
  .card.factflag { border-color: var(--gb-red); background: rgba(204,36,29,0.04); }
  .card-type.factcheck { background: rgba(204,36,29,0.12); color: var(--gb-red); }
  .toc-badge.factcheck { background: rgba(204,36,29,0.15); color: var(--gb-red); }
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
    box-shadow: 0 10px 28px -10px rgba(20,18,14,0.4);
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
    font-family: 'JetBrains Mono', monospace;
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
  .askmenu-input-row textarea:focus { border-color: var(--accent); }

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
    box-shadow: 0 18px 44px -16px rgba(20,18,14,0.5);
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
  .seg.newest { background: rgba(215,153,33,0.09); }
  .transcript-order {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 1px 7px;
    border-radius: 8px;
    margin-left: 6px;
    background: rgba(20,18,14,0.08);
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
  .toc-badge.research { background: rgba(20,18,14,0.10); color: var(--gb-green); }
  .toc-badge.summary { background: rgba(215,153,33,0.15); color: var(--gb-yellow); }
  .toc-badge.mockup { background: rgba(177,98,134,0.15); color: var(--gb-mauve); }
  .toc-badge.codegen { background: rgba(69,133,136,0.15); color: var(--gb-blue); }
  .toc-badge.analysis { background: rgba(214,93,14,0.15); color: var(--gb-peach); }

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
  .toc-heading.active { color: var(--gb-text); background: rgba(69,133,136,0.1); border-left: 2px solid var(--gb-blue); padding-left: 16px; }
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
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    padding: 0 4px;
  }
  .agenda-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-overlay2);
  }
  .agenda-progress {
    font-size: 10px;
    color: var(--gb-subtext0);
    font-weight: 600;
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
    background: rgba(204,36,29,0.08);
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
    </span>
    <span class="state-pill idle" id="statePill">Idle</span>
    <span class="session-timer" id="sessionTimer"></span>
    <button class="btn btn-ghost" id="newMeetingBtn" style="display:none" onclick="newMeeting()">&larr; New Meeting</button>
    <button class="btn btn-green" id="startStopBtn" style="display:none" onclick="toggleSession()">Start</button>
  </div>
</div>

<!-- ─── Stats Bar ──────────────────────────────────────────── -->
<div class="stats-bar" id="statsBar">
  <div class="stat-tile"><div class="stat-label">Words</div><div class="stat-value" id="statWords">0</div></div>
  <div class="stat-tile"><div class="stat-label">Pace</div><div class="stat-value" id="statPace">0/m</div></div>
  <div class="stat-tile"><div class="stat-label">You</div><div class="stat-value" id="statYou">0</div></div>
  <div class="stat-tile"><div class="stat-label">Meeting</div><div class="stat-value" id="statMeeting">0</div></div>
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
    <div class="transcript-feed" id="transcriptFeed"></div>
  </div>

  <!-- Main Column -->
  <div class="main" id="mainCol">
    <div id="idleOverlay"></div>
    <div id="quickActionsSlot"></div>
    <div class="intel-status" id="intelStatus" style="display:none">
      <span class="intel-dot"></span>
      <span id="intelStatusText">Listening</span>
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

<div class="toast-stack" id="toastStack"></div>

<script>
(function() {
  // ─── DOM Refs ───────────────────────────────────────────────
  var statusDot = document.getElementById('statusDot');
  var headerTitle = document.getElementById('headerTitle');
  var statePill = document.getElementById('statePill');
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
  var timerInterval = null;
  var totalWords = 0;
  var micWords = 0;
  var meetingWords = 0;
  var segments = [];
  var currentFilter = 'all';
  var autoScroll = true;
  var actionCards = new Map();
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
    btn.disabled = !wsConnected || agendaState.kind === 'extracting';
  }

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
    var textarea = '<textarea id="startAgenda" rows="5" placeholder="Confirm Q1 hiring plan&#10;Review campaign results&#10;Paste notes / a prep doc and click Extract" oninput="onAgendaTextareaInput()"' + readonly + '>' + escapeHtml(value) + '</textarea>';
    var helper = '<div class="agenda-helper">One item per line, or paste notes / a prep doc and click Extract.</div>';

    var buttonLabel, disabled = '';
    if (agendaState.kind === 'extracting') {
      buttonLabel = '<span class="agenda-edit-spinner"></span>Extracting…';
      disabled = ' disabled';
    } else {
      buttonLabel = 'Extract items from notes';
      if (!(agendaRawSnapshot && agendaRawSnapshot.trim())) disabled = ' disabled';
    }

    var status = '';
    if (agendaState.kind === 'empty') {
      status = '<span class="agenda-edit-status empty">' + escapeHtml(agendaState.message || 'No items found — edit and try again, or start with the raw text.') + '</span>';
    } else if (agendaState.kind === 'error') {
      status = '<span class="agenda-edit-status error">' + escapeHtml(agendaState.message || 'Extraction failed.') + '</span>';
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
        setAgendaState({ kind: 'error', message: res.data.error || 'Extraction failed' });
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
  var actionMarkers = ['action item','follow up','next step','send','share','create','draft','schedule','update','write','review','prepare','need to',"let's",'we should',"i'll",'i will','can you','could you','own that','take that'];
  var decisionMarkers = ['we decided','decision','agreed','approved',"we'll go with","let's do",'locking','move forward with','ship this','finalize'];
  var blockerMarkers = ['blocker','blocked','risk','concern','issue','problem',"can't",'cannot','stuck','delay','slip','waiting on'];
  var questionStarts = ['what','why','how','when','where','who','should','can','could','would','do we','are we'];

  function detectSignals(text) {
    var lower = text.toLowerCase();
    var signals = [];
    for (var i = 0; i < actionMarkers.length; i++) { if (lower.includes(actionMarkers[i])) { signals.push('action'); break; } }
    for (var i = 0; i < decisionMarkers.length; i++) { if (lower.includes(decisionMarkers[i])) { signals.push('decision'); break; } }
    for (var i = 0; i < blockerMarkers.length; i++) { if (lower.includes(blockerMarkers[i])) { signals.push('risk'); break; } }
    if (lower.includes('?')) {
      for (var i = 0; i < questionStarts.length; i++) { if (lower.startsWith(questionStarts[i]) || lower.includes(' ' + questionStarts[i] + ' ')) { signals.push('question'); break; } }
    }
    return signals;
  }

  // ─── Agenda Tracker ────────────────────────────────────────
  function renderAgendaStatus(status) {
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
    if (typeof marked !== 'undefined') return marked.parse(text);
    return '<pre>' + escapeHtml(text) + '</pre>';
  }

  function highlightCode() {
    if (typeof hljs !== 'undefined') {
      document.querySelectorAll('.card-body pre code:not(.hljs)').forEach(function(b) { hljs.highlightElement(b); });
    }
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
      }
    }, 1000);
  }
  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  // ─── Stats ─────────────────────────────────────────────────
  function updateStats() {
    document.getElementById('statWords').textContent = totalWords;
    document.getElementById('statYou').textContent = micWords;
    document.getElementById('statMeeting').textContent = meetingWords;
    var elapsed = sessionStartTime ? (Date.now() - sessionStartTime) / 60000 : 1;
    var pace = elapsed > 0.5 ? Math.round(totalWords / elapsed) : 0;
    document.getElementById('statPace').textContent = pace + '/m';
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

  // ─── UI State Transitions ─────────────────────────────────
  function updateUI() {
    // State pill
    statePill.className = 'state-pill ' + sessionState;
    statePill.textContent = sessionState.charAt(0).toUpperCase() + sessionState.slice(1);

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
      '<div class="idle-actions">' +
        '<button class="btn btn-green" id="startBtn" onclick="startSession()"' + btnDisabled + '>Start Session</button>' +
      '</div>' +
      statusMsg +
      '<span class="sessions-link" onclick="showSessionHistory()">View Past Sessions</span>' +
    '</div></div>';

    // Populate context list and agenda editor after DOM is built
    renderContextList();
    renderAgendaEditor();
  }

  function showQuickActions() {
    quickActionsSlot.innerHTML = '<div class="quick-actions">' +
      '<div class="qa-title-row">' +
        '<div class="quick-actions-title">Quick Actions</div>' +
        '<div class="monitor-toggles">' +
          '<button class="monitor-toggle' + (featureState.factcheck ? ' on' : '') + '" onclick="toggleFeature(\\'factcheck\\')" title="Live fact-checking of claims \u2014 extra API cost while on">Fact-check: ' + (featureState.factcheck ? 'On' : 'Off') + '</button>' +
          '<button class="monitor-toggle' + (featureState.coach ? ' on' : '') + '" onclick="toggleFeature(\\'coach\\')" title="Suggests high-priority things to say \u2014 extra API cost while on">Coach: ' + (featureState.coach ? 'On' : 'Off') + '</button>' +
        '</div>' +
      '</div>' +
      '<input class="quick-actions-input" id="quickPrompt" placeholder="Topic or prompt (optional)...">' +
      '<div class="quick-actions-row">' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'fast-research\\')" title="Haiku, streaming">\u26A1 Fast</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'research\\')">Research</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'summary\\')">Summary</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'analysis\\')">Analysis</button>' +
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
      // Optimistic UI: the server may take several seconds to finish stopping
      // (auto-summary, action completion, etc.) before it broadcasts
      // session.state=archived. Flip to "ending" immediately so the user
      // sees their click register; the authoritative broadcast will settle
      // the final state when the server catches up.
      sessionState = 'ending';
      // Freeze the displayed duration at end-press. The server may take
      // many seconds (auto-summary + up to 60s worker grace period) before
      // it broadcasts session.state=archived, and the meeting is logically
      // over the moment the user clicks End.
      stopTimer();
      updateUI();
      if (hasNativeBridge()) {
        window.__copilotNativeBridge.stopSession();
      } else {
        wsSend({ type: 'session.stop' });
      }
    } else {
      // Start with values from form if available, otherwise empty
      startSession();
    }
  };

  window.startSession = function() {
    // Block start while an extraction is in flight — Start Session must not
    // race against an about-to-settle extract.
    if (agendaState.kind === 'extracting') return;

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
    t.className = 'toast';

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

  var ACTION_LABELS = { 'fast-research': 'Fast research', research: 'Research', summary: 'Summary', analysis: 'Analysis' };

  window.triggerAction = function(type) {
    var prompt = (document.getElementById('quickPrompt') || {}).value || '';
    wsSend({ type: 'action.trigger', actionType: type, prompt: prompt || undefined });
    var el = document.getElementById('quickPrompt');
    if (el) el.value = '';
    showToast((ACTION_LABELS[type] || type) + ' queued');
  };

  window.approveAction = function(id) { wsSend({ type: 'action.approve', actionId: id }); };

  // Dismissal is irreversible once the server hears about it, so hide the
  // card locally first and only send action.dismiss after the undo window.
  var DISMISS_UNDO_MS = 5000;
  var pendingDismissals = new Map(); // actionId -> { timer }

  window.dismissAction = function(id) {
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
      wsSend({ type: 'action.dismiss', actionId: id });
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

  window.cancelAction = function(id) { wsSend({ type: 'action.cancel', actionId: id }); };

  // ─── Highlight-to-Ask (transcript selection) ──────────────
  // Highlight transcript text → right-click → Fact check / Explain / Custom
  // prompt. Opens a floating panel anchored to the selection that streams
  // the answer from POST /present/ask. Same interaction as ask-widget.
  var askSel = null;
  var askAbort = null;
  var askMenuEl, askMenuInputRow, askMenuInput;
  var askPanelEl, askPanelEyebrow, askPanelQuote, askPanelBody;
  var ASK_LABELS = { factcheck: 'Fact check', explain: 'Explain', custom: 'Your question' };

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

  buildAskUi();
  transcriptFeed.addEventListener('contextmenu', function(e) {
    var captured = captureTranscriptSelection();
    if (!captured) { hideAskMenu(); return; }
    askSel = captured;
    e.preventDefault();
    showAskMenu(e.clientX, e.clientY);
  });
  document.addEventListener('mousedown', function(e) {
    if (askMenuEl && askMenuEl.style.display === 'block' && !askMenuEl.contains(e.target)) hideAskMenu();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (askMenuEl && askMenuEl.style.display === 'block') hideAskMenu();
    else if (askPanelEl && askPanelEl.classList.contains('open')) closeAskPanel();
  });

  // ─── Transcript ───────────────────────────────────────────
  function addSegment(seg) {
    segments.push(seg);
    var wc = seg.wordCount || (seg.text ? seg.text.split(/\\s+/).filter(Boolean).length : 0);
    totalWords += wc;
    if (seg.source === 'mic') micWords += wc;
    else meetingWords += wc;

    segCountEl.textContent = segments.length;
    updateStats();
    renderSegment(seg);
  }

  function renderSegment(seg) {
    if (!seg.text || seg.text.trim() === '') return;

    var srcClass = seg.source === 'mic' ? 'mic' : 'meeting';
    var srcLabel = seg.source === 'mic' ? 'You' : 'Meeting';
    var signals = detectSignals(seg.text);
    var ts = formatTimestamp(typeof seg.timestamp === 'string' ? new Date(seg.timestamp).getTime() : seg.timestamp, sessionStartTime);

    var el = document.createElement('div');
    el.className = 'seg ' + srcClass;
    el.dataset.source = seg.source;
    el.dataset.text = seg.text.toLowerCase();

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

    if (isReplay) {
      // Replay reads top-down like a document — keep chronological order.
      transcriptFeed.appendChild(el);
      if (autoScroll) transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
    } else {
      // Live: newest-first so the latest line is always visible without scrolling.
      var prevNewest = transcriptFeed.querySelector('.seg.newest');
      if (prevNewest) prevNewest.classList.remove('newest');
      el.classList.add('newest');
      transcriptFeed.insertBefore(el, transcriptFeed.firstChild);
      if (autoScroll) transcriptFeed.scrollTop = 0;
    }
  }

  window.setFilter = function(filter, btn) {
    currentFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.toggle('active', b === btn); });
    filterTranscript();
  };

  window.filterTranscript = function() {
    var search = (document.getElementById('transcriptSearch') || {}).value || '';
    search = search.toLowerCase();
    transcriptFeed.querySelectorAll('.seg').forEach(function(el) {
      var matchSource = currentFilter === 'all' || el.dataset.source === currentFilter;
      var matchSearch = !search || el.dataset.text.includes(search);
      el.style.display = (matchSource && matchSearch) ? '' : 'none';
    });
  };

  // ─── Action Card Rendering ────────────────────────────────
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
      body = '<div class="card-body"><p>' + escapeHtml(action.description || '') + '</p>';
      if (action.triggerQuote) {
        body += '<div class="card-trigger">"' + escapeHtml(action.triggerQuote.slice(0, 120)) + (action.triggerQuote.length > 120 ? '...' : '') + '"</div>';
      }
      if (!isReplay) {
        body += '<div class="card-actions">' +
          '<button class="btn btn-green" onclick="approveAction(\\'' + action.id + '\\')">Approve</button>' +
          '<button class="btn btn-ghost" onclick="dismissAction(\\'' + action.id + '\\')">Dismiss</button>' +
        '</div>';
      }
      body += '</div>';
    } else if (action.state === 'running') {
      if (isReplay) {
        body = '<div class="card-body"><p style="color:var(--gb-overlay2)">Did not complete during session.</p></div>';
      } else {
        // Streaming-ready running body: placeholder shown until first delta,
        // then the streaming-text div is appended to by the action.stream handler.
        body = '<div class="card-body">' +
          '<div class="streaming-placeholder"><span class="spinner"></span> Running...</div>' +
          '<div class="streaming-text" style="white-space:pre-wrap;font-family:\\'JetBrains Mono\\',monospace;font-size:12px;line-height:1.5;color:var(--gb-text)"></div>' +
          '<div class="card-actions"><button class="btn btn-ghost-red" onclick="cancelAction(\\'' + action.id + '\\')">Cancel</button></div>' +
        '</div>';
      }
    } else if (action.result && action.result.artifacts && action.result.artifacts.length > 0) {
      body = '<div class="card-body">';
      action.result.artifacts.forEach(function(artifact, i) {
        if (i > 0) body += '<div class="artifact-divider"></div>';
        if (artifact.title) body += '<div class="artifact-label">' + escapeHtml(artifact.title) + '</div>';
        if (artifact.type === 'markdown') body += renderMarkdown(artifact.content);
        else if (artifact.type === 'code') body += '<pre><code>' + escapeHtml(artifact.content) + '</code></pre>';
        else body += '<pre>' + escapeHtml(artifact.content) + '</pre>';
      });
      body += '</div>';
    } else if (action.result && action.result.summary) {
      body = '<div class="card-body"><p>' + escapeHtml(action.result.summary) + '</p></div>';
    } else if (action.state === 'failed') {
      var errMsg = (action.result && action.result.error) || 'Unknown error';
      body = '<div class="card-body"><p style="color:var(--gb-red)">' + escapeHtml(errMsg) + '</p></div>';
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
    coachSlot.innerHTML = '<div class="coach-strip">' +
      '<span class="coach-kind">' + escapeHtml(s.kind) + '</span>' +
      '<div class="coach-body">' +
        '<div class="coach-phrasing">' + escapeHtml(s.phrasing) + '</div>' +
        '<div class="coach-why">' + escapeHtml(s.headline) + (s.why ? ' \\u2014 ' + escapeHtml(s.why) : '') + '</div>' +
      '</div>' +
      '<button class="coach-close" onclick="dismissCoach()" title="Dismiss">\\u00d7</button>' +
    '</div>';
    coachExpireTimer = setTimeout(function() { window.dismissCoach(); }, 90000);
  }

  window.dismissCoach = function() {
    if (coachExpireTimer) { clearTimeout(coachExpireTimer); coachExpireTimer = null; }
    coachSlot.innerHTML = '';
  };

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
  window.addEventListener('scroll', function() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function() {
      scrollRaf = null;
      var scrollY = window.scrollY + 120;
      var activeHeadingId = null;
      var activeCardId = null;

      resultsEl.querySelectorAll('.card-body h1[id], .card-body h2[id], .card-body h3[id]').forEach(function(h) {
        if (h.getBoundingClientRect().top + window.scrollY <= scrollY) activeHeadingId = h.id;
      });
      resultsEl.querySelectorAll('.card').forEach(function(c) {
        if (c.getBoundingClientRect().top + window.scrollY <= scrollY) activeCardId = c.id;
      });

      tocEntries.querySelectorAll('.toc-heading').forEach(function(l) {
        l.classList.toggle('active', l.getAttribute('href') === '#' + activeHeadingId);
      });
      tocEntries.querySelectorAll('.toc-card-title').forEach(function(l) {
        l.classList.toggle('active', l.dataset.target === activeCardId);
      });
    });
  });

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
        }

        el.appendChild(item);
      });
      updateBulkBar();
    });
  }

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

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn('[WS] Not connected, cannot send:', msg.type);
      // Try reconnecting
      if (!ws || ws.readyState === WebSocket.CLOSED) connectWS();
    }
  }

  function connectWS() {
    if (isReplay) return;

    var port = window.location.port || '17890';
    ws = new WebSocket('ws://localhost:' + port);

    ws.onopen = function() {
      wsRetries = 0;
      statusDot.className = 'status-dot connected';
      // Enable start button if on idle screen (respects agenda extraction state)
      refreshStartButton();
      var connMsg = idleOverlay.querySelector('p[style*="red"]');
      if (connMsg) connMsg.remove();
      // Check current session state
      fetch('/health').then(function(r) { return r.json(); }).then(function(d) {
        if (d.session) {
          sessionState = 'live';
          sessionId = d.session;
          sessionStartTime = Date.now(); // approximate
          // Load existing transcript from server so refresh doesn't lose history
          fetch('/transcript').then(function(r) { return r.json(); }).then(function(t) {
            if (t.segments && t.segments.length > 0) {
              // Clear any duplicates from WS messages received during fetch
              transcriptFeed.innerHTML = '';
              segments = [];
              totalWords = 0; micWords = 0; meetingWords = 0;
              t.segments.forEach(function(seg) { addSegment(seg); });
              // Segments prepend in live mode, so newest is already at the top.
              setTimeout(function() { transcriptFeed.scrollTop = 0; }, 100);
            }
          }).catch(function() {});
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
          if (msg.state === 'live' && !sessionStartTime) {
            sessionStartTime = Date.now();
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
            transcriptFeed.innerHTML = '';
            segCountEl.textContent = '0';
            clearAgenda();
            resultsEl.innerHTML = '';
            actionCards.clear();
            factFlagCards.clear();
            window.dismissCoach();
          }
          updateUI();
          break;

        case 'transcript.update':
          if (msg.segment) addSegment(msg.segment);
          flashAudioIndicator();
          break;

        case 'action.suggested':
          if (msg.action) renderAction({
            id: msg.action.id,
            type: msg.action.type,
            title: msg.action.title,
            description: msg.action.description,
            triggerQuote: msg.action.triggerQuote,
            estimatedDurationSec: msg.action.estimatedDurationSec,
            state: msg.action.state || 'suggested',
            completedAt: null,
            result: null,
          });
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

        case 'action.status':
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
              // Hide the "Running..." placeholder on first delta
              var placeholder = streamCard.querySelector('.streaming-placeholder');
              if (placeholder && streamText.textContent === '') {
                placeholder.style.display = 'none';
              }
              streamText.textContent += msg.delta;
              // No auto-scroll: with newest-first ordering the streaming card
              // is already at the top, and forcing scroll fights reading.
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
    fetch('/present/actions')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.actions && data.actions.length > 0) {
          data.actions.forEach(renderAction);
        }
      });
  }
})();
<\/script>
</body>
</html>`;
