import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake OpenAI client whose stream ends the way an aborted one does: text,
// then nothing, no `response.completed` and so no usage.
const events = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock('openai', () => ({
  default: class {
    responses = {
      create: async () => ({
        async *[Symbol.asyncIterator]() {
          for (const e of events.list) yield e;
        },
      }),
    };
  },
}));

const { openaiFastResearchStream, estimatedUsage } = await import('../api/openai.js');
const { getLlmBudgetSnapshot, resetLlmBudget } = await import('../api/budget.js');

describe('fast research stream usage', () => {
  beforeEach(() => {
    resetLlmBudget();
    process.env.OPENAI_API_KEY = 'test';
  });

  it('counts a stream that ended without its usage (Stop) instead of billing it as free', async () => {
    events.list = [{ type: 'response.output_text.delta', delta: 'Half an answer' }];
    const system = 'x'.repeat(3_000);
    await openaiFastResearchStream({ systemPrompt: system, userContent: 'q', history: [{ role: 'user', content: 'earlier' }], label: 'chat' });
    const snap = getLlmBudgetSnapshot();
    expect(snap.tokens).toBe(estimatedUsage(3_000 + 1 + 7, 'Half an answer'.length).input_tokens + estimatedUsage(0, 14).output_tokens);
    expect(snap.estimatedDollars).toBeGreaterThan(0);
  });

  it('uses the reported usage when the stream completes', async () => {
    events.list = [
      { type: 'response.output_text.delta', delta: 'Done.' },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 5 }, output: [] } },
    ];
    await openaiFastResearchStream({ systemPrompt: 's', userContent: 'q' });
    expect(getLlmBudgetSnapshot().tokens).toBe(105);
  });
});
