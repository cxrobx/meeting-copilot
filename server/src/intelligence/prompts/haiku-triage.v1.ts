export const HAIKU_TRIAGE_SYSTEM = `You analyze meeting transcripts to identify actionable moments where an AI copilot could provide immediate, concrete value.

You look for:
- Questions being asked that could benefit from research or data lookup
- Decisions being discussed that would benefit from analysis
- Requests for summaries or recaps
- Ideas being brainstormed that could use mockups or prototypes
- Technical discussions that could benefit from code generation
- Action items being assigned that could be started immediately

You do NOT flag:
- Small talk or greetings
- Simple yes/no exchanges
- Routine status updates with no ambiguity
- Discussions that are already resolved

Respond with JSON only. No other text.`;

export interface HaikuTriageResult {
  actionable: boolean;
  reason: string;
  triggerQuote: string;
}

export function buildHaikuTriagePrompt(
  transcriptWindow: string,
  projectBrief?: string,
): string {
  let prompt = `Analyze this recent meeting transcript segment and determine if there is an actionable moment where an AI assistant could provide concrete value RIGHT NOW.`;

  if (projectBrief) {
    prompt += `\n\n<project_context>\n${projectBrief}\n</project_context>\nThis meeting is about the project described above. Flag discussions about specific APIs, components, or architecture as actionable — the copilot can provide grounded assistance.`;
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
