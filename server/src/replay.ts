#!/usr/bin/env tsx
/**
 * Replay a recorded transcript fixture through the IntelligenceEngine.
 *
 * Usage: npx tsx src/replay.ts <fixture.json> [output.json]
 *
 * Reads transcript segments from a fixture file, feeds them into the
 * IntelligenceEngine with realistic inter-segment timing (capped at 2s),
 * collects all suggestions, and writes the output.
 *
 * Does NOT start a full server — uses IntelligenceEngine directly.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

import { IntelligenceEngine } from './intelligence/index.js';
import type { TranscriptSegment } from './transcription/types.js';
import type { ActionSuggestion } from './workers/types.js';

// Load environment (for ANTHROPIC_API_KEY etc.)
dotenv.config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

// ─── Types ──────────────────────────────────────────────────────────────────

interface FixtureSegment {
  text: string;
  source: 'mic' | 'meeting';
  label: string;
  timestamp: number;
  duration: number;
  wordCount: number;
}

interface Fixture {
  sessionId: string;
  recordedAt: string;
  segments: FixtureSegment[];
}

interface ReplayOutput {
  fixtureFile: string;
  replayedAt: string;
  segmentsReplayed: number;
  suggestions: Array<{
    type: string;
    title: string;
    description: string;
    triggerQuote: string;
    estimatedDurationSec: number;
    params: Record<string, any>;
  }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const MAX_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fixtureArg = process.argv[2];
  const outputArg = process.argv[3]; // optional; if omitted, writes to stdout

  if (!fixtureArg) {
    console.error('Usage: npx tsx src/replay.ts <fixture.json> [output.json]');
    process.exit(1);
  }

  const fixturePath = resolve(fixtureArg);
  const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

  if (!fixture.segments || fixture.segments.length === 0) {
    console.error('Fixture has no segments.');
    process.exit(1);
  }

  console.error(`[Replay] Fixture: ${fixturePath}`);
  console.error(`[Replay] Session: ${fixture.sessionId}`);
  console.error(`[Replay] Segments: ${fixture.segments.length}`);

  // Collect suggestions
  const suggestions: ActionSuggestion[] = [];

  const engine = new IntelligenceEngine();
  engine.onSuggestion((suggestion: ActionSuggestion) => {
    suggestions.push(suggestion);
    console.error(
      `[Replay] Suggestion #${suggestions.length}: [${suggestion.type}] ${suggestion.title}`,
    );
  });

  // Start the engine (begins the eval loop)
  engine.start();

  // Feed segments with realistic timing
  let prevTimestamp: number | null = null;

  for (let i = 0; i < fixture.segments.length; i++) {
    const seg = fixture.segments[i]!;

    // Calculate delay from previous segment
    if (prevTimestamp !== null) {
      const rawDelay = seg.timestamp - prevTimestamp;
      const delay = Math.min(Math.max(rawDelay, 0), MAX_DELAY_MS);
      if (delay > 0) {
        await sleep(delay);
      }
    }
    prevTimestamp = seg.timestamp;

    // Build a TranscriptSegment with a fresh timestamp relative to now
    const segment: TranscriptSegment = {
      id: uuidv4(),
      text: seg.text,
      source: seg.source,
      label: seg.label,
      timestamp: Date.now(),
      duration: seg.duration,
      wordCount: seg.wordCount,
    };

    engine.addTranscript(segment);

    if ((i + 1) % 10 === 0 || i === fixture.segments.length - 1) {
      console.error(
        `[Replay] Fed segment ${i + 1}/${fixture.segments.length}`,
      );
    }
  }

  // Wait for any in-flight evaluations to complete.
  // The engine runs evals on a 15s cadence, so after all segments are fed
  // we wait long enough for at least one more eval cycle to finish.
  console.error('[Replay] All segments fed. Waiting for final evaluations...');
  await sleep(20_000);

  // Stop the engine
  engine.stop();

  // Build output
  const output: ReplayOutput = {
    fixtureFile: fixturePath,
    replayedAt: new Date().toISOString(),
    segmentsReplayed: fixture.segments.length,
    suggestions: suggestions.map((s) => ({
      type: s.type,
      title: s.title,
      description: s.description,
      triggerQuote: s.triggerQuote,
      estimatedDurationSec: s.estimatedDurationSec,
      params: s.params,
    })),
  };

  const outputJson = JSON.stringify(output, null, 2);

  if (outputArg) {
    const outputPath = resolve(outputArg);
    writeFileSync(outputPath, outputJson);
    console.error(`[Replay] Output written to: ${outputPath}`);
  } else {
    // Write to stdout for piping
    process.stdout.write(outputJson + '\n');
  }

  // Print summary to stderr
  console.error('');
  console.error('─── Replay Summary ───');
  console.error(`  Segments replayed: ${fixture.segments.length}`);
  console.error(`  Suggestions generated: ${suggestions.length}`);
  console.error(`  Evals run: ${engine.evalsRun}`);
  console.error(`  Haiku hit rate: ${(engine.haikuHitRate * 100).toFixed(1)}%`);
  if (outputArg) {
    console.error(`  Output: ${resolve(outputArg)}`);
  }
}

main().catch((err) => {
  console.error('[Replay] Fatal error:', err);
  process.exit(1);
});
