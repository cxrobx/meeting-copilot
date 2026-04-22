#!/usr/bin/env tsx
/**
 * Replay recorded WAV audio through the full meeting-copilot pipeline.
 *
 * Usage: npx tsx src/replay-audio.ts <recording-dir> [--speed <multiplier>] [--port <port>]
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--speed' && args[i + 1]) {
      speed = parseFloat(args[i + 1]!);
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === '--auto-approve') {
      autoApprove = true;
    } else if (!args[i]!.startsWith('--')) {
      recordingDir = args[i]!;
    }
  }

  if (!recordingDir) {
    console.error('Usage: npx tsx src/replay-audio.ts <recording-dir> [--speed <multiplier>] [--port <port>] [--auto-approve]');
    console.error('');
    console.error('Options:');
    console.error('  --speed <n>      Playback speed multiplier (default: 1, use 4 for 4x faster)');
    console.error('  --port <n>       Server port (default: 17890)');
    console.error('  --auto-approve   Automatically approve suggestions so workers execute');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx src/replay-audio.ts ~/Documents/Notes4ChrisRecordings/recordings/2026-03-17_22-02-27_session --speed 4 --auto-approve');
    process.exit(1);
  }

  return { recordingDir, speed, port, autoApprove };
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
  actionsCompleted: number;
  errors: number;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { recordingDir, speed, port, autoApprove } = parseArgs();

  // Load manifest
  const manifest = loadManifest(recordingDir);
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Meeting Copilot — Audio Replay                             ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
  console.log(`  Recording:  ${basename(recordingDir)}`);
  console.log(`  Title:      ${manifest.meetingContext?.title ?? 'Untitled'}`);
  console.log(`  Attendees:  ${manifest.meetingContext?.participants ?? 'Unknown'}`);
  console.log(`  Agenda:     ${manifest.meetingContext?.agenda ?? 'None'}`);
  console.log(`  Speed:      ${speed}x`);
  console.log(`  Auto-approve: ${autoApprove ? 'YES' : 'no'}`);
  console.log(`  Server:     ws://localhost:${port}`);
  console.log('');

  // Read audio files and chunk with WAV headers
  const tracks: Array<{ source: 'mic' | 'meeting'; chunks: Buffer[] }> = [];

  if (manifest.tracks.system?.file) {
    const systemPath = join(recordingDir, manifest.tracks.system.file);
    const pcm = readWavPcm(systemPath);
    const chunks = chunkWithHeaders(pcm, BYTES_PER_CHUNK, OVERLAP_BYTES);
    tracks.push({ source: 'meeting', chunks });
    const durationSec = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
    console.log(`  System audio: ${chunks.length} chunks (${(durationSec / 60).toFixed(1)} min)`);
  }

  if (manifest.tracks.mic?.file) {
    const micPath = join(recordingDir, manifest.tracks.mic.file);
    const pcm = readWavPcm(micPath);
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
    actionsCompleted: 0,
    errors: 0,
  };

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
          stats.suggestionsReceived++;
          console.log(`\n  \x1b[32m>>> SUGGESTION: [${msg.action.type}] ${msg.action.title}\x1b[0m`);
          console.log(`      ${msg.action.description}`);
          console.log(`      Trigger: "${msg.action.triggerQuote.slice(0, 80)}..."`);
          if (autoApprove && msg.action?.id) {
            console.log(`      \x1b[34m>>> AUTO-APPROVING...\x1b[0m`);
            ws.send(JSON.stringify({ type: 'action.approve', actionId: msg.action.id }));
          }
          console.log('');
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
    agenda: manifest.meetingContext?.agenda,
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
  console.log(`  Actions completed:     ${stats.actionsCompleted}`);
  console.log(`  Errors:                ${stats.errors}`);
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
