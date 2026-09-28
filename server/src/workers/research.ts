import { claudeSuggest } from '../claude-cli.js';
import { MODEL_CONFIG, EFFORT_CONFIG } from '../model-config.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';
import { checkAttributions, citationFooter, extractUrlSources, stripSourceList } from './citations.js';

export class ResearchWorker implements Worker {
  public readonly name = 'research';
  public readonly capabilities: WorkerCapabilities = {
    network: 'web-search',
    filesystem: { read: [], write: [] },
    subprocess: false,
    // Generous safety cap (~15 min): jobs run until done or the user cancels.
    maxDurationMs: 900_000,
    maxMemoryMB: 100,
  };

  async execute(
    params: Record<string, any>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const query = params.query as string | undefined;
    const context = params.context as string | undefined;

    if (!query) {
      return {
        success: false,
        data: null,
        summary: 'No query provided for research',
        error: 'Missing required param: query',
      };
    }

    if (signal.aborted) {
      return {
        success: false,
        data: null,
        summary: 'Research cancelled before start',
        error: 'Aborted',
      };
    }

    try {
      const systemPrompt = `You are a research assistant helping during a live meeting. Provide concise, factual, well-structured findings. Use markdown formatting. Focus on the most relevant and actionable information.

If context from the meeting is provided, use it to tailor your research to what the participants actually need.`;

      const userContent = context
        ? `Research query: ${query}\n\nMeeting context:\n${context}`
        : `Research query: ${query}`;

      const onDelta = params._onDelta as ((text: string) => void) | undefined;
      const raw = await claudeSuggest(userContent, systemPrompt, signal, ['WebSearch', 'WebFetch'], {
        onDelta,
        model: MODEL_CONFIG.deepResearch,
        effort: EFFORT_CONFIG.deepResearch,
      });
      // Same output shape and attribution check as Fast research (see
      // citations.ts). The prompt is deliberately untouched: there is no eval
      // for this worker, so a prompt change here could not be measured.
      const sources = extractUrlSources(raw);
      const answer = stripSourceList(raw);
      const unverifiedAttributions = checkAttributions(answer, sources);
      const text = `${answer}${citationFooter(sources, unverifiedAttributions)}`;

      if (signal.aborted) {
        return {
          success: false,
          data: null,
          summary: 'Research cancelled during execution',
          error: 'Aborted',
        };
      }

      return {
        success: true,
        data: { query, answer, findings: text, sources, unverifiedAttributions },
        summary: `Research completed for: ${query}`,
        artifacts: [
          {
            type: 'markdown',
            content: text,
            title: `Research: ${query}`,
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        summary: `Research failed: ${message}`,
        error: message,
      };
    }
  }
}
