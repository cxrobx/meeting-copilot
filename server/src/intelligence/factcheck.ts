import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import {
  isOpenAiApiAvailable,
  openaiTriageJson,
  openaiFastResearchStream,
  type FastResearchSource,
} from '../api/openai.js';
import { isAnthropicApiAvailable, anthropicTriageJson } from '../api/anthropic.js';
import {
  FACTCHECK_EXTRACT_SYSTEM,
  FACTCHECK_EXTRACT_SCHEMA,
  FACTCHECK_VERIFY_SYSTEM,
  FACTCHECK_KNOWLEDGE_SYSTEM,
  FACTCHECK_KNOWLEDGE_SCHEMA,
  buildFactcheckExtractPrompt,
  buildFactcheckVerifyPrompt,
  buildFactcheckKnowledgePrompt,
  type ClaimExtractionResult,
  type VerificationResult,
  type KnowledgeAssessment,
  type FactVerdict,
} from './prompts/factcheck.v1.js';

const CHECK_INTERVAL_MS = 25_000;
const MIN_NEW_WORDS_BEFORE_CHECK = 25;
const WINDOW_TAIL_CHARS = 2_400;
const MAX_VERIFICATIONS_PER_MINUTE = 4;
const MIN_CHECK_WORTHINESS = 0.6;
const MIN_FLAG_CONFIDENCE = 0.7;
const MAX_TRACKED_CLAIMS = 60;
// Tier-1 knowledge check: skip web verification entirely when the model is
// at least this confident the claim is correct (and it isn't time-sensitive).
const KNOWLEDGE_CORRECT_CONFIDENCE = 0.8;
// Event-driven triggering off claim-shaped segments.
const TRIGGER_MIN_GAP_MS = 10_000;
const TRIGGER_DEBOUNCE_MS = 1_500;

// Cheap local heuristic for "this text might contain a checkable claim".
// Used both to fire early checks on fresh segments and to skip interval
// sweeps over windows with nothing claim-shaped (no API cost either way).
const CLAIM_SHAPED_PATTERNS = [
  /\d/, // numbers: prices, dates, versions, percentages
  /\b(according to|study|studies|research|benchmark(s|ed)?|report(ed|s)?|documentation|whitepaper)\b/i,
  /\b(always|never|every|everyone|no one|nobody)\b/i,
  /\b(faster|slower|cheaper|costlier|bigger|smaller|better|worse|more|less) than\b/i,
  /\bthe (only|first|last|biggest|largest|most|least)\b/i,
];

export function looksClaimShaped(text: string): boolean {
  return CLAIM_SHAPED_PATTERNS.some((re) => re.test(text));
}

export interface FactFlag {
  id: string;
  claim: string;
  speaker: 'you' | 'meeting';
  quote: string;
  verdict: FactVerdict;
  confidence: number;
  correction: string;
  explanation: string;
  sources: FastResearchSource[];
  webSearched: boolean;
  checkedAt: number;
}

/**
 * Opt-in live fact-checker. Extracts checkable claims from the transcript on
 * a fixed cadence (cheap JSON call), then verifies the worthwhile ones —
 * with web search when OPENAI_API_KEY is set, model-knowledge-only via Haiku
 * otherwise. Only likely_incorrect / disputed verdicts are emitted as flags.
 *
 * Fully inert until start() — no timers, no API calls — so the per-meeting
 * cost is zero unless the user toggles it on.
 */
