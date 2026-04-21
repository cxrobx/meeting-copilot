import { EventEmitter } from 'node:events';
import { claudeChat } from '../claude-cli.js';
import { isAnthropicApiAvailable, anthropicHaikuCachedJson } from '../api/anthropic.js';

const EVAL_INTERVAL_MS = 15_000;
const MIN_NEW_WORDS_BEFORE_EVAL = 15;
// First eval fires when transcript reaches this total word count — doesn't
// require waiting for MIN_NEW_WORDS_BEFORE_EVAL of growth.
const MIN_TOTAL_WORDS_FOR_FIRST_EVAL = 15;

const EXTRACT_MAX_ITEMS = 20;
const EXTRACT_ITEM_MAX_CHARS = 150;
const BULLET_PREFIX_RE = /^[\s\-\*•‣]+/;
const NUMBERED_PREFIX_RE = /^\d+[\.\)]\s*/;
const TRAILING_PUNCTUATION_RE = /[\s.,;:!?]+$/;

export type AgendaItemState = 'pending' | 'partial' | 'covered';

export interface AgendaItem {
  id: string;
  text: string;
  state: AgendaItemState;
  evidence?: string;
  updatedAt?: number;
}

export interface AgendaStatus {
  items: AgendaItem[];
  missing: string[];
  lastEvalAt: number;
  fullyCovered: boolean;
}

export interface AgendaEvalResponse {
  items: Array<{
    id: string;
    state: AgendaItemState;
    evidence?: string;
  }>;
  missing_warnings?: string[];
}

/**
 * Parses a freeform agenda string into discrete items.
 * Supports: one-per-line, bulleted (-, *, •, numbered 1., 2)), or comma-separated single-line.
 */
export function parseAgenda(raw: string): AgendaItem[] {
  if (!raw) return [];

  const trimmed = raw.trim();
  if (!trimmed) return [];

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let rawItems: string[];

  if (lines.length > 1) {
    rawItems = lines;
  } else {
    // Single line — split on commas/semicolons if present
    const parts = trimmed.split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean);
    rawItems = parts.length > 1 ? parts : [trimmed];
  }

  return rawItems
    .map((s) => s.replace(/^[\s\-\*•‣]+/, '').replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(Boolean)
    .map((text, idx) => ({
      id: `a${idx + 1}`,
      text,
      state: 'pending' as AgendaItemState,
    }));
}

export interface AgendaEvalDeps {
  triage?: (prompt: string, systemPrompt: string, signal?: AbortSignal) => Promise<string>;
}

export class AgendaTracker extends EventEmitter {
  private items: AgendaItem[] = [];
  private missing: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastEvalAt = 0;
  private lastEvalWordCount = 0;
  private transcriptProvider: () => string = () => '';
  private wordCountProvider: () => number = () => 0;
  private sessionTitle = '';

  // Generation token — bumped on every start() and stop(). Any in-flight eval
  // whose captured generation no longer matches is discarded before it can
  // mutate state or emit, so stale results from a prior session cannot bleed
  // into the next one.
  private generation = 0;

  // Promise for the currently-running evaluation (if any). `evaluateNow()`
  // awaits this before starting its own pass so forced final evals cannot be
  // dropped when the 30s loop is mid-flight.
  private currentEval: Promise<void> | null = null;

  // Abort controller for the in-flight triage call — signalled on stop().
  private abortController: AbortController | null = null;

  private readonly triage: NonNullable<AgendaEvalDeps['triage']>;

  constructor(deps: AgendaEvalDeps = {}) {
    super();
    // Use Haiku directly via claudeChat rather than the Gemini→Haiku→Codex
    // triage chain. The chain is tuned for the 15s intelligence loop with a
    // small 5-minute transcript window; for agenda eval with the full
    // growing transcript, Gemini was stalling out for 30–40s on first runs
    // before falling back to Haiku anyway. Skipping straight to Haiku keeps
    // latency in the 2–5s range and makes the panel responsive.
    this.triage = deps.triage ?? ((prompt, systemPrompt, signal) =>
      claudeChat(prompt, {
        systemPrompt,
        model: 'claude-haiku-4-5-20251001',
        signal,
      }));
  }

