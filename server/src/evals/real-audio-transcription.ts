#!/usr/bin/env tsx
/**
 * Evaluate the production local transcription path against a real dual-track
 * Notes4Chris recording without starting a Meeting Copilot session or invoking
 * any intelligence provider.
 *
 * The evaluator intentionally calls the same TranscriptionService,
 * TranscriptDedup, and TranscriptStitcher classes used by index.ts. It never
 * writes audio and snapshots ~/.meeting-copilot before/after to catch accidental
 * audio persistence.
 *
 * Usage:
 *   npm run eval:audio -- <recording-dir> [--minutes 5] [--reference-dir <dir>]
 *     [--show-transcript]
 */

import {
  type Dirent,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import {
  BYTES_PER_SAMPLE,
  CHANNELS,
  CHUNK_DURATION_SECONDS,
  CHUNK_OVERLAP_SECONDS,
  SAMPLE_RATE,
} from '../audio/chunkConfig.js';
import { TranscriptDedup } from '../transcription/dedup.js';
import { TranscriptionService } from '../transcription/index.js';
import { TranscriptStitcher } from '../transcription/stitch.js';
import type { TranscriptSegment } from '../transcription/types.js';

type Source = 'meeting' | 'mic';

interface Args {
  recordingDir: string;
  referenceDir?: string;
  minutes: number;
  showTranscript: boolean;
}

interface Manifest {
  meetingContext?: {
    title?: string;
  };
  tracks?: {
    system?: { file?: string };
    mic?: { file?: string };
  };
}

interface WavData {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

interface ReferenceRow {
  startMs: number;
  endMs: number;
  text: string;
}

interface SourceResult {
  source: Source;
  chunksSubmitted: number;
  rawFragments: string[];
  dedupedFragments: string[];
  finalSegments: TranscriptSegment[];
  errors: string[];
}

const AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aiff',
  '.caf',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
]);

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let recordingDir = '';
  let referenceDir: string | undefined;
  let minutes = 5;
  let showTranscript = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--minutes') {
      minutes = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--reference-dir') {
      referenceDir = argv[index + 1];
      index += 1;
    } else if (arg === '--show-transcript') {
      showTranscript = true;
    } else if (!arg.startsWith('--') && !recordingDir) {
      recordingDir = arg;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!recordingDir) {
    throw new Error(
      'Usage: npm run eval:audio -- <recording-dir> [--minutes 5] ' +
        '[--reference-dir <dir>] [--show-transcript]',
    );
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('--minutes must be a positive number');
  }

  return {
    recordingDir: resolve(recordingDir),
    referenceDir: referenceDir ? resolve(referenceDir) : undefined,
    minutes,
    showTranscript,
  };
}

function readWav(filePath: string): WavData {
  const buffer = readFileSync(filePath);
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(`${filePath} is not a RIFF/WAVE file`);
  }

  let offset = 12;
  let format:
    | { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number }
    | undefined;
  let pcm: Buffer | undefined;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = Math.min(dataStart + chunkLength, buffer.length);

    if (chunkId === 'fmt ' && chunkLength >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(dataStart),
        channels: buffer.readUInt16LE(dataStart + 2),
        sampleRate: buffer.readUInt32LE(dataStart + 4),
        bitsPerSample: buffer.readUInt16LE(dataStart + 14),
      };
    } else if (chunkId === 'data') {
      pcm = buffer.subarray(dataStart, dataEnd);
    }

    offset = dataStart + chunkLength + (chunkLength % 2);
  }

  if (!format || !pcm) throw new Error(`${filePath} is missing fmt or data chunks`);
  if (format.audioFormat !== 1) {
    throw new Error(`${filePath} is not uncompressed PCM (format=${format.audioFormat})`);
  }

  return {
    pcm,
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
  };
}

function createWav(pcm: Buffer): Buffer {
  const dataLength = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return Buffer.concat([header, pcm]);
}

