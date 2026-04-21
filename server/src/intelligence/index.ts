import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { claudeTriage, claudeSuggest } from '../claude-cli.js';
import { isOpenAiApiAvailable, openaiTriageJson } from '../api/openai.js';
import type { TranscriptSegment } from '../transcription/types.js';
import type { ActionSuggestion } from '../workers/types.js';
import type { ProjectContext } from '../project/index.js';
import { formatProjectBrief } from '../project/index.js';
import type { ContextDoc } from '../context/index.js';
import { buildContextManifest, buildContextBlock } from '../context/index.js';
import {
  HAIKU_TRIAGE_SYSTEM,
  buildHaikuTriagePrompt,
  type HaikuTriageResult,
} from './prompts/haiku-triage.v1.js';
import {
  SONNET_SUGGEST_SYSTEM,
  buildSonnetSuggestPrompt,
  buildSonnetSuggestPromptSplit,
  type SonnetSuggestionResult,
} from './prompts/sonnet-suggest.v1.js';
import { isAnthropicApiAvailable, anthropicSuggestStream } from '../api/anthropic.js';

const WINDOW_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const BASE_EVAL_INTERVAL_MS = 15_000;
const BACKOFF_EVAL_INTERVAL_MS = 30_000;
const MAX_EVAL_IN_FLIGHT = 2;
const EVAL_QUEUE_DEPTH = 3;
const CONTEXT_COMPRESSION_INTERVAL_MS = 5 * 60 * 1000;
const OVERLAP_HISTORY_SIZE = 5;
const OVERLAP_THRESHOLD = 0.8;

const IMMEDIATE_TRIGGERS = [
  '?',
  'should we',
  "let's",
  'what if',
];

export class IntelligenceEngine extends EventEmitter {
  private segments: TranscriptSegment[] = [];
  private evalTimer: ReturnType<typeof setInterval> | null = null;
  private compressionTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private consecutiveNonActionable = 0;
  private evalInFlight = 0;
  private evalQueue: Array<() => Promise<void>> = [];
  private recentWindowHashes: string[] = [];
  private recentWindowWordSets: Set<string>[] = [];
  private contextSummaries: Array<{
    summary: string;
    windowStart: number;
    windowEnd: number;
    createdAt: number;
  }> = [];

  // Project names to watch for - can be configured externally
  public projectNames: string[] = [];
  private projectContext: ProjectContext[] = [];
  private meetingContext: { agenda?: string; attendees?: string } = {};
  private contextDocs: ContextDoc[] = [];
  private contextManifest: string = '';

  // Metrics
  public evalsRun = 0;
  public haikuActionableCount = 0;
  public sonnetCallCount = 0;
  public totalSuggestionLatencyMs = 0;

  private suggestionCallback:
    | ((suggestion: ActionSuggestion) => void)
    | null = null;
  private contextSummaryCallback:
    | ((summary: { summary: string; windowStart: number; windowEnd: number }) => void)
    | null = null;

  constructor() {
    super();
  }

  onSuggestion(callback: (suggestion: ActionSuggestion) => void): void {
    this.suggestionCallback = callback;
  }

  onContextSummary(
    callback: (summary: {
      summary: string;
      windowStart: number;
      windowEnd: number;
    }) => void,
  ): void {
    this.contextSummaryCallback = callback;
  }

  setProjectContext(contexts: ProjectContext[]): void {
    this.projectContext = contexts;
    this.projectNames = contexts.map((c) => c.name);
  }

  getProjectContext(): ProjectContext[] {
    return this.projectContext;
  }

  setMeetingContext(context: { agenda?: string; attendees?: string }): void {
    this.meetingContext = context;
  }

  getMeetingContext(): { agenda?: string; attendees?: string } {
    return this.meetingContext;
  }

  setContextDocs(docs: ContextDoc[]): void {
    this.contextDocs = docs;
    this.contextManifest = docs.length > 0 ? buildContextManifest(docs) : '';
  }

