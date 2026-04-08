import { claudeSuggest } from '../claude-cli.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';

/**
 * Fast research: Haiku 4.5 with WebSearch, streamed token-by-token.
 * Optimized for minimum latency to first token during live meetings.
 */
export class FastResearchWorker implements Worker {
  public readonly name = 'fast-research';
  public readonly capabilities: WorkerCapabilities = {
    network: 'web-search',
    filesystem: { read: [], write: [] },
    subprocess: false,
    maxDurationMs: 60_000,
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
        summary: 'No query provided for fast research',
        error: 'Missing required param: query',
      };
    }

    if (signal.aborted) {
      return {
        success: false,
        data: null,
        summary: 'Fast research cancelled before start',
        error: 'Aborted',
      };
    }

    try {
      const systemPrompt = `You provide fast, factual answers during a live meeting. Be concise: 2-4 sentences, lead with the answer, add a one-line source or caveat only if essential. Markdown is fine but keep it tight. Prefer recent and authoritative sources.`;

      const userContent = context
        ? `Question: ${query}\n\nMeeting context:\n${context}`
        : `Question: ${query}`;

      const onDelta = params._onDelta as ((text: string) => void) | undefined;
      const text = await claudeSuggest(
        userContent,
        systemPrompt,
        signal,
        ['WebSearch', 'WebFetch'],
        { onDelta, model: 'claude-haiku-4-5-20251001' },
      );

      if (signal.aborted) {
        return {
          success: false,
          data: null,
          summary: 'Fast research cancelled during execution',
          error: 'Aborted',
        };
      }

      return {
        success: true,
        data: { query, findings: text },
        summary: `Fast research completed for: ${query}`,
        artifacts: [
          {
            type: 'markdown',
            content: text,
            title: `Fast: ${query}`,
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        summary: `Fast research failed: ${message}`,
        error: message,
      };
    }
  }
}
