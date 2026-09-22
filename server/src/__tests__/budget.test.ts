import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  beginLlmRequest,
  recordLlmUsage,
  resetLlmBudget,
  getLlmBudgetSnapshot,
  setLlmBudgetExceededHandler,
  LlmBudgetExceededError,
  LlmRateLimitedError,
} from '../api/budget.js';

const LUNA = { inputDollarsPerMillion: 0.1, outputDollarsPerMillion: 0.5 };

/** One metered call: begin (the guard) then record its usage. */
function call(inputTokens: number, outputTokens = 60, prices = LUNA): void {
  beginLlmRequest();
  recordLlmUsage({ inputTokens, outputTokens, ...prices });
}

describe('per-session LLM budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T21:00:00Z'));
    resetLlmBudget();
    setLlmBudgetExceededHandler(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never stops a 90-minute meeting at the busiest rate a real one has run', () => {
    // Class: "a non-dollar ceiling binds before the dollar one". It ended the
    // 07-31 call at minute 8 (tokens), 09-14 at 32 (requests) and 09-21 at 26
    // (requests). Peak measured minute: 36 requests, 153k tokens. Run that
    // peak for every one of 90 minutes, on the live lanes' gpt-6-luna prices.
    const handler = vi.fn();
    setLlmBudgetExceededHandler(handler);
    for (let minute = 0; minute < 90; minute++) {
      for (let i = 0; i < 36; i++) {
        expect(() => call(4_250)).not.toThrow();
        vi.advanceTimersByTime(60_000 / 36);
      }
    }
    const snap = getLlmBudgetSnapshot();
    expect(snap.requests).toBe(90 * 36); // 3,240 — six times the old 500 cap
    expect(snap.tokens).toBeGreaterThan(13_000_000); // six times the old 2M cap
    expect(snap.estimatedDollars).toBeLessThan(snap.maxDollars);
    expect(handler).not.toHaveBeenCalled();
  });

  it('has no lifetime request or token ceiling by default', () => {
    const snap = getLlmBudgetSnapshot();
    expect(snap.maxRequests).toBeNull();
    expect(snap.maxTokens).toBeNull();
    expect(snap.maxDollars).toBe(10);
  });

  it('pauses a runaway request loop, and resumes once the minute drains', () => {
    const { maxRequestsPerMinute } = getLlmBudgetSnapshot();
    for (let i = 0; i < maxRequestsPerMinute; i++) call(100);
    expect(() => beginLlmRequest()).toThrow(LlmRateLimitedError);
    // A pause is still a budget error, so callers skip the tick instead of
    // failing over to another provider.
    expect(() => beginLlmRequest()).toThrow(LlmBudgetExceededError);

    vi.advanceTimersByTime(60_001);
    expect(() => call(100)).not.toThrow();
  });

  it('pauses a runaway context loop on tokens per minute', () => {
    const { maxTokensPerMinute } = getLlmBudgetSnapshot();
    call(maxTokensPerMinute);
    expect(() => beginLlmRequest()).toThrow(/tokens \d+\/\d+ per minute/);
    vi.advanceTimersByTime(60_001);
    expect(() => beginLlmRequest()).not.toThrow();
  });

  it('never reports a rate pause as a session lockout', () => {
    const handler = vi.fn();
    setLlmBudgetExceededHandler(handler);
    const { maxRequestsPerMinute } = getLlmBudgetSnapshot();
    for (let i = 0; i < maxRequestsPerMinute; i++) call(100);
    for (let i = 0; i < 20; i++) expect(() => beginLlmRequest()).toThrow(LlmRateLimitedError);
    // The dashboard pins "stopped for this session" on this handler; a pause
    // that clears in a minute must not claim that.
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not count a paused request', () => {
    const { maxRequestsPerMinute } = getLlmBudgetSnapshot();
    for (let i = 0; i < maxRequestsPerMinute; i++) call(100);
    expect(() => beginLlmRequest()).toThrow();
    expect(getLlmBudgetSnapshot().requests).toBe(maxRequestsPerMinute);
  });

  it('stops at the dollar ceiling, naming it with its numbers', () => {
    const { maxDollars } = getLlmBudgetSnapshot();
    recordLlmUsage({ inputTokens: 1_000_000, outputTokens: 0, inputDollarsPerMillion: maxDollars, outputDollarsPerMillion: 0 });
    // Diagnosing the original lockout required a /debug query precisely because
    // the message was generic. The numbers belong in the error.
    expect(() => beginLlmRequest()).toThrow(`dollars ${maxDollars.toFixed(2)}/${maxDollars}`);
    expect(() => beginLlmRequest()).not.toThrow(LlmRateLimitedError);
  });

  it('reports the lockout exactly once per session', () => {
    const handler = vi.fn();
    setLlmBudgetExceededHandler(handler);
    recordLlmUsage({ inputTokens: 1_000_000, outputTokens: 0, inputDollarsPerMillion: 10, outputDollarsPerMillion: 0 });

    for (let i = 0; i < 50; i++) {
      expect(() => beginLlmRequest()).toThrow(LlmBudgetExceededError);
    }

    // 726 identical broadcasts is what the user saw as "nothing happened".
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.stringContaining('dollars'));
  });

  it('re-arms the one-shot report on the next session', () => {
    const handler = vi.fn();
    setLlmBudgetExceededHandler(handler);
    const spendAll = () => recordLlmUsage({ inputTokens: 1_000_000, outputTokens: 0, inputDollarsPerMillion: 10, outputDollarsPerMillion: 0 });

    spendAll();
    expect(() => beginLlmRequest()).toThrow();
    expect(handler).toHaveBeenCalledTimes(1);

    resetLlmBudget();
    spendAll();
    expect(() => beginLlmRequest()).toThrow();
    // A fresh meeting must warn again, or the second one fails silently.
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('resets every counter and the rate window between sessions', () => {
    const { maxRequestsPerMinute } = getLlmBudgetSnapshot();
    for (let i = 0; i < maxRequestsPerMinute; i++) call(100);
    resetLlmBudget();
    const snap = getLlmBudgetSnapshot();
    expect(snap.tokens).toBe(0);
    expect(snap.requests).toBe(0);
    expect(snap.estimatedDollars).toBe(0);
    expect(snap.requestsLastMinute).toBe(0);
    expect(() => beginLlmRequest()).not.toThrow();
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

describe('opt-in lifetime count ceilings', () => {
  afterEach(() => {
    delete process.env.COPILOT_MAX_LLM_REQUESTS_PER_SESSION;
    vi.resetModules();
  });

  it('still honours COPILOT_MAX_LLM_REQUESTS_PER_SESSION when set explicitly', async () => {
    process.env.COPILOT_MAX_LLM_REQUESTS_PER_SESSION = '3';
    vi.resetModules();
    const budget = await import('../api/budget.js');
    budget.resetLlmBudget();
    budget.setLlmBudgetExceededHandler(() => {});
    for (let i = 0; i < 3; i++) budget.beginLlmRequest();
    expect(() => budget.beginLlmRequest()).toThrow(/requests 3\/3/);
  });
});
