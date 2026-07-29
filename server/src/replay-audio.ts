#!/usr/bin/env tsx
/**
 * Replay recorded WAV audio through the full meeting-copilot pipeline.
 *
 * Usage: npx tsx src/replay-audio.ts <recording-dir> [--speed <multiplier>]
 *   [--minutes <n>] [--agenda <items>] [--port <port>]
 *
 * Reads system.wav and mic.wav from a Notes4Chris recording directory,
 * chunks them into 10-second segments (with proper WAV headers), and streams
 * them over WebSocket to the running copilot server — testing the full pipeline:
 *   audio → transcription → intelligence → suggestions → workers
 *
 * Requires the copilot server (and whisper-server) to be running.
 */

import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import WebSocket from 'ws';
import {
  CHUNK_DURATION_SECONDS,
  CHUNK_OVERLAP_SECONDS,
  SAMPLE_RATE,
  BYTES_PER_SAMPLE,
  CHANNELS,
  BYTES_PER_CHUNK,
} from './audio/chunkConfig.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const CHUNK_DURATION_SEC = CHUNK_DURATION_SECONDS; // shared with production
const CHUNK_ADVANCE_SEC = CHUNK_DURATION_SECONDS - CHUNK_OVERLAP_SECONDS;
const OVERLAP_BYTES =
  CHUNK_OVERLAP_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS;
const WAV_HEADER_SIZE = 44;

// ─── Args ───────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let recordingDir = '';
  let speed = 1;
  let port = 17890;
  let autoApprove = false;
  let minutes: number | undefined;
  let agenda: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--speed' && args[i + 1]) {
      speed = parseFloat(args[i + 1]!);
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === '--minutes' && args[i + 1]) {
      minutes = parseFloat(args[i + 1]!);
      i++;
    } else if (args[i] === '--agenda' && args[i + 1]) {
      agenda = args[i + 1]!;
      i++;
    } else if (args[i] === '--auto-approve') {
      autoApprove = true;
    } else if (!args[i]!.startsWith('--')) {
      recordingDir = args[i]!;
    }
  }

  if (!recordingDir) {
    console.error('Usage: npx tsx src/replay-audio.ts <recording-dir> [--speed <multiplier>] [--minutes <n>] [--agenda <items>] [--port <port>] [--auto-approve]');
    console.error('');
    console.error('Options:');
    console.error('  --speed <n>      Playback speed multiplier (default: 1, use 4 for 4x faster)');
    console.error('  --minutes <n>    Replay only the first n minutes');
    console.error('  --agenda <items> Override manifest agenda (semicolon-separated is supported)');
    console.error('  --port <n>       Server port (default: 17890)');
    console.error('  --auto-approve   Automatically approve suggestions so workers execute');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx src/replay-audio.ts ~/Documents/Notes4ChrisRecordings/recordings/2026-03-17_22-02-27_session --speed 4 --auto-approve');
    process.exit(1);
  }

  if (!Number.isFinite(speed) || speed <= 0) {
    throw new Error('--speed must be a positive number');
  }
  if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) {
    throw new Error('--minutes must be a positive number');
  }

  return { recordingDir, speed, port, autoApprove, minutes, agenda };
}

// ─── WAV Utilities ──────────────────────────────────────────────────────────

/** Read raw PCM data from a WAV file (strips the 44-byte header). */
function readWavPcm(filePath: string): Buffer {
  const buf = readFileSync(filePath);
  return buf.subarray(WAV_HEADER_SIZE);
}

/** Build a valid WAV header for a PCM data chunk. */
function createWavHeader(dataLength: number): Buffer {
  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4); // file size - 8
  header.write('WAVE', 8);

  // fmt sub-chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // sub-chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34); // bits per sample

  // data sub-chunk
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/**
 * Split PCM into overlapping chunks and prepend a WAV header to each.
 * Matches production: stride = chunkSize - overlapBytes so consecutive
 * chunks share the last `overlap` bytes. Without this stride, replay
 * emits non-overlapping 4s windows every 4s, which doesn't exercise the
 * boundary-duplication or Phase-4 dedup logic at all.
 */
