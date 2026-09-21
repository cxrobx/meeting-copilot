import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import dotenv from 'dotenv';

import { isOpenAiApiAvailable } from '../api/openai.js';
import { resetLlmBudget } from '../api/budget.js';
import { LLM_CONFIG, MODEL_CONFIG } from '../model-config.js';
// The real worker, not a copy of its prompt: this scores what the ⚡ Fast
// button ships, including the Claude fallback when the OpenAI call fails.
import { FastResearchWorker, FAST_RESEARCH_SYSTEM } from '../workers/fast-research.js';
import { claudeSuggest } from '../claude-cli.js';
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

// `luna` = the shipping worker. `claude` = the same prompt through the
// `claude` CLI with WebSearch/WebFetch (subscription, never the API — the CLI
// child env has ANTHROPIC_API_KEY stripped), which is the only way a Claude
// model can run this path here. It is a cold spawn per call because tool use
// bypasses the warm session, so its latency is what production would get.
type ProviderName = 'luna' | 'claude';

interface Args {
  runs: number;
  only: string[];
  provider: ProviderName;
  claudeModel: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const parsed: Args = { runs: 1, only: [], provider: 'luna', claudeModel: MODEL_CONFIG.suggestion };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs') parsed.runs = Math.max(1, Number(args[++i]) || 1);
    else if (args[i] === '--case') parsed.only.push(args[++i] ?? '');
    else if (args[i] === '--provider') parsed.provider = args[++i] === 'claude' ? 'claude' : 'luna';
    else if (args[i] === '--model') parsed.claudeModel = args[++i] ?? parsed.claudeModel;
  }
  return parsed;
}

const URL_RE = /https?:\/\/[^\s)\]}"'<>]+/g;

/** What the worker returns, reduced to what the grader and the table need. */
interface Answer {
  success: boolean;
  findings: string;
  sources: number;
  error?: string;
}

type Answerer = (query: string, onDelta: () => void, signal: AbortSignal) => Promise<Answer>;

function lunaAnswerer(): Answerer {
  const worker = new FastResearchWorker();
  return async (query, onDelta, signal) => {
    const result = await worker.execute({ query, _onDelta: onDelta }, signal);
    return {
      success: result.success,
      findings: result.success ? String(result.data?.findings ?? '') : '',
      sources: Array.isArray(result.data?.sources) ? result.data.sources.length : 0,
      error: result.success ? undefined : (result.error ?? result.summary),
    };
  };
}

