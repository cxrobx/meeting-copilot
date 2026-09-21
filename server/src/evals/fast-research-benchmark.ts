import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import dotenv from 'dotenv';

import { isOpenAiApiAvailable } from '../api/openai.js';
import { resetLlmBudget } from '../api/budget.js';
import { MODEL_CONFIG } from '../model-config.js';
// The real worker, not a copy of its prompt: this scores what the ⚡ Fast
// button ships, including the Claude fallback when the OpenAI call fails.
import { FastResearchWorker } from '../workers/fast-research.js';
import { CASES, gradeAnswer, type Grade, type ResearchCase } from './fast-research-cases.js';

const USER_ENV_PATH = join(homedir(), '.meeting-copilot', '.env');
if (existsSync(USER_ENV_PATH)) dotenv.config({ path: USER_ENV_PATH });
else dotenv.config();

// A live answer that takes this long has missed the conversation it was for.
// Not a production constant — fast research has no deadline — so this only
// marks slow answers in the table; it never changes a grade.
const SLOW_MS = 10_000;
const CASE_TIMEOUT_MS = 60_000;
const FALLBACK_MARKER = '_(OpenAI unavailable';

interface RunResult {
  caseId: string;
  kind: ResearchCase['kind'];
  grade: Grade;
  reasons: string[];
  ttftMs: number | null;
  totalMs: number;
  sources: number;
  fellBack: boolean;
  answer: string;
  error?: string;
}

function parseArgs(): { runs: number; only: string[] } {
  const args = process.argv.slice(2);
  let runs = 1;
  const only: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs') runs = Math.max(1, Number(args[++i]) || 1);
    else if (args[i] === '--case') only.push(args[++i] ?? '');
  }
  return { runs, only };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function percent(count: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((count / total) * 100)}%`;
}

async function runCase(worker: FastResearchWorker, testCase: ResearchCase): Promise<RunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CASE_TIMEOUT_MS);
  const started = performance.now();
  let ttftMs: number | null = null;
  try {
    const result = await worker.execute(
      {
        query: testCase.query,
        _onDelta: () => {
          if (ttftMs === null) ttftMs = Math.round(performance.now() - started);
        },
      },
      controller.signal,
    );
    const totalMs = Math.round(performance.now() - started);
    const findings: string = result.success ? String(result.data?.findings ?? '') : '';
    // Grade the answer, not the appended citation block: a source title can
    // contain the very words the key looks for.
    const answer = findings.split('\n\n---\n**Sources**')[0] ?? '';
    const graded = result.success
      ? gradeAnswer(testCase, answer)
      : { grade: 'wrong' as Grade, reasons: [`worker failed: ${result.error ?? result.summary}`] };
    return {
      caseId: testCase.id,
      kind: testCase.kind,
      ...graded,
      ttftMs,
      totalMs,
      sources: Array.isArray(result.data?.sources) ? result.data.sources.length : 0,
      fellBack: answer.startsWith(FALLBACK_MARKER),
      answer,
      error: result.success ? undefined : result.error,
    };
  } finally {
    clearTimeout(timer);
  }
}

function printResult(r: RunResult): void {
  const mark = r.grade === 'correct' ? '✓' : r.grade === 'hedged' ? '~' : '✗';
  const ttft = r.ttftMs === null ? '   —' : String(r.ttftMs).padStart(5);
  const slow = r.totalMs > SLOW_MS ? ' SLOW' : '';
  const fb = r.fellBack ? ' FALLBACK' : '';
  console.log(
    `${mark} ${r.caseId.padEnd(30)} ${r.kind.padEnd(5)} ${r.grade.padEnd(7)} `
      + `ttft ${ttft}ms  total ${String(r.totalMs).padStart(6)}ms  src ${r.sources}${slow}${fb}`,
  );
  if (r.grade !== 'correct') {
    for (const reason of r.reasons) console.log(`    · ${reason}`);
    // Printed in full so a grader miss (a right answer the regex did not
    // anticipate) is visible — audit these before trusting a regression.
    const body = r.answer.trim().replace(/\n+/g, ' ').slice(0, 600);
    console.log(`    > ${body || '(empty)'}`);
  }
}

function printSummary(results: RunResult[]): void {
  const facts = results.filter((r) => r.kind === 'fact');
  const traps = results.filter((r) => r.kind === 'trap');
  const count = (rs: RunResult[], g: Grade) => rs.filter((r) => r.grade === g).length;
  const ttfts = results.map((r) => r.ttftMs).filter((v): v is number => v !== null);
  const totals = results.map((r) => r.totalMs);
  const wrong = count(results, 'wrong');

  console.log('\nSummary');
  console.log(`  model             ${MODEL_CONFIG.fastResearch}`);
  console.log(`  answers           ${results.length}`);
  console.log(`  WRONG (confident) ${wrong} (${percent(wrong, results.length)})   <- the number that matters`);
  console.log(`  facts correct     ${count(facts, 'correct')}/${facts.length} · hedged ${count(facts, 'hedged')} · wrong ${count(facts, 'wrong')}`);
  console.log(`  traps declined    ${count(traps, 'correct')}/${traps.length} · fabricated ${count(traps, 'wrong')}`);
  console.log(`  ttft  p50/p95     ${percentile(ttfts, 50)} / ${percentile(ttfts, 95)} ms`);
  console.log(`  total p50/p95     ${percentile(totals, 50)} / ${percentile(totals, 95)} ms   (worst ${Math.max(0, ...totals)} ms)`);
  console.log(`  no sources cited  ${results.filter((r) => r.sources === 0).length}`);
  const fellBack = results.filter((r) => r.fellBack).length;
  if (fellBack > 0) console.log(`  FELL BACK         ${fellBack} — those answers are Claude's, not ${MODEL_CONFIG.fastResearch}'s`);
}

async function main(): Promise<void> {
  const { runs, only } = parseArgs();
  const cases = only.length > 0 ? CASES.filter((c) => only.includes(c.id)) : CASES;
  if (cases.length === 0) {
    console.error(`No cases match ${only.join(', ')}. Known: ${CASES.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }
  if (!isOpenAiApiAvailable()) {
    // Without a key the worker silently falls back to the Claude CLI, and the
    // numbers would describe a model production does not use.
    console.error('OPENAI_API_KEY not configured (or COPILOT_DISABLE_PAID_API=1) — refusing to score the fallback as the fast-research model.');
    process.exit(1);
  }

  console.log(`Fast-research accuracy eval · ${MODEL_CONFIG.fastResearch} + web_search · ${cases.length} cases × ${runs} run(s)`);
  console.log('METERED: every case is a live OpenAI call with web search. Questions are synthetic; no meeting content is sent.');

  const worker = new FastResearchWorker();
  const results: RunResult[] = [];
  for (let run = 1; run <= runs; run++) {
    if (runs > 1) console.log(`\nRun ${run}/${runs}`);
    for (const testCase of cases) {
      resetLlmBudget();
      const r = await runCase(worker, testCase);
      results.push(r);
      printResult(r);
    }
  }
  printSummary(results);
  // Nonzero exit on any confident-wrong answer, so this can gate a model swap.
  process.exit(results.some((r) => r.grade === 'wrong') ? 2 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
