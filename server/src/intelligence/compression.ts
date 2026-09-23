import { MODEL_CONFIG } from '../model-config.js';
import { parseFirstJsonObject } from './first-json.js';
import { runLiveJson, type LiveJsonSchema } from './live-json.js';

/**
 * Context compression: the live path's memory past its 5-minute window.
 *
 * Every 5 minutes the transcript older than the window is summarized into one
 * paragraph and dropped, and the last two paragraphs ride along in every
 * triage and suggestion prompt. So it runs on the same transport as the lanes
 * that read it: gpt-6-luna on the API, subscription Haiku when the API is off
 * (runLiveJson), which keeps `COPILOT_LIVE_LLM_MODE=cli` and
 * `COPILOT_DISABLE_PAID_API=1` free. Until 2026-09-22 it went through the CLI
 * chain, whose dead Gemini tier pinned the dashboard's "degraded" badge.
 *
 * It asks for `{summary}` JSON rather than prose because luna keeps writing
 * after it has finished (gotcha #21). A prose tail would be pasted into every
 * triage prompt for the next ten minutes; an object boundary is what lets
 * first-json cut it off.
 */
export const COMPRESSION_SYSTEM = [
  'Summarize this meeting transcript excerpt into one concise paragraph preserving key decisions, action items, and topics discussed. Be factual and specific.',
  '',
  'Respond with JSON only, no prose or code fences: {"summary": "<the paragraph>"}',
].join('\n');

export const COMPRESSION_SCHEMA: LiveJsonSchema = {
  name: 'context_summary',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary'],
    properties: {
      summary: { type: 'string' },
    },
  },
};

/** The summary paragraph from a model reply, or null when there is none. */
export function parseCompressionSummary(text: string): string | null {
  const parsed = parseFirstJsonObject<{ summary: string }>(
    text,
    (o) => typeof o.summary === 'string' && o.summary.trim().length > 0,
  );
  return parsed ? parsed.summary.trim() : null;
}

export async function summarizeOldContext(
  transcript: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runLiveJson({
    prompt: transcript,
    systemPrompt: COMPRESSION_SYSTEM,
    schema: COMPRESSION_SCHEMA,
    openAiModel: MODEL_CONFIG.compression,
    label: 'compression',
    signal,
    // A background job every 5 minutes, so nothing is waiting on it. The total
    // leaves room for a cold `claude` spawn when the API is off.
    providerTimeoutMs: 20_000,
    totalTimeoutMs: 120_000,
    maxOutputTokens: 600,
  });
  return parseCompressionSummary(result.text);
}