function makeChunks(wav: WavData, limitSeconds: number): Buffer[] {
  if (
    wav.sampleRate !== SAMPLE_RATE ||
    wav.channels !== CHANNELS ||
    wav.bitsPerSample !== BYTES_PER_SAMPLE * 8
  ) {
    throw new Error(
      `Expected ${SAMPLE_RATE}Hz mono 16-bit PCM; got ${wav.sampleRate}Hz, ` +
        `${wav.channels} channel(s), ${wav.bitsPerSample}-bit`,
    );
  }

  const bytesPerSecond = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const chunkBytes = CHUNK_DURATION_SECONDS * bytesPerSecond;
  const advanceBytes =
    (CHUNK_DURATION_SECONDS - CHUNK_OVERLAP_SECONDS) * bytesPerSecond;
  const cappedPcm = wav.pcm.subarray(
    0,
    Math.min(wav.pcm.length, Math.floor(limitSeconds * bytesPerSecond)),
  );
  const chunks: Buffer[] = [];

  for (let offset = 0; offset + chunkBytes <= cappedPcm.length; offset += advanceBytes) {
    chunks.push(createWav(cappedPcm.subarray(offset, offset + chunkBytes)));
  }
  return chunks;
}

function snapshotAudioFiles(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const stat = statSync(path);
        snapshot.set(path, `${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  visit(root);
  return snapshot;
}

function changedAudioFiles(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const changed: string[] = [];
  for (const [path, signature] of after) {
    if (before.get(path) !== signature) changed.push(path);
  }
  return changed;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)]!;
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function longestCommonSubsequenceLength(reference: string[], hypothesis: string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  previous.fill(0);

  for (let refIndex = 1; refIndex <= reference.length; refIndex += 1) {
    const current = new Array<number>(hypothesis.length + 1).fill(0);
    for (let hypIndex = 1; hypIndex <= hypothesis.length; hypIndex += 1) {
      current[hypIndex] =
        reference[refIndex - 1] === hypothesis[hypIndex - 1]
          ? previous[hypIndex - 1]! + 1
          : Math.max(previous[hypIndex]!, current[hypIndex - 1]!);
    }
    previous = current;
  }

  return previous[hypothesis.length]!;
}

function parseReferenceCsv(filePath: string, limitMs: number): ReferenceRow[] {
  const rows: ReferenceRow[] = [];
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^(\d+),(\d+),"(.*)"$/);
    if (!match) continue;
    const startMs = Number(match[1]);
    if (startMs >= limitMs) continue;
    rows.push({
      startMs,
      endMs: Number(match[2]),
      text: match[3]!.replace(/""/g, '"'),
    });
  }
  return rows;
}

function inferReferenceDir(recordingDir: string): string | undefined {
  const parent = resolve(recordingDir, '..');
  const recordingsRoot = basename(parent) === 'recordings' ? resolve(parent, '..') : undefined;
  if (!recordingsRoot) return undefined;
  return join(recordingsRoot, 'processed', basename(recordingDir));
}

function formatMs(value: number): string {
  return `${Math.round(value)}ms`;
}

function printSourceResult(
  result: SourceResult,
  referenceRows: ReferenceRow[],
  showTranscript: boolean,
): void {
  const hypothesisText = result.finalSegments.map((segment) => segment.text).join(' ');
  const referenceText = referenceRows.map((row) => row.text).join(' ');
  const hypothesisWords = normalizeWords(hypothesisText);
  const referenceWords = normalizeWords(referenceText);
  const matchedReferenceWords = longestCommonSubsequenceLength(
    referenceWords,
    hypothesisWords,
  );
  // Notes4Chris's prior transcript is generated rather than hand-labelled and
  // can omit low-volume utterances. Treat it as a coverage check: additions in
  // the new transcript are not automatically errors.
  const referenceCoverage =
    referenceWords.length > 0 ? matchedReferenceWords / referenceWords.length : null;

  console.log(`\n  ${result.source === 'mic' ? 'Microphone' : 'Meeting'} track`);
  console.log(`    Chunks submitted:      ${result.chunksSubmitted}`);
  console.log(`    Non-empty ASR chunks:  ${result.rawFragments.length}`);
  console.log(`    Deduped fragments:     ${result.dedupedFragments.length}`);
  console.log(`    Final segments:        ${result.finalSegments.length}`);
  console.log(`    Hypothesis words:      ${hypothesisWords.length}`);
  console.log(`    Reference words:       ${referenceWords.length}`);
  console.log(
    `    Reference coverage:   ${referenceCoverage === null ? 'n/a' : `${(referenceCoverage * 100).toFixed(1)}%`}`,
  );
  if (result.errors.length > 0) {
    console.log(`    Errors:                ${result.errors.length}`);
  }
  if (showTranscript) {
    console.log('    Hypothesis transcript:');
    console.log(`      ${hypothesisText}`);
    console.log('    Reference transcript:');
    console.log(`      ${referenceText}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const manifest = JSON.parse(
    readFileSync(join(args.recordingDir, 'manifest.json'), 'utf8'),
  ) as Manifest;
  const referenceDir = args.referenceDir ?? inferReferenceDir(args.recordingDir);
  const limitSeconds = args.minutes * 60;
  const copilotStateDir = join(homedir(), '.meeting-copilot');
  const audioBefore = snapshotAudioFiles(copilotStateDir);

  const trackSpecs: Array<{ source: Source; filePath: string }> = [];
  if (manifest.tracks?.system?.file) {
    trackSpecs.push({
      source: 'meeting',
      filePath: join(args.recordingDir, manifest.tracks.system.file),
    });
  }
  if (manifest.tracks?.mic?.file) {
    trackSpecs.push({
      source: 'mic',
      filePath: join(args.recordingDir, manifest.tracks.mic.file),
    });
  }
  if (trackSpecs.length === 0) throw new Error('No system or microphone track in manifest');

  const tracks = trackSpecs.map((track) => ({
    ...track,
    chunks: makeChunks(readWav(track.filePath), limitSeconds),
  }));

  process.env.TRANSCRIPTION_PROVIDER = 'parakeet';
  process.env.PARAKEET_URL ??= 'http://127.0.0.1:8077';
  const transcription = new TranscriptionService();
  const available = await transcription.isProviderAvailable();
  if (!available) {
    throw new Error(`Local transcription provider unavailable at ${transcription.providerInfo.endpoint}`);
  }

  const dedup = new TranscriptDedup();
  const stitcher = new TranscriptStitcher({ maxHoldMs: 60_000, maxGapMs: 60_000 });
  const results = new Map<Source, SourceResult>();
  for (const track of tracks) {
    results.set(track.source, {
      source: track.source,
      chunksSubmitted: track.chunks.length,
      rawFragments: [],
      dedupedFragments: [],
      finalSegments: [],
      errors: [],
    });
  }

  transcription.on('transcript', (segment: TranscriptSegment) => {
    const result = results.get(segment.source);
    if (!result || !segment.text.trim()) return;
    result.rawFragments.push(segment.text);
    const dedupedText = dedup.dedup(
      segment.source,
      segment.text,
      segment.timestamp,
      (segment.sequence ?? 0) > 0,
    );
    if (!dedupedText.trim()) return;
    result.dedupedFragments.push(dedupedText);
    stitcher.push({ ...segment, text: dedupedText });
  });

  stitcher.on(
    'segment',
    ({ segment, final }: { segment: TranscriptSegment; final: boolean }) => {
      if (final) results.get(segment.source)?.finalSegments.push(segment);
    },
  );

  console.log('\nMeeting Copilot — local real-audio transcription evaluation');
  console.log(`  Recording:      ${basename(args.recordingDir)}`);
  console.log(`  Title:          ${manifest.meetingContext?.title ?? 'Untitled'}`);
  console.log(`  Window:         first ${args.minutes} minute(s)`);
  console.log(`  Chunking:       4s/1s-overlap fallback path`);
  console.log(`  Provider:       ${transcription.providerInfo.model ?? transcription.providerInfo.mode}`);
  console.log(`  Endpoint:       ${transcription.providerInfo.endpoint ?? 'local'}`);
  console.log(`  Cloud LLMs:     disabled (intelligence pipeline not started)`);
  console.log(`  Raw audio writes: disabled`);

  const startedAt = Date.now();
  const maxChunks = Math.max(...tracks.map((track) => track.chunks.length));
  const captureBaseMs = Date.now() - limitSeconds * 1000;

  for (let sequence = 0; sequence < maxChunks; sequence += 1) {
    const elapsedSeconds =
      sequence * (CHUNK_DURATION_SECONDS - CHUNK_OVERLAP_SECONDS);
    const jobs = tracks.flatMap((track) => {
      const wav = track.chunks[sequence];
      if (!wav) return [];
      const captureStartedAt = new Date(captureBaseMs + elapsedSeconds * 1000);
      const captureEndedAt = new Date(
        captureStartedAt.getTime() + CHUNK_DURATION_SECONDS * 1000,
      );
      return [
        transcription.transcribeChunk(wav, track.source, {
          chunkId: `real-audio-${track.source}-${sequence}`,
          audioDurationSec: CHUNK_DURATION_SECONDS,
          captureStartedAt: captureStartedAt.toISOString(),
          captureEndedAt: captureEndedAt.toISOString(),
          sequence,
        }).catch((error: unknown) => {
          results.get(track.source)?.errors.push(
            error instanceof Error ? error.message : String(error),
          );
        }),
      ];
    });
    await Promise.all(jobs);
  }

  await transcription.flushPending(10_000);
  stitcher.flushAll();
  const wallTimeMs = Date.now() - startedAt;
  const audioAfter = snapshotAudioFiles(copilotStateDir);
  const audioChanges = changedAudioFiles(audioBefore, audioAfter);

  console.log('\nResults');
  for (const result of results.values()) {
    let referenceRows: ReferenceRow[] = [];
    if (referenceDir) {
      const referenceFile = join(
        referenceDir,
        result.source === 'meeting' ? 'system_transcript.csv' : 'mic_transcript.csv',
      );
      try {
        referenceRows = parseReferenceCsv(referenceFile, limitSeconds * 1000);
      } catch {
        // A recording without a prior Notes4Chris transcript is still useful
        // for latency, reliability, and privacy validation.
      }
    }
    printSourceResult(result, referenceRows, args.showTranscript);
  }

  const effectiveAudioSeconds = maxChunks *
    (CHUNK_DURATION_SECONDS - CHUNK_OVERLAP_SECONDS);
  console.log('\n  Pipeline');
  console.log(`    Chunks processed:      ${transcription.chunksProcessed}`);
  console.log(`    Transcription errors:  ${transcription.errorCount}`);
  console.log(`    Hallucinations dropped:${String(transcription.hallucinationsFiltered).padStart(3)}`);
  console.log(`    Provider latency p50:  ${formatMs(percentile(transcription.providerLatencySamples, 0.5))}`);
  console.log(`    Provider latency p95:  ${formatMs(percentile(transcription.providerLatencySamples, 0.95))}`);
  console.log(`    End-to-end p95:        ${formatMs(percentile(transcription.endToEndLatencySamples, 0.95))}`);
  console.log(`    Evaluation wall time:  ${(wallTimeMs / 1000).toFixed(1)}s`);
  console.log(`    Processing speed:      ${(effectiveAudioSeconds / (wallTimeMs / 1000)).toFixed(1)}x realtime`);
  console.log(`    New/changed audio:     ${audioChanges.length}`);
  for (const path of audioChanges) console.log(`      ${path}`);

  const totalErrors = Array.from(results.values())
    .reduce((sum, result) => sum + result.errors.length, 0);
  if (totalErrors > 0 || audioChanges.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    `\n[real-audio-eval] ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
