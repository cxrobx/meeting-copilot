import type { EventEmitter } from 'node:events';
import type { ActionLifecycle, WorkerResult } from './types.js';
import { checkAttributions, type ResearchSource } from './citations.js';

/**
 * Deep follow-up for every fast-research card (suggested cards, the dashboard's
 * Research button, the menu bar's Ask): the fast answer streams first,
 * deep research runs alongside it, and what deep adds is appended to the
 * finished card when it lands.
 *
 * Why both: measured 2026-09-22 on the three real research questions in
 * stored sessions, Fast (gpt-6-luna) answered in 6-12 s and Deep (Opus 5.5,
 * WebSearch + WebFetch) in 32-65 s — and Deep's answers were far better on
 * every open-ended one (vendors with prices, named examples, API limits).
 * On known-answer facts they tie (`npm run eval:research`). So the card
 * shows Fast at Fast's speed and never waits on Deep; Deep only adds.
 *
 * It lives outside the worker slots on purpose: the fast card completes and
 * frees its slot as it always did, so a 60 s deep run never queues the next
 * approved card behind it.
 */

export const PENDING_NOTE = '_Deep research is still reading. What it adds will appear here._';

export interface DeepFollowUpDeps {
  /** The deep research worker's execute(). Its `data.answer` is the text without the footer. */
  runDeep(params: { query: string; context?: string }, signal: AbortSignal): Promise<WorkerResult>;
  /** Markdown of what `deep` adds to `fast`, or '' when it adds nothing material. */
  compare(input: { query: string; fast: string; deep: string }, signal: AbortSignal): Promise<string>;
  enabled?: () => boolean;
  maxConcurrent?: number;
  log?: (message: string) => void;
}

interface Registry extends EventEmitter {
  getAction(actionId: string): ActionLifecycle | undefined;
  replaceActionResult(actionId: string, newResult: WorkerResult): void;
}

interface Run {
  controller: AbortController;
  deep: Promise<WorkerResult>;
  /** The fast result as the worker returned it, once the card completes. */
  fast?: WorkerResult;
}

export function wantsDeepFollowUp(action: ActionLifecycle): boolean {
  return action.type === 'fast-research' && typeof action.params?.query === 'string';
}

export const COMPARE_SYSTEM = `You compare two research answers to the same question, asked during a live meeting. The user has already read ANSWER A. ANSWER B is a slower, deeper answer.

Write only what B adds that would change or improve a decision: options A missed, specifics (prices, limits, names, dates), risks, or places where B contradicts A (say which is better supported). At most 6 markdown bullets, one or two lines each. Keep B's inline markdown links on the facts they support. No preamble, no heading.

If B adds nothing material, reply with exactly: NOTHING`;

export class DeepFollowUp {
  private runs = new Map<string, Run>();
  private settled = new Set<string>();

  constructor(private registry: Registry, private deps: DeepFollowUpDeps) {
    registry.on('action.status', (action: ActionLifecycle) => this.onStatus(action));
  }

  get activeCount(): number {
    return this.runs.size;
  }

  private onStatus(action: ActionLifecycle): void {
    if (!wantsDeepFollowUp(action) || this.settled.has(action.id)) return;
    const run = this.runs.get(action.id);

    if (action.state === 'running' && !run) {
      if (this.deps.enabled && !this.deps.enabled()) return;
      if (this.runs.size >= (this.deps.maxConcurrent ?? 2)) {
        this.deps.log?.(`skipped for ${action.id}: ${this.runs.size} already running`);
        this.settled.add(action.id);
        return;
      }
      const controller = new AbortController();
      const deep = this.deps
        .runDeep({ query: action.params.query, context: action.params.context }, controller.signal)
        .catch((error): WorkerResult => ({
          success: false,
          data: null,
          summary: 'Deep research failed',
          error: error instanceof Error ? error.message : String(error),
        }));
      this.runs.set(action.id, { controller, deep });
      return;
    }

    if (!run) return;
    if (action.state === 'completed' && !run.fast && action.result?.success) {
      run.fast = action.result;
      this.registry.replaceActionResult(action.id, withAddendum(action.result, PENDING_NOTE));
      void this.finish(action.id, run);
      return;
    }
    if (action.state === 'failed' || action.state === 'cancelled' || action.state === 'expired'
      || (action.state === 'completed' && !run.fast)) {
      run.controller.abort();
      this.runs.delete(action.id);
      this.settled.add(action.id);
    }
  }

  private async finish(actionId: string, run: Run): Promise<void> {
    const fast = run.fast!;
    let addendum = '';
    try {
      const deep = await run.deep;
      if (run.controller.signal.aborted) return;
      const deepAnswer = deep.success ? String(deep.data?.answer ?? '') : '';
      if (!deepAnswer.trim()) {
        this.deps.log?.(`${actionId}: deep research returned nothing (${deep.error ?? deep.summary})`);
      } else {
        const added = (await this.deps.compare(
          { query: String(fast.data?.query ?? ''), fast: String(fast.data?.answer ?? ''), deep: deepAnswer },
          run.controller.signal,
        )).trim();
        addendum = renderAddendum(added, (deep.data?.sources ?? []) as ResearchSource[]);
      }
    } catch (error) {
      if (run.controller.signal.aborted) return;
      this.deps.log?.(`${actionId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.runs.delete(actionId);
      this.settled.add(actionId);
    }
    if (run.controller.signal.aborted) return;
    // Mark the card settled before replacing, so our own action.status is ignored.
    this.registry.replaceActionResult(actionId, addendum ? withAddendum(fast, addendum) : fast);
  }
}

/** The deep additions as a card section, or '' when there are none. */
export function renderAddendum(added: string, deepSources: ResearchSource[]): string {
  if (!added || /^NOTHING\.?$/i.test(added)) return '';
  const unverified = checkAttributions(added, deepSources);
  const warning = unverified.length
    ? `\n\n> ⚠ **Source not verified:** credits ${unverified.map((u) => u.source).join(', ')} without citing ${unverified.length > 1 ? 'them' : 'it'}.`
    : '';
  return `### Deep research adds\n${added}${warning}`;
}

/** A copy of the fast result with `section` appended to the card's markdown. */
export function withAddendum(result: WorkerResult, section: string): WorkerResult {
  const artifacts = result.artifacts?.map((artifact, i) =>
    i === 0 && artifact.type === 'markdown' ? { ...artifact, content: `${artifact.content}\n\n${section}` } : artifact);
  const findings = result.data?.findings;
  return {
    ...result,
    data: result.data && typeof findings === 'string' ? { ...result.data, findings: `${findings}\n\n${section}` } : result.data,
    artifacts,
  };
}
