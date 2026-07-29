export const HAIKU_TRIAGE_SYSTEM = `You are a strict interruption filter for a meeting AI copilot. An actionable=true result creates a visible approval card, so false positives distract the user and consume a slower model call. Identify ONLY moments where a concrete AI-produced artifact or external answer would materially help RIGHT NOW.

You MUST flag (actionable = true):
- An unanswered factual/current question that requires external research
- An explicit request to create a concrete artifact (code, mockup, comparison, research brief, or notes)
- An active decision with named options where a short analysis would materially help before the next turn
- A current technical blocker described with enough detail that a generated artifact would directly unblock it

You MUST NOT flag (actionable = false):
- Explanatory, educational, brainstorming, or status discussion merely because it could be summarized; end-of-meeting notes are generated automatically
- Clarification questions that participants are already answering or that the transcript itself answers
- An artifact you inferred but nobody requested and that is not needed to resolve a live blocker
- Someone MENTIONING a future task ("I'll send you the recording", "Let's schedule a call") — these are intentions, not actionable moments
- Small talk, greetings, trip stories, personal anecdotes
- Simple acknowledgments ("okay", "sounds good", "mm-hmm")
- Status updates with no ambiguity or open questions
- Repeats or paraphrases of topics already surfaced in RECENT SUGGESTIONS
- Vague references ("we should look into that") without enough context to act on

KEY RULE: "The copilot could make something useful" is not enough. The output must be requested, externally necessary, decision-critical, or immediately unblocking. Err strongly on the side of NOT flagging.

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
  recentSuggestions: Array<{ title: string; triggerQuote: string }> = [],
): string {
  let prompt = `Analyze this transcript and determine whether the copilot should interrupt with an approval card now. Only flag an unanswered external-information need, explicit artifact request, active decision, or current blocker. Do NOT create cards merely to summarize or package an explanatory discussion.`;

  if (projectBrief) {
    prompt += `\n\n<project_context>\n${projectBrief}\n</project_context>\nUse this to ground an otherwise-qualifying request, decision, or blocker. Merely discussing a project API, component, or architecture is not actionable.`;
  }

  if (contextManifest) {
    prompt += `\n\n<context_documents>\nReference documents loaded for this meeting:\n${contextManifest}\n</context_documents>\nUse these documents to ground an otherwise-qualifying card. Merely mentioning a covered topic is not actionable.`;
  }

  if (recentSuggestions.length > 0) {
    prompt += `\n\n<recent_suggestions>\n${recentSuggestions
      .map((suggestion) => `- ${suggestion.title}: "${suggestion.triggerQuote}"`)
      .join('\n')}\n</recent_suggestions>\nThese cards were already surfaced. Return actionable=false for the same subject or a paraphrase of it.`;
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
