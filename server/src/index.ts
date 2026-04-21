import { createServer } from 'node:http';
import { unlinkSync, existsSync, mkdirSync, chmodSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// File-based debug logging
const LOG_FILE = join(homedir(), '.meeting-copilot', 'server.log');
function debugLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
  console.log(msg);
}
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

import { TranscriptionService } from './transcription/index.js';
import { IntelligenceEngine } from './intelligence/index.js';
import { WorkerRegistry } from './workers/registry.js';
import { ResearchWorker } from './workers/research.js';
import { FastResearchWorker } from './workers/fast-research.js';
import { SummaryWorker } from './workers/summary.js';
import { MockupWorker } from './workers/mockup.js';
import { CodeGenWorker } from './workers/codegen.js';
import { AnalysisWorker } from './workers/analysis.js';
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

// Load environment
dotenv.config();

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
      data: string; // base64 PCM
      source: 'mic' | 'meeting';
    }
  | { type: 'session.start'; title?: string; projectNames?: string[]; agenda?: string; attendees?: string; contextPaths?: string[]; contextDirPaths?: string[] }
  | { type: 'session.stop' }
  | { type: 'action.approve'; actionId: string }
  | { type: 'action.dismiss'; actionId: string }
  | { type: 'action.cancel'; actionId: string }
  | { type: 'action.trigger'; actionType: string; prompt?: string };

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
        duration: number;
        wordCount: number;
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
      };
    }
  | {
      type: 'action.status';
      actionId: string;
      state: string;
      result?: any;
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
    }
  | {
      type: 'metrics';
      data: any;
    };

// ─── App State ─────────────────────────────────────────────────────────────

let sessionStore: SessionStore | null = null;
let eventLogger: EventLogger | null = null;
let sessionActive = false;

// Rolling summary: periodically refreshes the summary card with updated transcript
let rollingSummaryId: string | null = null;
let rollingSummaryTimer: ReturnType<typeof setInterval> | null = null;
let rollingSummaryWordCount = 0;
const ROLLING_SUMMARY_INTERVAL_MS = 120_000; // 2 minutes
let configuredRetentionDays = 90;
let whisperAvailable: boolean | null = null;

// ─── Initialize Core Services ──────────────────────────────────────────────

const transcription = new TranscriptionService();
const intelligence = new IntelligenceEngine();
const registry = new WorkerRegistry();
const debug = new DebugHandler(transcription, intelligence, registry);

// Register workers
registry.register(new ResearchWorker());
registry.register(new FastResearchWorker());
registry.register(new SummaryWorker());
registry.register(new MockupWorker());
registry.register(new CodeGenWorker());
registry.register(new AnalysisWorker());

