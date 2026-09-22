import { Router } from 'express';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TranscriptionService } from './transcription/index.js';
import type { IntelligenceEngine } from './intelligence/index.js';
import type { WorkerRegistry } from './workers/registry.js';
import type { DebugHandler } from './debug/index.js';
import type { SessionStore } from './session/store.js';
import type { EventLogger } from './session/events.js';
import { SessionStore as SessionStoreClass } from './session/store.js';
import { cleanupOldSessions } from './session/cleanup.js';
import { setSharingEnabled, isSharingEnabled, appendTranscript } from './session/shared.js';
import { getSettings, updateSettings } from './settings.js';
import { scanProjects } from './project/index.js';
import { suggestProjects } from './project/match.js';
import {
  loadContextConfig,
  saveContextConfig,
  addContextItem,
  removeContextItem,
  getContextItemInfo,
} from './context/index.js';
import { extractAgendaItemsFromNotes } from './intelligence/agenda.js';
import { getUpcomingMeetings } from './calendar/cxmail.js';
import { standingGoals } from './session/reviewStore.js';
import { prepRequestFromBody } from './prep/gather.js';
import { runMeetingPrep } from './prep/agent.js';
import type { ContextItemConfig } from './context/index.js';

interface RouteContext {
  transcription: TranscriptionService;
  intelligence: IntelligenceEngine;
  registry: WorkerRegistry;
  debug: DebugHandler;
  getSession: () => { store: SessionStore | null; logger: EventLogger | null; active: boolean };
  getWhisperAvailable: () => boolean | null;
  probeWhisperAvailable: () => Promise<boolean>;
  getRetentionDays: () => number;
  setRetentionDays: (days: number) => void;
}

// Preflight dependency check
interface PreflightCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

function runPreflightChecks(transcriptionAvailable: boolean | null, providerName = 'transcription provider'): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  checks.push({
    name: 'transcription',
    ok: transcriptionAvailable === true,
    detail: transcriptionAvailable === true ? `${providerName} available` : `${providerName} not reachable — transcription will fail`,
  });

  let claudeOk = false;
  try {
    const result = execFileSync('claude', ['--version'], { timeout: 5000, encoding: 'utf-8' });
    claudeOk = result.trim().length > 0;
  } catch {}
  checks.push({
    name: 'claude-cli',
    ok: claudeOk,
    detail: claudeOk ? 'Claude CLI available' : 'claude CLI not found — intelligence and workers will fail',
  });

  if (providerName === 'whisper-server') {
    const modelPath = join(homedir(), '.meeting-copilot', 'models', 'ggml-base.en.bin');
    const modelExists = existsSync(modelPath);
    checks.push({
      name: 'whisper-model',
      ok: modelExists,
      detail: modelExists ? 'Whisper model present' : `Model not found at ${modelPath}`,
    });
  }

  const sessionsDir = join(homedir(), '.meeting-copilot', 'sessions');
  let sessionsWritable = false;
  try {
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
    sessionsWritable = true;
  } catch {}
  checks.push({
    name: 'storage',
    ok: sessionsWritable,
    detail: sessionsWritable ? 'Session storage writable' : 'Cannot write to sessions directory',
  });

  return checks;
}

