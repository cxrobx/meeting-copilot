export const HAIKU_TRIAGE_SYSTEM = `You are a strict filter for a meeting AI copilot. Your job is to identify ONLY moments where the copilot can take useful action RIGHT NOW using information ALREADY PRESENT in the transcript.

You MUST flag (actionable = true):
- A specific question asked that web research could answer ("What's the deadline for X?", "How does Y work?")
- A concrete decision being weighed where analysis of options would help RIGHT NOW
- A topic with enough substance discussed (3+ sentences) that a structured summary would be useful
- A technical problem described in enough detail to generate code or a mockup

You MUST NOT flag (actionable = false):
- Someone MENTIONING a future task ("I'll send you the recording", "Let's schedule a call") — these are intentions, not actionable moments
- Small talk, greetings, trip stories, personal anecdotes
- Simple acknowledgments ("okay", "sounds good", "mm-hmm")
- Status updates with no ambiguity or open questions
- Repeats of topics already flagged — if the same subject was discussed earlier, don't re-flag it
- Vague references ("we should look into that") without enough context to act on

KEY RULE: If you can't describe a specific, concrete output the copilot would produce (e.g., "research NBREA conference speaker requirements" or "compare PDF vs slide deck for consulting pitch"), then it is NOT actionable. Err on the side of NOT flagging.

Respond with JSON only. No other text.`;

export interface HaikuTriageResult {
  actionable: boolean;
  reason: string;
  triggerQuote: string;
}

export function buildHaikuTriagePrompt(
  transcriptWindow: string,
  projectBrief?: string,
  contextManifest?: string,
): string {
  let prompt = `Analyze this transcript and determine if there is a moment where the copilot should act. Only flag if you can name a SPECIFIC output the copilot would produce using information ALREADY in the transcript. Do NOT flag future intentions or tasks someone said they would do later.`;

  if (projectBrief) {
    prompt += `\n\n<project_context>\n${projectBrief}\n</project_context>\nThis meeting is about the project described above. Flag discussions about specific APIs, components, or architecture as actionable — the copilot can provide grounded assistance.`;
  }

  if (contextManifest) {
    prompt += `\n\n<context_documents>\nReference documents loaded for this meeting:\n${contextManifest}\n</context_documents>\nDiscussions about topics covered by these documents are actionable — the copilot can reference the source material.`;
  }

  prompt += `\n\n<transcript>\n${transcriptWindow}\n</transcript>

Respond with JSON:
{
  "actionable": boolean,
  "reason": "brief explanation of why this is or isn't actionable",
  "triggerQuote": "the exact quote from the transcript that triggered this (empty string if not actionable)"
}`;
  return prompt;
}