  start(options: {
    agenda: string;
    transcriptProvider: () => string;
    wordCountProvider: () => number;
    sessionTitle?: string;
  }): AgendaItem[] {
    this.stop();
    // stop() already bumped the generation; the new session owns whatever
    // value `this.generation` now holds.
    this.items = parseAgenda(options.agenda);
    this.missing = [];
    this.transcriptProvider = options.transcriptProvider;
    this.wordCountProvider = options.wordCountProvider;
    this.sessionTitle = options.sessionTitle ?? '';
    this.lastEvalAt = 0;
    this.lastEvalWordCount = 0;

    if (this.items.length === 0) {
      return [];
    }

    this.running = true;
    this.timer = setInterval(() => {
      this.scheduleEval().catch(() => {/* swallow */});
    }, EVAL_INTERVAL_MS);

    return this.items;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.generation++;
    this.running = false;
    this.items = [];
    this.missing = [];
    this.transcriptProvider = () => '';
    this.wordCountProvider = () => 0;
    this.sessionTitle = '';
    this.lastEvalAt = 0;
    this.lastEvalWordCount = 0;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // Do NOT null currentEval — the in-flight promise will still settle, but
    // its generation check will discard the result.
  }

  getStatus(): AgendaStatus {
    return {
      items: this.items.map((i) => ({ ...i })),
      missing: [...this.missing],
      lastEvalAt: this.lastEvalAt,
      fullyCovered: this.items.length > 0 && this.items.every((i) => i.state === 'covered'),
    };
  }

  /**
   * Force an immediate evaluation (e.g., on session.stop for a final wrap-up).
   * Awaits any in-flight eval first so a forced pass is never silently dropped,
   * then runs a fresh pass against the current transcript.
   */
  async evaluateNow(): Promise<void> {
    if (this.currentEval) {
      try { await this.currentEval; } catch { /* already handled inside */ }
    }
    // After the prior eval settles, the session may have been stopped — in
    // that case `runEvaluation` bails on its own generation check.
    await this.runEvaluation(true);
  }

  private async scheduleEval(): Promise<void> {
    if (!this.running || this.items.length === 0) return;
    if (this.currentEval) {
      this.emit('eval', { skipped: 'in-flight' });
      return;
    }

    const currentWordCount = this.wordCountProvider();
    const isFirstEval = this.lastEvalAt === 0;
    const gateReason = isFirstEval
      ? currentWordCount < MIN_TOTAL_WORDS_FOR_FIRST_EVAL
        ? `first-eval: ${currentWordCount}/${MIN_TOTAL_WORDS_FOR_FIRST_EVAL} words`
        : null
      : currentWordCount - this.lastEvalWordCount < MIN_NEW_WORDS_BEFORE_EVAL
        ? `growth: +${currentWordCount - this.lastEvalWordCount}/${MIN_NEW_WORDS_BEFORE_EVAL}`
        : null;

    if (gateReason) {
      this.emit('eval', { skipped: gateReason });
      return;
    }

    await this.runEvaluation(false);
  }