// ─── Express App ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ type: 'audio/*', limit: '10mb' }));

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

  // Send current state (values match Swift SessionState enum)
  const stateMsg: OutboundMessage = {
    type: 'session.state',
    state: sessionActive ? 'live' : 'idle',
    sessionId: sessionStore?.id,
  };
  ws.send(JSON.stringify(stateMsg));

  ws.on('message', async (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as InboundMessage;
      await handleInboundMessage(message);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
      // Use debugLog (writes to server.log) so handler failures are diagnosable
      // without needing to capture the child process's stderr pipe.
      debugLog(`[${label}] Handler error: ${msg}${stack}`);
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

      try {
        const segment = await transcription.transcribeChunk(
          wavBuffer,
          message.source,
        );

        if (segment.text) {
          // Store and process
          if (sessionStore) {
            sessionStore.addTranscript(segment);
          }
          intelligence.addTranscript(segment);
          debug.recordTranscriptWords(segment.wordCount);

          eventLogger?.log('transcript.chunk', {
            segmentId: segment.id,
            source: segment.source,
            wordCount: segment.wordCount,
          });

          // Broadcast to Swift (dates as ISO-8601 for Swift Codable)
          broadcast({
            type: 'transcript.update',
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

          // Append to shared transcript for companion apps
          appendTranscript(segment);
        }
      } catch (error) {
        console.error(
          '[Transcription] Error:',
          error instanceof Error ? error.message : String(error),
        );
      }
      break;
    }

    case 'session.start': {
      if (sessionActive) {
        console.warn('[Session] Session already active, ignoring start');
        return;
      }

      // Create new session
      sessionStore = new SessionStore();
      sessionStore.createSession(message.title ?? '', message.projectNames ?? [], message.agenda, message.attendees);

      eventLogger = new EventLogger(sessionStore.directory);
      eventLogger.log('session.start', { sessionId: sessionStore.id, title: message.title, agenda: message.agenda, attendees: message.attendees });

      debug.setSessionStartTime(Date.now());
      debug.recordStateTransition();

      // Set meeting context on intelligence engine
      if (message.agenda || message.attendees) {
        intelligence.setMeetingContext({ agenda: message.agenda, attendees: message.attendees });
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

      debugLog(`[Session] Started: ${sessionStore.id}`);

      broadcast({
        type: 'session.state',
        state: 'live',
        sessionId: sessionStore.id,
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
              });
              if (action) {
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

      eventLogger?.log('session.stop', { sessionId: sessionStore.id });
      debug.recordStateTransition();

      // Stop rolling summary
      if (rollingSummaryTimer) {
        clearInterval(rollingSummaryTimer);
        rollingSummaryTimer = null;
      }
      rollingSummaryId = null;
      rollingSummaryWordCount = 0;

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
            },
          });
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

      // Let workers finish (includes auto-summary if triggered)
      await registry.onMeetingEnd();

      // Remove shared presence
      removePresence();

      // Update store
      sessionStore.updateState('ended');
      sessionStore.close();
      sessionStore = null;
      eventLogger = null;
      sessionActive = false;

      debugLog('[Session] Stopped');

      broadcast({
        type: 'session.state',
        state: 'archived',
      });
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

      const window = intelligence.getTranscriptWindow();
      const actionType = message.actionType as 'research' | 'fast-research' | 'summary' | 'mockup' | 'codegen' | 'analysis';
      const description = message.prompt ?? `Manual ${actionType} on current transcript`;

      const suggestion: ActionSuggestion = {
        type: actionType,
        title: message.prompt
          ? `${actionType.charAt(0).toUpperCase() + actionType.slice(1)}: ${message.prompt}`
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

      const action = registry.suggest(suggestion);
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

intelligence.onSuggestion((suggestion: ActionSuggestion) => {
  // Inject project context into worker params so workers get codebase awareness
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
    const docsBlock = buildContextBlock(contextDocs, suggestion.triggerQuote);
    const existing = suggestion.params.context ?? '';
    suggestion.params.context = existing
      ? `${existing}\n\nReference Documents:\n${docsBlock}`
      : `Reference Documents:\n${docsBlock}`;
  }

  const action = registry.suggest(suggestion);
  if (!action) return; // Dedup filtered it

  // Persist to store
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

  eventLogger?.log('action.suggested', {
    actionId: action.id,
    type: action.type,
    title: action.title,
  });

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

registry.on('action.status', (action: ActionLifecycle) => {
  if (sessionStore) {
    sessionStore.updateAction(action.id, {
      state: action.state,
      result: action.result,
      approvedAt: action.approvedAt,
      startedAt: action.startedAt,
      completedAt: action.completedAt,
    });
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

// ─── Intelligence Events ───────────────────────────────────────────────────

intelligence.on('intelligence.eval', (data) => {
  eventLogger?.log('intelligence.eval', data);
});

intelligence.on('intelligence.error', (data) => {
  eventLogger?.log('intelligence.error', data);
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

  // Check whisper availability
  const whisperOk = await transcription.isProviderAvailable();
  whisperAvailable = whisperOk;
  const whisperInfo = (transcription as any).provider?.getInfo?.() ?? {};
  console.log(`[Whisper] Available: ${whisperOk}`);
  if (whisperOk) {
    if (whisperInfo.endpoint) {
      console.log(`[Whisper] Endpoint: ${whisperInfo.endpoint}`);
    }
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
  });
}

// Reference to TCP server so shutdown can close it
let tcpServerRef: ReturnType<typeof createServer> | null = null;

// ─── Graceful Shutdown ─────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[Server] Received ${signal}, shutting down...`);

  // Stop intelligence
  intelligence.stop();

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
