export class LlmBudgetExceededError extends Error {
  readonly code: string = 'LLM_BUDGET_EXCEEDED';
  /** Which ceiling tripped, with its numbers — e.g. `dollars 10.02/10`. */
  readonly limit: string;

  constructor(message: string, limit: string) {
    super(message);
    this.limit = limit;
  }
}

/**
 * A runaway-loop pause, not a lockout: the per-minute window is full, and the
 * next call after it drains goes through. Subclasses the budget error so every
 * caller that skips a tick on the budget (rather than failing over to another
 * provider, or disabling the API for two minutes) does the same here.
 */
export class LlmRateLimitedError extends LlmBudgetExceededError {
  override readonly code = 'LLM_RATE_LIMITED';
}

function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ─── The one lifetime stop: dollars ─────────────────────────────────────────
//
// Only dollars end a session's AI. Request and token counts used to be
// lifetime ceilings too, and each became the binding stop in turn — the named
// class is "a non-dollar ceiling binds before the dollar one":
//   2026-07-31  tokens 300k/300k at minute 8 of 50, $0.32 spent.
//   2026-09-14  requests 500/500 at minute 32 of 38.
//   2026-09-21  requests 500/500 at minute 26 of 33, ~$0.68 spent.
// The 2M token ceiling that replaced 300k assumed ~6k tokens/min; the 09-21
// call ran ~36k/min, so it would have stopped that meeting at minute ~55.
// Both remain available as opt-in lifetime caps, and default to off.
const maxDollars = envLimit('COPILOT_MAX_LLM_DOLLARS_PER_SESSION', 10);
const maxRequests = envLimit('COPILOT_MAX_LLM_REQUESTS_PER_SESSION', Infinity);
const maxTokens = envLimit('COPILOT_MAX_LLM_TOKENS_PER_SESSION', Infinity);

// ─── Runaway detection: a one-minute window ─────────────────────────────────
//
// What the count ceilings were really for is catching a loop, and a loop is a
// RATE. Measured on real meetings: 15–17 requests/min median, 36 peak; 31–43k
// tokens/min median, 153k peak. The windows sit ~7x and ~13x above those
// peaks, so they never touch a meeting, and a loop is capped at that rate
// while the dollar ceiling does the stopping.
const maxRequestsPerMinute = envLimit('COPILOT_MAX_LLM_REQUESTS_PER_MINUTE', 240);
const maxTokensPerMinute = envLimit('COPILOT_MAX_LLM_TOKENS_PER_MINUTE', 2_000_000);
const WINDOW_MS = 60_000;

let requests = 0;
let tokens = 0;
let estimatedDollars = 0;
let recentRequests: number[] = [];
let recentTokens: Array<{ at: number; tokens: number }> = [];

// One-shot lockout reporting. The 2026-07-31 session logged the same budget
// error 726 times while the dashboard showed nothing a user could act on, so
// the handler fires exactly once per session and the caller is expected to say
// something durable rather than emit another transient error toast. A rate
// pause is not a lockout and never fires it.
let onExceeded: ((limit: string) => void) | null = null;
let reportedExceeded = false;

export function setLlmBudgetExceededHandler(handler: (limit: string) => void): void {
  onExceeded = handler;
}

export function resetLlmBudget(): void {
  requests = 0;
  tokens = 0;
  estimatedDollars = 0;
  recentRequests = [];
  recentTokens = [];
  reportedExceeded = false;
}

function pruneWindow(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (recentRequests.length > 0 && recentRequests[0]! <= cutoff) recentRequests.shift();
  while (recentTokens.length > 0 && recentTokens[0]!.at <= cutoff) recentTokens.shift();
}

function tokensLastMinute(): number {
  return recentTokens.reduce((sum, e) => sum + e.tokens, 0);
}

/**
 * Which lifetime ceiling (if any) is exhausted.
 *
 * Returns a human-readable `name current/max` string rather than a bare enum so
 * the number lands in the log and the dashboard. Diagnosing the 2026-07-31
 * lockout required querying /debug precisely because the error said only
 * "Per-session LLM budget reached".
 */
function exceededLimit(): string | null {
  if (estimatedDollars >= maxDollars) {
    return `dollars ${estimatedDollars.toFixed(2)}/${maxDollars}`;
  }
  if (requests >= maxRequests) return `requests ${requests}/${maxRequests}`;
  if (tokens >= maxTokens) return `tokens ${tokens}/${maxTokens}`;
  return null;
}

function exceededRate(): string | null {
  if (recentRequests.length >= maxRequestsPerMinute) {
    return `requests ${recentRequests.length}/${maxRequestsPerMinute} per minute`;
  }
  const t = tokensLastMinute();
  if (t >= maxTokensPerMinute) return `tokens ${t}/${maxTokensPerMinute} per minute`;
  return null;
}

export function beginLlmRequest(): void {
  const limit = exceededLimit();
  if (limit) {
    if (!reportedExceeded) {
      reportedExceeded = true;
      // Never let reporting break the guard itself — the throw below is the
      // contract every call site depends on.
      try {
        onExceeded?.(limit);
      } catch {
        /* ignore */
      }
    }
    throw new LlmBudgetExceededError(`Per-session LLM budget reached (${limit})`, limit);
  }
  const now = Date.now();
  pruneWindow(now);
  const rate = exceededRate();
  if (rate) {
    throw new LlmRateLimitedError(`LLM rate limit — possible runaway loop, pausing (${rate})`, rate);
  }
  requests += 1;
  recentRequests.push(now);
}

export function recordLlmUsage(params: {
  inputTokens: number;
  outputTokens: number;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  /** Per-call fees that are not tokens, e.g. OpenAI's per-search charge. */
  extraDollars?: number;
}): void {
  const used = params.inputTokens + params.outputTokens;
  tokens += used;
  recentTokens.push({ at: Date.now(), tokens: used });
  estimatedDollars +=
    (params.inputTokens * params.inputDollarsPerMillion
      + params.outputTokens * params.outputDollarsPerMillion) / 1_000_000
    + (params.extraDollars ?? 0);
}

export function getLlmBudgetSnapshot() {
  pruneWindow(Date.now());
  // JSON has no Infinity; an unset lifetime cap reads as null in /debug.
  const cap = (n: number) => (Number.isFinite(n) ? n : null);
  return {
    requests,
    tokens,
    estimatedDollars,
    maxDollars,
    maxRequests: cap(maxRequests),
    maxTokens: cap(maxTokens),
    requestsLastMinute: recentRequests.length,
    tokensLastMinute: tokensLastMinute(),
    maxRequestsPerMinute,
    maxTokensPerMinute,
  };
}
