/**
 * Agenda reconcile replay — regression check for the reconcile lane's model.
 *
 * Replays real sessions from ~/.meeting-copilot/sessions through the exact
 * production reconcile call (same system prompt, prompt builder, schema,
 * output cap, transcript slice and 30s cadence). Reconcile is stateless —
 * each call re-reads the transcript from scratch — so a replay is the call
 * production would have made at that moment.
 *
 * The candidate is whatever MODEL_CONFIG.agendaReconcile resolves to. With
 * `--baseline <model>` the baseline runs on the SAME checkpoints and the
 * candidate is gated against it. `--baseline-from <report.json>` reuses the
 * baseline arm of an earlier `--out` report instead of paying for it again
 * (checkpoints are deterministic, so they line up by time). Without either,
 * only the absolute gates apply and the live run's reconcile results are
 * printed for reference.
 *
 * Gates (exit 1 on any failure):
 *   schema    — parse + all-ids rate no worse than the baseline's
 *   latency   — calls over RECONCILE_PROVIDER_TIMEOUT_MS within the
 *               baseline's + slack (absolute: p95 inside it)
 *   evidence  — grounded-quote rate within 5 points of the baseline's. A quote
 *               is grounded when ≥80% of its words appear together in the
 *               transcript: models tidy stutters and ASR errors ("John" →
 *               "Jordan"), so character-exact is the wrong bar; invented content
 *               is what this catches. Verbatim is reported alongside.
 *   flapping  — covered-count drops within the baseline's + slack (10%:
 *               measured run-to-run spread, see FLAP_TOLERANCE)
 *   slack     — max(1 event, 5% of calls)
 *
 * Metered: ~$0.07 per 30-minute session on gpt-6-luna; a gpt-5.6-terra
 * baseline is ~20x that. Nothing leaves the machine except the production
 * call itself.
 *
 * Run under Node 20 (better-sqlite3 is built for the app's runtime Node —
 * gotcha #14):
 *   PATH=/usr/local/bin:$PATH npm run eval:agenda -- [--baseline <model> | --baseline-from <report.json>] [--out report.json] [sessionId ...]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import dotenv from 'dotenv';

import { openaiStructuredJson, tokenPrices } from '../api/openai.js';
import { resetLlmBudget } from '../api/budget.js';
import { MODEL_CONFIG } from '../model-config.js';
import {
  AGENDA_EVAL_SYSTEM,
  AGENDA_SCHEMA,
  MAX_RECONCILE_CHARS,
  RECONCILE_MAX_OUTPUT_TOKENS,
  RECONCILE_PROVIDER_TIMEOUT_MS,
  buildAgendaEvalPrompt,
  parseAgenda,
  parseAgendaResponse,
  type AgendaItem,
  type AgendaItemState,
} from '../intelligence/agenda.js';

const USER_ENV_PATH = join(homedir(), '.meeting-copilot', '.env');
if (existsSync(USER_ENV_PATH)) dotenv.config({ path: USER_ENV_PATH });
else dotenv.config();

const SESSIONS_DIR = join(homedir(), '.meeting-copilot', 'sessions');
// The tracker's own gates (agenda.ts): 30s timer, first eval at 15 words,
// then only after 5 new words.
const CADENCE_MS = 30_000;
const FIRST_EVAL_WORDS = 15;
const MIN_NEW_WORDS = 5;
// Relative gates allow 5% of calls or ONE event, whichever is larger: on a
// 10-call session 5% is zero events, and one tail call or one flap is noise
// (gpt-6-luna's over-deadline count ran 2/4/6/6 of 64 across four replays).
const TOLERANCE = 0.05;
// Flapping is noisier than that in BOTH models. Set after measuring, not
// before: six gpt-6-luna replays of the 09-21 Winslow call dropped 14–21 of
// 63 (mean 26.5%) against gpt-5.6-terra's 17 — a 7-event spread run to run.
// A gate inside the spread flips on dice; 10% of calls clears it.
const FLAP_TOLERANCE = 0.1;
const GROUNDED_COVERAGE = 0.8;

interface Row { label: string; text: string; timestamp: number; wordCount: number }
interface LiveReconcile { t: number; covered?: number; latencyMs?: number; deadline: boolean }
interface SessionData {
  id: string;
  title: string;
  agenda: string;
  startedAt: number;
  endedAt: number;
  rows: Row[];
  live: LiveReconcile[];
}

interface Call {
  ok: boolean;
  idsComplete: boolean;
  states: Record<string, AgendaItemState>;
  evidence: Record<string, string>;
  evidenceChecked: number;
  evidenceVerbatim: number;
  evidenceGrounded: number;
  evidenceMisses: string[];
  missing: string[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  raw?: string;
  error?: string;
}

interface Checkpoint { t: number; transcript: string }

interface ArmMetrics {
  model: string;
  calls: number;
  schemaRate: number;
  p50: number;
  p95: number;
  max: number;
  overDeadline: number;
  evidenceRate: number;
  groundedRate: number;
  evidenceChecked: number;
  drops: number;
  dropRate: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  dollars: number;
}

function parseArgs(argv: string[]) {
  let baseline: string | undefined;
  let baselineFrom: string | undefined;
  let out: string | undefined;
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline') baseline = argv[++i];
    else if (argv[i] === '--baseline-from') baselineFrom = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
    else ids.push(argv[i]!);
  }
  return { baseline, baselineFrom, out, ids };
}

async function openDb(path: string) {
  try {
    const { default: Database } = await import('better-sqlite3');
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('NODE_MODULE_VERSION')) {
      console.error('better-sqlite3 was built for a different Node. Run under Node 20:\n  PATH=/usr/local/bin:$PATH npm run eval:agenda');
      process.exit(2);
    }
    throw error;
  }
}

async function loadSession(id: string): Promise<SessionData | null> {
  const dir = join(SESSIONS_DIR, id);
  const dbPath = join(dir, 'session.db');
  if (!existsSync(dbPath)) return null;
  const db = await openDb(dbPath);
  try {
    const s = db.prepare('SELECT title, agenda, startedAt, endedAt FROM session LIMIT 1').get() as
      { title: string; agenda: string; startedAt: number; endedAt: number | null } | undefined;
    if (!s) return null;
    // Same query and formatting as the production transcriptProvider.
    const rows = db.prepare('SELECT label, text, timestamp, wordCount FROM transcript ORDER BY timestamp ASC').all() as Row[];
    // The live run's reconcile lane, from its own event log. `covered` after a
    // reconcile completion is that model's answer: reconcile sets every item
    // it returns, and only the delta lane (monotonic) acts in between.
    const live: LiveReconcile[] = [];
    const eventsPath = join(dir, 'events.jsonl');
    if (existsSync(eventsPath)) {
      for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
        if (!line.includes('"agenda.eval"') || !line.includes('"reconcile"')) continue;
        try {
          const e = JSON.parse(line);
          if (e.mode !== 'reconcile') continue;
          if (e.completed) live.push({ t: e.timestamp, covered: e.covered, latencyMs: e.latencyMs, deadline: false });
          else if (e.skipped === 'deadline') live.push({ t: e.timestamp, deadline: true });
        } catch { /* skip torn line */ }
      }
    }
    const last = rows.length ? rows[rows.length - 1]!.timestamp : s.startedAt;
    return { id, title: s.title, agenda: s.agenda, startedAt: s.startedAt, endedAt: s.endedAt ?? last, rows, live };
  } finally {
    db.close();
  }
}