export function createRoutes(ctx: RouteContext): Router {
  const router = Router();

  // POST /transcribe - legacy HTTP audio ingress. The app streams audio over
  // WebSocket; this path bypasses dedup + the transcript stitcher, so
  // anything using it writes divergent (fragmented, un-deduped) transcript
  // rows. Gated off unless explicitly re-enabled.
  router.post('/transcribe', async (req, res) => {
    if (process.env.COPILOT_ENABLE_HTTP_TRANSCRIBE !== '1') {
      res.status(410).json({
        success: false,
        error:
          'HTTP /transcribe is disabled — audio arrives via WebSocket (audio_chunk). ' +
          'Set COPILOT_ENABLE_HTTP_TRANSCRIBE=1 to re-enable this legacy path.',
      });
      return;
    }
    try {
      const { store, active } = ctx.getSession();
      if (!active || !store) {
        res.status(409).json({
          success: false,
          error: 'No active session. Start a session before sending audio.',
        });
        return;
      }

      const wavBuffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body);

      const source = (req.query.source as 'mic' | 'meeting') || 'meeting';
      ctx.debug.recordAudioChunk(wavBuffer.length);

      const segment = await ctx.transcription.transcribeChunk(wavBuffer, source);

      if (segment.text && store) {
        store.addTranscript(segment);
        ctx.intelligence.addTranscript(segment);
        ctx.debug.recordTranscriptWords(segment.wordCount);
        ctx.getSession().logger?.log('transcript.chunk', {
          segmentId: segment.id,
          source: segment.source,
          wordCount: segment.wordCount,
        });
        appendTranscript(segment);
      }

      res.json({
        success: true,
        segment: {
          id: segment.id,
          text: segment.text,
          source: segment.source,
          label: segment.label,
          timestamp: new Date(segment.timestamp).toISOString(),
          duration: segment.duration ?? 10,
          wordCount: segment.wordCount,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  // GET /debug
  router.get('/debug', ctx.debug.handler());

  // Health check — re-probes the selected ASR provider so the response reflects the current
  // subprocess state, not just the boot-time snapshot. The probe has a 1s
  // timeout in WhisperProvider.isAvailable() so this stays cheap.
  router.get('/health', async (_req, res) => {
    const { store, active } = ctx.getSession();
    const transcriptionAvailable = await ctx.probeWhisperAvailable();
    res.json({
      status: 'ok',
      session: active ? store?.id : null,
      transcriptionAvailable,
      transcription: ctx.transcription.providerInfo,
    });
  });

  // Live transcript (for web UI refresh during active session)
  router.get('/transcript', (_req, res) => {
    const { store, active } = ctx.getSession();
    if (!active || !store) {
      res.json({ segments: [], active: false });
      return;
    }
    const records = store.getTranscript();
    res.json({
      segments: records.map((r) => ({
        id: r.id,
        text: r.text,
        source: r.source,
        label: r.label,
        timestamp: r.timestamp,
        duration: r.duration,
        wordCount: r.wordCount,
      })),
      active: true,
      sessionId: store.id,
    });
  });

  // Preflight check — re-probes whisper to reflect current state
  router.get('/preflight', async (_req, res) => {
    const whisperOk = await ctx.probeWhisperAvailable();
    const checks = runPreflightChecks(whisperOk, ctx.transcription.providerInfo.mode);
    const allOk = checks.every((c) => c.ok);
    res.json({ ok: allOk, checks });
  });

  // Settings — persisted to ~/.meeting-copilot/settings.json and APPLIED to
  // the live pipeline (previously intelligenceCadence/presentationMode were
  // accepted and silently ignored).
  router.get('/settings', (_req, res) => {
    res.json({ settings: getSettings(), shareTranscript: isSharingEnabled() });
  });

  router.post('/settings', (req, res) => {
    const body = req.body as Record<string, any>;
    const applied: Record<string, any> = {};
    const ignored: string[] = [];

    const partial: Record<string, any> = {};
    if (typeof body.evalCadenceMs === 'number') partial.evalCadenceMs = body.evalCadenceMs;
    if (typeof body.suggestionTtlMs === 'number') partial.suggestionTtlMs = body.suggestionTtlMs;
    if (body.monitorDefaults && typeof body.monitorDefaults === 'object') partial.monitorDefaults = body.monitorDefaults;
    if (typeof body.retentionDays === 'number') partial.retentionDays = body.retentionDays;
    if (typeof body.summaryAutoWrite === 'boolean') partial.summaryAutoWrite = body.summaryAutoWrite;
    if (typeof body.matchVaultAppearance === 'boolean') partial.matchVaultAppearance = body.matchVaultAppearance;

    if (Object.keys(partial).length > 0) {
      const next = updateSettings(partial);
      // Apply live
      ctx.intelligence.setEvalCadence(next.evalCadenceMs);
      ctx.registry.setSuggestionTtl(next.suggestionTtlMs);
      if (partial.retentionDays !== undefined) {
        ctx.setRetentionDays(next.retentionDays);
        const result = cleanupOldSessions(next.retentionDays);
        applied.cleaned = result.deleted.length;
      }
      Object.assign(applied, next);
    }

    if (body.shareTranscript !== undefined) {
      setSharingEnabled(!!body.shareTranscript);
      applied.shareTranscript = !!body.shareTranscript;
      console.log(`[Config] Transcript sharing ${body.shareTranscript ? 'enabled' : 'disabled'}`);
    }

    // Honest response: unknown/no-op fields are reported, not silently acked.
    for (const key of Object.keys(body)) {
      if (!['evalCadenceMs', 'suggestionTtlMs', 'monitorDefaults', 'retentionDays', 'summaryAutoWrite', 'matchVaultAppearance', 'shareTranscript'].includes(key)) {
        ignored.push(key);
      }
    }

    res.json({ success: true, applied, ...(ignored.length ? { ignored } : {}) });
  });

  // Projects
  router.get('/projects', (_req, res) => {
    const projects = scanProjects();
    res.json({ projects });
  });

  // Which project is this meeting about? Local string matching only — no model
  // and no network, so the title (which carries client and attendee names)
  // never leaves the machine. See project/match.ts for why.
  router.get('/projects/suggest', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({ suggestions: suggestProjects(q, scanProjects()) });
  });

  // Upcoming meetings from cxmail's invite database (read-only, local).
  // Returns { meetings: [] } whenever cxmail or its DB is absent.
  router.get('/calendar/upcoming', (_req, res) => {
    try {
      res.json({ meetings: getUpcomingMeetings() });
    } catch (err) {
      res.json({ meetings: [], error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Goals the last few self-reviews keep repeating, to pre-fill the start
  // form's private goals (which the coach reads). { goals: [] } when there is
  // no pattern yet.
  router.get('/coach/standing-goals', (_req, res) => {
    const standing = standingGoals();
    res.json(standing ?? { goals: [], evidence: [], reviewed: 0 });
  });

  // Context sources (files + folders)
  const handleGetContextSources = (_req: any, res: any) => {
    const configs = loadContextConfig();
    const items = configs.map((c) => getContextItemInfo(c));
    res.json({ items });
  };
  router.get('/context-sources', handleGetContextSources);
  router.get('/context-dirs', handleGetContextSources); // backwards compat

  const handlePostContextSources = (req: any, res: any) => {
    const body = req.body as { items?: ContextItemConfig[] };
    if (!Array.isArray(body.items)) {
      res.status(400).json({ error: 'Expected { items: ContextItemConfig[] }' });
      return;
    }
    saveContextConfig(body.items);
    res.json({ success: true, count: body.items.length });
  };
  router.post('/context-sources', handlePostContextSources);
  router.post('/context-dirs', handlePostContextSources); // backwards compat

  // Add a single context source (used by file/folder pickers)
  router.post('/context-sources/add', (req, res) => {
    const body = req.body as { path?: string; type?: string; label?: string };
    if (!body.path || !body.type || !['file', 'folder'].includes(body.type)) {
      res.status(400).json({ error: 'Expected { path: string, type: "file"|"folder", label?: string }' });
      return;
    }
    const items = addContextItem({
      path: body.path,
      type: body.type as 'file' | 'folder',
      label: body.label,
    });
    res.json({ success: true, items: items.map((c) => getContextItemInfo(c)) });
  });

  // Extract trackable agenda items from freeform notes / markdown prep docs.
  // User-initiated, one-shot. Route handler is thin — all logic in
  // `extractAgendaItemsFromNotes` so it can be unit-tested without HTTP.
  router.post('/agenda/extract', async (req, res) => {
    const body = req.body as { raw?: unknown };
    const raw = body?.raw;
    if (typeof raw !== 'string') {
      res.status(400).json({ error: 'Expected { raw: string }' });
      return;
    }
    if (raw.trim().length === 0) {
      res.status(400).json({ error: 'Notes are empty' });
      return;
    }
    if (raw.length > 100_000) {
      res.status(400).json({ error: 'Notes too long (max 100,000 characters)' });
      return;
    }

    try {
      const items = await extractAgendaItemsFromNotes(raw);
      res.json({ items });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Agenda] Extraction failed:', message);
      res.status(502).json({ error: 'Extraction failed — try again or edit manually' });
    }
  });

  // Pre-meeting prep: the user's own records (email, past sessions, vault
  // notes) + a web-research agent → a brief and a suggested agenda. User-
  // initiated from the start form; runs on the subscription CLI. Streams
  // NDJSON so the form can show what the agent is doing:
  //   {"type":"progress","message":"Searching: …"} … then
  //   {"type":"result", brief, agenda, sources, mode, stats} or {"type":"error", message}
  router.post('/meeting/prep', async (req, res) => {
    const request = prepRequestFromBody(req.body);
    if (!request) {
      res.status(400).json({ error: 'Add a title, attendees or notes to prep from' });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(JSON.stringify(event) + '\n');
    };
    // `res` close, not `req` close: the JSON body is already consumed, so
    // `req` has closed by now. A closed response before we end it = the user
    // cancelled or navigated away — stop the agent.
    const ctl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ctl.abort();
    });
    try {
      const result = await runMeetingPrep(request, {
        signal: ctl.signal,
        aboutMe: getSettings().aboutMe,
        onProgress: (message) => send({ type: 'progress', message }),
      });
      console.log(`[Prep] ${result.mode} prep: ${result.agenda.length} items, ${result.sources.length} sources`);
      send({ type: 'result', ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== 'Aborted') {
        console.error('[Prep] failed:', message);
        send({ type: 'error', message });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  // Remove a context source
  router.delete('/context-sources', (req, res) => {
    const body = req.body as { path?: string };
    if (!body.path) {
      res.status(400).json({ error: 'Expected { path: string }' });
      return;
    }
    const items = removeContextItem(body.path);
    res.json({ success: true, items: items.map((c) => getContextItemInfo(c)) });
  });

  // Session history — list all sessions with manifest data
  router.get('/sessions', (_req, res) => {
    try {
      const sessionsDir = join(homedir(), '.meeting-copilot', 'sessions');
      if (!existsSync(sessionsDir)) {
        res.json([]);
        return;
      }

      const entries = readdirSync(sessionsDir, { withFileTypes: true });
      const sessions: any[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(sessionsDir, entry.name, 'manifest.json');
        try {
          if (!existsSync(manifestPath)) continue;
          const raw = readFileSync(manifestPath, 'utf-8');
          const manifest = JSON.parse(raw);
          sessions.push(manifest);
        } catch {
          // Skip sessions with unreadable manifests
        }
      }

      // Sort newest first by startedAt
      sessions.sort((a, b) => {
        const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return bTime - aTime;
      });

      res.json(sessions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  // Session export — markdown or JSON
  router.get('/sessions/:id/export', (req, res) => {
    try {
      const sessionId = req.params.id;
      const format = (req.query.format as string) || 'markdown';

      const sessionDir = join(homedir(), '.meeting-copilot', 'sessions', sessionId);
      if (!existsSync(sessionDir)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const store = new SessionStoreClass(sessionId);

      try {
        if (format === 'json') {
          const data = store.exportJSON();
          res.setHeader('Content-Type', 'application/json');
          res.json(data);
        } else {
          const markdown = store.exportMarkdown();
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          res.send(markdown);
        }
      } finally {
        store.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  // Delete a single session
  router.delete('/sessions/:id', (req, res) => {
    try {
      const sessionId = req.params.id;
      // Validate UUID format to prevent path traversal
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
        res.status(400).json({ error: 'Invalid session ID' });
        return;
      }

      const sessionDir = join(homedir(), '.meeting-copilot', 'sessions', sessionId);
      if (!existsSync(sessionDir)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      // Don't delete the active session
      const { store, active } = ctx.getSession();
      if (active && store?.id === sessionId) {
        res.status(409).json({ error: 'Cannot delete the active session' });
        return;
      }

      rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[Sessions] Deleted session ${sessionId}`);
      res.json({ success: true, deleted: sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  // Batch delete sessions
  router.post('/sessions/delete', (req, res) => {
    try {
      const body = req.body as { ids?: string[] };
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        res.status(400).json({ error: 'Expected { ids: string[] }' });
        return;
      }

      const { store, active } = ctx.getSession();
      const sessionsDir = join(homedir(), '.meeting-copilot', 'sessions');
      const deleted: string[] = [];
      const errors: string[] = [];

      for (const id of body.ids) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          errors.push(`Invalid session ID: ${id}`);
          continue;
        }
        if (active && store?.id === id) {
          errors.push(`Cannot delete active session: ${id}`);
          continue;
        }
        const sessionDir = join(sessionsDir, id);
        if (!existsSync(sessionDir)) continue;
        try {
          rmSync(sessionDir, { recursive: true, force: true });
          deleted.push(id);
        } catch (err) {
          errors.push(`Failed to delete ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.log(`[Sessions] Batch deleted ${deleted.length} sessions`);
      res.json({ success: true, deleted, errors });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