function chunkWithHeaders(
  pcm: Buffer,
  chunkSize: number,
  overlapBytes: number = 0,
): Buffer[] {
  const chunks: Buffer[] = [];
  const stride = Math.max(1, chunkSize - overlapBytes);
  for (let offset = 0; offset < pcm.length; offset += stride) {
    const pcmSlice = pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length));
    // Drop trailing sub-chunk-sized tails — production doesn't emit partial chunks.
    if (pcmSlice.length < chunkSize && offset > 0) break;
    const header = createWavHeader(pcmSlice.length);
    chunks.push(Buffer.concat([header, pcmSlice]));
  }
  return chunks;
}

// ─── Manifest ───────────────────────────────────────────────────────────────

interface Manifest {
  sessionId: string;
  meetingContext?: {
    title?: string;
    participants?: string;
    agenda?: string;
  };
  tracks: {
    system?: { file: string };
    mic?: { file: string };
  };
}

function loadManifest(dir: string): Manifest {
  const manifestPath = join(dir, 'manifest.json');
  return JSON.parse(readFileSync(manifestPath, 'utf-8'));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatTime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── Stats ──────────────────────────────────────────────────────────────────

interface Stats {
  chunksSent: number;
  transcriptsReceived: number;
  suggestionsReceived: number;
  agendaUpdates: number;
  coachSuggestions: number;
  actionsCompleted: number;
  errors: number;
  intelligenceErrors: number;
  lastAgendaStatus?: {
    items?: Array<{ id?: string; text?: string; state?: string; evidence?: string }>;
    missing?: string[];
    fullyCovered?: boolean;
  };
  coachTips: Array<{
    kind?: string;
    incidentType?: string;
    headline?: string;
    phrasing?: string;
    latencyMs?: number;
  }>;
  debugSnapshot?: any;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { recordingDir, speed, port, autoApprove, minutes, agenda } = parseArgs();

  // Load manifest
  const manifest = loadManifest(recordingDir);
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Meeting Copilot — Audio Replay                             ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
  console.log(`  Recording:  ${basename(recordingDir)}`);
  console.log(`  Title:      ${manifest.meetingContext?.title ?? 'Untitled'}`);
  console.log(`  Attendees:  ${manifest.meetingContext?.participants ?? 'Unknown'}`);
  const effectiveAgenda = agenda ?? manifest.meetingContext?.agenda;
  console.log(`  Agenda:     ${effectiveAgenda || 'None'}`);
  console.log(`  Duration:   ${minutes ? `first ${minutes} min` : 'full recording'}`);
  console.log(`  Speed:      ${speed}x`);
  console.log(`  Auto-approve: ${autoApprove ? 'YES' : 'no'}`);
  console.log(`  Server:     ws://localhost:${port}`);
  console.log('');

  // Read audio files and chunk with WAV headers
  const tracks: Array<{ source: 'mic' | 'meeting'; chunks: Buffer[] }> = [];

  if (manifest.tracks.system?.file) {
    const systemPath = join(recordingDir, manifest.tracks.system.file);
    const fullPcm = readWavPcm(systemPath);
    const pcm = minutes
      ? fullPcm.subarray(
          0,
          Math.min(
            fullPcm.length,
            Math.floor(minutes * 60 * SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS),
          ),
        )
      : fullPcm;
    const chunks = chunkWithHeaders(pcm, BYTES_PER_CHUNK, OVERLAP_BYTES);
    tracks.push({ source: 'meeting', chunks });
    const durationSec = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
    console.log(`  System audio: ${chunks.length} chunks (${(durationSec / 60).toFixed(1)} min)`);
  }

  if (manifest.tracks.mic?.file) {
    const micPath = join(recordingDir, manifest.tracks.mic.file);
    const fullPcm = readWavPcm(micPath);
    const pcm = minutes
      ? fullPcm.subarray(
          0,
          Math.min(
            fullPcm.length,
            Math.floor(minutes * 60 * SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS),
          ),
        )
      : fullPcm;
    const chunks = chunkWithHeaders(pcm, BYTES_PER_CHUNK, OVERLAP_BYTES);
    tracks.push({ source: 'mic', chunks });
    const durationSec = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
    console.log(`  Mic audio:    ${chunks.length} chunks (${(durationSec / 60).toFixed(1)} min)`);
  }

  if (tracks.length === 0) {
    console.error('ERROR: No audio tracks found in recording');
    process.exit(1);
  }

  const maxChunks = Math.max(...tracks.map((t) => t.chunks.length));
  const estimatedDuration = (maxChunks * CHUNK_ADVANCE_SEC) / speed;
  console.log(`\n  Total chunks: ${maxChunks} per track`);
  console.log(`  Est. replay:  ${(estimatedDuration / 60).toFixed(1)} min at ${speed}x speed\n`);

  // Connect to server
  console.log('Connecting to server...');
  const ws = new WebSocket(`ws://localhost:${port}`);

  let connected = true;

  const stats: Stats = {
    chunksSent: 0,
    transcriptsReceived: 0,
    suggestionsReceived: 0,
    agendaUpdates: 0,
    coachSuggestions: 0,
    actionsCompleted: 0,
    errors: 0,
    intelligenceErrors: 0,
    coachTips: [],
  };
  const seenSuggestionIds = new Set<string>();
  const reportedSuggestionIds = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', (err) => {
      console.error(`\nERROR: Cannot connect to server at ws://localhost:${port}`);
      console.error('Make sure the server is running: ./scripts/start.sh');
      reject(err);
    });
  });

  console.log('Connected!\n');

  // Detect disconnection
  ws.on('close', (code, reason) => {
    connected = false;
    console.error(`\n  \x1b[31mServer disconnected (code: ${code}, reason: ${reason?.toString() || 'none'})\x1b[0m`);
  });

  ws.on('error', (err) => {
    connected = false;
    console.error(`\n  \x1b[31mWebSocket error: ${err.message}\x1b[0m`);
  });

  // Listen for server messages
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'transcript.update':
          stats.transcriptsReceived++;
          const label = msg.segment.source === 'mic' ? '\x1b[36m[You]\x1b[0m' : '\x1b[33m[Meeting]\x1b[0m';
          console.log(`  ${label} ${msg.segment.text}`);
          break;

        case 'action.suggested':
          if (!seenSuggestionIds.has(msg.action?.id)) {
            seenSuggestionIds.add(msg.action?.id);
            stats.suggestionsReceived++;
          }
          // Streaming cards are broadcast repeatedly as their JSON fields
          // arrive. Count the stable id once and print only the finalized card.
          if (msg.action?.streaming === true || reportedSuggestionIds.has(msg.action?.id)) {
            break;
          }
          reportedSuggestionIds.add(msg.action?.id);
          console.log(`\n  \x1b[32m>>> SUGGESTION: [${msg.action.type}] ${msg.action.title}\x1b[0m`);
          console.log(`      ${msg.action.description}`);
          console.log(`      Trigger: "${msg.action.triggerQuote.slice(0, 80)}..."`);
          if (autoApprove && msg.action?.id) {
            console.log(`      \x1b[34m>>> AUTO-APPROVING...\x1b[0m`);
            ws.send(JSON.stringify({ type: 'action.approve', actionId: msg.action.id }));
          }
          console.log('');
          break;

        case 'agenda.status':
          stats.agendaUpdates++;
          stats.lastAgendaStatus = msg.status;
          console.log(`\n  \x1b[35m>>> AGENDA UPDATE\x1b[0m`);
          for (const item of msg.status?.items ?? []) {
            console.log(`      [${item.state ?? 'unknown'}] ${item.text ?? item.id}`);
            if (item.evidence) console.log(`        Evidence: "${item.evidence}"`);
          }
          if (msg.status?.missing?.length) {
            console.log(`      Missing: ${msg.status.missing.join('; ')}`);
          }
          console.log('');
          break;

        case 'coach.suggestion':
          stats.coachSuggestions++;
          stats.coachTips.push(msg.suggestion ?? {});
          console.log(`\n  \x1b[35m>>> COACH: ${msg.suggestion?.headline ?? 'Live guidance'}\x1b[0m`);
          if (msg.suggestion?.phrasing) console.log(`      Say: "${msg.suggestion.phrasing}"`);
          if (msg.suggestion?.why) console.log(`      Why: ${msg.suggestion.why}`);
          if (Number.isFinite(msg.suggestion?.latencyMs)) {
            console.log(`      Latency: ${msg.suggestion.latencyMs}ms`);
          }
          console.log('');
          break;

        case 'intelligence.error':
          stats.intelligenceErrors++;
          console.log(`  \x1b[31m  > INTELLIGENCE ERROR [${msg.source}]: ${msg.message}\x1b[0m`);
          break;

        case 'action.started':
          console.log(`  \x1b[34m  > RUNNING: ${msg.actionId}\x1b[0m`);
          break;

        case 'action.completed':
          stats.actionsCompleted++;
          console.log(`  \x1b[32m  > COMPLETED: ${msg.actionId}\x1b[0m`);
          if (msg.result?.content) {
            const preview = typeof msg.result.content === 'string'
              ? msg.result.content.slice(0, 200)
              : JSON.stringify(msg.result.content).slice(0, 200);
            console.log(`      ${preview}...`);
          }
          break;

        case 'action.error':
          stats.errors++;
          console.log(`  \x1b[31m  > ERROR: ${msg.actionId}: ${msg.error}\x1b[0m`);
          break;

        case 'session.state':
          console.log(`  [Session] State: ${msg.state}`);
          break;

        default:
          // Log other message types for debugging
          if (msg.type) {
            console.log(`  \x1b[90m[${msg.type}]\x1b[0m`);
          }
          break;
      }
    } catch {
      // Ignore non-JSON messages
    }
  });

  // Start session
  console.log('─── Starting Session ───────────────────────────────────────────\n');

  ws.send(JSON.stringify({
    type: 'session.start',
    title: manifest.meetingContext?.title ?? `Replay: ${basename(recordingDir)}`,
    agenda: effectiveAgenda,
    attendees: manifest.meetingContext?.participants,
  }));

  // Wait for session to initialize — verify it went live
  await sleep(2000);

  if (!connected) {
    console.error('\nERROR: Server disconnected during session start. Check server logs.');
    process.exit(1);
  }

  // Stream audio chunks with interleaved timing
  console.log('─── Streaming Audio ────────────────────────────────────────────\n');

  // Production emits every chunkDuration - overlap seconds, not every chunkDuration.
  const delayBetweenChunks = (CHUNK_ADVANCE_SEC * 1000) / speed;

  for (let i = 0; i < maxChunks; i++) {
    if (!connected) {
      console.error(`\n  Stopped at chunk ${i}/${maxChunks} — server disconnected.`);
      break;
    }

    const elapsed = i * CHUNK_ADVANCE_SEC;

    if (i % 6 === 0) {
      console.log(`\n  \x1b[90m── ${formatTime(elapsed)} ─ chunk ${i + 1}/${maxChunks} (sent: ${stats.chunksSent}, transcripts: ${stats.transcriptsReceived}) ──\x1b[0m\n`);
    }

    // Send chunks from all tracks for this time slot
    for (const track of tracks) {
      if (i < track.chunks.length) {
        const chunk = track.chunks[i]!;
        try {
          const captureEndedAt = new Date().toISOString();
          const captureStartedAt = new Date(
            Date.now() - CHUNK_DURATION_SEC * 1000,
          ).toISOString();
          ws.send(JSON.stringify({
            type: 'audio_chunk',
            data: chunk.toString('base64'),
            source: track.source,
            audioDurationSec: CHUNK_DURATION_SEC,
            captureStartedAt,
            captureEndedAt,
            sequence: i,
          }));
          stats.chunksSent++;
        } catch (err) {
          console.error(`  \x1b[31mFailed to send chunk: ${err}\x1b[0m`);
        }
      }
    }

    // Wait for real-time playback (adjusted by speed)
    if (i < maxChunks - 1) {
      await sleep(delayBetweenChunks);
    }
  }

  if (!connected) {
    printSummary(stats);
    process.exit(1);
  }

  // Wait for final transcriptions and intelligence evals to complete
  console.log('\n─── Waiting for Final Processing ───────────────────────────────\n');
  console.log('  Waiting 25s for in-flight transcriptions and intelligence eval...');
  await sleep(25000);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/debug`);
    if (response.ok) stats.debugSnapshot = await response.json();
  } catch {
    // Summary remains useful from WebSocket events when debug is unavailable.
  }

  // Stop session
  console.log('\n─── Stopping Session ───────────────────────────────────────────\n');
  if (connected) {
    ws.send(JSON.stringify({ type: 'session.stop' }));
    await sleep(5000); // Let auto-summary complete
  }

  printSummary(stats);

  ws.close();
  console.log('\nDone.');
  process.exit(0);
}

function printSummary(stats: Stats): void {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Replay Summary                                             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log(`  Audio chunks sent:     ${stats.chunksSent}`);
  console.log(`  Transcripts received:  ${stats.transcriptsReceived}`);
  console.log(`  Suggestions generated: ${stats.suggestionsReceived}`);
  console.log(`  Agenda updates:        ${stats.agendaUpdates}`);
  console.log(`  Coach tips:            ${stats.coachSuggestions}`);
  console.log(`  Actions completed:     ${stats.actionsCompleted}`);
  console.log(`  Errors:                ${stats.errors}`);
  console.log(`  Intelligence errors:   ${stats.intelligenceErrors}`);
  if (stats.lastAgendaStatus?.items?.length) {
    console.log('');
    console.log('  Final agenda:');
    for (const item of stats.lastAgendaStatus.items) {
      console.log(`    [${item.state ?? 'unknown'}] ${item.text ?? item.id}`);
    }
  }
  if (stats.coachTips.length > 0) {
    console.log('');
    console.log('  Coach guidance:');
    for (const tip of stats.coachTips) {
      console.log(
        `    [${tip.incidentType ?? tip.kind ?? 'tip'}] ${tip.headline ?? 'Live guidance'}` +
          `${Number.isFinite(tip.latencyMs) ? ` (${tip.latencyMs}ms)` : ''}`,
      );
      if (tip.phrasing) console.log(`      "${tip.phrasing}"`);
    }
  }
  const realtime = stats.debugSnapshot?.intelligence?.realtime;
  const transcription = stats.debugSnapshot?.transcription;
  if (realtime || transcription) {
    console.log('');
    console.log('  Live metrics:');
    if (transcription) {
      console.log(
        `    ASR p50/p95: ${transcription.providerLatencyP50Ms ?? 'n/a'}/` +
          `${transcription.providerLatencyP95Ms ?? 'n/a'}ms, errors ` +
          `${Math.round((transcription.errorRate ?? 0) * 1000) / 10}%`,
      );
    }
    if (realtime?.agenda) {
      console.log(
        `    Agenda evals: ${realtime.agenda.completedEvals}, avg ` +
          `${realtime.agenda.avgLatencyMs}ms, stale ${realtime.agenda.staleResults}`,
      );
    }
    if (realtime?.coach) {
      console.log(
        `    Coach evals: ${realtime.coach.evalsRun}, avg ` +
          `${realtime.coach.avgLatencyMs}ms, stale ${realtime.coach.staleResults}`,
      );
    }
  }
  console.log('');

  if (stats.transcriptsReceived === 0) {
    console.log('  \x1b[31m! No transcripts received — check that whisper-server is running\x1b[0m');
  }
  if (stats.suggestionsReceived === 0 && stats.transcriptsReceived > 0) {
    console.log('  \x1b[33m! No suggestions — intelligence engine may need more context or ANTHROPIC_API_KEY\x1b[0m');
  }
}

main().catch((err) => {
  console.error('[Replay] Fatal error:', err);
  process.exit(1);
});
