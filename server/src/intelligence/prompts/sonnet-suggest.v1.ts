export const SONNET_SUGGEST_SYSTEM = `You generate specific, executable action suggestions from meeting conversations. Each suggestion must be something an AI worker can accomplish in under 5 minutes.

Available action types:
- "research": Look up information, find data, investigate a topic
- "summary": Generate meeting notes, recaps, or action item lists
- "mockup": Create a UI wireframe with component layout and ASCII visualization
- "codegen": Generate code files (API endpoints, functions, components) from discussion
- "analysis": Analyze data, compare options, evaluate trade-offs

Type selection — prefer "mockup" for anything visual:
- If the discussion describes or asks about a UI surface — a screen, page, view, layout, form, dashboard, table, list view, flow, or "what it should look like" — choose "mockup", even when "research" or "analysis" could also apply. A described interface is a strong mockup signal; do NOT default to "analysis" for it. When in doubt between "mockup" and "analysis"/"research" for something a user would SEE, pick "mockup".

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

/**
 * Build the prompt as two halves: a session-stable prefix suitable for
 * prompt caching, and a per-call tail that changes on every invocation.
 *
 * The API path (Anthropic SDK with cache_control) uses this split so the
 * system+project+context prefix is cached after the first call and later
 * calls only pay full input cost for the transcript window + triage tail.
 *
 * CLI callers can still use `buildSonnetSuggestPrompt()` below which is
 * the old monolithic builder — it now delegates to this one.
 */
export function buildSonnetSuggestPromptSplit(
  transcriptWindow: string,
  triageResult: { reason: string; triggerQuote: string },
  projectBriefs?: string[],
  contextBlock?: string,
): { staticPrefix: string; dynamicTail: string } {
  let staticPrefix = `Based on this meeting transcript and the identified actionable moment, generate a specific action suggestion that an AI worker can execute immediately.`;

  if (projectBriefs?.length) {
    staticPrefix += `\n\n<project_context>\n${projectBriefs.join('\n\n---\n\n')}\n</project_context>\nGround suggestions in the actual codebase. Reference real files, services, and patterns. For codegen, include target file paths. For research, focus on the project's tech stack.`;
  }

  if (contextBlock) {
    staticPrefix += `\n\n<context_documents>\n${contextBlock}\n</context_documents>\nUse these reference documents to ground your suggestions. Cite specific details from the documents when relevant.`;
  }

  const dynamicTail = `\n\n<transcript>\n${transcriptWindow}\n</transcript>

<triage_analysis>
Reason: ${triageResult.reason}
Trigger: "${triageResult.triggerQuote}"
</triage_analysis>

Respond with JSON only. Emit the keys in EXACTLY this order — "type", "title",
then "params" — so the worker can begin the moment "params" is complete, before
you finish writing the rest:
{
  "type": "research" | "summary" | "mockup" | "codegen" | "analysis",
  "title": "Short, specific title (under 60 chars)",
  "params": {
    // type-specific parameters the worker needs
    // For research: { "query": "...", "context": "..." }
    // For summary: { "scope": "full" | "recent", "focus": "..." }
    // For mockup: { "description": "...", "context": "...", "platform": "web"|"mobile"|"desktop", "style": "minimal"|"detailed" }
    // For codegen: { "task": "...", "context": "...", "language": "typescript", "framework": "express", "style": "scaffold"|"complete"|"snippet" }
    // For analysis: { "topic": "...", "context": "...", "compareOptions": [...] }
  },
  "description": "Clear description of what the worker should do",
  "triggerQuote": "exact quote from transcript that triggered this",
  "estimatedDurationSec": number
}`;

  return { staticPrefix, dynamicTail };
}

export function buildSonnetSuggestPrompt(
  transcriptWindow: string,
  triageResult: { reason: string; triggerQuote: string },
  projectBriefs?: string[],
  contextBlock?: string,
): string {
  const { staticPrefix, dynamicTail } = buildSonnetSuggestPromptSplit(
    transcriptWindow,
    triageResult,
    projectBriefs,
    contextBlock,
  );
  return staticPrefix + dynamicTail;
}
