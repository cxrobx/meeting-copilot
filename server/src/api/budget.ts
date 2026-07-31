export class LlmBudgetExceededError extends Error {
  readonly code = 'LLM_BUDGET_EXCEEDED';
  /** Which ceiling tripped, with its numbers — e.g. `tokens 302793/300000`. */
  readonly limit: string;

  constructor(message: string, limit: string) {
    super(message);
    this.limit = limit;
  }
}

// Two live lanes can legitimately exceed 120 calls in an hour even with local
// gating (agenda reconciliation alone can run 120 times). Token and dollar
// ceilings remain the primary spend guards; this cap catches runaway loops.
const maxRequests = Number(process.env.COPILOT_MAX_LLM_REQUESTS_PER_SESSION || 500);

// Dollars is the ceiling that actually reflects spend; tokens is a coarse
// backstop for a runaway context loop. Keep them calibrated so DOLLARS binds
// first, or the copilot goes silent long before it has cost anything.
//
// This was 300_000 and it was badly miscalibrated after the 2026-07-30 OpenAI
// price cut: the 2026-07-31 session tripped the token ceiling 8 minutes into a
// 50-minute meeting having spent $0.32 of the $10 allowance — 3% of budget, and
// every suggestion, agenda reconcile and coach turn was dead for the remaining
// 42 minutes. Measured rate on that session was ~6k tokens/min (~$0.0064/min),
// so 2M tokens covers a ~5.5-hour meeting and still lands near $2 — comfortably
// inside the dollar cap, which is where the real stop should come from.
const maxTokens = Number(process.env.COPILOT_MAX_LLM_TOKENS_PER_SESSION || 2_000_000);
const maxDollars = Number(process.env.COPILOT_MAX_LLM_DOLLARS_PER_SESSION || 10);

let requests = 0;
let tokens = 0;
let estimatedDollars = 0;

// One-shot lockout reporting. The 2026-07-31 session logged the same budget
// error 726 times while the dashboard showed nothing a user could act on, so
// the handler fires exactly once per session and the caller is expected to say
// something durable rather than emit another transient error toast.
let onExceeded: ((limit: string) => void) | null = null;
let reportedExceeded = false;

export function setLlmBudgetExceededHandler(handler: (limit: string) => void): void {
  onExceeded = handler;
}

export function resetLlmBudget(): void {
  requests = 0;
  tokens = 0;
  estimatedDollars = 0;
  reportedExceeded = false;
}

/**
 * Which ceiling (if any) is currently exhausted.
 *
 * Returns a human-readable `name current/max` string rather than a bare enum so
 * the number lands in the log and the dashboard. Diagnosing the 2026-07-31
 * lockout required querying /debug precisely because the error said only
 * "Per-session LLM budget reached".
 */
function exceededLimit(): string | null {
  if (requests >= maxRequests) return `requests ${requests}/${maxRequests}`;
  if (tokens >= maxTokens) return `tokens ${tokens}/${maxTokens}`;
  if (estimatedDollars >= maxDollars) {
    return `dollars ${estimatedDollars.toFixed(2)}/${maxDollars}`;
  }
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
  requests += 1;
}

export function recordLlmUsage(params: {
  inputTokens: number;
  outputTokens: number;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
}): void {
  tokens += params.inputTokens + params.outputTokens;
  estimatedDollars +=
    (params.inputTokens * params.inputDollarsPerMillion
      + params.outputTokens * params.outputDollarsPerMillion) / 1_000_000;
}

export function getLlmBudgetSnapshot() {
  return { requests, tokens, estimatedDollars, maxRequests, maxTokens, maxDollars };
}