  getContextDocs(): ContextDoc[] {
    return this.contextDocs;
  }

  addTranscript(segment: TranscriptSegment): void {
    this.segments.push(segment);

    // Check for immediate triggers
    if (this.running && this.shouldTriggerImmediate(segment.text)) {
      this.scheduleEval();
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Start adaptive eval loop
    this.resetEvalTimer();

    // Start context compression timer
    this.compressionTimer = setInterval(() => {
      this.compressOldContext();
    }, CONTEXT_COMPRESSION_INTERVAL_MS);

    this.emit('started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.evalTimer) {
      clearInterval(this.evalTimer);
      this.evalTimer = null;
    }
    if (this.compressionTimer) {
      clearInterval(this.compressionTimer);
      this.compressionTimer = null;
    }

    this.projectContext = [];
    this.meetingContext = {};
    this.contextDocs = [];
    this.contextManifest = '';

    this.emit('stopped');
  }

  get isRunning(): boolean {
    return this.running;
  }

  get haikuHitRate(): number {
    return this.evalsRun > 0 ? this.haikuActionableCount / this.evalsRun : 0;
  }

  get sonnetCallRate(): number {
    return this.evalsRun > 0 ? this.sonnetCallCount / this.evalsRun : 0;
  }

  get avgSuggestionLatencyMs(): number {
    return this.sonnetCallCount > 0
      ? this.totalSuggestionLatencyMs / this.sonnetCallCount
      : 0;
  }

  getTranscriptWindow(): string {
    const cutoff = Date.now() - WINDOW_DURATION_MS;
    const windowSegments = this.segments.filter(
      (s) => s.timestamp >= cutoff && s.text.length > 0,
    );
    const transcript = windowSegments
      .map((s) => `${s.label} ${s.text}`)
      .join('\n');

    // Prepend meeting context header if available
    const contextParts: string[] = [];
    if (this.meetingContext.agenda) {
      contextParts.push(`Meeting Agenda: ${this.meetingContext.agenda}`);
    }
    if (this.meetingContext.attendees) {
      contextParts.push(`Attendees: ${this.meetingContext.attendees}`);
    }
    if (contextParts.length > 0) {
      return `[Meeting Context]\n${contextParts.join('\n')}\n\n[Transcript]\n${transcript}`;
    }
    return transcript;
  }

  getFullTranscript(): string {
    return this.segments
      .filter((s) => s.text.length > 0)
      .map((s) => `${s.label} ${s.text}`)
      .join('\n');
  }

  private shouldTriggerImmediate(text: string): boolean {
    const lower = text.toLowerCase();
    for (const trigger of IMMEDIATE_TRIGGERS) {
      if (lower.includes(trigger)) return true;
    }
    for (const name of this.projectNames) {
      if (lower.includes(name.toLowerCase())) return true;
    }
    return false;
  }

  private resetEvalTimer(): void {
    if (this.evalTimer) {
      clearInterval(this.evalTimer);
    }

    const interval =
      this.consecutiveNonActionable >= 3
        ? BACKOFF_EVAL_INTERVAL_MS
        : BASE_EVAL_INTERVAL_MS;

    this.evalTimer = setInterval(() => {
      this.scheduleEval();
    }, interval);
  }

  private scheduleEval(): void {
    if (!this.running) return;

    // Bounded queue: drop if too deep
    if (this.evalQueue.length >= EVAL_QUEUE_DEPTH) return;

    const evalFn = async () => {
      await this.runEvaluation();
    };

    if (this.evalInFlight < MAX_EVAL_IN_FLIGHT) {
      this.evalInFlight++;
      evalFn().finally(() => {
        this.evalInFlight--;
        this.drainEvalQueue();
      });
    } else {
      this.evalQueue.push(evalFn);
    }
  }

  private drainEvalQueue(): void {
    while (
      this.evalInFlight < MAX_EVAL_IN_FLIGHT &&
      this.evalQueue.length > 0
    ) {
      const next = this.evalQueue.shift()!;
      this.evalInFlight++;
      next().finally(() => {
        this.evalInFlight--;
        this.drainEvalQueue();
      });
    }
  }

  private async runEvaluation(): Promise<void> {
    const window = this.getTranscriptWindow();
    if (!window || window.trim().length < 20) return;

    // Overlap dedup
    const windowHash = this.hashWindow(window);
    const windowWords = new Set(window.toLowerCase().split(/\s+/).filter(Boolean));
    if (this.isOverlapping(windowHash, windowWords)) return;

    this.recentWindowHashes.push(windowHash);
    this.recentWindowWordSets.push(windowWords);
    if (this.recentWindowHashes.length > OVERLAP_HISTORY_SIZE) {
      this.recentWindowHashes.shift();
      this.recentWindowWordSets.shift();
    }

    this.evalsRun++;
    const startTime = Date.now();

    try {
      // Tier 1: Haiku triage
      const triageResult = await this.runHaikuTriage(window);
      this.emit('intelligence.eval', {
        tier: 1,
        actionable: triageResult.actionable,
        reason: triageResult.reason,
      });

      if (!triageResult.actionable) {
        this.consecutiveNonActionable++;
        if (this.consecutiveNonActionable === 3) {
          this.resetEvalTimer(); // Switch to backoff
        }
        return;
      }

      this.consecutiveNonActionable = 0;
      this.haikuActionableCount++;
      this.resetEvalTimer(); // Back to base interval

      // Tier 2: Sonnet suggestion
      this.sonnetCallCount++;
      const suggestion = await this.runSonnetSuggestion(window, triageResult);
      const latency = Date.now() - startTime;
      this.totalSuggestionLatencyMs += latency;

      if (suggestion) {
        this.emit('intelligence.suggestion', suggestion);
        if (this.suggestionCallback) {
          this.suggestionCallback(suggestion);
        }
      }
    } catch (error) {
      this.emit('intelligence.error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runHaikuTriage(window: string): Promise<HaikuTriageResult> {
    const projectBrief = this.projectContext.length > 0
      ? formatProjectBrief(this.projectContext[0]!)
      : undefined;
    const prompt = buildHaikuTriagePrompt(
      window,
      projectBrief,
      this.contextManifest || undefined,
    );

    // Prefer GPT-5.4 Mini via OpenAI Responses API when OPENAI_API_KEY is
    // set. This is the realtime-critical path — removing the CLI spawn and
    // using a model tuned for fast short JSON output cuts triage latency
    // from 2–5s (with 30s+ tail-risk stalls) to 400–800ms.
    if (isOpenAiApiAvailable()) {
      try {
        const text = await openaiTriageJson(
          prompt,
          HAIKU_TRIAGE_SYSTEM,
          {
            name: 'triage_result',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['actionable', 'reason', 'triggerQuote'],
              properties: {
                actionable: { type: 'boolean' },
                reason: { type: 'string' },
                triggerQuote: { type: 'string' },
              },
            },
          },
          { timeoutMs: 8_000 },
        );
        return JSON.parse(text) as HaikuTriageResult;
      } catch (err) {
        // Fall through to CLI path on any API failure so the loop stays
        // alive if the key is bad or the service blips.
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('intelligence.error', { error: `[openai-triage] ${msg}` });
      }
    }

    // CLI fallback — Gemini → Haiku → Codex chain.
    const text = await claudeTriage(prompt, HAIKU_TRIAGE_SYSTEM);
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as HaikuTriageResult;
      }
      return JSON.parse(text) as HaikuTriageResult;
    } catch {
      return { actionable: false, reason: 'Failed to parse triage response', triggerQuote: '' };
    }
  }

