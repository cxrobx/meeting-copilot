#!/usr/bin/env tsx
/**
 * Compare replay output against an expected baseline.
 *
 * Usage: npx tsx src/replay-diff.ts <output.json> <expected.json>
 *
 * Matching logic: two suggestions match if they share the same type AND
 * their titles have > 50% word overlap (Jaccard similarity on lowercased words).
 *
 * Exits 0 if all expected suggestions are matched, 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Suggestion {
  type: string;
  title: string;
  description: string;
  triggerQuote: string;
  estimatedDurationSec: number;
  params: Record<string, any>;
}

interface ReplayOutput {
  fixtureFile: string;
  replayedAt: string;
  segmentsReplayed: number;
  suggestions: Suggestion[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function isSimilar(a: Suggestion, b: Suggestion): boolean {
  if (a.type !== b.type) return false;
  const overlap = wordOverlap(titleWords(a.title), titleWords(b.title));
  return overlap > 0.5;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const outputArg = process.argv[2];
  const expectedArg = process.argv[3];

  if (!outputArg || !expectedArg) {
    console.error(
      'Usage: npx tsx src/replay-diff.ts <output.json> <expected.json>',
    );
    process.exit(1);
  }

  const outputPath = resolve(outputArg);
  const expectedPath = resolve(expectedArg);

  const output: ReplayOutput = JSON.parse(readFileSync(outputPath, 'utf-8'));
  const expected: ReplayOutput = JSON.parse(
    readFileSync(expectedPath, 'utf-8'),
  );

  const outputSuggestions = output.suggestions;
  const expectedSuggestions = expected.suggestions;

  // Track which output suggestions have been matched
  const matchedOutputIndices = new Set<number>();
  const matched: Array<{
    expected: Suggestion;
    actual: Suggestion;
    overlap: number;
  }> = [];
  const missing: Suggestion[] = [];

  // For each expected suggestion, find the best matching output suggestion
  for (const exp of expectedSuggestions) {
    let bestIdx = -1;
    let bestOverlap = 0;

    for (let i = 0; i < outputSuggestions.length; i++) {
      if (matchedOutputIndices.has(i)) continue;
      const out = outputSuggestions[i]!;
      if (out.type !== exp.type) continue;

      const overlap = wordOverlap(
        titleWords(exp.title),
        titleWords(out.title),
      );
      if (overlap > 0.5 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      matchedOutputIndices.add(bestIdx);
      matched.push({
        expected: exp,
        actual: outputSuggestions[bestIdx]!,
        overlap: bestOverlap,
      });
    } else {
      missing.push(exp);
    }
  }

  // Extra suggestions = output suggestions not matched to any expected
  const extra: Suggestion[] = outputSuggestions.filter(
    (_, i) => !matchedOutputIndices.has(i),
  );

  // ─── Print Report ───────────────────────────────────────────────────────

  console.log('');
  console.log('═══ Replay Diff Report ═══');
  console.log('');

  if (matched.length > 0) {
    console.log(`MATCHED (${matched.length}):`);
    for (const m of matched) {
      const pct = (m.overlap * 100).toFixed(0);
      console.log(`  ✓ [${m.expected.type}] "${m.expected.title}"`);
      console.log(
        `    → "${m.actual.title}" (${pct}% overlap)`,
      );
    }
    console.log('');
  }

  if (missing.length > 0) {
    console.log(`MISSING (${missing.length}):`);
    for (const m of missing) {
      console.log(`  ✗ [${m.type}] "${m.title}"`);
    }
    console.log('');
  }

  if (extra.length > 0) {
    console.log(`EXTRA (${extra.length}):`);
    for (const e of extra) {
      console.log(`  + [${e.type}] "${e.title}"`);
    }
    console.log('');
  }

  // Summary line
  const total = expectedSuggestions.length;
  const pass = missing.length === 0;

  console.log('───────────────────────');
  console.log(
    `Expected: ${total}  Matched: ${matched.length}  Missing: ${missing.length}  Extra: ${extra.length}`,
  );
  console.log(`Result: ${pass ? 'PASS' : 'FAIL'}`);
  console.log('');

  process.exit(pass ? 0 : 1);
}

main();
