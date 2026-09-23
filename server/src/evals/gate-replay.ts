#!/usr/bin/env tsx
/**
 * Noise-gate replay: does gating the Grok stream lose words, and what does it save?
 *
 * Replays a recorded meeting (mic.wav + system.wav, 16 kHz mono PCM16, as
 * CXNotes writes them) through the live streaming path twice at once:
 *   - REFERENCE: every frame streamed to Grok (the ungated setup)
 *   - GATED:     frames through the noise gate, plus the local fallback: the
 *                app's utterance chunks the gate did not send go to Parakeet,
 *                as in production. The app cuts chunks with Silero VAD; here a
 *                speech detector more sensitive than the gate (6 dB over the
 *                floor vs 12) cuts them at 300 ms pauses, capped at 6 s
 * then aligns the two transcripts word by word and lists every stretch the
 * reference has that the gated run lost. Billing is compared on seconds sent.
 *
 * Usage:
 *   secret run -k XAI_API_KEY -- npx tsx src/evals/gate-replay.ts <recording-dir> \
 *     [--from <sec>] [--minutes <n>] [--speed <x>] [--noise] [--out <file.json>]
 * --noise adds a second ungated run: its recall against the reference is how
 * much Grok itself varies between identical runs, the floor to judge the gate by.
 * Needs the Parakeet sidecar on :8077 (the app runs it). Costs about
 * $0.0067 per replayed minute per track for the reference run, less for gated.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StreamingTranscriber } from '../transcription/streaming.js';
import { WhisperProvider } from '../transcription/whisper.js';
import { frameRms } from '../transcription/gate.js';
import type { TranscriptSegment } from '../transcription/types.js';

type Source = 'mic' | 'meeting';
const FRAME = 3200;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const dir = process.argv[2];
if (!dir || dir.startsWith('--')) {
  console.error('Usage: gate-replay.ts <recording-dir> [--from <sec>] [--minutes <n>] [--speed <x>] [--out <file>]');
  process.exit(2);
}
const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
  console.error('XAI_API_KEY is not set (run under: secret run -k XAI_API_KEY -- …)');
  process.exit(2);
}
const fromSec = Number(arg('from', '0'));
const minutes = Number(arg('minutes', '5'));
const speed = Number(arg('speed', '1'));
const outFile = arg('out', '');
const withNoise = process.argv.includes('--noise');

function track(file: string): Buffer {
  const pcm = readFileSync(join(dir, file)).subarray(44);
  return pcm.subarray(fromSec * 32_000, (fromSec + minutes * 60) * 32_000);
}
const tracks: Record<Source, Buffer> = { mic: track('mic.wav'), meeting: track('system.wav') };
const frames = Math.floor(Math.min(tracks.mic.length, tracks.meeting.length) / FRAME);

// One virtual clock for both runs: audio time, so replaying faster than real
// time keeps every timestamp consistent.
const t0 = Date.now();
let clock = t0;
const now = () => clock;

const reference = new StreamingTranscriber<null>({ apiKey, now, gate: false });
const reference2 = withNoise ? new StreamingTranscriber<null>({ apiKey, now, gate: false }) : null;
const gated = new StreamingTranscriber<{ source: Source; startMs: number; pcm: Buffer }>({ apiKey, now });
const parakeet = new WhisperProvider(process.env.PARAKEET_URL ?? 'http://127.0.0.1:8077', { mode: 'parakeet', supportsPrompt: false });

interface Line { source: Source; startMs: number; text: string; via: string }
const out: Record<'reference' | 'reference2' | 'gated', Line[]> = { reference: [], reference2: [], gated: [] };
const collect = (name: 'reference' | 'reference2' | 'gated') => ({ segment, final }: { segment: TranscriptSegment; final: boolean }) => {
  if (final) out[name].push({ source: segment.source, startMs: Date.parse(segment.captureStartedAt ?? '') - t0, text: segment.text, via: 'grok' });
};
reference.on('segment', collect('reference'));
gated.on('segment', collect('gated'));
reference2?.on('segment', collect('reference2'));

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24); h.writeUInt32LE(32_000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const localJobs: Promise<void>[] = [];
let localChunks = 0;
function local(source: Source, startMs: number, pcm: Buffer) {
  localChunks++;
  localJobs.push(parakeet.transcribe(wav(pcm)).then((r) => {
    if (r.text.trim()) out.gated.push({ source, startMs: startMs - t0, text: r.text.trim(), via: 'parakeet' });
  }).catch((e) => console.warn('[parakeet]', e instanceof Error ? e.message : e)));
}
gated.on('replay', ({ chunks }: { chunks: Array<{ source: Source; startMs: number; pcm: Buffer }> }) => {
  for (const c of chunks) local(c.source, c.startMs, c.pcm);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Replaying ${(frames / 600).toFixed(1)} min from ${fromSec}s of ${dir} at ${speed}x`);
  reference.start('');
  gated.start('');
  reference2?.start('');
  await sleep(1_500); // both streams ready

  const wall0 = Date.now();
  // Per-source utterance chunker standing in for the app's VAD emitter.
  const vad = Object.fromEntries((['mic', 'meeting'] as Source[]).map((src) => [src, { floor: 0.002, speech: [] as Buffer[], startMs: 0, quiet: 0 }]));
  const emitChunk = (source: Source) => {
    const v = vad[source]!;
    if (v.speech.length >= 3) { // ≥300 ms, like the app's minimum
      const pcm = Buffer.concat(v.speech);
      const endMs = v.startMs + v.speech.length * 100;
      if (!gated.claimChunk(source, v.startMs, endMs, { source, startMs: v.startMs, pcm })) local(source, v.startMs, pcm);
    }
    v.speech = []; v.quiet = 0;
  };
  for (let f = 0; f < frames; f++) {
    for (const source of ['mic', 'meeting'] as Source[]) {
      const pcm = tracks[source].subarray(f * FRAME, (f + 1) * FRAME);
      reference.pushFrame(source, pcm, clock);
      reference2?.pushFrame(source, pcm, clock);
      gated.pushFrame(source, pcm, clock);
      const v = vad[source]!;
      const rms = frameRms(pcm);
      v.floor = rms < v.floor ? v.floor * 0.9 + rms * 0.1 : v.floor * 0.999 + rms * 0.001;
      const speechy = rms > Math.max(0.002, v.floor * 2); // 6 dB: more sensitive than the gate
      if (speechy) {
        if (v.speech.length === 0) v.startMs = clock;
        v.speech.push(pcm); v.quiet = 0;
        if (v.speech.length >= 60) emitChunk(source); // 6 s cap
      } else if (v.speech.length > 0) {
        v.speech.push(pcm);
        if (++v.quiet >= 3) emitChunk(source); // 300 ms pause ends the utterance
      }
    }
    clock += 100;
    const due = wall0 + ((f + 1) * 100) / speed;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    if (f % 600 === 599) console.log(`  ${((f + 1) / 600).toFixed(0)} min…`);
  }
  for (const source of ['mic', 'meeting'] as Source[]) emitChunk(source);
  await Promise.all([reference.stop(), gated.stop(), reference2?.stop()]);
  await Promise.all(localJobs);
  report();
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);

/** Words of `ref` (with times) missing from `hyp`, via an LCS alignment per source. */
function missing(ref: Line[], hyp: Line[]) {
  const runs: Array<{ source: Source; atSec: number; words: string }> = [];
  let refWords = 0, matched = 0, hypWords = 0;
  for (const source of ['mic', 'meeting'] as Source[]) {
    const r = ref.filter((l) => l.source === source).sort((a, b) => a.startMs - b.startMs)
      .flatMap((l) => norm(l.text).map((w) => ({ w, at: l.startMs })));
    const h = hyp.filter((l) => l.source === source).sort((a, b) => a.startMs - b.startMs)
      .flatMap((l) => norm(l.text));
    refWords += r.length; hypWords += h.length;
    const n = r.length, m = h.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = r[i]!.w === h[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
    let i = 0, j = 0; let run: string[] = []; let runAt = 0;
    const flush = () => { if (run.length) runs.push({ source, atSec: Math.round(fromSec + runAt / 1000), words: run.join(' ') }); run = []; };
    while (i < n) {
      if (j < m && r[i]!.w === h[j]) { matched++; flush(); i++; j++; }
      else if (j < m && dp[i]![j + 1]! >= dp[i + 1]![j]!) j++;
      else { if (!run.length) runAt = r[i]!.at; run.push(r[i]!.w); i++; }
    }
    flush();
  }
  return { refWords, hypWords, matched, runs };
}

function report() {
  const sent = { reference: reference.sentSeconds, gated: gated.sentSeconds };
  const total = (s: Record<Source, number>) => s.mic + s.meeting;
  const cmp = missing(out.reference, out.gated);
  const long = cmp.runs.filter((r) => r.words.split(' ').length >= 2);
  const summary = {
    replayedMinutes: +(frames / 600).toFixed(1),
    secondsSent: {
      reference: { mic: Math.round(sent.reference.mic), meeting: Math.round(sent.reference.meeting) },
      gated: { mic: Math.round(sent.gated.mic), meeting: Math.round(sent.gated.meeting) },
    },
    billedSaving: `${(100 * (1 - total(sent.gated) / total(sent.reference))).toFixed(1)}%`,
    words: { reference: cmp.refWords, gatedPlusFallback: cmp.hypWords },
    recall: `${((100 * cmp.matched) / Math.max(1, cmp.refWords)).toFixed(1)}%`,
    extraWords: `${cmp.hypWords - cmp.matched} (${((100 * (cmp.hypWords - cmp.matched)) / Math.max(1, cmp.hypWords)).toFixed(1)}% of gated output)`,
    localChunks,
    gatedLinesViaParakeet: out.gated.filter((l) => l.via === 'parakeet').length,
    missingRuns: cmp.runs.length,
    ...(reference2 ? { grokNoiseRecall: (() => { const c = missing(out.reference, out.reference2); return `${((100 * c.matched) / Math.max(1, c.refWords)).toFixed(1)}% (ungated vs ungated: the variance floor)`; })() } : {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nReference words missing from the gated run, 2+ word stretches (${long.length}):`);
  for (const r of long) console.log(`  [${r.source} @${r.atSec}s] ${r.words}`);
  if (outFile) writeFileSync(outFile, JSON.stringify({ summary, runs: cmp.runs, ...out }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
