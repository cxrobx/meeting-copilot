import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  Worker,
  WorkerResult,
  ActionSuggestion,
  ActionLifecycle,
} from './types.js';

const MAX_CONCURRENT_WORKERS = 3;
const MAX_RETRY_COUNT = 2;
const BASE_RETRY_DELAY_MS = 1_000; // 1s, doubled each retry

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('timeout') ||
      msg.includes('429') ||
      msg.includes('500') ||
      msg.includes('rate limit') ||
      msg.includes('internal server error')
    );
  }
  return false;
}

export class WorkerRegistry extends EventEmitter {
  private workers = new Map<string, Worker>();
  private actions = new Map<string, ActionLifecycle>();
  private runningCount = 0;
  private approvedQueue: string[] = []; // Action IDs waiting to run
  private suggestionHashes = new Set<string>();

  register(worker: Worker): void {
    this.workers.set(worker.name, worker);
  }

  getWorker(name: string): Worker | undefined {
    return this.workers.get(name);
  }

  getAction(actionId: string): ActionLifecycle | undefined {
    return this.actions.get(actionId);
  }

  getAllActions(): ActionLifecycle[] {
    return Array.from(this.actions.values());
  }

  getActionsByState(
    state: ActionLifecycle['state'],
  ): ActionLifecycle[] {
    return Array.from(this.actions.values()).filter(
      (a) => a.state === state,
    );
  }

  suggest(suggestion: ActionSuggestion): ActionLifecycle | null {
    // Dedup check: hash type + params
    const dedupKey = createHash('sha256')
      .update(JSON.stringify({ type: suggestion.type, params: suggestion.params }))
      .digest('hex');

    if (this.suggestionHashes.has(dedupKey)) {
      return null; // Duplicate suggestion
    }
    this.suggestionHashes.add(dedupKey);

    const action: ActionLifecycle = {
      id: uuidv4(),
      type: suggestion.type,
      title: suggestion.title,
      description: suggestion.description,
      triggerQuote: suggestion.triggerQuote,
      estimatedDurationSec: suggestion.estimatedDurationSec,
      params: suggestion.params,
      state: 'suggested',
      createdAt: Date.now(),
      timeoutMs: this.getTimeoutForType(suggestion.type),
      retryCount: 0,
      cancelController: new AbortController(),
    };

    this.actions.set(action.id, action);
    this.emit('action.suggested', action);
    return action;
  }

  approve(actionId: string): void {
    const action = this.actions.get(actionId);
    if (!action) return;
    if (action.state !== 'suggested' && action.state !== 'failed') return;

    // Reset execution state on retry from failed
    if (action.state === 'failed') {
      action.retryCount = 0;
      action.result = undefined;
      action.startedAt = undefined;
      action.completedAt = undefined;
      action.cancelController = new AbortController();
    }

    action.state = 'approved';
    action.approvedAt = Date.now();
    this.emit('action.status', action);

    if (this.runningCount < MAX_CONCURRENT_WORKERS) {
      this.executeAction(action);
    } else {
      action.state = 'queued';
      this.approvedQueue.push(actionId);
      this.emit('action.status', action);
    }
  }

  dismiss(actionId: string): void {
    const action = this.actions.get(actionId);
    if (!action || action.state !== 'suggested') return;

    action.state = 'cancelled';
    action.completedAt = Date.now();
    this.emit('action.status', action);
    this.actions.delete(actionId);
  }

  cancel(actionId: string): void {
    const action = this.actions.get(actionId);
    if (!action) return;

    if (action.state === 'running' || action.state === 'queued') {
      action.cancelController.abort();
      action.state = 'cancelled';
      action.completedAt = Date.now();
      this.emit('action.status', action);

      // Remove from queue if it was queued
      const idx = this.approvedQueue.indexOf(actionId);
      if (idx !== -1) {
        this.approvedQueue.splice(idx, 1);
      }
    }
  }

