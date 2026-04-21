import { claudeSuggest } from '../claude-cli.js';
import {
  isOpenAiApiAvailable,
  openaiFastResearchStream,
  type FastResearchSource,
} from '../api/openai.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';

/**
 * Fast research: low-latency factual answer during a live meeting.
 *
 * Preferred path: GPT-5.4 Mini via OpenAI Responses API + native web_search
 * tool. No CLI spawn overhead; first token typically lands in 2–4s.
 * Falls back to Claude Haiku CLI when OPENAI_API_KEY isn't configured.
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

    const systemPrompt = `You provide fast, factual answers during a live meeting. Be concise: 2-4 sentences, lead with the answer, add a one-line source or caveat only if essential. Markdown is fine but keep it tight. Prefer recent and authoritative sources.`;

    const userContent = context
      ? `Question: ${query}\n\nMeeting context:\n${context}`
      : `Question: ${query}`;

    const onDelta = params._onDelta as ((text: string) => void) | undefined;

    try {
      let text: string;
      let sources: FastResearchSource[] = [];

      if (isOpenAiApiAvailable()) {
        try {
          const result = await openaiFastResearchStream({
            systemPrompt,
            userContent,
            signal,
            onDelta,
          });
          text = result.text;
          sources = result.sources;

          // Append sources to the rendered artifact so the user can click
          // through. The streamed deltas already landed in the action card;
          // the final artifact gets a consolidated citations block appended.
          if (sources.length > 0) {
            const citationLines = sources
              .map((s, i) => `[${i + 1}] [${s.title || s.url}](${s.url})`)
              .join('\n');
            text = `${text}\n\n---\n**Sources**\n${citationLines}`;
          }
        } catch (apiErr) {
          // Preserve aborts — don't silently fall back after the user
          // cancelled. For any other failure (bad key, rate limit, network,
          // 5xx), fall through to the Claude CLI path so the action card
          // still renders something useful.
          if (signal.aborted) throw apiErr;
          const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
          if (msg === 'Aborted') throw apiErr;
          text = await claudeSuggest(
            userContent,
            systemPrompt,
            signal,
            ['WebSearch', 'WebFetch'],
            { onDelta, model: 'claude-haiku-4-5-20251001' },
          );
          text = `_(OpenAI unavailable — fell back to Claude: ${msg})_\n\n${text}`;
        }
      } else {
        text = await claudeSuggest(
          userContent,
          systemPrompt,
          signal,
          ['WebSearch', 'WebFetch'],
          { onDelta, model: 'claude-haiku-4-5-20251001' },
        );
      }

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
        data: { query, findings: text, sources },
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
