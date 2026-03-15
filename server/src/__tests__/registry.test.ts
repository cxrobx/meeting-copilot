import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkerRegistry } from '../workers/registry.js';
import type { Worker, WorkerResult, ActionSuggestion } from '../workers/types.js';

function makeWorker(name: string, result?: Partial<WorkerResult>): Worker {
  return {
    name,
    capabilities: {
      network: 'none',
      filesystem: { read: [], write: [] },
      subprocess: false,
      maxDurationMs: 10_000,
      maxMemoryMB: 256,
    },
    execute: vi.fn().mockResolvedValue({
      success: true,
      data: null,
      summary: 'done',
      ...result,
    }),
  };
}

function makeSuggestion(overrides?: Partial<ActionSuggestion>): ActionSuggestion {
  return {
    type: 'research',
    title: 'Test suggestion',
    description: 'Test description',
    triggerQuote: 'someone said something',
    estimatedDurationSec: 10,
    params: { query: 'test' },
    ...overrides,
  };
}

describe('WorkerRegistry', () => {
  let registry: WorkerRegistry;

  beforeEach(() => {
    registry = new WorkerRegistry();
    registry.register(makeWorker('research'));
    registry.register(makeWorker('summary'));
  });

  it('registers and retrieves workers', () => {
    expect(registry.getWorker('research')).toBeDefined();
    expect(registry.getWorker('summary')).toBeDefined();
    expect(registry.getWorker('nonexistent')).toBeUndefined();
  });

  it('creates an action from a suggestion', () => {
    const action = registry.suggest(makeSuggestion());
    expect(action).not.toBeNull();
    expect(action!.state).toBe('suggested');
    expect(action!.type).toBe('research');
    expect(action!.id).toBeTruthy();
  });

  it('deduplicates identical suggestions', () => {
    const s = makeSuggestion();
    const first = registry.suggest(s);
    const second = registry.suggest(s);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('allows different suggestions', () => {
    const first = registry.suggest(makeSuggestion({ title: 'First' }));
    const second = registry.suggest(makeSuggestion({ title: 'Second', params: { query: 'different' } }));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it('approves a suggested action', () => {
    const action = registry.suggest(makeSuggestion())!;
    const events: string[] = [];
    registry.on('action.status', (a) => events.push(a.state));

    registry.approve(action.id);

    expect(events).toContain('approved');
  });

  it('dismisses a suggested action', () => {
    const action = registry.suggest(makeSuggestion())!;
    registry.dismiss(action.id);

    expect(action.state).toBe('cancelled');
    expect(registry.getAction(action.id)).toBeUndefined(); // deleted
  });

  it('cancels a running action', () => {
    const action = registry.suggest(makeSuggestion())!;
    registry.approve(action.id);
    // Force state to running for the test
    action.state = 'running';

    registry.cancel(action.id);

    expect(action.state).toBe('cancelled');
    expect(action.completedAt).toBeDefined();
  });

  it('ignores approve on non-suggested actions', () => {
    const action = registry.suggest(makeSuggestion())!;
    registry.dismiss(action.id);

    // Should not throw or change state
    registry.approve(action.id);
  });

  it('tracks actions by state', () => {
    registry.suggest(makeSuggestion({ params: { q: '1' } }));
    registry.suggest(makeSuggestion({ params: { q: '2' } }));

    expect(registry.getActionsByState('suggested')).toHaveLength(2);
    expect(registry.getActionsByState('running')).toHaveLength(0);
  });

  it('reports byState metrics', () => {
    registry.suggest(makeSuggestion({ params: { q: '1' } }));
    registry.suggest(makeSuggestion({ params: { q: '2' } }));

    const counts = registry.byState;
    expect(counts.suggested).toBe(2);
  });

  it('expires suggestions on meeting end', async () => {
    const a1 = registry.suggest(makeSuggestion({ params: { q: 'a' } }))!;
    const a2 = registry.suggest(makeSuggestion({ params: { q: 'b' } }))!;

    await registry.onMeetingEnd();

    expect(a1.state).toBe('expired');
    expect(a2.state).toBe('expired');
  });
});
