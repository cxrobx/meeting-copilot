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
  const suggestion: ActionSuggestion = {
    type: 'research',
    title: 'Test suggestion',
    description: 'Test description',
    triggerQuote: '',
    estimatedDurationSec: 10,
    params: { query: 'test' },
    ...overrides,
  };
  suggestion.triggerQuote = overrides?.triggerQuote
    ?? `${suggestion.title} came up as a distinct actionable moment in the meeting.`;
  return suggestion;
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

  it('remembers a trigger after its card is dismissed', () => {
    const first = registry.suggest(makeSuggestion({
      title: 'Research autonomous agent permissions',
      triggerQuote: 'What permissions do I need to set up in order for this to flow freely?',
      params: { query: 'agent permissions' },
    }))!;
    registry.dismiss(first.id);

    const repeatedMoment = registry.suggest(makeSuggestion({
      type: 'codegen',
      title: 'Generate an agent permission settings file',
      triggerQuote: 'What permissions do I need to set up in order for this to flow freely?',
      params: { task: 'write settings' },
    }));
    expect(repeatedMoment).toBeNull();
  });

  it('deduplicates same-type title paraphrases across different transcript quotes', () => {
    registry.suggest(makeSuggestion({
      type: 'summary',
      title: 'Document Fable Codex agent orchestration workflow',
      triggerQuote: 'Fable builds the plan and Codex implements the tickets.',
      params: { focus: 'workflow' },
    }));

    const paraphrase = registry.suggest(makeSuggestion({
      type: 'summary',
      title: 'Summarize Fable Codex orchestration workflow',
      triggerQuote: 'We add verification gates at the end.',
      params: { focus: 'gates' },
    }));
    expect(paraphrase).toBeNull();
  });

  it('deduplicates a finalized streaming card against prior meeting history', () => {
    registry.suggest(makeSuggestion({
      title: 'Research autonomous agent permissions',
      triggerQuote: 'What permissions do I need to set up in order for this to flow freely?',
      params: { query: 'agent permissions' },
    }));
    registry.suggestStreaming('stream-duplicate', {
      type: 'codegen',
      title: 'Generate permission settings',
    });

    const finalized = registry.finalizeStreaming('stream-duplicate', makeSuggestion({
      type: 'codegen',
      title: 'Generate permission settings',
      triggerQuote: 'What permissions do I need to set up in order for this to flow freely?',
      params: { task: 'write settings' },
    }));
    expect(finalized).toBeNull();
    expect(registry.getAction('stream-duplicate')).toBeUndefined();
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
    // Distinct titles — identical titles trip the fuzzy Jaccard dedup
    registry.suggest(makeSuggestion({ title: 'Investigate rollout options', params: { q: '1' } }));
    registry.suggest(makeSuggestion({ title: 'Compare pricing models', params: { q: '2' } }));

    expect(registry.getActionsByState('suggested')).toHaveLength(2);
    expect(registry.getActionsByState('running')).toHaveLength(0);
  });

  it('reports byState metrics', () => {
    registry.suggest(makeSuggestion({ title: 'Investigate rollout options', params: { q: '1' } }));
    registry.suggest(makeSuggestion({ title: 'Compare pricing models', params: { q: '2' } }));

    const counts = registry.byState;
    expect(counts.suggested).toBe(2);
  });

  it('expires suggestions on meeting end', async () => {
    const a1 = registry.suggest(makeSuggestion({ title: 'Investigate rollout options', params: { q: 'a' } }))!;
    const a2 = registry.suggest(makeSuggestion({ title: 'Compare pricing models', params: { q: 'b' } }))!;

    await registry.onMeetingEnd();

    expect(a1.state).toBe('expired');
    expect(a2.state).toBe('expired');
  });

  it('clears meeting-scoped dedup history when the meeting ends', async () => {
    registry.suggest(makeSuggestion({
      title: 'Research autonomous agent permissions',
      triggerQuote: 'What permissions do I need to set up in order for this to flow freely?',
      params: { query: 'agent permissions' },
    }));

    await registry.onMeetingEnd();

    const nextMeeting = registry.suggest(makeSuggestion({
      type: 'codegen',
      title: 'Generate permission settings',
      triggerQuote: 'What permissions do I need to set up in order for this to flow freely?',
      params: { task: 'write settings' },
    }));
    expect(nextMeeting).not.toBeNull();
  });

  it('retries transient failures up to 2 times (3 attempts total)', async () => {
    let calls = 0;
    const flaky: Worker = {
      name: 'analysis',
      capabilities: {
        network: 'none',
        filesystem: { read: [], write: [] },
        subprocess: false,
        maxDurationMs: 10_000,
        maxMemoryMB: 256,
      },
      execute: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls < 3) throw new Error('network hiccup: ECONNRESET');
        return { success: true, data: null, summary: 'third time lucky' };
      }),
    };
    registry.register(flaky);
    const action = registry.suggest(
      makeSuggestion({ type: 'analysis', title: 'Flaky analysis job', params: { q: 'flaky' } }),
    )!;
    registry.approve(action.id);

    await vi.waitFor(() => expect(action.state).toBe('completed'), { timeout: 8_000 });
    expect(calls).toBe(3);
    expect(action.retryCount).toBe(2);
  }, 10_000);

  describe('system actions', () => {
    /** Worker whose execute() blocks until the test resolves it. */
    function makeBlockingWorker(name: string) {
      const resolvers: Array<(r: WorkerResult) => void> = [];
      const worker: Worker = {
        name,
        capabilities: {
          network: 'none',
          filesystem: { read: [], write: [] },
          subprocess: false,
          maxDurationMs: 10_000,
          maxMemoryMB: 256,
        },
        execute: vi.fn().mockImplementation(
          () => new Promise<WorkerResult>((resolve) => resolvers.push(resolve)),
        ),
      };
      return {
        worker,
        resolveAll: () => {
          for (const r of resolvers.splice(0)) {
            r({ success: true, data: null, summary: 'done' });
          }
        },
      };
    }

    function saturateSlots(blocking: { worker: Worker }) {
      registry.register(blocking.worker);
      // force: near-identical titles would otherwise trip the fuzzy dedup
      const running = [1, 2, 3].map((i) => {
        const a = registry.suggest(
          makeSuggestion({ type: 'research', title: `Slow job ${i}`, params: { q: `slow-${i}` } }),
          { force: true },
        )!;
        registry.approve(a.id);
        return a;
      });
      return running;
    }

    it('executes a system action immediately even when all slots are busy', () => {
      const blocking = makeBlockingWorker('research');
      saturateSlots(blocking);

      const userAction = registry.suggest(makeSuggestion({ title: 'User research four', params: { q: 'user-4' } }))!;
      registry.approve(userAction.id);
      expect(userAction.state).toBe('queued');

      const systemAction = registry.suggest(
        makeSuggestion({ type: 'summary', title: 'Meeting Summary: End', params: { transcript: 'x' } }),
        { force: true, system: true },
      )!;
      registry.approve(systemAction.id);
      expect(systemAction.state).not.toBe('queued');
      expect(['running', 'completed']).toContain(systemAction.state);

      blocking.resolveAll();
    });

    it('system action survives onMeetingEnd while user queue is cancelled', async () => {
      const blocking = makeBlockingWorker('research');
      saturateSlots(blocking);

      const queuedUser = registry.suggest(makeSuggestion({ title: 'Queued user job', params: { q: 'queued' } }))!;
      registry.approve(queuedUser.id);
      expect(queuedUser.state).toBe('queued');

      const systemAction = registry.suggest(
        makeSuggestion({ type: 'summary', title: 'Meeting Summary: End', params: { transcript: 'x' } }),
        { force: true, system: true },
      )!;
      registry.approve(systemAction.id);

      const endPromise = registry.onMeetingEnd();
      // Let the blocked user workers finish so the grace wait resolves.
      blocking.resolveAll();
      await endPromise;

      expect(queuedUser.state).toBe('cancelled');
      expect(systemAction.state).toBe('completed');
    }, 15_000);

    it('does not expire suggested system actions on meeting end', async () => {
      const systemSuggested = registry.suggest(
        makeSuggestion({ type: 'summary', title: 'System pending', params: { transcript: 'y' } }),
        { force: true, system: true },
      )!;

      await registry.onMeetingEnd();

      expect(systemSuggested.state).toBe('suggested');
    });
  });
});