export class FactCheckMonitor extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private generation = 0;
  private currentCheck: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  private transcriptProvider: () => string = () => '';
  private wordCountProvider: () => number = () => 0;
  private sessionTitle = '';

  private lastCheckWordCount = 0;
  private lastRunAt = 0;
  private triggerTimer: ReturnType<typeof setTimeout> | null = null;
  private checkedClaimHashes = new Set<string>();
  private checkedClaimTexts: string[] = [];
  private verificationTimestamps: number[] = [];

  // Metrics
  public extractionsRun = 0;
  public knowledgeChecksRun = 0;
  public verificationsRun = 0; // tier-2 web verifications only
  public flagsEmitted = 0;

  isRunning(): boolean {
    return this.running;
  }

  start(options: {
    transcriptProvider: () => string;
    wordCountProvider: () => number;
    sessionTitle?: string;
  }): void {
    this.stop();
    this.transcriptProvider = options.transcriptProvider;
    this.wordCountProvider = options.wordCountProvider;
    this.sessionTitle = options.sessionTitle ?? '';
    this.lastCheckWordCount = this.wordCountProvider();

    if (!isOpenAiApiAvailable() && !isAnthropicApiAvailable()) {
      this.emit('error', 'fact-check needs OPENAI_API_KEY or ANTHROPIC_API_KEY');
      return;
    }

    this.running = true;
    this.timer = setInterval(() => {
      this.scheduleCheck('interval').catch(() => {/* surfaced via error event */});
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Event-driven entry: called per transcript segment. Claim-shaped segments
   * fire a check within ~1.5s instead of waiting for the next interval sweep.
   */
  noteSegment(text: string): void {
    if (!this.running || !text || !looksClaimShaped(text)) return;
    if (Date.now() - this.lastRunAt < TRIGGER_MIN_GAP_MS) return;
    if (this.currentCheck || this.triggerTimer) return;
    // Debounce so a burst of segments coalesces into one check.
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = null;
      this.scheduleCheck('claim-shaped').catch(() => {/* surfaced via error event */});
    }, TRIGGER_DEBOUNCE_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.triggerTimer) {
      clearTimeout(this.triggerTimer);
      this.triggerTimer = null;
    }
    this.generation++;
    this.running = false;
    this.lastCheckWordCount = 0;
    this.lastRunAt = 0;
    this.checkedClaimHashes.clear();
    this.checkedClaimTexts = [];
    this.verificationTimestamps = [];
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async scheduleCheck(trigger: string): Promise<void> {
    if (!this.running) return;
    if (this.currentCheck) {
      this.emit('eval', { skipped: 'in-flight', trigger });
      return;
    }

    if (trigger === 'interval') {
      // Interval sweeps gate on word growth AND claim-shaped content, so an
      // idle (or claim-free) stretch costs zero API calls. Triggered checks
      // bypass both — the triggering segment is the signal.
      const words = this.wordCountProvider();
      if (words - this.lastCheckWordCount < MIN_NEW_WORDS_BEFORE_CHECK) {
        this.emit('eval', { skipped: `growth: +${words - this.lastCheckWordCount}/${MIN_NEW_WORDS_BEFORE_CHECK}`, trigger });
        return;
      }
      const window = this.transcriptProvider().slice(-WINDOW_TAIL_CHARS);
      if (!looksClaimShaped(window)) {
        this.emit('eval', { skipped: 'no-claim-shaped-content', trigger });
        return;
      }
    }

    const gen = this.generation;
    const controller = new AbortController();
    this.abortController = controller;
    const task = this.runCheck(gen, trigger, controller.signal)
      .catch((err) => {
        if (gen === this.generation) {
          this.emit('error', err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        this.currentCheck = null;
        if (this.abortController === controller) this.abortController = null;
      });
    this.currentCheck = task;
    await task;
  }

  private async runCheck(gen: number, trigger: string, signal: AbortSignal): Promise<void> {
    const transcript = this.transcriptProvider();
    if (!transcript || transcript.trim().length < 40) return;
    const window = transcript.slice(-WINDOW_TAIL_CHARS);
    this.lastCheckWordCount = this.wordCountProvider();
    this.lastRunAt = Date.now();

    // Stage 1: extract claims
    this.extractionsRun++;
    const extractPrompt = buildFactcheckExtractPrompt(window, this.checkedClaimTexts.slice(-15));
    const raw = isOpenAiApiAvailable()
      ? await openaiTriageJson(extractPrompt, FACTCHECK_EXTRACT_SYSTEM, FACTCHECK_EXTRACT_SCHEMA, { signal, label: 'factcheck-extract' })
      : await anthropicTriageJson(
          `${extractPrompt}\n\nRespond with JSON: {"claims": [{"claim", "speaker" ("you"|"meeting"), "quote", "checkWorthiness" (0-1)}]}`,
          FACTCHECK_EXTRACT_SYSTEM,
          { signal, label: 'factcheck-extract' },
        );
    if (gen !== this.generation) return;

    let extraction: ClaimExtractionResult;
    try {
      extraction = JSON.parse(extractJson(raw)) as ClaimExtractionResult;
    } catch {
      this.emit('eval', { skipped: 'extract-parse-failed' });
      return;
    }

    const candidates = (extraction.claims ?? []).filter((c) => {
      if (!c.claim || c.checkWorthiness < MIN_CHECK_WORTHINESS) return false;
      const hash = hashClaim(c.claim);
      if (this.checkedClaimHashes.has(hash)) return false;
      return true;
    });
    this.emit('eval', { extracted: extraction.claims?.length ?? 0, candidates: candidates.length, trigger });

    for (const candidate of candidates) {
      if (gen !== this.generation) return;

      const hash = hashClaim(candidate.claim);
      this.checkedClaimHashes.add(hash);
      this.checkedClaimTexts.push(candidate.claim);
      if (this.checkedClaimTexts.length > MAX_TRACKED_CLAIMS) this.checkedClaimTexts.shift();

      // ── Tier 1: model-knowledge assessment (cheap, ~sub-second) ──
      this.knowledgeChecksRun++;
      const knowledgePrompt = buildFactcheckKnowledgePrompt(candidate.claim, candidate.quote);
      let assessment: KnowledgeAssessment;
      try {
        const raw2 = isOpenAiApiAvailable()
          ? await openaiTriageJson(knowledgePrompt, FACTCHECK_KNOWLEDGE_SYSTEM, FACTCHECK_KNOWLEDGE_SCHEMA, { signal, label: 'factcheck-knowledge' })
          : await anthropicTriageJson(
              `${knowledgePrompt}\n\nRespond with JSON: {"assessment" ("correct"|"suspect_incorrect"|"uncertain"), "timeSensitive" (bool), "confidence" (0-1), "correction", "explanation"}`,
              FACTCHECK_KNOWLEDGE_SYSTEM,
              { signal, label: 'factcheck-knowledge' },
            );
        assessment = JSON.parse(extractJson(raw2)) as KnowledgeAssessment;
      } catch (err) {
        if (gen === this.generation) {
          this.emit('eval', { knowledgeFailed: candidate.claim.slice(0, 80), error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      if (gen !== this.generation) return;

      // Confident-correct and not time-sensitive → done, no web call, no flag.
      if (assessment.assessment === 'correct' && !assessment.timeSensitive && assessment.confidence >= KNOWLEDGE_CORRECT_CONFIDENCE) {
        this.emit('eval', { verified: candidate.claim.slice(0, 80), tier: 'knowledge', verdict: 'correct', confidence: assessment.confidence, trigger });
        continue;
      }

      // ── Tier 2: web verification for suspect / uncertain / time-sensitive ──
      if (!isOpenAiApiAvailable()) {
        // No web search available: flag only confident knowledge-tier suspicions.
        this.emit('eval', { verified: candidate.claim.slice(0, 80), tier: 'knowledge', verdict: assessment.assessment, confidence: assessment.confidence, trigger });
        if (assessment.assessment === 'suspect_incorrect' && assessment.confidence >= MIN_FLAG_CONFIDENCE) {
          this.flagsEmitted++;
          this.emit('flag', {
            id: randomUUID(),
            claim: candidate.claim,
            speaker: candidate.speaker,
            quote: candidate.quote,
            verdict: 'likely_incorrect',
            confidence: assessment.confidence,
            correction: assessment.correction ?? '',
            explanation: assessment.explanation ?? '',
            sources: [],
            webSearched: false,
            checkedAt: Date.now(),
          } satisfies FactFlag);
        }
        continue;
      }

      if (!this.takeVerificationSlot()) {
        this.emit('eval', { skipped: 'verification-budget', trigger });
        return;
      }

      this.verificationsRun++;
      const verifyPrompt = buildFactcheckVerifyPrompt(candidate.claim, candidate.quote, this.sessionTitle);
      let verdictRaw: string;
      let sources: FastResearchSource[] = [];
      try {
        const res = await openaiFastResearchStream({
          systemPrompt: FACTCHECK_VERIFY_SYSTEM,
          userContent: verifyPrompt,
          signal,
          label: 'factcheck-verify',
        });
        verdictRaw = res.text;
        sources = res.sources;
      } catch (err) {
        if (gen === this.generation) {
          this.emit('eval', { verifyFailed: candidate.claim.slice(0, 80), error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      if (gen !== this.generation) return;

      let verification: VerificationResult;
      try {
        verification = JSON.parse(extractJson(verdictRaw)) as VerificationResult;
      } catch {
        this.emit('eval', { skipped: 'verify-parse-failed', claim: candidate.claim.slice(0, 80) });
        continue;
      }

      const flaggable = verification.verdict === 'likely_incorrect' || verification.verdict === 'disputed';
      this.emit('eval', { verified: candidate.claim.slice(0, 80), tier: 'web', verdict: verification.verdict, confidence: verification.confidence, trigger });
      if (!flaggable || verification.confidence < MIN_FLAG_CONFIDENCE) continue;

      this.flagsEmitted++;
      const flag: FactFlag = {
        id: randomUUID(),
        claim: candidate.claim,
        speaker: candidate.speaker,
        quote: candidate.quote,
        verdict: verification.verdict,
        confidence: verification.confidence,
        correction: verification.correction ?? '',
        explanation: verification.explanation ?? '',
        sources,
        webSearched: true,
        checkedAt: Date.now(),
      };
      this.emit('flag', flag);
    }
  }

  /** Sliding-window rate limiter for verification calls. */
  private takeVerificationSlot(): boolean {
    const now = Date.now();
    this.verificationTimestamps = this.verificationTimestamps.filter((t) => now - t < 60_000);
    if (this.verificationTimestamps.length >= MAX_VERIFICATIONS_PER_MINUTE) return false;
    this.verificationTimestamps.push(now);
    return true;
  }
}

function hashClaim(claim: string): string {
  const normalized = claim.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(normalized).digest('hex');
}

/** Pull the outermost JSON object out of a possibly-prose-wrapped response. */
function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return text;
  return text.slice(start, end + 1);
}
