import { EventEmitter } from 'node:events';
import { claudeTriage } from '../claude-cli.js';

const EVAL_INTERVAL_MS = 30_000;
const MIN_NEW_WORDS_BEFORE_EVAL = 25;

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
    this.triage = deps.triage ?? claudeTriage;
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
    if (!this.running || this.currentEval || this.items.length === 0) return;

    const currentWordCount = this.wordCountProvider();
    if (currentWordCount - this.lastEvalWordCount < MIN_NEW_WORDS_BEFORE_EVAL) {
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
    try {
      const prompt = buildAgendaEvalPrompt(this.items, transcript, this.sessionTitle);
      const raw = await this.triage(prompt, AGENDA_EVAL_SYSTEM, signal);

      // Stale-guard: drop the result if the session changed while we awaited.
      if (gen !== this.generation) return;

      const parsed = parseAgendaResponse(raw);
      if (!parsed) return;

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

      if (changed) {
        this.emit('status', this.getStatus());
      }
    } catch (err) {
      if (gen !== this.generation) return; // session changed — swallow silently
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Aborted') return;
      this.emit('error', msg);
    }
  }
}

const AGENDA_EVAL_SYSTEM = `You track whether a meeting is covering its planned agenda items. You read the full transcript so far and the agenda list, and mark each item as covered, partially addressed, or still pending. You also flag items that seem to be running out of time to discuss.

Rules:
- "covered" = the topic was genuinely discussed (not just mentioned in passing). Evidence must exist in the transcript.
- "partial" = touched briefly but not fully addressed, or only one speaker discussed it.
- "pending" = not yet discussed at all.
- Be lenient on wording — the transcript uses everyday language; the agenda may use shorthand. Match by intent.
- Evidence must be a short direct quote from the transcript (under 120 chars).
- Only produce missing_warnings if the transcript shows the meeting is wrapping up (wrap-up/summary/farewell language) AND items remain pending.

Respond with JSON only. No other text.`;

function buildAgendaEvalPrompt(
  items: AgendaItem[],
  transcript: string,
  sessionTitle: string,
): string {
  const agendaList = items.map((i) => `  ${i.id}: ${i.text}`).join('\n');
  const titleLine = sessionTitle ? `Meeting: ${sessionTitle}\n\n` : '';
  return `${titleLine}Agenda items to track:
${agendaList}

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
