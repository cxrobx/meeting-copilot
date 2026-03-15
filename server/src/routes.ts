import { Router } from 'express';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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
import { setSharingEnabled, appendTranscript } from './session/shared.js';
import { scanProjects } from './project/index.js';

interface RouteContext {
  transcription: TranscriptionService;
  intelligence: IntelligenceEngine;
  registry: WorkerRegistry;
  debug: DebugHandler;
  getSession: () => { store: SessionStore | null; logger: EventLogger | null; active: boolean };
  getWhisperAvailable: () => boolean | null;
  getRetentionDays: () => number;
  setRetentionDays: (days: number) => void;
}

// Preflight dependency check
interface PreflightCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

function runPreflightChecks(whisperAvailable: boolean | null): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  checks.push({
    name: 'whisper',
    ok: whisperAvailable === true,
    detail: whisperAvailable === true ? 'Whisper transcription available' : 'Whisper not reachable — transcription will fail',
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

  const modelPath = join(homedir(), '.meeting-copilot', 'models', 'ggml-base.en.bin');
  const modelExists = existsSync(modelPath);
  checks.push({
    name: 'whisper-model',
    ok: modelExists,
    detail: modelExists ? 'Whisper model present' : `Model not found at ${modelPath}`,
  });

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

  // POST /transcribe - receive audio chunks via HTTP
  router.post('/transcribe', async (req, res) => {
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

  // Health check
  router.get('/health', (_req, res) => {
    const { store, active } = ctx.getSession();
    res.json({
      status: 'ok',
      session: active ? store?.id : null,
      whisperAvailable: ctx.getWhisperAvailable(),
    });
  });

  // Preflight check
  router.get('/preflight', (_req, res) => {
    const checks = runPreflightChecks(ctx.getWhisperAvailable());
    const allOk = checks.every((c) => c.ok);
    res.json({ ok: allOk, checks });
  });

  // Settings
  router.post('/settings', (req, res) => {
    const body = req.body as Record<string, any>;
    const applied: Record<string, any> = {};

    if (body.retentionDays !== undefined && body.retentionDays >= 7) {
      ctx.setRetentionDays(body.retentionDays);
      const result = cleanupOldSessions(body.retentionDays);
      applied.retentionDays = body.retentionDays;
      applied.cleaned = result.deleted.length;
    }

    if (body.shareTranscript !== undefined) {
      setSharingEnabled(!!body.shareTranscript);
      applied.shareTranscript = !!body.shareTranscript;
      console.log(`[Config] Transcript sharing ${body.shareTranscript ? 'enabled' : 'disabled'}`);
    }

    if (body.intelligenceCadence !== undefined) {
      applied.intelligenceCadence = body.intelligenceCadence;
      console.log(`[Config] Intelligence cadence set to: ${body.intelligenceCadence}`);
    }

    if (body.presentationMode !== undefined) {
      applied.presentationMode = !!body.presentationMode;
      console.log(`[Config] Presentation mode ${body.presentationMode ? 'enabled' : 'disabled'}`);
    }

    res.json({ success: true, applied });
  });

  // Projects
  router.get('/projects', (_req, res) => {
    const projects = scanProjects();
    res.json({ projects });
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

  return router;
}