function claudeAnswerer(model: string): Answerer {
  return async (query, onDelta, signal) => {
    try {
      const text = await claudeSuggest(`Question: ${query}`, FAST_RESEARCH_SYSTEM, signal, ['WebSearch', 'WebFetch'], {
        onDelta,
        model,
      });
      // No structured citations on this path; count the URLs it surfaced.
      return { success: true, findings: text, sources: new Set(text.match(URL_RE) ?? []).size };
    } catch (error) {
      return { success: false, findings: '', sources: 0, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function percent(count: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((count / total) * 100)}%`;
}

async function runCase(answerer: Answerer, testCase: ResearchCase): Promise<RunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CASE_TIMEOUT_MS);
  const started = performance.now();
  let ttftMs: number | null = null;
  try {
    const result = await answerer(
      testCase.query,
      () => {
        if (ttftMs === null) ttftMs = Math.round(performance.now() - started);
      },
      controller.signal,
    );
    const totalMs = Math.round(performance.now() - started);
    // Grade the answer, not the appended citation block: a source title can
    // contain the very words the key looks for.
    const answer = result.findings.split('\n\n---\n**Sources**')[0] ?? '';
    const graded = result.success
      ? gradeAnswer(testCase, answer)
      : { grade: 'wrong' as Grade, reasons: [`worker failed: ${result.error}`] };
    return {
      caseId: testCase.id,
      kind: testCase.kind,
      ...graded,
      ttftMs,
      totalMs,
      sources: result.sources,
      fellBack: answer.startsWith(FALLBACK_MARKER),
      answer,
      error: result.error,
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

function printSummary(results: RunResult[], label: string): void {
  const facts = results.filter((r) => r.kind === 'fact');
  const traps = results.filter((r) => r.kind === 'trap');
  const count = (rs: RunResult[], g: Grade) => rs.filter((r) => r.grade === g).length;
  const ttfts = results.map((r) => r.ttftMs).filter((v): v is number => v !== null);
  const totals = results.map((r) => r.totalMs);
  const wrong = count(results, 'wrong');

  console.log('\nSummary');
  console.log(`  model             ${label}`);
  console.log(`  answers           ${results.length}`);
  console.log(`  WRONG (confident) ${wrong} (${percent(wrong, results.length)})   <- the number that matters`);
  console.log(`  facts correct     ${count(facts, 'correct')}/${facts.length} · hedged ${count(facts, 'hedged')} · wrong ${count(facts, 'wrong')}`);
  console.log(`  traps declined    ${count(traps, 'correct')}/${traps.length} · fabricated ${count(traps, 'wrong')}`);
  console.log(`  ttft  p50/p95     ${percentile(ttfts, 50)} / ${percentile(ttfts, 95)} ms`);
  console.log(`  total p50/p95     ${percentile(totals, 50)} / ${percentile(totals, 95)} ms   (worst ${Math.max(0, ...totals)} ms)`);
  console.log(`  no sources cited  ${results.filter((r) => r.sources === 0).length}`);
  const fellBack = results.filter((r) => r.fellBack).length;
  if (fellBack > 0) console.log(`  FELL BACK         ${fellBack} — those answers are Claude's, not ${label}'s`);
}

async function main(): Promise<void> {
  const { runs, only, provider, claudeModel } = parseArgs();
  const cases = only.length > 0 ? CASES.filter((c) => only.includes(c.id)) : CASES;
  if (cases.length === 0) {
    console.error(`No cases match ${only.join(', ')}. Known: ${CASES.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }
  if (provider === 'luna' && !isOpenAiApiAvailable()) {
    // Without a key the worker silently falls back to the Claude CLI, and the
    // numbers would describe a model production does not use.
    console.error('OPENAI_API_KEY not configured (or COPILOT_DISABLE_PAID_API=1) — refusing to score the fallback as the fast-research model.');
    process.exit(1);
  }

  // With COPILOT_LIVE_LLM_MODE=cli the worker skips OpenAI and answers with
  // Haiku through the claude CLI, so label (and don't call metered) that run.
  const workerOnCli = provider === 'luna' && LLM_CONFIG.liveTransport === 'cli';
  const label = provider === 'claude'
    ? `${claudeModel} (claude CLI)`
    : workerOnCli ? `${MODEL_CONFIG.haiku} (claude CLI, COPILOT_LIVE_LLM_MODE=cli)` : MODEL_CONFIG.fastResearch;
  console.log(`Fast-research accuracy eval · ${label} + web search · ${cases.length} cases × ${runs} run(s)`);
  console.log(provider === 'luna' && !workerOnCli
    ? 'METERED: every case is a live OpenAI call with web search. Questions are synthetic; no meeting content is sent.'
    : 'Subscription: every case is a cold `claude` CLI spawn with WebSearch/WebFetch. Questions are synthetic.');

  const answerer = provider === 'luna' ? lunaAnswerer() : claudeAnswerer(claudeModel);
  const results: RunResult[] = [];
  for (let run = 1; run <= runs; run++) {
    if (runs > 1) console.log(`\nRun ${run}/${runs}`);
    for (const testCase of cases) {
      resetLlmBudget();
      const r = await runCase(answerer, testCase);
      results.push(r);
      printResult(r);
    }
  }
  printSummary(results, label);
  // Nonzero exit on any confident-wrong answer, so this can gate a model swap.
  process.exit(results.some((r) => r.grade === 'wrong') ? 2 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
