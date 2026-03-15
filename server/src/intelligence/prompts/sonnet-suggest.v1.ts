export const SONNET_SUGGEST_SYSTEM = `You generate specific, executable action suggestions from meeting conversations. Each suggestion must be something an AI worker can accomplish in under 5 minutes.

Available action types:
- "research": Look up information, find data, investigate a topic
- "summary": Generate meeting notes, recaps, or action item lists
- "mockup": Create a UI wireframe with component layout and ASCII visualization
- "codegen": Generate code files (API endpoints, functions, components) from discussion
- "analysis": Analyze data, compare options, evaluate trade-offs

Guidelines:
- Be specific in your title and description - vague suggestions are useless
- The triggerQuote must be an exact substring from the transcript
- estimatedDurationSec should be realistic (15-300 seconds)
- params should contain everything the worker needs to execute
- Prefer smaller, focused suggestions over broad ones

When project context is provided:
- Reference actual files, modules, and architecture from the project
- For codegen, specify target files and follow the project's conventions
- For analysis, ground comparisons in the project's existing choices

Respond with JSON only. No other text.`;

export interface SonnetSuggestionResult {
  type: 'research' | 'summary' | 'mockup' | 'codegen' | 'analysis';
  title: string;
  description: string;
  triggerQuote: string;
  estimatedDurationSec: number;
  params: Record<string, any>;
}

export function buildSonnetSuggestPrompt(
  transcriptWindow: string,
  triageResult: { reason: string; triggerQuote: string },
  projectBriefs?: string[],
): string {
  let prompt = `Based on this meeting transcript and the identified actionable moment, generate a specific action suggestion that an AI worker can execute immediately.`;

  if (projectBriefs?.length) {
    prompt += `\n\n<project_context>\n${projectBriefs.join('\n\n---\n\n')}\n</project_context>\nGround suggestions in the actual codebase. Reference real files, services, and patterns. For codegen, include target file paths. For research, focus on the project's tech stack.`;
  }

  prompt += `\n\n<transcript>\n${transcriptWindow}\n</transcript>

<triage_analysis>
Reason: ${triageResult.reason}
Trigger: "${triageResult.triggerQuote}"
</triage_analysis>

Respond with JSON:
{
  "type": "research" | "summary" | "mockup" | "codegen" | "analysis",
  "title": "Short, specific title (under 60 chars)",
  "description": "Clear description of what the worker should do",
  "triggerQuote": "exact quote from transcript that triggered this",
  "estimatedDurationSec": number,
  "params": {
    // type-specific parameters the worker needs
    // For research: { "query": "...", "context": "..." }
    // For summary: { "scope": "full" | "recent", "focus": "..." }
    // For mockup: { "description": "...", "context": "...", "platform": "web"|"mobile"|"desktop", "style": "minimal"|"detailed" }
    // For codegen: { "task": "...", "context": "...", "language": "typescript", "framework": "express", "style": "scaffold"|"complete"|"snippet" }
    // For analysis: { "topic": "...", "context": "...", "compareOptions": [...] }
  }
}`;
  return prompt;
}
