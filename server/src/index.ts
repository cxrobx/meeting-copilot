import { createServer } from 'node:http';
import { unlinkSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { log, safeErrorMessage } from './logging.js';

function debugLog(msg: string): void {
  log('server', msg);
  console.log(msg);
}
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

import { TranscriptionService } from './transcription/index.js';
import type { TranscriptSegment } from './transcription/types.js';
import { TranscriptDedup } from './transcription/dedup.js';
import { TranscriptStitcher } from './transcription/stitch.js';
import { IntelligenceEngine } from './intelligence/index.js';
import { setLlmBudgetExceededHandler } from './api/budget.js';
import { AgendaTracker, type AgendaStatus } from './intelligence/agenda.js';
import { FactCheckMonitor, type FactFlag } from './intelligence/factcheck.js';
import { CoachMonitor, type CoachSuggestion } from './intelligence/coach.js';
import { WorkerRegistry } from './workers/registry.js';
import { ResearchWorker } from './workers/research.js';
import { FastResearchWorker } from './workers/fast-research.js';
import { SummaryWorker } from './workers/summary.js';
import { MockupWorker } from './workers/mockup.js';
import { CodeGenWorker } from './workers/codegen.js';
import { AnalysisWorker } from './workers/analysis.js';
import { ReviewWorker, buildReviewParams } from './workers/review.js';
import { SessionStore } from './session/store.js';
import { EventLogger } from './session/events.js';
import { DebugHandler } from './debug/index.js';
import { cleanupOldSessions, cleanStalePresence } from './session/cleanup.js';
import { writePresence, removePresence, appendTranscript, setSharingEnabled } from './session/shared.js';
import { createPresentRouter } from './present/index.js';
import { createRoutes } from './routes.js';
import { scanProjects, loadProjectContext, formatProjectBrief } from './project/index.js';
import type { ProjectContext } from './project/index.js';
import { loadContextDocs, loadContextConfig, buildContextBlock } from './context/index.js';
import type { ContextItemConfig } from './context/index.js';
import type { ActionSuggestion, ActionLifecycle } from './workers/types.js';
import { isAnthropicApiAvailable } from './api/anthropic.js';
import { isOpenAiApiAvailable } from './api/openai.js';
import { paidApiDisabled } from './api/killswitch.js';
import { disposeAllWarmSessions } from './persistent-claude.js';
import { cliHealth } from './claude-cli.js';
import { getSettings } from './settings.js';
import { LLM_CONFIG, MODEL_CONFIG } from './model-config.js';

// Load environment — prefer ~/.meeting-copilot/.env so a packaged .app
// user has a stable, user-writable location for API keys that survives
// reinstalling the bundle. Falls back to the cwd .env (dev mode).
const USER_ENV_PATH = join(homedir(), '.meeting-copilot', '.env');
if (existsSync(USER_ENV_PATH)) {
  dotenv.config({ path: USER_ENV_PATH });
} else {
  dotenv.config();
}

// ─── Background-CLI marker ────────────────────────────────────────────────
// Every realtime AI call (triage/suggest/agenda/coach/factcheck) and every
// worker spawns the `claude`/`gemini`/`codex` CLI in headless --print mode.
// Each spawn inherits this env var, which propagates to any hooks those CLIs
// run (e.g. a user's global Stop hook that plays a sound). User hooks should
// no-op when MEETING_COPILOT is set so a live meeting isn't a wall of dings.
process.env.MEETING_COPILOT = '1';

// ─── Shared Transcript Config ─────────────────────────────────────────────
if (process.env.SHARE_TRANSCRIPT === 'false') {
  setSharingEnabled(false);
  console.log('[Config] Transcript sharing disabled');
}

// ─── Socket Path ───────────────────────────────────────────────────────────
const COPILOT_DIR = join(homedir(), '.meeting-copilot');
const SOCKET_PATH = join(COPILOT_DIR, 'copilot.sock');

// ─── WebSocket Message Types ───────────────────────────────────────────────

// Messages FROM Swift app
type InboundMessage =
  | {
      type: 'audio_chunk';
      data: string; // base64 WAV
      source: 'mic' | 'meeting';
      chunkId?: string;
      audioDurationSec?: number;
      captureStartedAt?: string;
      captureEndedAt?: string;
      sequence?: number;
      /** True when this chunk shares audio with the previous one
       *  (timer overlap or VAD max-utterance carry). Dedup runs only
       *  on continuation chunks — non-continuation chunks with shared
       *  vocabulary (e.g. "thank you" said in two separate utterances)
       *  MUST NOT be trimmed. */
      isContinuation?: boolean;
    }
  | { type: 'audio.flush' }
  | { type: 'session.start'; title?: string; projectNames?: string[]; agenda?: string; attendees?: string; contextPaths?: string[]; contextDirPaths?: string[] }
  | { type: 'session.stop' }
  | { type: 'action.approve'; actionId: string }
  | { type: 'action.dismiss'; actionId: string }
  | { type: 'action.cancel'; actionId: string }
  | {
      type: 'action.trigger';
      actionType: string;
      prompt?: string;
      // Card-derived mockups (right-click → Mockup / Revise mock): the source
      // card's text, and — for revisions — the existing wireframe/HTML to edit.
      cardContent?: string;
      baseWireframe?: string;
      baseHtml?: string;
    }
  | { type: 'feature.toggle'; feature: 'factcheck' | 'coach'; enabled: boolean }
  | { type: 'meeting.goals'; goals: string };

// Messages TO Swift app
type OutboundMessage =
  | {
      type: 'transcript.update';
      segment: {
        id: string;
        text: string;
        source: string;
        label: string;
        timestamp: string; // ISO-8601
        audioDurationSec: number;
        transcriptionLatencyMs: number;
        captureStartedAt?: string;
        captureEndedAt?: string;
        sequence?: number;
        duration: number; // @deprecated — alias of audioDurationSec
        wordCount: number;
        replace?: boolean; // true → update the open segment in place (stitcher)
      };
    }
  | {
      type: 'action.suggested';
      action: {
        id: string;
        type: string;
        title: string;
        description: string;
        triggerQuote: string;
        estimatedDurationSec: number;
        state: string;
        createdAt: string; // ISO-8601
        streaming?: boolean;
        paramsReady?: boolean;
        pendingApproval?: boolean;
      };
    }
  | {
      type: 'action.status';
      actionId: string;
      state: string;
      result?: any;
      streaming?: boolean;
      paramsReady?: boolean;
      pendingApproval?: boolean;
    }
  | {
      type: 'action.stream';
      actionId: string;
      delta: string;
    }
  | {
      type: 'session.state';
      state: 'idle' | 'priming' | 'live' | 'degraded' | 'ending' | 'error' | 'archived';
      sessionId?: string;
      // Optional progress hint shown while state==='ending' (post-meeting workers).
      message?: string;
      // Authoritative session start (epoch ms) + title so a reconnecting or
      // refreshed client shows the real elapsed time instead of resetting.
      startedAt?: number;
      title?: string;
    }
  | {
      type: 'metrics';
      data: any;
    }
  | {
      type: 'agenda.status';
      status: AgendaStatus;
    }
  | {
      type: 'intelligence.status';
      phase: 'evaluating' | 'generating' | 'idle';
    }
  | {
      type: 'feature.state';
      features: { factcheck: boolean; coach: boolean };
    }
  | {
      type: 'factcheck.flag';
      flag: FactFlag;
    }
  | {
      type: 'coach.suggestion';
      suggestion: CoachSuggestion;
    }
  | {
      // Realtime intelligence failure — surfaced so tier degradation and
      // silent monitor errors are visible in the dashboard instead of only
      // in server.log.
      type: 'intelligence.error';
      source: 'triage' | 'suggest' | 'compression' | 'agenda' | 'factcheck' | 'coach' | 'cli' | 'budget';
      message: string;
      at: number; // epoch ms
      /** True when a whole tier/monitor is being skipped, not just one failure. */
      degraded?: boolean;
      /** True when a previously degraded source recovered. */
      recovered?: boolean;
    };

// ─── App State ─────────────────────────────────────────────────────────────

let sessionStore: SessionStore | null = null;
let eventLogger: EventLogger | null = null;
let sessionActive = false;

// Post-stop lifecycle, tracked independently of sessionActive so a client that
// (re)connects — or missed the single terminal broadcast — resolves to the
// correct view instead of falling back to live/idle and stranding on "Ending…".
//   'ending'   = stop received; post-meeting workers (summary/self-review) draining
//   'archived' = fully stopped; review view
//   null       = no ended session this run (idle or live)
// Reset to null on session.start.
let postSessionState: 'ending' | 'archived' | null = null;
let lastSessionId: string | null = null;

// Rolling summary: periodically refreshes the summary card with updated transcript
let rollingSummaryId: string | null = null;
let rollingSummaryTimer: ReturnType<typeof setInterval> | null = null;
let rollingSummaryWordCount = 0;
const ROLLING_SUMMARY_INTERVAL_MS = 120_000; // 2 minutes
let configuredRetentionDays = getSettings().retentionDays;
let whisperAvailable: boolean | null = null;

// ─── Initialize Core Services ──────────────────────────────────────────────

const transcription = new TranscriptionService();
const transcriptDedup = new TranscriptDedup();
const transcriptStitcher = new TranscriptStitcher();
const intelligence = new IntelligenceEngine();
const agendaTracker = new AgendaTracker();
const registry = new WorkerRegistry();
const debug = new DebugHandler(transcription, intelligence, registry);

// Apply persisted settings to the live pipeline at boot (settings.json >
// env > defaults; POST /settings re-applies at runtime).
intelligence.setEvalCadence(getSettings().evalCadenceMs);
registry.setSuggestionTtl(getSettings().suggestionTtlMs);

// Snapshot of last broadcast agenda status — served to late-joining clients
let lastAgendaStatus: AgendaStatus | null = null;

let lastAgendaMissingCount = 0;
agendaTracker.on('status', (status: AgendaStatus) => {
  lastAgendaStatus = status;
  eventLogger?.log('agenda.status', {
    covered: status.items.filter((i) => i.state === 'covered').length,
    total: status.items.length,
    missing: status.missing,
  });
  broadcast({ type: 'agenda.status', status });
  // A fresh "might be missing" warning is a coachable moment.
  if (status.missing.length > lastAgendaMissingCount && coach.isRunning()) {
    coach.requestEval('agenda-warning');
  }
  lastAgendaMissingCount = status.missing.length;
});

agendaTracker.on('error', (msg: string) => {
  debugLog(`[Agenda] error: ${msg}`);
  broadcast({ type: 'intelligence.error', source: 'agenda', message: msg, at: Date.now() });
});

agendaTracker.on('eval', (info: Record<string, unknown>) => {
  // Diagnostic event — emitted on every schedule/skip/completion so
  // server.log captures enough to explain "why didn't it update?"
  debugLog(`[Agenda] ${JSON.stringify(info)}`);
  eventLogger?.log('agenda.eval', info);
});

// ─── Live Monitors: Fact-check + Recovery Coach ────────────────────────────
// Fact-check remains opt-in. Coach is the primary live product loop and starts
// on by default for new installs, while still respecting the persisted toggle.

const factCheck = new FactCheckMonitor();
const coach = new CoachMonitor();
const featureFlags = { factcheck: false, coach: false };
debug.setRealtimeMetricsProvider(() => ({
  agenda: agendaTracker.getMetrics(),
  coach: coach.getMetrics(),
}));
// Flags raised this session — replayed to late-joining clients (page reload).
let sessionFactFlags: FactFlag[] = [];
let lastCoachSuggestion: CoachSuggestion | null = null;
// The user's private goals for this meeting — coach-only context. Content is
// deliberately NOT logged to the session JSONL (only its length).
let meetingGoals = '';

factCheck.on('flag', (flag: FactFlag) => {
  sessionFactFlags.push(flag);
  eventLogger?.log('factcheck.flag', {
    claim: flag.claim,
    speaker: flag.speaker,
    verdict: flag.verdict,
    confidence: flag.confidence,
    webSearched: flag.webSearched,
  });
  broadcast({ type: 'factcheck.flag', flag });
});
factCheck.on('eval', (info: Record<string, unknown>) => {
  debugLog(`[FactCheck] ${JSON.stringify(info)}`);
  eventLogger?.log('factcheck.eval', info);
});
factCheck.on('error', (msg: string) => {
  debugLog(`[FactCheck] error: ${msg}`);
  broadcast({ type: 'intelligence.error', source: 'factcheck', message: msg, at: Date.now() });
});

coach.on('suggestion', (suggestion: CoachSuggestion) => {
  lastCoachSuggestion = suggestion;
  eventLogger?.log('coach.suggestion', {
    kind: suggestion.kind,
    incidentType: suggestion.incidentType,
    priority: suggestion.priority,
    confidence: suggestion.confidence,
    headline: suggestion.headline,
    latencyMs: suggestion.latencyMs,
  });
  broadcast({ type: 'coach.suggestion', suggestion });
});
coach.on('eval', (info: Record<string, unknown>) => {
  debugLog(`[Coach] ${JSON.stringify(info)}`);
  eventLogger?.log('coach.eval', info);
});
coach.on('error', (msg: string) => {
  debugLog(`[Coach] error: ${msg}`);
  broadcast({ type: 'intelligence.error', source: 'coach', message: msg, at: Date.now() });
});

function monitorTranscriptProvider(): string {
  if (!sessionStore) return '';
  return sessionStore
    .getTranscript()
    .map((r) => `${r.label} ${r.text}`)
    .join('\n');
}

function monitorWordCountProvider(): number {
  if (!sessionStore) return 0;
  return sessionStore.getTranscript().reduce((sum, r) => sum + (r.wordCount || 0), 0);
}

function monitorSpeakerStats(): { micWords: number; meetingWords: number } | null {
  if (!sessionStore) return null;
  let micWords = 0;
  let meetingWords = 0;
  for (const r of sessionStore.getTranscript()) {
    if (r.source === 'mic') micWords += r.wordCount || 0;
    else meetingWords += r.wordCount || 0;
  }
  return { micWords, meetingWords };
}

/** Start/stop a monitor to match its flag. Safe to call redundantly. */
function applyFeatureFlags(): void {
  const session = sessionStore?.getSession();
  if (featureFlags.factcheck && sessionActive && !factCheck.isRunning()) {
    factCheck.start({
      transcriptProvider: monitorTranscriptProvider,
      wordCountProvider: monitorWordCountProvider,
      sessionTitle: session?.title,
    });
    debugLog('[FactCheck] started');
  } else if ((!featureFlags.factcheck || !sessionActive) && factCheck.isRunning()) {
    factCheck.stop();
    debugLog('[FactCheck] stopped');
  }

  if (featureFlags.coach && sessionActive && !coach.isRunning()) {
    const meetingContext = intelligence.getMeetingContext();
    coach.start({
      transcriptProvider: monitorTranscriptProvider,
      wordCountProvider: monitorWordCountProvider,
      agendaStatusProvider: () => lastAgendaStatus,
      goalsProvider: () => meetingGoals,
      speakerStatsProvider: monitorSpeakerStats,
      sessionTitle: session?.title,
      attendees: meetingContext.attendees,
    });
    debugLog('[Coach] started');
  } else if ((!featureFlags.coach || !sessionActive) && coach.isRunning()) {
    coach.stop();
    debugLog('[Coach] stopped');
  }
}

// Register workers
registry.register(new ResearchWorker());
registry.register(new FastResearchWorker());
registry.register(new SummaryWorker());
registry.register(new MockupWorker());
registry.register(new CodeGenWorker());
registry.register(new AnalysisWorker());
registry.register(new ReviewWorker());

// ─── Express App ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ type: 'audio/*', limit: '10mb' }));

// Vendored dashboard assets (marked/DOMPurify/highlight.js/JetBrains Mono) —
// served locally so /present works offline and stops leaking page loads to
// CDNs. `../vendor` resolves to server/vendor from BOTH src/ (tsx dev) and
// dist/ (packaged bundle) since dist mirrors src one level under server/.
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');
app.use('/vendor', express.static(VENDOR_DIR, { maxAge: '7d' }));

// Share/Present mode
app.use(createPresentRouter(registry));

// Routes (health, preflight, settings, transcribe, projects, debug)
app.use(createRoutes({
  transcription,
  intelligence,
  registry,
  debug,
  getSession: () => ({ store: sessionStore, logger: eventLogger, active: sessionActive }),
  getWhisperAvailable: () => whisperAvailable,
  probeWhisperAvailable: async () => {
    const ok = await transcription.isProviderAvailable();
    whisperAvailable = ok;
    return ok;
  },
  getRetentionDays: () => configuredRetentionDays,
  setRetentionDays: (days) => { configuredRetentionDays = days; },
}));

// ─── HTTP Server ───────────────────────────────────────────────────────────

const server = createServer(app);

// ─── WebSocket Server ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });
const clients = new Set<WebSocket>();

function broadcast(message: OutboundMessage): void {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function handleWsConnection(ws: WebSocket, label: string): void {
  clients.add(ws);
  debugLog(`[${label}] Client connected (total: ${clients.size})`);

  // Send current state (values match Swift SessionState enum). postSessionState
  // takes precedence so a reconnect during/after stop resolves to ending/archived
  // rather than falling back to live/idle and stranding the UI on "Ending…".
  const reportedState = postSessionState ?? (sessionActive ? 'live' : 'idle');
  const sessionRecord = sessionStore?.getSession();
  const stateMsg: OutboundMessage = {
    type: 'session.state',
    state: reportedState,
    sessionId: sessionStore?.id ?? lastSessionId ?? undefined,
    startedAt: sessionRecord?.startedAt,
    title: sessionRecord?.title || undefined,
    ...(reportedState === 'ending'
      ? { message: 'Wrapping up — generating summary & self-review…' }
      : {}),
  };
  ws.send(JSON.stringify(stateMsg));

  // Replay the latest agenda status so late-joining clients (e.g., browser reload)
  // see the current coverage without waiting for the next 30s evaluation.
  if (sessionActive && lastAgendaStatus && lastAgendaStatus.items.length > 0) {
    ws.send(JSON.stringify({ type: 'agenda.status', status: lastAgendaStatus }));
  }

  // Replay monitor state + this session's fact flags / latest coach tip so a
  // page reload doesn't lose them.
  ws.send(JSON.stringify({ type: 'feature.state', features: { ...featureFlags } }));
  if (sessionActive) {
    for (const flag of sessionFactFlags) {
      ws.send(JSON.stringify({ type: 'factcheck.flag', flag }));
    }
    if (lastCoachSuggestion && lastCoachSuggestion.expiresAt > Date.now()) {
      ws.send(JSON.stringify({ type: 'coach.suggestion', suggestion: lastCoachSuggestion }));
    }
  }

  ws.on('message', async (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as InboundMessage;
      await handleInboundMessage(message);
    } catch (error) {
      // Use debugLog (writes to server.log) so handler failures are diagnosable
      // without needing to capture the child process's stderr pipe.
      debugLog(`[${label}] Handler error: ${safeErrorMessage(error)}`);
    }
  });

  ws.on('close', (code, reason) => {
    clients.delete(ws);
    debugLog(`[${label}] Client disconnected (code: ${code}, reason: ${reason?.toString() || 'none'}, total: ${clients.size})`);
  });

  ws.on('error', (error) => {
    debugLog(`[${label}] Client error: ${error.message}`);
    clients.delete(ws);
  });
}

wss.on('connection', (ws) => handleWsConnection(ws, 'WS'));

// ─── Inbound Message Handler ───────────────────────────────────────────────

async function handleInboundMessage(message: InboundMessage): Promise<void> {
  if (message.type !== 'audio_chunk') {
    debugLog(`[Inbound] ${message.type}`);
  }
  switch (message.type) {
    case 'audio_chunk': {
      if (!sessionActive || !sessionStore) {
        debugLog('[Audio] Dropping chunk because no session is active');
        break;
      }

      const wavBuffer = Buffer.from(message.data, 'base64');
      debugLog(`[Audio] Chunk received: ${wavBuffer.length} bytes, source: ${message.source}`);
      debug.recordAudioChunk(wavBuffer.length);

      // Snapshot the session id BEFORE the await. Short chunks mean more
      // in-flight work; a session.stop during transcription must not cause
      // us to persist or broadcast a stale segment into a new session.
      const chunkSessionId = sessionStore.id;

      try {
        const segment = await transcription.transcribeChunk(
          wavBuffer,
          message.source,
          {
            chunkId: message.chunkId,
            audioDurationSec: message.audioDurationSec,
            captureStartedAt: message.captureStartedAt,
            captureEndedAt: message.captureEndedAt,
            sequence: message.sequence,
          },
        );

        if (!sessionActive || sessionStore?.id !== chunkSessionId) {
          debugLog('[Audio] Dropping in-flight chunk — session changed during transcription');
          break;
        }

        if (segment.text) {
          // Phase 4: strip chunk-boundary overlap before persistence. Since
          // Swift emits 4s chunks every 3s, each chunk's first ~1s is the
          // previous chunk's last ~1s. Dedup in-place on `segment.text` so
          // SQLite / broadcast / shared JSONL are all clean (summaries and
          // exports read from SQLite).
          // Dedup only when the emitter flagged this chunk as carrying
          // audio from the previous one. VAD pause-triggered chunks are
          // standalone utterances — repeated words across them are NOT
          // duplicates. Default to `true` for older Swift clients that
          // don't send the flag yet (fixed-timer path always overlapped).
          const isContinuation = message.isContinuation ?? true;
          const dedupedText = transcriptDedup.dedup(
            segment.source,
            segment.text,
            segment.timestamp,
            isContinuation,
          );
          if (!dedupedText) {
            debugLog(`[Dedup] Dropped duplicate segment from ${segment.source}`);
            break;
          }
          if (dedupedText !== segment.text) {
            debugLog(`[Dedup] Trimmed overlap from ${segment.source}`);
            segment.text = dedupedText;
            segment.wordCount = dedupedText.split(/\s+/).filter(Boolean).length;
          }

          // Phase: sentence-stitching. Feed the deduped fragment to the
          // stitcher, which grows a per-source open segment and emits live
          // updates (broadcast only) until the sentence closes — at which
          // point the cohesive segment is persisted, fed to intelligence, and
          // appended to the shared JSONL. See transcriptStitcher.on('segment').
          transcriptStitcher.push(segment);
        }
      } catch (error) {
        console.error(
          '[Transcription] Error:',
          error instanceof Error ? error.message : String(error),
        );
      }
      break;
    }

    case 'audio.flush': {
      // Phase 3 hook — Swift side signals a session-stop flush to drain the
      // VAD emitter's buffered partial utterance. Today a no-op (timer
      // emitter doesn't buffer); wired up now so the flow is already there.
      try {
        await transcription.flushPending();
      } catch (err) {
        console.warn('[Transcription] flushPending failed:', err);
      }
      break;
    }

    case 'session.start': {
      if (sessionActive) {
        console.warn('[Session] Session already active, ignoring start');
        return;
      }

      // A new meeting supersedes any archived/ending lifecycle from the last one.
      postSessionState = null;
      lastSessionId = null;

      // Create new session
      sessionStore = new SessionStore();
      sessionStore.createSession(message.title ?? '', message.projectNames ?? [], message.agenda, message.attendees);

      eventLogger = new EventLogger(sessionStore.directory);
      eventLogger.log('session.start', { sessionId: sessionStore.id, title: message.title, agenda: message.agenda, attendees: message.attendees });

      debug.setSessionStartTime(Date.now());
      debug.recordStateTransition();
      debug.resetSessionMetrics();
      transcription.resetSessionMetrics();
      transcriptDedup.reset();
      transcriptStitcher.reset();

      // Seed whisper's initial_prompt with attendees + topics so proper
      // nouns (names, project names, keywords) transcribe accurately from
      // the first chunk. Capped at ~1500 chars in setSessionPrompt().
      const promptParts: string[] = [];
      if (message.attendees?.trim()) {
        promptParts.push(`Meeting attendees: ${message.attendees.trim()}.`);
      }
      if (message.agenda?.trim()) {
        promptParts.push(`Topics: ${message.agenda.trim().slice(0, 800)}.`);
      }
      transcription.setSessionPrompt(promptParts.join(' '));

      // Set meeting context on intelligence engine
      if (message.agenda || message.attendees) {
        intelligence.setMeetingContext({ agenda: message.agenda, attendees: message.attendees });
      }

      // Start agenda tracker if the user supplied agenda items
      lastAgendaStatus = null;
      if (message.agenda && message.agenda.trim()) {
        const items = agendaTracker.start({
          agenda: message.agenda,
          sessionTitle: message.title,
          transcriptProvider: () => {
            if (!sessionStore) return '';
            return sessionStore
              .getTranscript()
              .map((r) => `${r.label} ${r.text}`)
              .join('\n');
          },
          wordCountProvider: () => {
            if (!sessionStore) return 0;
            return sessionStore.getTranscript().reduce((sum, r) => sum + (r.wordCount || 0), 0);
          },
        });
        if (items.length > 0) {
          const initial: AgendaStatus = {
            items,
            missing: [],
            lastEvalAt: 0,
            fullyCovered: false,
          };
          lastAgendaStatus = initial;
          broadcast({ type: 'agenda.status', status: initial });
          eventLogger.log('agenda.start', { itemCount: items.length });
        }
      }

      // Load project context if specified
      if (message.projectNames?.length) {
        const contexts = (await Promise.all(
          message.projectNames.map((name) => loadProjectContext(name)),
        )).filter((c): c is ProjectContext => c !== null);
        intelligence.setProjectContext(contexts);
        console.log(`[Session] Project context loaded: ${contexts.map((c) => c.name).join(', ')}`);
      }

      // Load context docs (files + folders) if specified
      const contextPaths = message.contextPaths ?? message.contextDirPaths ?? [];
      if (contextPaths.length > 0) {
        const savedConfig = loadContextConfig();
        const items: ContextItemConfig[] = contextPaths.map((p) => {
          const saved = savedConfig.find((c) => c.path === p);
          if (saved) return saved;
          // Infer type from filesystem
          try {
            const isDir = statSync(p).isDirectory();
            return { path: p, type: isDir ? 'folder' : 'file' } as ContextItemConfig;
          } catch {
            return { path: p, type: 'file' } as ContextItemConfig;
          }
        });
        const docs = loadContextDocs(items);
        intelligence.setContextDocs(docs);
        console.log(`[Session] Context docs loaded: ${docs.length} files from ${contextPaths.length} sources`);
      }

      // Start intelligence engine
      intelligence.start();
      sessionActive = true;

      // Per-session starting state comes from persisted settings. Recovery
      // coach defaults on for new installs; fact-check remains off by default.
      const monitorDefaults = getSettings().monitorDefaults;
      featureFlags.factcheck = monitorDefaults.factcheck;
      featureFlags.coach = monitorDefaults.coach;
      sessionFactFlags = [];
      lastCoachSuggestion = null;
      meetingGoals = '';
      lastAgendaMissingCount = 0;
      applyFeatureFlags();
      broadcast({ type: 'feature.state', features: { ...featureFlags } });

      debugLog(`[Session] Started: ${sessionStore.id}`);

      broadcast({
        type: 'session.state',
        state: 'live',
        sessionId: sessionStore.id,
        startedAt: sessionStore.getSession()?.startedAt,
      });

      // Write shared presence for companion apps
      writePresence(sessionStore.id);

      // Start rolling summary timer
      rollingSummaryId = null;
      rollingSummaryWordCount = 0;
      if (rollingSummaryTimer) clearInterval(rollingSummaryTimer);
      rollingSummaryTimer = setInterval(async () => {
        if (!sessionActive || !sessionStore) return;

        const transcriptRecords = sessionStore.getTranscript();
        const currentWordCount = transcriptRecords.reduce((sum, r) => sum + (r.wordCount || 0), 0);

        // Only refresh if transcript has grown meaningfully (50+ new words)
        if (currentWordCount - rollingSummaryWordCount < 50) return;
        rollingSummaryWordCount = currentWordCount;

        const fullTranscript = transcriptRecords
          .map((r) => `${r.label} ${r.text}`)
          .join('\n');

        if (!fullTranscript.trim()) return;

        const session = sessionStore.getSession();
        const summaryWorker = registry.getWorker('summary');
        if (!summaryWorker) return;

        try {
          debugLog('[RollingSummary] Refreshing summary...');
          const result = await summaryWorker.execute(
            {
              transcript: fullTranscript,
              scope: 'full',
              title: session?.title,
              // The note's filename is stamped from the meeting's own start
              // time, not "now" — otherwise a call that runs past midnight
              // refreshes onto a second file under tomorrow's date.
              startedAt: session?.startedAt,
              attendees: session?.attendees,
            },
            new AbortController().signal,
          );

          if (result.success) {
            if (rollingSummaryId) {
              // Update existing card in-place
              registry.replaceActionResult(rollingSummaryId, result);
              debugLog(`[RollingSummary] Updated action ${rollingSummaryId}`);
            } else {
              // First rolling summary — create it via suggest + auto-approve
              const action = registry.suggest({
                type: 'summary',
                title: `Meeting Summary: ${session?.title || 'Live'}`,
                description: 'Auto-updating meeting summary (refreshes every 2 min)',
                triggerQuote: fullTranscript.slice(-100),
                estimatedDurationSec: 15,
                params: { transcript: fullTranscript, scope: 'full', title: session?.title, _rolling: true },
              }, { force: true, system: true });
              if (action) {
                // Persist the row BEFORE flipping to completed — the
                // action.status emit below persists via updateAction, which
                // needs an existing row or the card vanishes on reload.
                sessionStore.addAction({
                  id: action.id,
                  type: action.type,
                  title: action.title,
                  description: action.description,
                  triggerQuote: action.triggerQuote,
                  state: action.state,
                  params: action.params,
                  createdAt: action.createdAt,
                });
                // Directly set to completed with the result (skip worker execution)
                action.state = 'completed';
                action.result = result;
                action.completedAt = Date.now();
                registry.emit('action.status', action);
                rollingSummaryId = action.id;
                debugLog(`[RollingSummary] Created initial summary: ${action.id}`);
              }
            }
          }
        } catch (err) {
          debugLog(`[RollingSummary] Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, ROLLING_SUMMARY_INTERVAL_MS);

      break;
    }

    case 'session.stop': {
      if (!sessionActive || !sessionStore) {
        console.warn('[Session] No active session to stop');
        return;
      }
      // Idempotent: a second stop (double-click, app + browser both sending)
      // while workers are draining must not re-run the wrap-up sequence.
      if (postSessionState === 'ending') {
        debugLog('[Session] Stop already in progress, ignoring');
        return;
      }

      postSessionState = 'ending';
      lastSessionId = sessionStore.id;

      eventLogger?.log('session.stop', {
        sessionId: sessionStore.id,
        metrics: debug.getSessionSnapshot(),
      });
      debug.recordStateTransition();

      // Authoritative "ending" broadcast — settles the optimistic client flip and
      // lets every client (the app, a reconnecting browser) know the meeting is
      // wrapping up. The terminal "archived" is broadcast in the finally below so
      // it fires even if the wrap-up sequence throws.
      broadcast({
        type: 'session.state',
        state: 'ending',
        sessionId: lastSessionId,
        message: 'Wrapping up — generating summary & self-review…',
      });

      try {
        // Drain any VAD-buffered partial utterance (Phase 3 hook — no-op today).
        try {
          await transcription.flushPending();
        } catch {
          /* non-critical */
        }
        // Close any open stitched sentences so the final transcript (read below
        // for the summary + review) holds complete, cohesive segments.
        transcriptStitcher.flushAll();
        transcription.clearSessionPrompt();

        // Stop rolling summary
        if (rollingSummaryTimer) {
          clearInterval(rollingSummaryTimer);
          rollingSummaryTimer = null;
        }
        rollingSummaryId = null;
        rollingSummaryWordCount = 0;

        // Run a final agenda evaluation so the wrap-up state is captured before stop
        try {
          await agendaTracker.evaluateNow();
        } catch {
          // Non-critical — don't block shutdown
        }
        agendaTracker.stop();

        // Stop opt-in monitors
        featureFlags.factcheck = false;
        featureFlags.coach = false;
        applyFeatureFlags();
        broadcast({ type: 'feature.state', features: { ...featureFlags } });

        // Stop intelligence
        intelligence.stop();

        // Auto-generate end-of-meeting summary
        try {
          const transcriptRecords = sessionStore.getTranscript();
          if (transcriptRecords.length > 0) {
            const fullTranscript = transcriptRecords
              .map((r) => `${r.label} ${r.text}`)
              .join('\n');
            const session = sessionStore.getSession();
            const summaryAction = registry.suggest({
              type: 'summary',
              title: `Meeting Summary: ${session?.title || 'Untitled'}`,
              description: 'Auto-generated end-of-meeting summary',
              triggerQuote: fullTranscript.slice(-200),
              estimatedDurationSec: 30,
              params: {
                transcript: fullTranscript,
                scope: 'full',
                title: session?.title,
                // Both already live on the session record; without them the
                // filename falls back to "now" and drops the counterpart.
                startedAt: session?.startedAt,
                attendees: session?.attendees,
              },
            }, { force: true, system: true });
            if (summaryAction) {
              sessionStore.addAction({
                id: summaryAction.id,
                type: summaryAction.type,
                title: summaryAction.title,
                description: summaryAction.description,
                triggerQuote: summaryAction.triggerQuote,
                state: summaryAction.state,
                params: summaryAction.params,
                createdAt: summaryAction.createdAt,
              });
              registry.approve(summaryAction.id);
              debugLog('[Session] Auto-summary triggered');
            }
          }
        } catch (error) {
          console.error('[Session] Failed to trigger auto-summary:', error instanceof Error ? error.message : String(error));
        }

        // Auto-generate a post-meeting self-review (how the USER performed) +
        // cross-meeting trends. Runs in the same onMeetingEnd grace window as the
        // summary; if a long transcript exceeds the window it fails → Retry card.
        try {
          const transcriptRecords = sessionStore.getTranscript();
          if (transcriptRecords.length > 0) {
            const session = sessionStore.getSession();
            const reviewParams = buildReviewParams({
              transcriptRecords,
              title: session?.title,
              sessionId: sessionStore.id,
              agendaSummary:
                lastAgendaStatus && lastAgendaStatus.items.length > 0
                  ? lastAgendaStatus.items.map((i) => `[${i.state}] ${i.text}`).join('\n') +
                    (lastAgendaStatus.missing.length > 0
                      ? `\nPossibly missing: ${lastAgendaStatus.missing.join('; ')}`
                      : '')
                  : '',
              goals: meetingGoals,
              factFlags: sessionFactFlags
                .filter((f) => f.speaker === 'you')
                .map((f) => ({ claim: f.claim, verdict: f.verdict, correction: f.correction })),
            });
            const reviewAction = registry.suggest({
              type: 'review',
              title: `Self-Review: ${session?.title || 'Untitled'}`,
              description: 'Post-meeting self-review — how you did, with cross-meeting trends',
              triggerQuote: String(reviewParams.transcript).slice(-200),
              estimatedDurationSec: 30,
              params: reviewParams,
            }, { force: true, system: true });
            if (reviewAction) {
              sessionStore.addAction({
                id: reviewAction.id,
                type: reviewAction.type,
                title: reviewAction.title,
                description: reviewAction.description,
                triggerQuote: reviewAction.triggerQuote,
                state: reviewAction.state,
                params: reviewAction.params,
                createdAt: reviewAction.createdAt,
              });
              registry.approve(reviewAction.id);
              debugLog('[Session] Auto-review triggered');
            }
          }
        } catch (error) {
          console.error('[Session] Failed to trigger auto-review:', error instanceof Error ? error.message : String(error));
        }

        // Let workers finish (includes auto-summary + auto-review if triggered)
        await registry.onMeetingEnd();
      } catch (error) {
        console.error(
          '[Session] Stop sequence error:',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        // Always finalize — even if the wrap-up sequence above threw — so the UI
        // can never strand on "Ending…". Each step is independently guarded so a
        // late failure can't skip the terminal broadcast.
        try {
          removePresence();
        } catch {
          /* non-critical */
        }
        try {
          sessionStore?.updateState('ended');
        } catch {
          /* non-critical */
        }
        try {
          sessionStore?.close();
        } catch {
          /* non-critical */
        }
        sessionStore = null;
        eventLogger = null;
        sessionActive = false;
        postSessionState = 'archived';

        debugLog('[Session] Stopped');

        broadcast({
          type: 'session.state',
          state: 'archived',
          sessionId: lastSessionId ?? undefined,
        });
      }
      break;
    }

    case 'action.approve': {
      // Inject live transcript into worker params if not already present
      const actionToApprove = registry.getAction(message.actionId);
      if (actionToApprove && sessionStore) {
        const transcriptRecords = sessionStore.getTranscript();
        if (transcriptRecords.length > 0) {
          const transcript = transcriptRecords.map((r) => `${r.label} ${r.text}`).join('\n');
          if (actionToApprove.type === 'summary' && !actionToApprove.params.transcript) {
            actionToApprove.params.transcript = transcript;
            actionToApprove.params.title = actionToApprove.params.title ?? sessionStore.getSession()?.title;
          }
          // Give all workers meeting context if they don't have it
          if (!actionToApprove.params.meetingTranscript) {
            actionToApprove.params.meetingTranscript = transcript;
          }
        }
      }
      registry.approve(message.actionId);
      eventLogger?.log('action.approved', { actionId: message.actionId });
      break;
    }

    case 'action.dismiss': {
      registry.dismiss(message.actionId);
      eventLogger?.log('action.dismissed', { actionId: message.actionId });
      break;
    }

    case 'feature.toggle': {
      if (message.feature !== 'factcheck' && message.feature !== 'coach') break;
      featureFlags[message.feature] = !!message.enabled;
      applyFeatureFlags();
      eventLogger?.log('feature.toggle', { feature: message.feature, enabled: featureFlags[message.feature] });
      broadcast({ type: 'feature.state', features: { ...featureFlags } });
      break;
    }

    case 'meeting.goals': {
      meetingGoals = (message.goals ?? '').toString().slice(0, 1_000).trim();
      // Privacy: goals can contain negotiation positions — log length only.
      eventLogger?.log('meeting.goals', { length: meetingGoals.length });
      debugLog(`[Coach] meeting goals set (${meetingGoals.length} chars)`);
      break;
    }

    case 'action.cancel': {
      registry.cancel(message.actionId);
      eventLogger?.log('action.cancelled', { actionId: message.actionId });
      break;
    }

    case 'action.trigger': {
      if (!sessionActive || !sessionStore) {
        console.warn('[Action] No active session for manual trigger');
        return;
      }

      // Self-review is special: it needs the FULL transcript + talk-ratio +
      // agenda + fact flags, not the recent triage window. Build it via the
      // same helper the stop-path auto-review uses, then auto-approve so it
      // runs immediately as a normal card.
      if (message.actionType === 'review') {
        const transcriptRecords = sessionStore.getTranscript();
        if (transcriptRecords.length === 0) {
          debugLog('[Action] Review trigger ignored — no transcript yet');
          return;
        }
        const session = sessionStore.getSession();
        const reviewParams = buildReviewParams({
          transcriptRecords,
          title: session?.title,
          sessionId: sessionStore.id,
          agendaSummary:
            lastAgendaStatus && lastAgendaStatus.items.length > 0
              ? lastAgendaStatus.items.map((i) => `[${i.state}] ${i.text}`).join('\n') +
                (lastAgendaStatus.missing.length > 0
                  ? `\nPossibly missing: ${lastAgendaStatus.missing.join('; ')}`
                  : '')
              : '',
          goals: meetingGoals,
          factFlags: sessionFactFlags
            .filter((f) => f.speaker === 'you')
            .map((f) => ({ claim: f.claim, verdict: f.verdict, correction: f.correction })),
        });
        const reviewAction = registry.suggest({
          type: 'review',
          title: `Self-Review: ${session?.title || 'Untitled'}`,
          description: message.prompt || 'Self-review of the meeting so far',
          triggerQuote: String(reviewParams.transcript).slice(-200),
          estimatedDurationSec: 30,
          params: reviewParams,
        });
        if (!reviewAction) {
          debugLog('[Action] Review trigger filtered by dedup');
          return;
        }
        sessionStore.addAction({
          id: reviewAction.id,
          type: reviewAction.type,
          title: reviewAction.title,
          description: reviewAction.description,
          triggerQuote: reviewAction.triggerQuote,
          state: reviewAction.state,
          params: reviewAction.params,
          createdAt: reviewAction.createdAt,
        });
        broadcast({
          type: 'action.suggested',
          action: {
            id: reviewAction.id,
            type: reviewAction.type,
            title: reviewAction.title,
            description: reviewAction.description,
            triggerQuote: reviewAction.triggerQuote,
            estimatedDurationSec: reviewAction.estimatedDurationSec,
            state: reviewAction.state,
            createdAt: new Date(reviewAction.createdAt).toISOString(),
          },
        });
        registry.approve(reviewAction.id);
        eventLogger?.log('action.approved', { actionId: reviewAction.id, source: 'manual-review' });
        break;
      }

      const window = intelligence.getTranscriptWindow();
      const actionType = message.actionType as 'research' | 'fast-research' | 'summary' | 'mockup' | 'codegen' | 'analysis';
      const description = message.prompt ?? `Manual ${actionType} on current transcript`;

      // Card-derived mockup: a right-click "Mockup"/"Revise mock" carries the
      // source card's text (cardContent) and, for a revision, the base
      // wireframe/HTML. These are deliberate user clicks, so bypass dedup.
      const mockupBase = actionType === 'mockup' ? (message.baseWireframe || message.baseHtml) : undefined;
      const isCardDerived = actionType === 'mockup' && Boolean(message.cardContent || mockupBase);

      const titleVerb = mockupBase ? 'Mockup revision' : `${actionType.charAt(0).toUpperCase() + actionType.slice(1)}`;
      const suggestion: ActionSuggestion = {
        type: actionType,
        title: message.prompt
          ? `${titleVerb}: ${message.prompt}`
          : mockupBase
            ? 'Mockup revision'
            : `Manual ${actionType.charAt(0).toUpperCase() + actionType.slice(1)}`,
        description,
        triggerQuote: window.slice(-200),
        estimatedDurationSec: 30,
        params: (() => {
          switch (actionType) {
            case 'research':
            case 'fast-research':
              return {
                query: message.prompt || 'Research topics from current discussion',
                context: window,
              };
            case 'summary':
              return {
                transcript: window,
                scope: message.prompt ? 'focused' : 'full',
                ...(message.prompt ? { focus: message.prompt } : {}),
                title: sessionStore?.getSession()?.title,
              };
            case 'analysis':
              return {
                topic: message.prompt || 'Analyze current discussion',
                context: window,
              };
            case 'mockup': {
              // Mockup worker requires `description`; the prompt is that. For a
              // card-derived mockup, fold the source card's text into context and
              // (for revisions) pass the existing wireframe/HTML through as the base.
              const mockupContext = [window, message.cardContent ? `Source card:\n${message.cardContent}` : '']
                .filter(Boolean)
                .join('\n\n');
              return {
                description:
                  message.prompt ||
                  (mockupBase
                    ? 'Refine and improve this mockup'
                    : message.cardContent
                      ? `UI mockup based on: ${message.cardContent.slice(0, 200)}`
                      : 'UI mockup from the current discussion'),
                context: mockupContext,
                ...(message.baseWireframe ? { baseWireframe: message.baseWireframe } : {}),
                ...(message.baseHtml ? { baseHtml: message.baseHtml } : {}),
              };
            }
            case 'codegen':
              // CodeGen worker requires `task`.
              return {
                task: message.prompt || 'Code from the current discussion',
                context: window,
              };
            default:
              return {
                context: window,
                ...(message.prompt ? { userPrompt: message.prompt } : {}),
              };
          }
        })(),
      };

      // Inject project context into worker params
      const projectContext = intelligence.getProjectContext();
      if (projectContext.length > 0) {
        const projectBlock = projectContext.map((c) => formatProjectBrief(c)).join('\n---\n');
        const existing = suggestion.params.context ?? '';
        suggestion.params.context = existing
          ? `${existing}\n\nProject Context:\n${projectBlock}`
          : `Project Context:\n${projectBlock}`;
        suggestion.params._projectPaths = projectContext.map((c) => c.path);
      }

      // Inject context directory docs into worker params
      const contextDocs = intelligence.getContextDocs();
      if (contextDocs.length > 0) {
        const docsBlock = buildContextBlock(contextDocs, message.prompt);
        const existing = suggestion.params.context ?? '';
        suggestion.params.context = existing
          ? `${existing}\n\nReference Documents:\n${docsBlock}`
          : `Reference Documents:\n${docsBlock}`;
      }

      const action = registry.suggest(suggestion, isCardDerived ? { force: true } : undefined);
      if (!action) {
        debugLog('[Action] Manual trigger filtered by dedup');
        return;
      }

      // Persist to store
      sessionStore.addAction({
        id: action.id,
        type: action.type,
        title: action.title,
        description: action.description,
        triggerQuote: action.triggerQuote,
        state: action.state,
        params: action.params,
        createdAt: action.createdAt,
      });

      eventLogger?.log('action.suggested', {
        actionId: action.id,
        type: action.type,
        title: action.title,
        source: 'manual',
      });

      // Broadcast suggestion to Swift
      broadcast({
        type: 'action.suggested',
        action: {
          id: action.id,
          type: action.type,
          title: action.title,
          description: action.description,
          triggerQuote: action.triggerQuote,
          estimatedDurationSec: action.estimatedDurationSec,
          state: action.state,
          createdAt: new Date(action.createdAt).toISOString(),
        },
      });

      // Auto-approve immediately — manual triggers bypass approval flow
      registry.approve(action.id);
      eventLogger?.log('action.approved', { actionId: action.id, source: 'manual' });

      break;
    }
  }
}

// ─── Intelligence → WebSocket Bridge ───────────────────────────────────────

// Inject project + context-doc awareness into a worker's params (once per
// suggestion — the params object that the worker will actually execute with).
function injectWorkerContext(params: Record<string, any>, triggerQuote: string): void {
  const projectContext = intelligence.getProjectContext();
  if (projectContext.length > 0) {
    const projectBlock = projectContext.map((c) => formatProjectBrief(c)).join('\n---\n');
    const existing = params.context ?? '';
    params.context = existing ? `${existing}\n\nProject Context:\n${projectBlock}` : `Project Context:\n${projectBlock}`;
    params._projectPaths = projectContext.map((c) => c.path);
  }
  const contextDocs = intelligence.getContextDocs();
  if (contextDocs.length > 0) {
    const docsBlock = buildContextBlock(contextDocs, triggerQuote);
    const existing = params.context ?? '';
    params.context = existing ? `${existing}\n\nReference Documents:\n${docsBlock}` : `Reference Documents:\n${docsBlock}`;
  }
}

function broadcastActionCard(action: ActionLifecycle): void {
  broadcast({
    type: 'action.suggested',
    action: {
      id: action.id,
      type: action.type,
      title: action.title,
      description: action.description,
      triggerQuote: action.triggerQuote,
      estimatedDurationSec: action.estimatedDurationSec,
      state: action.state,
      streaming: action.streaming ?? false,
      paramsReady: action.paramsReady ?? false,
      pendingApproval: action.pendingApproval ?? false,
      createdAt: new Date(action.createdAt).toISOString(),
    },
  });
}

// Streaming suggestion: the card is created and broadcast WHILE the Sonnet JSON
// is still generating, so the user can pre-approve it. When params close (and
// if pre-approved), the worker launches immediately — no waiting for the rest.
const injectedSuggestionIds = new Set<string>();

intelligence.onPartialSuggestion(({ id, partial, final, done }) => {
  if (!done) {
    if (!partial.type || !partial.title) return; // need enough to show a card

    if (!registry.getAction(id)) {
      // First meaningful partial → create the streaming card.
      let params: Record<string, any> | undefined;
      if (partial.paramsReady && partial.params) {
        injectWorkerContext(partial.params, partial.triggerQuote ?? '');
        injectedSuggestionIds.add(id);
        params = partial.params;
      }
      const action = registry.suggestStreaming(id, {
        type: partial.type,
        title: partial.title,
        description: partial.description,
        triggerQuote: partial.triggerQuote,
        estimatedDurationSec: partial.estimatedDurationSec,
        params,
      });
      if (params) action.paramsReady = true;
      broadcastActionCard(action);
      return;
    }

    // Subsequent partial → grow the card.
    const fields: Record<string, any> = {
      title: partial.title,
      description: partial.description,
      triggerQuote: partial.triggerQuote,
      estimatedDurationSec: partial.estimatedDurationSec,
    };
    if (partial.paramsReady && partial.params && !injectedSuggestionIds.has(id)) {
      injectWorkerContext(partial.params, partial.triggerQuote ?? '');
      injectedSuggestionIds.add(id);
      fields.params = partial.params; // first & only time we set params (now injected)
      fields.paramsReady = true;
    }
    registry.updateStreaming(id, fields); // may auto-dispatch if pre-approved
    const updated = registry.getAction(id);
    if (updated) broadcastActionCard(updated);
    return;
  }

  // done
  if (!final) {
    if (registry.getAction(id)) {
      registry.finalizeStreaming(id, null); // drop the in-progress card
      broadcast({ type: 'action.status', actionId: id, state: 'cancelled' });
    }
    injectedSuggestionIds.delete(id);
    return;
  }

  if (!injectedSuggestionIds.has(id)) {
    injectWorkerContext(final.params, final.triggerQuote);
    injectedSuggestionIds.add(id);
  }

  const action = registry.getAction(id)
    ? registry.finalizeStreaming(id, final)
    : registry.suggest(final); // never created a streaming card → normal path
  injectedSuggestionIds.delete(id);
  if (!action) return; // dedup filtered or dropped

  if (sessionStore) {
    sessionStore.addAction({
      id: action.id,
      type: action.type,
      title: action.title,
      description: action.description,
      triggerQuote: action.triggerQuote,
      state: action.state,
      params: action.params,
      createdAt: action.createdAt,
    });
  }
  eventLogger?.log('action.suggested', { actionId: action.id, type: action.type, title: action.title });
  broadcastActionCard(action);
});

intelligence.onContextSummary((summary) => {
  if (sessionStore) {
    sessionStore.addContextSummary(summary);
  }
  eventLogger?.log('intelligence.compression', {
    windowStart: summary.windowStart,
    windowEnd: summary.windowEnd,
  });
});

// ─── Worker Events → WebSocket Bridge ──────────────────────────────────────

/**
 * Persist an action status that arrived AFTER the session's store was closed
 * (stop `finally` nulls sessionStore, but a worker force-cancelled at the
 * END_GRACE ceiling can still resolve later). Reopens the existing session DB,
 * upserts the row, refreshes the manifest, and closes — so late results
 * survive into replay instead of being broadcast once and lost.
 */
function persistActionPostSession(sessionId: string, action: ActionLifecycle): void {
  const dbPath = join(homedir(), '.meeting-copilot', 'sessions', sessionId, 'session.db');
  // Never create a ghost session dir for a bogus id — only reopen existing DBs.
  if (!existsSync(dbPath)) return;
  try {
    const store = new SessionStore(sessionId);
    try {
      const changes = store.updateAction(action.id, {
        state: action.state,
        result: action.result,
        approvedAt: action.approvedAt,
        startedAt: action.startedAt,
        completedAt: action.completedAt,
      });
      if (changes === 0) {
        store.addAction({
          id: action.id,
          type: action.type,
          title: action.title,
          description: action.description,
          triggerQuote: action.triggerQuote,
          state: action.state,
          params: action.params,
          createdAt: action.createdAt,
        });
        store.updateAction(action.id, {
          state: action.state,
          result: action.result,
          approvedAt: action.approvedAt,
          startedAt: action.startedAt,
          completedAt: action.completedAt,
        });
      }
      store.writeManifest();
    } finally {
      store.close();
    }
    debugLog(`[Session] Persisted post-session action ${action.id} (${action.state}) into ${sessionId}`);
  } catch (err) {
    debugLog(`[Session] Post-session persist failed for ${action.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

registry.on('action.status', (action: ActionLifecycle) => {
  if (sessionStore) {
    sessionStore.updateAction(action.id, {
      state: action.state,
      result: action.result,
      approvedAt: action.approvedAt,
      startedAt: action.startedAt,
      completedAt: action.completedAt,
    });
  } else if (lastSessionId) {
    persistActionPostSession(lastSessionId, action);
  }

  eventLogger?.log('action.status', {
    actionId: action.id,
    state: action.state,
  });

  broadcast({
    type: 'action.status',
    actionId: action.id,
    state: action.state,
    result: action.result,
    streaming: action.streaming ?? false,
    paramsReady: action.paramsReady ?? false,
    pendingApproval: action.pendingApproval ?? false,
  });
});

registry.on('action.stream', ({ actionId, delta }: { actionId: string; delta: string }) => {
  broadcast({ type: 'action.stream', actionId, delta });
});

registry.on('action.completed', (action: ActionLifecycle) => {
  eventLogger?.log('worker.complete', {
    actionId: action.id,
    type: action.type,
    success: action.result?.success,
  });
});

// ─── Transcript Stitcher → persistence + broadcast ─────────────────────────
// The stitcher grows a per-source open segment and emits it on every change.
// Every emit broadcasts a transcript.update with replace:true (so the UI
// replaces the open line in place); only CLOSED (cohesive) segments are
// persisted to SQLite, fed to intelligence, and appended to the shared JSONL.
transcriptStitcher.on(
  'segment',
  ({ segment, final }: { segment: TranscriptSegment; final: boolean }) => {
    if (!sessionActive || !sessionStore) return;

    // Coach sees stable open-segment updates as well as the final cohesive
    // turn. This lets meeting-side pressure/questions start inference before
    // the stitcher's silence timeout, while mic answer review waits for final.
    if (coach.isRunning()) {
      coach.noteSegment(segment.text, segment.source, {
        final,
        segmentId: segment.id,
        timestamp: segment.timestamp,
      });
    }

    if (final) {
      sessionStore.addTranscript(segment);
      intelligence.addTranscript(segment);
      // Event-driven monitor triggers fire on the cleaned, cohesive segment.
      if (factCheck.isRunning()) factCheck.noteSegment(segment.text);
      agendaTracker.noteSegment(segment.text, segment.source);
      debug.recordTranscriptWords(segment.wordCount);
      debug.recordTranscriptSegment(segment);
      eventLogger?.log('transcript.segment', {
        segmentId: segment.id,
        source: segment.source,
        wordCount: segment.wordCount,
        audioDurationSec: segment.audioDurationSec,
        transcriptionLatencyMs: segment.transcriptionLatencyMs,
        sequence: segment.sequence,
      });
      appendTranscript(segment);
    }

    // Broadcast to all clients (dates as ISO-8601 for Swift Codable).
    // `duration` kept during v2 rollout for backward compat; `replace` tells
    // the dashboard to update the existing line rather than insert a new one.
    broadcast({
      type: 'transcript.update',
      segment: {
        id: segment.id,
        text: segment.text,
        source: segment.source,
        label: segment.label,
        timestamp: new Date(segment.timestamp).toISOString(),
        audioDurationSec: segment.audioDurationSec,
        transcriptionLatencyMs: segment.transcriptionLatencyMs,
        captureStartedAt: segment.captureStartedAt,
        captureEndedAt: segment.captureEndedAt,
        sequence: segment.sequence,
        duration: segment.audioDurationSec,
        wordCount: segment.wordCount,
        replace: true,
      },
    });
  },
);

// ─── Intelligence Events ───────────────────────────────────────────────────

intelligence.on('intelligence.eval', (data) => {
  eventLogger?.log('intelligence.eval', data);
});

// Live "evaluating / drafting" indicator for the dashboard. Not logged —
// purely ephemeral UI state.
intelligence.on('intelligence.activity', (data: { phase: 'evaluating' | 'generating' | 'idle' }) => {
  broadcast({ type: 'intelligence.status', phase: data.phase });
});

intelligence.on('intelligence.error', (data) => {
  eventLogger?.log('intelligence.error', data);
  // Also surface to server.log so `grep '[openai-triage]' server.log` (and
  // similar tag-based workflows) pick up failures without having to open the
  // per-session JSONL.
  try {
    debugLog(`[intelligence.error] ${JSON.stringify(data)}`);
  } catch {
    debugLog(`[intelligence.error] (unserializable payload)`);
  }
  const message = typeof data?.error === 'string' ? data.error : 'Intelligence eval failed';
  broadcast({
    type: 'intelligence.error',
    source: message.startsWith('Context compression') ? 'compression' : 'triage',
    message,
    at: Date.now(),
  });
});

// Per-session LLM budget lockout. Fires ONCE per session, unlike the
// per-call `intelligence.error` above: once the budget is spent every lane
// fails identically forever, and repeating that hundreds of times told the
// user nothing (the 2026-07-31 session logged it 726 times while the meeting
// silently ran on with no suggestions). `degraded: true` pins the badge so the
// state is visible for the rest of the meeting rather than toasting once.
setLlmBudgetExceededHandler((limit) => {
  const message = `LLM budget exhausted (${limit}) — suggestions, agenda and coach are stopped for this session.`;
  debugLog(`[budget] ${message}`);
  broadcast({ type: 'intelligence.error', source: 'budget', message, at: Date.now(), degraded: true });
});

// CLI-tier health: the Gemini triage circuit breaker opening/closing. Degraded
// pins the dashboard badge until recovery.
cliHealth.on('degraded', (data: { message: string }) => {
  broadcast({ type: 'intelligence.error', source: 'cli', message: data.message, at: Date.now(), degraded: true });
});
cliHealth.on('recovered', () => {
  broadcast({ type: 'intelligence.error', source: 'cli', message: 'Gemini triage recovered', at: Date.now(), recovered: true });
});

// ─── Startup ───────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Ensure base directory exists
  if (!existsSync(COPILOT_DIR)) {
    mkdirSync(COPILOT_DIR, { recursive: true });
  }

  // Remove stale socket file
  if (existsSync(SOCKET_PATH)) {
    console.log('[Server] Removing stale socket file');
    unlinkSync(SOCKET_PATH);
  }

  // Cleanup stale shared presence from a previous crash
  cleanStalePresence();

  // Cleanup old sessions
  const cleanupResult = cleanupOldSessions(configuredRetentionDays);
  if (cleanupResult.deleted.length > 0) {
    console.log(
      `[Cleanup] Deleted ${cleanupResult.deleted.length} old session(s)`,
    );
  }
  if (cleanupResult.errors.length > 0) {
    console.warn('[Cleanup] Errors:', cleanupResult.errors);
  }

  // Check selected transcription provider availability.
  const transcriptionOk = await transcription.isProviderAvailable();
  whisperAvailable = transcriptionOk;
  const transcriptionInfo = transcription.providerInfo;
  console.log(`[Transcription] ${transcriptionInfo.mode} available: ${transcriptionOk}`);
  if (transcriptionOk) {
    if (transcriptionInfo.endpoint) {
      console.log(`[Transcription] Endpoint: ${transcriptionInfo.endpoint}`);
    }
  }

  const openaiOk = isOpenAiApiAvailable();
  const anthropicOk = isAnthropicApiAvailable();
  if (paidApiDisabled()) {
    debugLog('[LLM] COPILOT_DISABLE_PAID_API set — ALL inference forced to the CLIs. Zero OpenAI/Anthropic spend this run (Fast + highlight-to-ask fall back to CLI).');
  } else {
    const liveProviders = LLM_CONFIG.liveTransport === 'cli'
      ? 'cli'
      : [openaiOk ? 'openai' : '', anthropicOk ? 'anthropic' : ''].filter(Boolean).join('+') || 'cli-fallback';
    debugLog(`[LLM] live=${liveProviders} agenda=${MODEL_CONFIG.agenda}/${MODEL_CONFIG.agendaReconcile} coach=${MODEL_CONFIG.coach} · workers=${LLM_CONFIG.workerTransport}`);
    debugLog(`[LLM] Fast button=${openaiOk ? 'openai:configured+web_search' : 'cli:haiku+WebSearch (no OPENAI_API_KEY)'} · highlight-to-ask=${openaiOk ? 'openai' : anthropicOk ? 'anthropic' : 'cli'}`);
  }

  // Start listening on Unix domain socket
  server.listen(SOCKET_PATH, () => {
    // Set socket permissions to owner-only
    try {
      chmodSync(SOCKET_PATH, 0o600);
    } catch (error) {
      console.warn(
        '[Server] Failed to set socket permissions:',
        error instanceof Error ? error.message : String(error),
      );
    }

    console.log(`[Server] Listening on ${SOCKET_PATH}`);
  });

  // Also listen on localhost TCP for Swift app (URLSessionWebSocketTask
  // doesn't natively support Unix sockets). Bound to localhost only.
  const TCP_PORT = parseInt(process.env.COPILOT_PORT || '17890', 10);
  tcpServerRef = createServer(app);
  const tcpWss = new WebSocketServer({ server: tcpServerRef });

  const tcpServer = tcpServerRef;
  tcpWss.on('connection', (ws) => handleWsConnection(ws, 'WS/TCP'));

  tcpServer.listen(TCP_PORT, '127.0.0.1', () => {
    console.log(`[Server] Listening on http://127.0.0.1:${TCP_PORT}`);
    debugLog('[Server] Meeting Copilot server ready');
    // Fire-and-forget: pay whisper's Metal JIT cost now so the user's
    // first real chunk lands in ~500ms instead of ~3s. Safe to run even
    // before a session starts — whisper-server caches the model.
    transcription.prewarm().catch(() => {
      /* logged inside prewarm() */
    });
  });
}

// Reference to TCP server so shutdown can close it
let tcpServerRef: ReturnType<typeof createServer> | null = null;

// ─── Graceful Shutdown ─────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[Server] Received ${signal}, shutting down...`);

  // Stop intelligence + agenda
  intelligence.stop();
  agendaTracker.stop();

  // Kill any warm persistent `claude` sessions so they don't orphan on :17890.
  disposeAllWarmSessions();

  // Close WebSocket connections
  for (const client of clients) {
    client.close(1001, 'Server shutting down');
  }
  wss.close();

  // Remove shared presence
  removePresence();

  // Close session if active
  if (sessionStore) {
    sessionStore.updateState('ended');
    sessionStore.close();
    sessionStore = null;
  }

  // Close HTTP servers
  server.close();
  if (tcpServerRef) {
    tcpServerRef.close();
    tcpServerRef = null;
  }

  // Remove socket file
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
      console.log('[Server] Socket file removed');
    } catch {
      // Best effort
    }
  }

  console.log('[Server] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught exception:', error);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
  shutdown('unhandledRejection');
});

// ─── Start Server ──────────────────────────────────────────────────────────

start().catch((error) => {
  console.error('[Server] Failed to start:', error);
  process.exit(1);
});
