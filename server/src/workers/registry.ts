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
// Ceiling for how long onMeetingEnd lets in-flight workers finish before a
// force-cancel. The auto-summary + auto-review fired at session.stop run on the
// CLIs (non-streaming Sonnet) over the FULL transcript, which routinely takes
// >60s — the old 60s ceiling silently killed the self-review on real meetings.
// The drain resolves the instant running hits 0, so a higher ceiling adds no
// latency in the common case; it only raises the cap before a genuinely hung
// worker is abandoned.
const END_GRACE_MS = 240_000; // 4 min
// Auto-expire unactioned suggestions after this long. Default respects the
// legacy SUGGESTION_TTL_MS env var; the effective value is runtime-tunable
// via setSuggestionTtl (wired to the settings system in index.ts).
const DEFAULT_SUGGESTION_TTL_MS = (() => {
  const raw = Number(process.env.SUGGESTION_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

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
  private suggestionTimers = new Map<string, NodeJS.Timeout>();
  private suggestionTtlMs = DEFAULT_SUGGESTION_TTL_MS;

  /** Runtime-tunable suggestion TTL (applies to suggestions created after the change). */
  setSuggestionTtl(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.suggestionTtlMs = ms;
  }

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

  /**
   * Replace the result of a completed action in-place (for rolling updates).
   * Emits action.status so all clients see the update.
   */
  replaceActionResult(actionId: string, newResult: WorkerResult): void {
    const action = this.actions.get(actionId);
    if (!action || action.state !== 'completed') return;
    action.result = newResult;
    action.completedAt = Date.now();
    this.emit('action.status', action);
  }

  suggest(suggestion: ActionSuggestion, opts?: { force?: boolean; system?: boolean }): ActionLifecycle | null {
    // `force` skips the dedup gate for deliberate user actions (e.g. a
    // right-click "Revise mock" or card-derived mockup) so an explicit click
    // never silently vanishes against a near-identical recent card.
    // `system` marks server-fired session-critical actions (auto-summary,
    // auto-review, rolling summary) — see ActionLifecycle.system.
    if (!opts?.force && this.isDuplicate(suggestion)) return null;
    this.addDedupHash(suggestion);

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
      system: opts?.system || undefined,
    };

    this.actions.set(action.id, action);
    this.emit('action.suggested', action);
    this.startSuggestionTtl(action.id);
    return action;
  }

  /** Exact (type+params) or fuzzy (similar title within type) duplicate check. */
  private isDuplicate(s: { type: string; params: Record<string, any>; title: string }, excludeId?: string): boolean {
    const dedupKey = createHash('sha256')
      .update(JSON.stringify({ type: s.type, params: s.params }))
      .digest('hex');
    if (this.suggestionHashes.has(dedupKey)) return true;

    const titleWords = new Set(s.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 3));
    for (const existing of this.actions.values()) {
      if (existing.id === excludeId) continue;
      if (existing.type !== s.type) continue;
      if (existing.state === 'cancelled' || existing.state === 'expired') continue;
      const existingWords = new Set(existing.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 3));
      let intersection = 0;
      for (const w of titleWords) { if (existingWords.has(w)) intersection++; }
      const union = titleWords.size + existingWords.size - intersection;
      if (union > 0 && intersection / union >= 0.75) return true;
    }
    return false;
  }

  private addDedupHash(s: { type: string; params: Record<string, any> }): void {
    const dedupKey = createHash('sha256')
      .update(JSON.stringify({ type: s.type, params: s.params }))
      .digest('hex');
    this.suggestionHashes.add(dedupKey);
  }

  private startSuggestionTtl(actionId: string): void {
    const timer = setTimeout(() => {
      this.suggestionTimers.delete(actionId);
      const current = this.actions.get(actionId);
      if (!current || current.state !== 'suggested') return;
      current.state = 'expired';
      current.completedAt = Date.now();
      this.emit('action.status', current);
      this.actions.delete(actionId);
    }, this.suggestionTtlMs);
    this.suggestionTimers.set(actionId, timer);
  }

  // ─── Streaming suggestion lifecycle ────────────────────────────────────────
  // A suggestion is created EARLY (while its JSON is still generating) so the
  // user can watch the card form and pre-approve it before it's fully written.

  /** Create a card from the first partial (needs at least type + title). */
  suggestStreaming(
    id: string,
    fields: { type: string; title: string; description?: string; triggerQuote?: string; estimatedDurationSec?: number; params?: Record<string, any> },
  ): ActionLifecycle {
    const action: ActionLifecycle = {
      id,
      type: fields.type,
      title: fields.title,
      description: fields.description ?? '',
      triggerQuote: fields.triggerQuote ?? '',
      estimatedDurationSec: fields.estimatedDurationSec ?? 0,
      params: fields.params ?? {},
      state: 'suggested',
      streaming: true,
      paramsReady: false,
      createdAt: Date.now(),
      timeoutMs: this.getTimeoutForType(fields.type),
      retryCount: 0,
      cancelController: new AbortController(),
    };
    this.actions.set(id, action);
    this.emit('action.suggested', action);
    return action;
  }

  /** Merge streamed fields. If params just closed and the user pre-approved, dispatch now. */
  updateStreaming(
    id: string,
    fields: { title?: string; description?: string; triggerQuote?: string; estimatedDurationSec?: number; params?: Record<string, any>; paramsReady?: boolean },
  ): void {
    const action = this.actions.get(id);
    if (!action || !action.streaming) return;
    if (fields.title !== undefined) action.title = fields.title;
    if (fields.description !== undefined) action.description = fields.description;
    if (fields.triggerQuote !== undefined) action.triggerQuote = fields.triggerQuote;
    if (fields.estimatedDurationSec !== undefined) action.estimatedDurationSec = fields.estimatedDurationSec;
    if (fields.params !== undefined) action.params = fields.params;

    if (fields.paramsReady && !action.paramsReady) {
      action.paramsReady = true;
      if (action.pendingApproval && action.state === 'suggested') {
        this.startApproved(action); // pre-approved + params now ready → launch
        return;
      }
    }
    // No action.status emit here: the streamed card text is broadcast by index.ts
    // as action.suggested (one message type, no per-frame DB writes). Dispatch and
    // terminal state changes still emit via startApproved/finalizeStreaming.
  }

  /** Lock in the complete suggestion. Dispatches if pre-approved; else starts the TTL. */
  finalizeStreaming(id: string, full: ActionSuggestion | null): ActionLifecycle | null {
    const action = this.actions.get(id);
    if (!action) return null;
    if (!action.streaming) return action; // already finalized/dispatched

    if (!full) {
      // Parse failed and nothing started → drop the in-progress card.
      if (action.state === 'suggested') {
        this.actions.delete(id);
        action.state = 'cancelled';
        action.completedAt = Date.now();
      }
      action.streaming = false;
      this.emit('action.status', action);
      return null;
    }

    action.type = full.type;
    action.title = full.title;
    action.description = full.description;
    action.triggerQuote = full.triggerQuote;
    action.estimatedDurationSec = full.estimatedDurationSec;
    action.streaming = false;
    // Only adopt the final params if they were NEVER finalized mid-stream.
    // Otherwise action.params already holds the (context-injected, possibly
    // in-use by an early-dispatched worker) version — don't clobber it.
    if (!action.paramsReady) {
      action.params = full.params;
      action.paramsReady = true;
    }

    // Already dispatched early (running/approved/queued) — just refresh display.
    if (action.state !== 'suggested') {
      this.emit('action.status', action);
      return action;
    }

    // Drop now-revealed duplicates (compare against OTHER actions).
    if (this.isDuplicate(full, id)) {
      this.actions.delete(id);
      action.state = 'cancelled';
      action.completedAt = Date.now();
      this.emit('action.status', action);
      return null;
    }
    this.addDedupHash(full);

    if (action.pendingApproval) {
      this.startApproved(action); // approved during stream → launch now
      return action;
    }

    // Complete, unapproved card → normal suggested lifecycle + TTL.
    this.emit('action.status', action);
    this.startSuggestionTtl(id);
    return action;
  }

  private clearSuggestionTimer(actionId: string): void {
    const t = this.suggestionTimers.get(actionId);
    if (t) {
      clearTimeout(t);
      this.suggestionTimers.delete(actionId);
    }
  }

  approve(actionId: string): void {
    const action = this.actions.get(actionId);
    if (!action) return;
    if (action.state !== 'suggested' && action.state !== 'failed') return;

    // Early approval: the suggestion is still streaming and its params haven't
    // closed yet. Record the intent — updateStreaming/finalizeStreaming will
    // dispatch the instant params are ready, with no second click needed.
    if (action.streaming && !action.paramsReady) {
      action.pendingApproval = true;
      this.emit('action.status', action);
      return;
    }

    this.startApproved(action);
  }

  /** Transition an approved (or pre-approved, now-ready) action into execution. */
  private startApproved(action: ActionLifecycle): void {
    this.clearSuggestionTimer(action.id);
    action.streaming = false;
    action.pendingApproval = false;

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

    // System actions (auto-summary/review at stop) bypass the cap — they fire
    // exactly when 3 user workers may be draining, and queueing them would
    // hand them to onMeetingEnd's cancel sweep. Momentary concurrency is
    // bounded (2 system actions exist) and only occurs at meeting end.
    if (action.system || this.runningCount < MAX_CONCURRENT_WORKERS) {
      this.executeAction(action);
    } else {
      action.state = 'queued';
      this.approvedQueue.push(action.id);
      this.emit('action.status', action);
    }
  }

  dismiss(actionId: string): void {
    const action = this.actions.get(actionId);
    if (!action || action.state !== 'suggested') return;
    this.clearSuggestionTimer(actionId);

    action.state = 'cancelled';
    action.completedAt = Date.now();
    this.emit('action.status', action);
    this.actions.delete(actionId);
  }

  cancel(actionId: string): void {
    const action = this.actions.get(actionId);
    if (!action) return;
    this.clearSuggestionTimer(actionId);

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
    // Drain pending TTL timers — onMeetingEnd handles the 'suggested' → 'expired'
    // transition itself, and we don't want a stale setTimeout firing post-session.
    for (const t of this.suggestionTimers.values()) clearTimeout(t);
    this.suggestionTimers.clear();

    // Expire all unapproved suggestions. System actions are exempt — the
    // auto-summary/review fired at stop must survive the sweep.
    for (const action of this.actions.values()) {
      if (action.state === 'suggested' && !action.system) {
        action.state = 'expired';
        this.emit('action.status', action);
      }
    }

    // Cancel queued user actions. Queued system actions (shouldn't exist —
    // startApproved bypasses the cap for them — but defense in depth) are
    // launched immediately instead of cancelled.
    const queuedSystem: string[] = [];
    for (const actionId of this.approvedQueue) {
      const action = this.actions.get(actionId);
      if (!action || action.state !== 'queued') continue;
      if (action.system) {
        queuedSystem.push(actionId);
        continue;
      }
      action.state = 'cancelled';
      action.completedAt = Date.now();
      this.emit('action.status', action);
    }
    this.approvedQueue = [];
    for (const actionId of queuedSystem) {
      const action = this.actions.get(actionId);
      if (action && action.state === 'queued') {
        this.executeAction(action);
      }
    }

    // Give in-flight workers a grace period (see END_GRACE_MS) to finish.
    if (this.getActionsByState('running').length > 0) {
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
        }, END_GRACE_MS);

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
    // Generous safety cap (~15 min) for any worker that doesn't set its own —
    // jobs run until done or cancel; a truly-hung CLI still fails → Retry.
    return worker?.capabilities.maxDurationMs ?? 900_000;
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

    // Inject streaming callback for worker types that support it. The worker
    // reads params._onDelta and forwards text chunks as they arrive from the
    // Claude CLI; the registry emits them as action.stream events.
    const streamingTypes = new Set(['research', 'fast-research', 'summary', 'analysis']);
    if (streamingTypes.has(action.type) && typeof action.params._onDelta !== 'function') {
      action.params._onDelta = (delta: string) => {
        this.emit('action.stream', { actionId: action.id, delta });
      };
    }

    // Early-emit hook: a worker can publish a partial result before execute()
    // resolves. The mockup worker uses it to show its fast ASCII wireframe
    // while the HTML phase is still rendering. The partial rides an
    // action.status event with state kept as 'running' (not mutating the live
    // action's state/result), so the dashboard renders partial artifacts in
    // place without marking the card complete.
    if (typeof action.params._emitEarly !== 'function') {
      action.params._emitEarly = (partial: WorkerResult) => {
        if (action.state !== 'running') return; // ignore late emits after cancel/finish
        this.emit('action.status', { ...action, state: 'running', result: partial });
      };
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
