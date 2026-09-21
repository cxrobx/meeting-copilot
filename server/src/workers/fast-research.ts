import { claudeSuggest } from '../claude-cli.js';
import {
  isOpenAiApiAvailable,
  openaiFastResearchStream,
  type FastResearchSource,
} from '../api/openai.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';
import { LLM_CONFIG, MODEL_CONFIG } from '../model-config.js';

// Exported so `npm run eval:research` scores alternative models against the
// exact prompt this worker ships, not a copy that drifts.
//
// The second paragraph exists because of `nonexistent-gartner-study`: asked
// what a study that does not exist found, Luna answered 5 runs out of 5 —
// with a vendor-blog statistic credited to "the 2025 Gartner study", or with
// no source at all. On a live call that answer gets repeated to a client.
export const FAST_RESEARCH_SYSTEM = `You provide fast, factual answers during a live meeting. Be concise: 2-4 sentences, lead with the answer, add a one-line source or caveat only if essential. Markdown is fine but keep it tight. Prefer recent and authoritative sources.

Never credit a figure or finding to a named source (a study, report, firm, law or document) unless you actually found that source. If the question names one you cannot find, say so first, in the first sentence. Only then may you offer the closest thing you did find, and name where it really comes from.`;

/**
 * Fast research: low-latency factual answer during a live meeting.
 *
 * Preferred path: GPT-5.6 Luna via OpenAI Responses API + native web_search
 * tool. No CLI spawn overhead.
 * Falls back to Claude Haiku CLI when OPENAI_API_KEY isn't configured.
 */
export class FastResearchWorker implements Worker {
  public readonly name = 'fast-research';
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

    const systemPrompt = FAST_RESEARCH_SYSTEM;

    const userContent = context
      ? `Question: ${query}\n\nMeeting context:\n${context}`
      : `Question: ${query}`;

    const onDelta = params._onDelta as ((text: string) => void) | undefined;

    try {
      let text: string;
      let sources: FastResearchSource[] = [];

      // `COPILOT_LIVE_LLM_MODE=cli` is the documented subscription-only switch;
      // this worker used to ignore it and bill OpenAI whenever a key was set.
      if (LLM_CONFIG.liveTransport !== 'cli' && isOpenAiApiAvailable()) {
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
            { onDelta, model: MODEL_CONFIG.haiku },
          );
          text = `_(OpenAI unavailable — fell back to Claude: ${msg})_\n\n${text}`;
        }
      } else {
        text = await claudeSuggest(
          userContent,
          systemPrompt,
          signal,
          ['WebSearch', 'WebFetch'],
          { onDelta, model: MODEL_CONFIG.haiku },
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