  async onMeetingEnd(): Promise<void> {
    // Expire all unapproved suggestions
    for (const action of this.actions.values()) {
      if (action.state === 'suggested') {
        action.state = 'expired';
        this.emit('action.status', action);
      }
    }

    // Cancel queued actions
    for (const actionId of this.approvedQueue) {
      const action = this.actions.get(actionId);
      if (action && action.state === 'queued') {
        action.state = 'cancelled';
        action.completedAt = Date.now();
        this.emit('action.status', action);
      }
    }
    this.approvedQueue = [];

    // Give in-flight workers 60s grace period
    const runningActions = this.getActionsByState('running');
    if (runningActions.length > 0) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force-cancel any still running
          for (const action of this.getActionsByState('running')) {
            action.cancelController.abort();
            action.state = 'cancelled';
            action.completedAt = Date.now();
            this.emit('action.status', action);
          }
          resolve();
        }, 60_000);

        // Check periodically if all done
        const check = setInterval(() => {
          if (this.getActionsByState('running').length === 0) {
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          }
        }, 1_000);
      });
    }

    this.suggestionHashes.clear();
  }

  // Metrics helpers
  get byState(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const action of this.actions.values()) {
      counts[action.state] = (counts[action.state] ?? 0) + 1;
    }
    return counts;
  }

  get avgCompletionTimeMs(): Record<string, number> {
    const totals: Record<string, { sum: number; count: number }> = {};
    for (const action of this.actions.values()) {
      if (action.state === 'completed' && action.startedAt && action.completedAt) {
        if (!totals[action.type]) {
          totals[action.type] = { sum: 0, count: 0 };
        }
        totals[action.type]!.sum += action.completedAt - action.startedAt;
        totals[action.type]!.count++;
      }
    }
    const result: Record<string, number> = {};
    for (const [type, data] of Object.entries(totals)) {
      result[type] = data.count > 0 ? data.sum / data.count : 0;
    }
    return result;
  }

  get failureRate(): number {
    const completed = this.getActionsByState('completed').length;
    const failed = this.getActionsByState('failed').length;
    const total = completed + failed;
    return total > 0 ? failed / total : 0;
  }

  private getTimeoutForType(type: string): number {
    const worker = this.workers.get(type);
    return worker?.capabilities.maxDurationMs ?? 120_000;
  }

  private async executeAction(action: ActionLifecycle): Promise<void> {
    const worker = this.workers.get(action.type);
    if (!worker) {
      action.state = 'failed';
      action.completedAt = Date.now();
      action.result = {
        success: false,
        data: null,
        summary: `No worker registered for type: ${action.type}`,
        error: `Unknown worker type: ${action.type}`,
      };
      this.emit('action.status', action);
      this.drainQueue();
      return;
    }

    action.state = 'running';
    action.startedAt = Date.now();
    this.runningCount++;
    this.emit('action.status', action);

    try {
      // Timeout enforcement via Promise.race
      const timeoutPromise = new Promise<WorkerResult>((_, reject) => {
        setTimeout(() => {
          action.cancelController.abort();
          reject(new Error(`Worker timed out after ${action.timeoutMs}ms`));
        }, action.timeoutMs);
      });

      const result = await Promise.race([
        worker.execute(action.params, action.cancelController.signal),
        timeoutPromise,
      ]);

      action.result = result;
      action.state = result.success ? 'completed' : 'failed';
      action.completedAt = Date.now();

      // Auto-retry on transient failure with exponential backoff
      if (!result.success && action.retryCount < MAX_RETRY_COUNT) {
        const errorStr = result.error ?? result.summary;
        if (isTransientError(new Error(errorStr))) {
          action.retryCount++;
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, action.retryCount - 1);
          await new Promise((r) => setTimeout(r, delay));

          action.state = 'running';
          action.cancelController = new AbortController();
          this.emit('action.status', action);

          const retryTimeoutPromise = new Promise<WorkerResult>((_, reject) => {
            setTimeout(() => {
              action.cancelController.abort();
              reject(new Error(`Worker timed out after ${action.timeoutMs}ms`));
            }, action.timeoutMs);
          });

          const retryResult = await Promise.race([
            worker.execute(action.params, action.cancelController.signal),
            retryTimeoutPromise,
          ]);

          action.result = retryResult;
          action.state = retryResult.success ? 'completed' : 'failed';
          action.completedAt = Date.now();
        }
      }

      this.emit('action.status', action);
      if (action.state === 'completed') {
        this.emit('action.completed', action);
      }
    } catch (error) {
      // Retry on transient errors
      if (
        action.retryCount < MAX_RETRY_COUNT &&
        isTransientError(error)
      ) {
        action.retryCount++;
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, action.retryCount - 1);
        await new Promise((r) => setTimeout(r, delay));

        action.cancelController = new AbortController();
        this.emit('action.status', action);

        try {
          const retryTimeoutPromise = new Promise<WorkerResult>((_, reject) => {
            setTimeout(() => {
              action.cancelController.abort();
              reject(new Error(`Worker timed out after ${action.timeoutMs}ms`));
            }, action.timeoutMs);
          });

          const retryResult = await Promise.race([
            worker.execute(action.params, action.cancelController.signal),
            retryTimeoutPromise,
          ]);

          action.result = retryResult;
          action.state = retryResult.success ? 'completed' : 'failed';
          action.completedAt = Date.now();
          this.emit('action.status', action);
          if (action.state === 'completed') {
            this.emit('action.completed', action);
          }
        } catch (retryError) {
          action.state = 'failed';
          action.completedAt = Date.now();
          action.result = {
            success: false,
            data: null,
            summary: `Worker failed after retry: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
            error: retryError instanceof Error ? retryError.message : String(retryError),
          };
          this.emit('action.status', action);
        }
      } else {
        action.state = 'failed';
        action.completedAt = Date.now();
        action.result = {
          success: false,
          data: null,
          summary: `Worker failed: ${error instanceof Error ? error.message : String(error)}`,
          error: error instanceof Error ? error.message : String(error),
        };
        this.emit('action.status', action);
      }
    } finally {
      this.runningCount--;
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    while (
      this.runningCount < MAX_CONCURRENT_WORKERS &&
      this.approvedQueue.length > 0
    ) {
      const nextId = this.approvedQueue.shift()!;
      const nextAction = this.actions.get(nextId);
      if (nextAction && nextAction.state === 'queued') {
        this.executeAction(nextAction);
      }
    }
  }
}