  private async runSonnetSuggestion(
    window: string,
    triageResult: HaikuTriageResult,
  ): Promise<ActionSuggestion | null> {
    const projectBriefs = this.projectContext.map((c) => formatProjectBrief(c));
    const contextBlock = this.contextDocs.length > 0
      ? buildContextBlock(this.contextDocs, triageResult.triggerQuote)
      : undefined;

    let text: string;

    if (isAnthropicApiAvailable()) {
      try {
        const { staticPrefix, dynamicTail } = buildSonnetSuggestPromptSplit(
          window,
          {
            reason: triageResult.reason,
            triggerQuote: triageResult.triggerQuote,
          },
          projectBriefs.length > 0 ? projectBriefs : undefined,
          contextBlock,
        );
        const result = await anthropicSuggestStream({
          systemPrompt: SONNET_SUGGEST_SYSTEM,
          staticContext: staticPrefix,
          dynamicTail,
        });
        text = result.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('intelligence.error', { error: `[anthropic-suggest] ${msg}` });
        // Fall back to CLI so a single API blip doesn't kill the loop.
        text = await claudeSuggest(
          buildSonnetSuggestPrompt(
            window,
            {
              reason: triageResult.reason,
              triggerQuote: triageResult.triggerQuote,
            },
            projectBriefs.length > 0 ? projectBriefs : undefined,
            contextBlock,
          ),
          SONNET_SUGGEST_SYSTEM,
        );
      }
    } else {
      text = await claudeSuggest(
        buildSonnetSuggestPrompt(
          window,
          {
            reason: triageResult.reason,
            triggerQuote: triageResult.triggerQuote,
          },
          projectBriefs.length > 0 ? projectBriefs : undefined,
          contextBlock,
        ),
        SONNET_SUGGEST_SYSTEM,
      );
    }

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const raw = jsonMatch ? jsonMatch[0] : text;
      const result = JSON.parse(raw) as SonnetSuggestionResult;
      return {
        type: result.type,
        title: result.title,
        description: result.description,
        triggerQuote: result.triggerQuote,
        estimatedDurationSec: result.estimatedDurationSec,
        params: result.params,
      };
    } catch {
      return null;
    }
  }

  private hashWindow(window: string): string {
    return createHash('sha256').update(window).digest('hex');
  }

  private isOverlapping(newHash: string, newWords: Set<string>): boolean {
    if (this.recentWindowHashes.includes(newHash)) return true;

    // Check Jaccard similarity against recent eval windows
    for (const prevWords of this.recentWindowWordSets) {
      let intersection = 0;
      for (const word of newWords) {
        if (prevWords.has(word)) intersection++;
      }
      const union = newWords.size + prevWords.size - intersection;
      if (union > 0 && intersection / union >= OVERLAP_THRESHOLD) {
        return true;
      }
    }

    return false;
  }

  private async compressOldContext(): Promise<void> {
    const cutoff = Date.now() - WINDOW_DURATION_MS;
    const oldSegments = this.segments.filter(
      (s) => s.timestamp < cutoff && s.text.length > 0,
    );

    if (oldSegments.length < 10) return; // Not enough to compress

    const oldText = oldSegments
      .map((s) => `${s.label} ${s.text}`)
      .join('\n');

    try {
      const summary = await claudeTriage(
        oldText,
        'Summarize this meeting transcript excerpt into a concise paragraph preserving key decisions, action items, and topics discussed. Be factual and specific.',
      );

      if (summary) {
        const summaryRecord = {
          summary,
          windowStart: oldSegments[0]!.timestamp,
          windowEnd: oldSegments[oldSegments.length - 1]!.timestamp,
          createdAt: Date.now(),
        };

        this.contextSummaries.push(summaryRecord);

        if (this.contextSummaryCallback) {
          this.contextSummaryCallback(summaryRecord);
        }

        this.emit('intelligence.compression', summaryRecord);

        // Remove compressed segments
        this.segments = this.segments.filter(
          (s) => s.timestamp >= cutoff,
        );
      }
    } catch (error) {
      this.emit('intelligence.error', {
        error: `Context compression failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