  private async runEvaluation(force: boolean): Promise<void> {
    // Re-entrancy guard. Forced evals are expected to have awaited the
    // in-flight promise via `evaluateNow()` before reaching here.
    if (this.currentEval) return;

    const gen = this.generation;
    if (!force && !this.running) return;

    const transcript = this.transcriptProvider();
    if (!transcript || transcript.trim().length < 20) {
      if (!force) return;
    }

    const controller = new AbortController();
    this.abortController = controller;

    const task = this.doEvaluation(gen, transcript, controller.signal);
    this.currentEval = task;
    try {
      await task;
    } finally {
      if (this.currentEval === task) {
        this.currentEval = null;
      }
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  private async doEvaluation(
    gen: number,
    transcript: string,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    this.emit('eval', { started: true, words: this.wordCountProvider() });
    try {
      // Prefer the Anthropic API with prompt caching. The agenda list +
      // session title are stable across a session, so after the first call
      // the cache hits and only the transcript window pays input cost.
      // CLI path stays as the fallback so no key = still works.
      let raw: string;
      if (isAnthropicApiAvailable()) {
        const { staticPrefix, dynamicTail } = buildAgendaEvalPromptSplit(
          this.items,
          transcript,
          this.sessionTitle,
        );
        raw = await anthropicHaikuCachedJson({
          systemPrompt: AGENDA_EVAL_SYSTEM,
          staticContext: staticPrefix,
          dynamicTail,
          signal,
          label: 'agenda-eval',
        });
      } else {
        const prompt = buildAgendaEvalPrompt(this.items, transcript, this.sessionTitle);
        raw = await this.triage(prompt, AGENDA_EVAL_SYSTEM, signal);
      }

      // Stale-guard: drop the result if the session changed while we awaited.
      if (gen !== this.generation) {
        this.emit('eval', { stale: true });
        return;
      }

      const parsed = parseAgendaResponse(raw);
      if (!parsed) {
        this.emit('eval', { parseFailed: true, rawSnippet: raw.slice(0, 200) });
        return;
      }

      let changed = false;
      const byId = new Map(parsed.items.map((r) => [r.id, r]));
      for (const item of this.items) {
        const update = byId.get(item.id);
        if (!update) continue;

        // Clear stale evidence when an item transitions back to pending.
        if (update.state === 'pending' && item.state !== 'pending') {
          item.state = 'pending';
          item.evidence = undefined;
          item.updatedAt = Date.now();
          changed = true;
          continue;
        }

        if (
          update.state !== item.state ||
          (update.evidence && update.evidence !== item.evidence)
        ) {
          item.state = update.state;
          if (update.evidence) item.evidence = update.evidence;
          item.updatedAt = Date.now();
          changed = true;
        }
      }

      const nextMissing = parsed.missing_warnings ?? [];
      if (JSON.stringify(nextMissing) !== JSON.stringify(this.missing)) {
        this.missing = nextMissing;
        changed = true;
      }

      this.lastEvalAt = Date.now();
      this.lastEvalWordCount = this.wordCountProvider();

      // Always emit status on a successful eval so consumers see lastEvalAt
      // advance and can confirm the tracker is live, even when the LLM
      // returned no state changes. Broadcasting identical payloads back-to-
      // back is cheap (JSON serialization) and makes the feature observable.
      const covered = this.items.filter((i) => i.state === 'covered').length;
      const partial = this.items.filter((i) => i.state === 'partial').length;
      this.emit('eval', {
        completed: true,
        changed,
        covered,
        partial,
        total: this.items.length,
        latencyMs: Date.now() - startedAt,
      });
      this.emit('status', this.getStatus());
    } catch (err) {
      if (gen !== this.generation) return; // session changed — swallow silently
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Aborted') return;
      this.emit('error', msg);
    }
  }
}

const AGENDA_EVAL_SYSTEM = `You track whether a meeting is covering its planned agenda items. You read the full transcript so far and the agenda list, and mark each item as covered, partially addressed, or still pending. You also flag items that seem to be running out of time to discuss.

State definitions:
- "covered" = both sides engaged with the topic — the question was raised AND at least a substantive answer or back-and-forth followed. Evidence must exist in the transcript.
- "partial" = the topic has clearly surfaced but isn't fully resolved. THIS INCLUDES: the user asking or raising an agenda question even if no answer has been given yet. Asking counts. A reasonable phrasing of the agenda item appearing in the transcript is enough for "partial" even without a response.
- "pending" = the topic has not appeared in the transcript at all.

Matching rules:
- Be lenient on wording. The transcript is everyday spoken language with transcription errors; the agenda may use shorthand. Match by intent, not exact phrasing.
- If the user paraphrases or approximates an agenda item, it still counts. E.g. "walk us through month one, the first 20 hours" matches "Walk us through month 1 — how are the first 20 hours spent".
- An item can be "partial" even if the transcript barely scratches the surface. Err on the side of "partial" over "pending" when a reasonable connection exists.
- Evidence must be a short direct quote from the transcript (under 120 chars). Quote the moment the item surfaced, not a generic line.

Warnings:
- Only produce missing_warnings if the transcript shows wrap-up/summary/farewell language AND items remain pending.

Respond with JSON only. No other text.`;

function buildAgendaEvalPromptSplit(
  items: AgendaItem[],
  transcript: string,
  sessionTitle: string,
): { staticPrefix: string; dynamicTail: string } {
  const agendaList = items.map((i) => `  ${i.id}: ${i.text}`).join('\n');
  const titleLine = sessionTitle ? `Meeting: ${sessionTitle}\n\n` : '';
  const staticPrefix = `${titleLine}Agenda items to track:
${agendaList}`;

  const dynamicTail = `

Transcript so far:
<transcript>
${transcript}
</transcript>

For each agenda item, determine its state based on what has actually been discussed.

Respond with JSON:
{
  "items": [
    { "id": "a1", "state": "covered" | "partial" | "pending", "evidence": "short direct quote from transcript, or empty if pending" }
  ],
  "missing_warnings": ["human-readable sentence for any agenda item that still looks un-addressed as the meeting wraps up (only if wrap-up signals are present)"]
}`;
  return { staticPrefix, dynamicTail };
}

function buildAgendaEvalPrompt(
  items: AgendaItem[],
  transcript: string,
  sessionTitle: string,
): string {
  const { staticPrefix, dynamicTail } = buildAgendaEvalPromptSplit(items, transcript, sessionTitle);
  return staticPrefix + dynamicTail;
}

function parseAgendaResponse(raw: string): AgendaEvalResponse | null {
  if (!raw) return null;
  // Extract the largest JSON object in the response
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed.items)) return null;
    const items = parsed.items
      .filter((i: any) => i && typeof i.id === 'string' && typeof i.state === 'string')
      .map((i: any) => ({
        id: i.id,
        state: normalizeState(i.state),
        evidence: typeof i.evidence === 'string' ? i.evidence.trim() : undefined,
      }));
    const missing = Array.isArray(parsed.missing_warnings)
      ? parsed.missing_warnings.filter((s: any) => typeof s === 'string' && s.trim().length > 0)
      : [];
    return { items, missing_warnings: missing };
  } catch {
    return null;
  }
}

