// Fact-check prompts, v1.
// Two stages: (1) cheap claim extraction from the latest transcript window,
// (2) verification of extracted claims (web search when available).

export interface ExtractedClaim {
  claim: string;
  speaker: 'you' | 'meeting';
  quote: string;
  checkWorthiness: number; // 0-1
}

export interface ClaimExtractionResult {
  claims: ExtractedClaim[];
}

export const FACTCHECK_EXTRACT_SYSTEM = `You extract VERIFIABLE FACTUAL CLAIMS from live meeting transcripts so they can be fact-checked.

Extract a claim ONLY when ALL of these hold:
- It is a specific, objective assertion about the world (numbers, dates, names, prices, technical capabilities, historical events, published research).
- It could plausibly be wrong AND being wrong would matter to the discussion.
- It is stated as fact, not hedged ("I think", "maybe", "roughly") or framed as opinion, preference, prediction, or personal anecdote.
- It is NOT about the meeting participants' own internal plans, feelings, or company-private matters that public sources cannot verify.

Return at most 3 claims per window — the most consequential ones. Return an empty list when nothing qualifies; that is the common case and is the correct answer for small talk, planning chatter, and opinions.

Respond with JSON only.`;

export function buildFactcheckExtractPrompt(
  transcriptWindow: string,
  alreadyChecked: string[],
): string {
  const seen = alreadyChecked.length > 0
    ? `\n\nAlready checked this meeting (do NOT re-extract these or trivial restatements of them):\n${alreadyChecked.map((c) => `- ${c}`).join('\n')}`
    : '';
  return `Latest transcript window ("You" = the user's mic, "Meeting" = other participants):\n\n${transcriptWindow}${seen}`;
}

export const FACTCHECK_EXTRACT_SCHEMA = {
  name: 'claim_extraction',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['claims'],
    properties: {
      claims: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claim', 'speaker', 'quote', 'checkWorthiness'],
          properties: {
            claim: { type: 'string', description: 'The factual claim, restated as a standalone verifiable statement' },
            speaker: { type: 'string', enum: ['you', 'meeting'] },
            quote: { type: 'string', description: 'Short verbatim quote from the transcript containing the claim' },
            checkWorthiness: { type: 'number', description: '0-1: how specific, consequential and checkable this is' },
          },
        },
      },
    },
  },
} as const;

// ─── Tier 1: model-knowledge assessment (cheap, fast — no tools) ──────────
// Routes the claim: confident-correct stops here; suspect / uncertain /
// time-sensitive claims escalate to web verification.

export interface KnowledgeAssessment {
  assessment: 'correct' | 'suspect_incorrect' | 'uncertain';
  timeSensitive: boolean;
  confidence: number; // 0-1
  correction: string;
  explanation: string;
}

export const FACTCHECK_KNOWLEDGE_SYSTEM = `You assess a factual claim from a live meeting using ONLY your own knowledge — no tools, no searching.

- "correct": you are confident the claim is accurate (minor rounding or paraphrase is still correct).
- "suspect_incorrect": you believe it is wrong. Provide the correction and a one-sentence explanation.
- "uncertain": you genuinely cannot tell either way.

Set timeSensitive=true when settling the claim requires current data — prices, latest versions, recent events, market figures, anything likely to have changed since your training data.

Be honest about uncertainty: "uncertain" routes the claim to web verification, which is the safe path. A confident wrong answer here is the worst outcome.

Respond with JSON only.`;

export function buildFactcheckKnowledgePrompt(claim: string, quote: string): string {
  return `Claim: ${claim}\nAs said in the meeting: "${quote}"`;
}

export const FACTCHECK_KNOWLEDGE_SCHEMA = {
  name: 'knowledge_assessment',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['assessment', 'timeSensitive', 'confidence', 'correction', 'explanation'],
    properties: {
      assessment: { type: 'string', enum: ['correct', 'suspect_incorrect', 'uncertain'] },
      timeSensitive: { type: 'boolean' },
      confidence: { type: 'number', description: '0-1 confidence in the assessment' },
      correction: { type: 'string', description: 'Corrected fact when suspect_incorrect, else empty' },
      explanation: { type: 'string', description: 'One sentence, empty when assessment is correct' },
    },
  },
} as const;

export type FactVerdict = 'correct' | 'likely_incorrect' | 'disputed' | 'unverifiable';

export interface VerificationResult {
  verdict: FactVerdict;
  confidence: number; // 0-1
  correction: string; // empty when verdict is correct/unverifiable
  explanation: string;
}

export const FACTCHECK_VERIFY_SYSTEM = `You verify a single factual claim made during a live meeting. Use web search when you need current or specific information.

Verdict rules:
- "correct": the claim is accurate (minor rounding/paraphrase is still correct).
- "likely_incorrect": reliable sources contradict the claim. Provide the correction.
- "disputed": credible sources genuinely disagree.
- "unverifiable": you cannot establish it either way. Prefer this over guessing.

Be conservative: a false flag interrupts a live meeting and erodes trust. Only use "likely_incorrect" when you are confident. Keep the explanation to one or two sentences.

Respond with ONLY a JSON object, no prose before or after:
{"verdict": "...", "confidence": 0.0, "correction": "...", "explanation": "..."}`;

export function buildFactcheckVerifyPrompt(claim: string, quote: string, meetingTitle: string): string {
  return `Meeting: ${meetingTitle || 'untitled'}\nClaim to verify: ${claim}\nAs said in the meeting: "${quote}"`;
}
