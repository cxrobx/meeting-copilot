import { beforeEach, describe, expect, it, vi } from 'vitest';

// The answerer picks between the metered API and the subscription CLI; both
// are faked here so no call leaves the machine.
const openai = vi.hoisted(() => ({ available: true, stream: vi.fn() }));
const cli = vi.hoisted(() => ({ suggest: vi.fn() }));

vi.mock('../api/openai.js', () => ({
  isOpenAiApiAvailable: () => openai.available,
  openaiFastResearchStream: openai.stream,
}));
vi.mock('../claude-cli.js', () => ({ claudeSuggest: cli.suggest }));

const { defaultChatAnswerer } = await import('../chat/service.js');
const { MODEL_CONFIG } = await import('../model-config.js');
const { CHAT_NO_TASK_TOOL, DRAFT_TASK_TOOL } = await import('../chat/context.js');

function request(deltas: string[] = []) {
  return {
    system: 'SYSTEM + meeting',
    history: [{ role: 'user' as const, content: 'first' }, { role: 'assistant' as const, content: 'one' }],
    user: 'and then?',
    signal: new AbortController().signal,
    onDelta: (t: string) => deltas.push(t),
    label: 'chat',
  };
}

describe('defaultChatAnswerer', () => {
  beforeEach(() => {
    openai.available = true;
    openai.stream.mockReset();
    cli.suggest.mockReset();
  });

  it('answers on the metered path with the chat model, history and web search', async () => {
    openai.stream.mockImplementation(async (p: any) => { p.onDelta('Zero.'); return { text: 'Zero.', sources: [{ url: 'u', title: 't' }] }; });
    const deltas: string[] = [];
    const out = await defaultChatAnswerer()(request(deltas));
    expect(out).toEqual({ text: 'Zero.', sources: [{ url: 'u', title: 't' }], via: MODEL_CONFIG.chat });
    expect(openai.stream.mock.calls[0]![0]).toMatchObject({ model: MODEL_CONFIG.chat, systemPrompt: 'SYSTEM + meeting', userContent: 'and then?', history: request().history });
    expect(deltas).toEqual(['Zero.']);
    expect(cli.suggest).not.toHaveBeenCalled();
  });

  it('offers draft_task and hands its calls back as task drafts, never anything else it called', async () => {
    const draft = { title: 'Send Rory the deck', notes: 'n', priority: 2, due: '2026-10-09', people: ['Rory'] };
    openai.stream.mockResolvedValue({ text: 'Drafted it.', sources: [], calls: [{ name: 'draft_task', arguments: draft }, { name: 'other', arguments: {} }] });
    const out = await defaultChatAnswerer()(request());
    expect(openai.stream.mock.calls[0]![0].functions).toEqual([DRAFT_TASK_TOOL]);
    expect(out.taskDrafts).toEqual([draft]);
  });

  it('falls back to the subscription CLI when the API fails before its first word', async () => {
    openai.stream.mockRejectedValue(new Error('Per-session LLM budget reached ($10)'));
    cli.suggest.mockResolvedValue('From the CLI.');
    const logs: string[] = [];
    const out = await defaultChatAnswerer((m) => logs.push(m))(request());
    expect(out).toEqual({ text: 'From the CLI.', sources: [], via: MODEL_CONFIG.worker });
    const [prompt, system, , tools, opts] = cli.suggest.mock.calls[0]!;
    expect(prompt).toBe('Our conversation so far:\nUser: first\n\nYou: one\n\nNow:\nand then?');
    expect(system).toBe(`SYSTEM + meeting\n\n${CHAT_NO_TASK_TOOL}`);
    expect(tools).toEqual(['WebSearch', 'WebFetch']);
    expect(opts).toMatchObject({ cold: true, model: MODEL_CONFIG.worker });
    expect(logs[0]).toContain('budget reached');
  });

  it('uses the CLI straight away when the API is off', async () => {
    openai.available = false;
    cli.suggest.mockResolvedValue('CLI.');
    expect((await defaultChatAnswerer()(request())).via).toBe(MODEL_CONFIG.worker);
    expect(openai.stream).not.toHaveBeenCalled();
  });

  it('reports a failure mid-answer instead of starting over on the CLI', async () => {
    openai.stream.mockImplementation(async (p: any) => { p.onDelta('Half'); throw new Error('socket hang up'); });
    await expect(defaultChatAnswerer()(request())).rejects.toThrow('socket hang up');
    expect(cli.suggest).not.toHaveBeenCalled();
  });
});
