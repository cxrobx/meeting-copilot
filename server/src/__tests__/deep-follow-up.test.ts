import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DeepFollowUp, PENDING_NOTE, renderAddendum, withAddendum, type DeepFollowUpDeps } from '../workers/deep-follow-up.js';
import type { ActionLifecycle, WorkerResult } from '../workers/types.js';

/** The registry surface DeepFollowUp uses, with replaceActionResult behaving like the real one. */
class FakeRegistry extends EventEmitter {
  actions = new Map<string, ActionLifecycle>();
  getAction(id: string) { return this.actions.get(id); }
  replaceActionResult(id: string, result: WorkerResult) {
    const action = this.actions.get(id);
    if (!action || action.state !== 'completed') return;
    action.result = result;
    this.emit('action.status', action);
  }
  set(id: string, patch: Partial<ActionLifecycle>) {
    const action = { ...(this.actions.get(id) ?? baseAction(id)), ...patch } as ActionLifecycle;
    this.actions.set(id, action);
    this.emit('action.status', action);
    return action;
  }
}

function baseAction(id: string, params: Record<string, any> = { query: 'best video APIs?', context: 'ctx' }): ActionLifecycle {
  return {
    id, type: 'fast-research', title: 't', description: '', triggerQuote: '', estimatedDurationSec: 5,
    params, state: 'approved', createdAt: 0, timeoutMs: 1, retryCount: 0, cancelController: new AbortController(),
  };
}

const fastResult: WorkerResult = {
  success: true,
  data: { query: 'best video APIs?', answer: 'Runway.', findings: 'Runway.\n\n---\n**Sources**' },
  summary: 'ok',
  artifacts: [{ type: 'markdown', content: 'Runway.\n\n---\n**Sources**' }],
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(overrides: Partial<DeepFollowUpDeps> = {}) {
  const registry = new FakeRegistry();
  const deep = deferred<WorkerResult>();
  const deps: DeepFollowUpDeps = {
    runDeep: vi.fn(() => deep.promise),
    compare: vi.fn(async () => '- Kling is cheaper ([fal](https://fal.ai)).'),
    ...overrides,
  };
  const follow = new DeepFollowUp(registry, deps);
  return { registry, deep, deps, follow };
}

const card = (r: FakeRegistry) => r.actions.get('a1')!.result!.artifacts![0]!.content;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('DeepFollowUp', () => {
  it('starts deep when the fast card starts, shows the note on completion, then appends what deep adds', async () => {
    const { registry, deep, deps } = setup();
    registry.set('a1', { state: 'running' });
    expect(deps.runDeep).toHaveBeenCalledWith({ query: 'best video APIs?', context: 'ctx' }, expect.any(AbortSignal));

    registry.set('a1', { state: 'completed', result: fastResult });
    expect(card(registry)).toContain(PENDING_NOTE);

    deep.resolve({ success: true, data: { answer: 'Kling 3.0 at $0.07/s.', sources: [] }, summary: 'ok' });
    await flush(); await flush();
    expect(deps.compare).toHaveBeenCalledWith({ query: 'best video APIs?', fast: 'Runway.', deep: 'Kling 3.0 at $0.07/s.' }, expect.any(AbortSignal));
    expect(card(registry)).toContain('### Deep research adds\n- Kling is cheaper');
    expect(card(registry)).not.toContain(PENDING_NOTE);
    expect(card(registry).startsWith('Runway.')).toBe(true);
  });

  it('removes the note and adds nothing when deep adds nothing', async () => {
    const { registry, deep } = setup({ compare: async () => 'NOTHING' });
    registry.set('a1', { state: 'running' });
    registry.set('a1', { state: 'completed', result: fastResult });
    deep.resolve({ success: true, data: { answer: 'Runway.', sources: [] }, summary: 'ok' });
    await flush(); await flush();
    expect(card(registry)).toBe(fastResult.artifacts![0]!.content);
  });

  it('restores the fast answer when deep fails', async () => {
    const { registry, deep, deps } = setup();
    registry.set('a1', { state: 'running' });
    registry.set('a1', { state: 'completed', result: fastResult });
    deep.resolve({ success: false, data: null, summary: 'Research failed', error: 'boom' });
    await flush(); await flush();
    expect(deps.compare).not.toHaveBeenCalled();
    expect(card(registry)).toBe(fastResult.artifacts![0]!.content);
  });

  it('aborts deep when the card is cancelled', () => {
    let signal: AbortSignal | undefined;
    const { registry } = setup({ runDeep: (_p, s) => { signal = s; return new Promise(() => {}); } });
    registry.set('a1', { state: 'running' });
    registry.set('a1', { state: 'cancelled' });
    expect(signal?.aborted).toBe(true);
  });

  it('skips other worker types, and turned-off mode', () => {
    const { registry, deps } = setup();
    registry.actions.set('r', { ...baseAction('r'), type: 'research' });
    registry.set('r', { state: 'running' });
    expect(deps.runDeep).not.toHaveBeenCalled();

    const off = setup({ enabled: () => false });
    off.registry.set('a1', { state: 'running' });
    expect(off.deps.runDeep).not.toHaveBeenCalled();
  });

  it('caps concurrent deep runs', () => {
    const { registry, deps, follow } = setup({ maxConcurrent: 2 });
    for (const id of ['a', 'b', 'c']) registry.set(id, { state: 'running' });
    expect(deps.runDeep).toHaveBeenCalledTimes(2);
    expect(follow.activeCount).toBe(2);
  });

  it('starts deep once, however many running updates arrive', () => {
    const { registry, deps } = setup();
    registry.set('a1', { state: 'running' });
    registry.set('a1', { state: 'running' });
    expect(deps.runDeep).toHaveBeenCalledTimes(1);
  });
});

describe('renderAddendum / withAddendum', () => {
  it('treats NOTHING as no addendum', () => {
    expect(renderAddendum('NOTHING', [])).toBe('');
    expect(renderAddendum('nothing.', [])).toBe('');
  });

  it('warns when an addition credits a named source deep never cited', () => {
    expect(renderAddendum('- According to Gartner, 40% switch.', [])).toContain('Source not verified');
  });

  it('appends to the markdown artifact and the findings, not to the answer', () => {
    const out = withAddendum(fastResult, 'X');
    expect(out.artifacts![0]!.content.endsWith('\n\nX')).toBe(true);
    expect(out.data.findings.endsWith('\n\nX')).toBe(true);
    expect(out.data.answer).toBe('Runway.');
    expect(fastResult.artifacts![0]!.content.endsWith('X')).toBe(false);
  });
});
