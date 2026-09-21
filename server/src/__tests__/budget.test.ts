import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  beginLlmRequest,
  recordLlmUsage,
  resetLlmBudget,
  getLlmBudgetSnapshot,
  setLlmBudgetExceededHandler,
  LlmBudgetExceededError,
} from '../api/budget.js';

/** Spend `tokens` at a price that keeps the dollar ceiling well clear. */
function burnTokens(tokens: number): void {
  recordLlmUsage({
    inputTokens: tokens,
    outputTokens: 0,
    inputDollarsPerMillion: 1,
    outputDollarsPerMillion: 1,
  });
}

describe('per-session LLM budget', () => {
  beforeEach(() => {
    resetLlmBudget();
    setLlmBudgetExceededHandler(() => {});
  });

  it('lets dollars bind before tokens at realistic spend rates', () => {
    // The 2026-07-31 regression: a 50-minute meeting burned 302,793 tokens for
    // $0.32 and got locked out 8 minutes in. That much usage must now pass
    // freely — the token ceiling is a runaway-loop backstop, not the throttle.
    burnTokens(302_793);
    expect(() => beginLlmRequest()).not.toThrow();

    const snap = getLlmBudgetSnapshot();
    expect(snap.tokens).toBe(302_793);
    expect(snap.tokens).toBeLessThan(snap.maxTokens);
  });

  it('still stops a runaway context loop at the token ceiling', () => {
    const { maxTokens } = getLlmBudgetSnapshot();
    burnTokens(maxTokens);
    expect(() => beginLlmRequest()).toThrow(LlmBudgetExceededError);
  });

  it('names the ceiling that tripped, with its numbers', () => {
    const { maxTokens } = getLlmBudgetSnapshot();
    burnTokens(maxTokens);
    // Diagnosing the original lockout required a /debug query precisely because
    // the message was generic. The numbers belong in the error.
    expect(() => beginLlmRequest()).toThrow(new RegExp(`tokens ${maxTokens}/${maxTokens}`));
  });

  it('reports the lockout exactly once per session', () => {
    const handler = vi.fn();
    setLlmBudgetExceededHandler(handler);
    burnTokens(getLlmBudgetSnapshot().maxTokens);

    for (let i = 0; i < 50; i++) {
      expect(() => beginLlmRequest()).toThrow(LlmBudgetExceededError);
    }

    // 726 identical broadcasts is what the user saw as "nothing happened".
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.stringContaining('tokens'));
  });

  it('re-arms the one-shot report on the next session', () => {
    const handler = vi.fn();
    setLlmBudgetExceededHandler(handler);

    burnTokens(getLlmBudgetSnapshot().maxTokens);
    expect(() => beginLlmRequest()).toThrow();
    expect(handler).toHaveBeenCalledTimes(1);

    resetLlmBudget();
    burnTokens(getLlmBudgetSnapshot().maxTokens);
    expect(() => beginLlmRequest()).toThrow();
    // A fresh meeting must warn again, or the second one fails silently.
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not count a rejected request against the request ceiling', () => {
    burnTokens(getLlmBudgetSnapshot().maxTokens);
    expect(() => beginLlmRequest()).toThrow();
    // The throw happens before the increment, so a locked-out session must not
    // keep inflating `requests` — the /debug snapshot is a diagnostic record of
    // where spend actually stopped.
    expect(getLlmBudgetSnapshot().requests).toBe(0);
  });

  it('reports the dollar ceiling when dollars are what ran out', () => {
    const { maxDollars } = getLlmBudgetSnapshot();
    recordLlmUsage({
      inputTokens: 1_000_000,
      outputTokens: 0,
      inputDollarsPerMillion: maxDollars,
      outputDollarsPerMillion: 0,
    });
    expect(() => beginLlmRequest()).toThrow(/dollars/);
  });

  it('resets every counter between sessions', () => {
    burnTokens(1000);
    beginLlmRequest();
    resetLlmBudget();
    const snap = getLlmBudgetSnapshot();
    expect(snap.tokens).toBe(0);
    expect(snap.requests).toBe(0);
    expect(snap.estimatedDollars).toBe(0);
  });

  it('counts per-call fees (web search) toward the dollar ceiling, not the token one', () => {
    // A searched fast-research answer: ~17k tokens of mostly search content,
    // plus two billed searches. The fee is most of its cost.
    recordLlmUsage({
      inputTokens: 16_942,
      outputTokens: 220,
      inputDollarsPerMillion: 0.2,
      outputDollarsPerMillion: 1.2,
      extraDollars: 2 * 0.01,
    });
    const snap = getLlmBudgetSnapshot();
    expect(snap.tokens).toBe(17_162);
    expect(snap.estimatedDollars).toBeCloseTo(0.0036528 + 0.02, 6);
  });
});