function normalizeState(s: string): AgendaItemState {
  const v = s.toLowerCase();
  if (v === 'covered' || v === 'done' || v === 'complete') return 'covered';
  if (v === 'partial' || v === 'partially' || v === 'in_progress') return 'partial';
  return 'pending';
}

// ─── Agenda extraction from freeform notes ──────────────────────────────────

type ChatFn = (
  prompt: string,
  options: { systemPrompt?: string; model?: string; signal?: AbortSignal },
) => Promise<string>;

export interface ExtractAgendaDeps {
  chat?: ChatFn;
  signal?: AbortSignal;
}

const AGENDA_EXTRACT_SYSTEM = `You extract a meeting-tracking agenda from freeform notes, prep docs, or markdown briefs. Given the user's input, return 5–15 short concrete items they want to make sure they COVER or ASK during the meeting.

Rules:
- Each item is one short imperative or phrase, under 100 characters.
- Prefer the user's own wording where present — don't paraphrase if their phrasing is already tight.
- Exclude: post-meeting follow-ups, topics the user explicitly marks as hold-back / don't-raise / ask-after-the-call, attendee lists, scheduling or logistics metadata, the user's own scoring or evaluation criteria, and general commentary.
- If the input is already a clean one-per-line list, return those items as-is.
- If the user clearly wrote fewer than 5 items, return what they wrote — don't invent.

Respond with JSON only. No prose, no code fences.`;

function buildAgendaExtractPrompt(raw: string): string {
  return `<notes>
${raw}
</notes>

Respond with JSON:
{ "items": ["short phrase 1", "short phrase 2", ...] }`;
}

/**
 * Extract a list of trackable agenda items from freeform notes.
 *
 * Uses Sonnet via claudeChat() — the extraction is user-initiated, one-shot,
 * and benefits from the larger/stricter model. Retries once on schema failure
 * before giving up. Normalizes, dedupes (case-insensitive), caps at 20.
 *
 * Returns `[]` for empty input (no LLM call) and for unrecoverable parse
 * failures.
 */
export async function extractAgendaItemsFromNotes(
  raw: string,
  deps: ExtractAgendaDeps = {},
): Promise<string[]> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];

  const chat = deps.chat ?? (claudeChat as ChatFn);
  const signal = deps.signal;

  const firstPrompt = buildAgendaExtractPrompt(trimmed);
  let response: string;
  try {
    response = await chat(firstPrompt, {
      systemPrompt: AGENDA_EXTRACT_SYSTEM,
      model: 'claude-sonnet-4-6',
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'Aborted') throw err;
    throw new Error(
      `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed = parseExtractResponse(response);
  if (!parsed) {
    // One retry with a clarifying follow-up.
    const retryPrompt = `${firstPrompt}

Your previous reply was not valid JSON matching the required shape. Return JSON only, with no prose and no code fences:
{ "items": ["..."] }`;
    try {
      const retry = await chat(retryPrompt, {
        systemPrompt: AGENDA_EXTRACT_SYSTEM,
        model: 'claude-sonnet-4-6',
        signal,
      });
      parsed = parseExtractResponse(retry);
    } catch (err) {
      if (err instanceof Error && err.message === 'Aborted') throw err;
      // Retry call failed — fall through to empty result.
    }
  }

  if (!parsed) return [];
  return normalizeExtractedItems(parsed);
}

/**
 * Parses the raw model response into a string[] of raw item text, or null if
 * the response doesn't match the expected shape. Handles:
 *   - bare JSON objects
 *   - ```json fenced code blocks
 *   - leading/trailing prose around a JSON object
 */
export function parseExtractResponse(raw: string): string[] | null {
  if (!raw || typeof raw !== 'string') return null;

  // Strip ```json / ``` fences if present.
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;

  const out: string[] = [];
  for (const entry of items) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim();
    if (!text) continue;
    if (text.length > EXTRACT_ITEM_MAX_CHARS) continue;
    out.push(text);
  }
  return out;
}

/**
 * Normalize a raw extracted list: strip bullet/number prefixes, trim trailing
 * punctuation, collapse whitespace, dedupe case-insensitively on the result,
 * cap at EXTRACT_MAX_ITEMS.
 */
export function normalizeExtractedItems(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw
      .replace(BULLET_PREFIX_RE, '')
      .replace(NUMBERED_PREFIX_RE, '')
      .replace(/\s+/g, ' ')
      .replace(TRAILING_PUNCTUATION_RE, '')
      .trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= EXTRACT_MAX_ITEMS) break;
  }
  return out;
}