/** Sessions with a real agenda (≥2 items) and a real transcript; replays of one recording counted once. */
async function defaultSessions(): Promise<SessionData[]> {
  const out: SessionData[] = [];
  const seen = new Set<string>();
  for (const id of readdirSync(SESSIONS_DIR)) {
    const s = await loadSession(id);
    if (!s || parseAgenda(s.agenda).length < 2 || s.rows.length < 50) continue;
    const key = `${s.agenda}|${s.rows.length}|${s.rows[0]?.text ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** The moments the tracker would have reconciled, with the transcript it would have sent. */
function checkpoints(s: SessionData): Checkpoint[] {
  const out: Checkpoint[] = [];
  let lastWords = -1;
  for (let t = s.startedAt + CADENCE_MS; t <= s.endedAt + CADENCE_MS; t += CADENCE_MS) {
    const at = Math.min(t, s.endedAt);
    const rows = s.rows.filter((r) => r.timestamp <= at);
    const words = rows.reduce((sum, r) => sum + (r.wordCount || 0), 0);
    if (at !== s.endedAt) {
      if (lastWords < 0 && words < FIRST_EVAL_WORDS) continue;
      if (lastWords >= 0 && words - lastWords < MIN_NEW_WORDS) continue;
    }
    lastWords = words;
    out.push({ t: at, transcript: rows.map((r) => `${r.label} ${r.text}`).join('\n').slice(-MAX_RECONCILE_CHARS) });
    if (at === s.endedAt) break;
  }
  return out;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const tokens = (s: string) => normalize(s).split(' ').filter(Boolean);
// Speaker labels sit between segments; a quote spanning two segments drops them.
const unlabelled = (transcript: string) => transcript.replace(/\[(You|Meeting)\]/g, ' ');

/** ≥80% of the quote's words inside one transcript window twice its length. */
function grounded(quote: string, haystack: string[]): boolean {
  const q = tokens(quote);
  if (q.length === 0) return true;
  const need = new Set(q);
  const width = Math.max(q.length * 2, 12);
  let best = 0;
  for (let i = 0; i < haystack.length; i++) {
    if (!need.has(haystack[i]!)) continue;
    const window = new Set(haystack.slice(i, i + width));
    const hits = q.filter((w) => window.has(w)).length;
    if (hits > best) best = hits;
    if (best === q.length) break;
  }
  return best / q.length >= GROUNDED_COVERAGE;
}

function scoreEvidence(call: Call, transcript: string): void {
  const plain = unlabelled(transcript);
  const haystack = normalize(plain);
  const words = tokens(plain);
  call.evidenceChecked = 0;
  call.evidenceVerbatim = 0;
  call.evidenceGrounded = 0;
  call.evidenceMisses = [];
  for (const quote of Object.values(call.evidence)) {
    call.evidenceChecked++;
    if (haystack.includes(normalize(quote))) call.evidenceVerbatim++;
    if (grounded(quote, words)) call.evidenceGrounded++;
    else call.evidenceMisses.push(quote);
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function countDrops(series: number[]): number {
  let drops = 0;
  for (let i = 1; i < series.length; i++) if (series[i]! < series[i - 1]!) drops++;
  return drops;
}

const coveredOf = (c: Call) => Object.values(c.states).filter((v) => v === 'covered').length;

async function reconcile(model: string, items: AgendaItem[], title: string, cp: Checkpoint): Promise<Call> {
  const call: Call = {
    ok: false, idsComplete: false, states: {}, evidence: {},
    evidenceChecked: 0, evidenceVerbatim: 0, evidenceGrounded: 0, evidenceMisses: [], missing: [],
    latencyMs: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0,
  };
  try {
    const raw = await openaiStructuredJson(
      buildAgendaEvalPrompt(items, cp.transcript, title),
      AGENDA_EVAL_SYSTEM,
      AGENDA_SCHEMA as any,
      {
        model,
        label: 'agenda-reconcile-replay',
        reasoningEffort: 'none',
        maxOutputTokens: RECONCILE_MAX_OUTPUT_TOKENS,
        // Generous so the whole latency distribution is visible; the gate
        // scores it against the production deadline instead.
        timeoutMs: 30_000,
        onUsage: (u) => {
          call.latencyMs = u.latencyMs;
          call.inputTokens = u.inputTokens;
          call.outputTokens = u.outputTokens;
          call.cachedTokens = u.cachedTokens;
        },
      },
    );
    const parsed = parseAgendaResponse(raw);
    if (!parsed) {
      call.raw = raw;
      return call;
    }
    call.ok = true;
    for (const r of parsed.items) {
      call.states[r.id] = r.state;
      if (r.evidence) call.evidence[r.id] = r.evidence;
    }
    scoreEvidence(call, cp.transcript);
    call.idsComplete = items.every((i) => call.states[i.id] !== undefined);
    call.missing = parsed.missing_warnings ?? [];
  } catch (error) {
    call.error = error instanceof Error ? error.message : String(error);
  }
  return call;
}

function metrics(model: string, calls: Call[]): ArmMetrics {
  const good = calls.filter((c) => c.ok);
  const lat = good.map((c) => c.latencyMs);
  const evidenceChecked = good.reduce((a, c) => a + c.evidenceChecked, 0);
  const evidenceVerbatim = good.reduce((a, c) => a + c.evidenceVerbatim, 0);
  const evidenceGrounded = good.reduce((a, c) => a + c.evidenceGrounded, 0);
  const drops = countDrops(good.map(coveredOf));
  const prices = tokenPrices(model);
  const inputTokens = good.reduce((a, c) => a + c.inputTokens, 0);
  const outputTokens = good.reduce((a, c) => a + c.outputTokens, 0);
  return {
    model,
    calls: calls.length,
    schemaRate: calls.length ? calls.filter((c) => c.ok && c.idsComplete).length / calls.length : 0,
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    max: Math.max(0, ...lat),
    overDeadline: lat.filter((l) => l > RECONCILE_PROVIDER_TIMEOUT_MS).length,
    evidenceRate: evidenceChecked ? evidenceVerbatim / evidenceChecked : 1,
    groundedRate: evidenceChecked ? evidenceGrounded / evidenceChecked : 1,
    evidenceChecked,
    drops,
    dropRate: good.length > 1 ? drops / (good.length - 1) : 0,
    inputTokens,
    outputTokens,
    cachedTokens: good.reduce((a, c) => a + c.cachedTokens, 0),
    dollars: (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000,
  };
}

const slack = (n: number, tolerance = TOLERANCE) => Math.max(1, Math.floor(n * tolerance));
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

function describe(m: ArmMetrics): string {
  return `schema ${pct(m.schemaRate)} · p50/p95/max ${m.p50}/${m.p95}/${m.max}ms (${m.overDeadline} over ${RECONCILE_PROVIDER_TIMEOUT_MS}ms) · quotes grounded ${pct(m.groundedRate)} / verbatim ${pct(m.evidenceRate)} of ${m.evidenceChecked} · drops ${m.drops}/${m.calls - 1} (${pct(m.dropRate)}) · ${m.inputTokens} in/${m.cachedTokens} cached ≈ $${m.dollars.toFixed(4)}`;
}

async function main(): Promise<void> {
  resetLlmBudget();
  const { baseline: baselineArg, baselineFrom, out, ids } = parseArgs(process.argv.slice(2));
  const candidate = MODEL_CONFIG.agendaReconcile;
  // A saved baseline arm, keyed by session then checkpoint time.
  const saved = new Map<string, Map<number, Call>>();
  let savedModel: string | undefined;
  if (baselineFrom) {
    for (const sess of JSON.parse(readFileSync(baselineFrom, 'utf8')) as any[]) {
      if (!sess.baseline) continue;
      savedModel = sess.baseline.model;
      saved.set(sess.session, new Map(sess.checkpoints.filter((c: any) => c.baseline).map((c: any) => [c.t, c.baseline as Call])));
    }
  }
  const baseline = baselineArg ?? savedModel;
  const sessions = ids.length
    ? (await Promise.all(ids.map(loadSession))).filter((s): s is SessionData => s !== null)
    : await defaultSessions();
  if (sessions.length === 0) {
    console.error('No sessions with an agenda of 2+ items and 50+ transcript rows.');
    process.exit(2);
  }

  console.log(`Agenda reconcile replay — candidate=${candidate}${baseline ? ` baseline=${baseline}` : ''}, ${sessions.length} session(s)\n`);
  let failed = false;
  const report: unknown[] = [];

  for (const s of sessions) {
    const items = parseAgenda(s.agenda);
    const cps = checkpoints(s);
    console.log(`▶ ${s.title} (${s.id.slice(0, 8)}) — ${items.length} items, ${Math.round((s.endedAt - s.startedAt) / 60_000)} min, ${cps.length} checkpoints`);

    const cand: Call[] = [];
    const base: Call[] = [];
    for (const cp of cps) {
      // Both arms see the identical checkpoint, run side by side so each keeps
      // its own warm prompt cache as the transcript grows.
      const cached = saved.get(s.id)?.get(cp.t);
      if (cached) scoreEvidence(cached, cp.transcript);
      const [c, b] = await Promise.all([
        reconcile(candidate, items, s.title, cp),
        cached ?? (baselineArg ? reconcile(baselineArg, items, s.title, cp) : Promise.resolve(null)),
      ]);
      cand.push(c);
      if (b) base.push(b);
      const minute = ((cp.t - s.startedAt) / 60_000).toFixed(1).padStart(5);
      const bPart = b ? `  ${baseline}=${b.ok ? coveredOf(b) : 'x'}` : '';
      process.stdout.write(`  ${minute}m ${candidate}=${c.ok ? coveredOf(c) : 'x'}${bPart}\n`);
    }

    const cm = metrics(candidate, cand);
    console.log(`  candidate ${describe(cm)}`);
    let bm: ArmMetrics | null = null;
    if (baseline && base.length === cand.length) {
      bm = metrics(baseline, base);
      console.log(`  baseline  ${describe(bm)}`);
      // Per (checkpoint, item) agreement where both arms answered.
      let same = 0;
      let total = 0;
      for (let k = 0; k < cand.length; k++) {
        if (!cand[k]!.ok || !base[k]!.ok) continue;
        for (const i of items) {
          total++;
          if (cand[k]!.states[i.id] === base[k]!.states[i.id]) same++;
        }
      }
      console.log(`  agreement ${same}/${total} item-states (${pct(total ? same / total : 0)})`);
    }
    const live = s.live.filter((e) => !e.deadline);
    if (live.length > 1) {
      const series = live.map((e) => e.covered ?? 0);
      const lat = live.map((e) => e.latencyMs ?? 0);
      console.log(`  live      ${live.length} reconciles, ${s.live.length - live.length} dropped at the deadline · p50/max ${percentile(lat, 50)}/${Math.max(...lat)}ms · drops ${countDrops(series)}/${series.length - 1} (${pct(countDrops(series) / (series.length - 1))})`);
    }

    const gates = [
      { name: 'schema', pass: cm.schemaRate >= (bm ? bm.schemaRate : 1) },
      { name: 'latency', pass: bm ? cm.overDeadline <= bm.overDeadline + slack(cm.calls) : cm.p95 <= RECONCILE_PROVIDER_TIMEOUT_MS },
      { name: 'evidence', pass: cm.groundedRate >= (bm ? bm.groundedRate - TOLERANCE : 0) },
      { name: 'flapping', pass: bm ? cm.drops <= bm.drops + slack(cm.calls - 1, FLAP_TOLERANCE) : true },
    ];
    console.log(`  gates     ${gates.map((g) => `${g.pass ? 'PASS' : 'FAIL'} ${g.name}`).join(' · ')}`);
    if (gates.some((g) => !g.pass)) failed = true;

    const failures = cand.filter((c) => !c.ok || !c.idsComplete);
    for (const f of failures.slice(0, 3)) {
      console.log(`  ! candidate ${f.error ? `error: ${f.error}` : f.ok ? 'missing ids' : `unparseable (${f.outputTokens} out tokens): ${JSON.stringify(f.raw ?? '').slice(0, 400)}`}`);
    }
    const misses = cand.flatMap((c) => c.evidenceMisses);
    for (const m of misses.slice(0, 4)) console.log(`  ~ quote not grounded: “${m.slice(0, 110)}”`);

    const finalC = cand[cand.length - 1];
    const finalB = base[base.length - 1];
    if (finalC?.ok) {
      console.log('  final states (candidate' + (finalB ? ' | baseline' : '') + '):');
      for (const i of items) {
        const b = finalB?.ok ? ` | ${(finalB.states[i.id] ?? '—').padEnd(8)}` : '';
        console.log(`    ${i.id} ${(finalC.states[i.id] ?? '—').padEnd(8)}${b} ${i.text.slice(0, 64)}`);
      }
    }
    console.log('');
    report.push({ session: s.id, title: s.title, candidate: cm, baseline: bm, checkpoints: cps.map((cp, k) => ({ t: cp.t, candidate: cand[k], baseline: bm ? base[k] : null })) });
  }

  if (out) {
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`Report written to ${out}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
