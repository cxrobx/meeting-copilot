export class LlmBudgetExceededError extends Error {
  readonly code = 'LLM_BUDGET_EXCEEDED';
}

// Two live lanes can legitimately exceed 120 calls in an hour even with local
// gating (agenda reconciliation alone can run 120 times). Token and dollar
// ceilings remain the primary spend guards; this cap catches runaway loops.
const maxRequests = Number(process.env.COPILOT_MAX_LLM_REQUESTS_PER_SESSION || 500);
const maxTokens = Number(process.env.COPILOT_MAX_LLM_TOKENS_PER_SESSION || 300_000);
const maxDollars = Number(process.env.COPILOT_MAX_LLM_DOLLARS_PER_SESSION || 10);

let requests = 0;
let tokens = 0;
let estimatedDollars = 0;

export function resetLlmBudget(): void {
  requests = 0;
  tokens = 0;
  estimatedDollars = 0;
}

export function beginLlmRequest(): void {
  if (requests >= maxRequests || tokens >= maxTokens || estimatedDollars >= maxDollars) {
    throw new LlmBudgetExceededError('Per-session LLM budget reached');
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
