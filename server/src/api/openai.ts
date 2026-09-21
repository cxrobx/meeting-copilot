import OpenAI from 'openai';
import { paidApiDisabled } from './killswitch.js';
import { log } from '../logging.js';
import { MODEL_CONFIG } from '../model-config.js';
import { beginLlmRequest, recordLlmUsage } from './budget.js';

const TRIAGE_MODEL = MODEL_CONFIG.triage;
const FAST_RESEARCH_MODEL = MODEL_CONFIG.fastResearch;

let cachedClient: OpenAI | null = null;

// The installed SDK's public union predates GPT-5.6's `max` effort. Live
// meeting routes intentionally use `none`, so keep the local type aligned
// with the SDK until a dependency upgrade is separately evaluated.
type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

// Dollars per million tokens. Updated 2026-07-30 for OpenAI's price cut —
// Luna dropped 80% (was 1/6) and Terra 20% (was 2.5/15). These feed the
// per-session dollar ceiling in budget.ts, so stale-high numbers trip the
// killswitch early rather than merely mis-reporting.
// Sol is unchanged; `service_tier: "fast"` (which replaced Priority
// Processing) would bill Sol at 2x these rates, but no call site sets it.
function tokenPrices(model: string): { input: number; output: number } {
  if (model.includes('gpt-5.6-luna')) return { input: 0.2, output: 1.2 };
  if (model.includes('gpt-5.6-terra')) return { input: 2, output: 12 };
  if (model.includes('gpt-5.6-sol') || model === 'gpt-5.6') return { input: 5, output: 30 };
  return { input: 2, output: 10 };
}

// OpenAI bills the web_search tool per call, separately from tokens. $0.01 is
// what it cost when this was written and has not been re-checked against the
// pricing page — override it rather than trusting it. Pessimistic on purpose,
// like the token prices above: a high number trips the ceiling early.
const WEB_SEARCH_DOLLARS_PER_CALL = Number(process.env.COPILOT_OPENAI_WEB_SEARCH_PER_CALL || 0.01);

function getClient(): OpenAI {
  if (!cachedClient) cachedClient = new OpenAI();
  return cachedClient;
}

export function isOpenAiApiAvailable(): boolean {
  if (paidApiDisabled()) return false; // cost-safe test mode — force CLI
  return !!(process.env.OPENAI_API_KEY ?? '').trim();
}

/**
 * Fast JSON-only triage call via the configured GPT-5.6 role model. Uses the Responses API with
 * a strict JSON schema so the response is guaranteed to parse.
 *
 * `schema` follows JSON Schema. `name` identifies the schema for OpenAI.
 */
export async function openaiStructuredJson(
  prompt: string,
  systemPrompt: string,
  schema: {
    name: string;
    schema: Record<string, unknown>;
  },
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    label?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    maxOutputTokens?: number;
  } = {},
): Promise<string> {
  const client = getClient();
  beginLlmRequest();
  const tag = options.label ?? 'triage';
  const model = options.model ?? TRIAGE_MODEL;
  const started = Date.now();
  const res = await client.responses.create(
    {
      model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: schema.name,
          strict: true,
          schema: schema.schema,
        },
      },
      reasoning: { effort: options.reasoningEffort ?? 'none' },
      ...(options.maxOutputTokens
        ? { max_output_tokens: options.maxOutputTokens }
        : {}),
    },
    {
      timeout: options.timeoutMs ?? 10_000,
      maxRetries: 0,
      signal: options.signal,
    },
  );
  const elapsed = Date.now() - started;
  const u: any = res.usage;
  const prices = tokenPrices(model);
  recordLlmUsage({
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    inputDollarsPerMillion: Number(process.env.COPILOT_OPENAI_INPUT_PER_MILLION || prices.input),
    outputDollarsPerMillion: Number(process.env.COPILOT_OPENAI_OUTPUT_PER_MILLION || prices.output),
  });
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  log('api/openai', `${tag} model=${model} latencyMs=${elapsed} in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cached=${cached}`);

  return res.output_text;
}

export async function openaiTriageJson(
  prompt: string,
  systemPrompt: string,
  schema: {
    name: string;
    schema: Record<string, unknown>;
  },
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    label?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    maxOutputTokens?: number;
  } = {},
): Promise<string> {
  return openaiStructuredJson(prompt, systemPrompt, schema, options);
}

export interface FastResearchSource {
  url: string;
  title: string;
}

export interface FastResearchResult {
  text: string;
  sources: FastResearchSource[];
}

/**
 * Streaming fast research via GPT-5.6 Luna + the built-in web_search tool.
 * Deltas are delivered via the onDelta callback; the final text and source
 * citations are returned.
 */
export async function openaiFastResearchStream(params: {
  systemPrompt: string;
  userContent: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  label?: string;
}): Promise<FastResearchResult> {
  const client = getClient();
  beginLlmRequest();
  const tag = params.label ?? 'fast-research';
  const started = Date.now();
  let firstTokenAt = 0;

  const stream = await client.responses.create(
    {
      model: FAST_RESEARCH_MODEL,
      tools: [{ type: 'web_search' }],
      input: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userContent },
      ],
      stream: true,
      reasoning: { effort: 'low' },
    },
    { signal: params.signal, maxRetries: 0 },
  );

  const sources: FastResearchSource[] = [];
  const seenUrls = new Set<string>();
  let accumulated = '';
  let usage: OpenAI.Responses.ResponseUsage | undefined;
  let searches = 0;

  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      if (firstTokenAt === 0) firstTokenAt = Date.now();
      accumulated += event.delta;
      try {
        params.onDelta?.(event.delta);
      } catch {
        // Don't kill the stream on a bad callback.
      }
    } else if (event.type === 'response.output_item.done') {
      const item = event.item as { type: string; content?: Array<Record<string, unknown>> };
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if ((part as { type?: string }).type !== 'output_text') continue;
          const annotations = (part as { annotations?: Array<Record<string, unknown>> }).annotations;
          if (!Array.isArray(annotations)) continue;
          for (const a of annotations) {
            if ((a as { type?: string }).type !== 'url_citation') continue;
            const url = (a as { url?: string }).url;
            const title = (a as { title?: string }).title ?? '';
            if (url && !seenUrls.has(url)) {
              seenUrls.add(url);
              sources.push({ url, title });
            }
          }
        }
      }
    } else if (event.type === 'response.completed') {
      usage = event.response.usage;
      searches = event.response.output.filter((o) => o.type === 'web_search_call').length;
    }
  }

  // Until 2026-09-21 this path called beginLlmRequest() but never recorded
  // usage, so fast research was invisible to the per-session dollar ceiling.
  // It now runs for every approved research suggestion, so it has to count.
  // Measured: ~4.5k input tokens of tool overhead even with no search, up to
  // ~17k with two searches — and each search is billed per call on top.
  const prices = tokenPrices(FAST_RESEARCH_MODEL);
  recordLlmUsage({
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    inputDollarsPerMillion: Number(process.env.COPILOT_OPENAI_INPUT_PER_MILLION || prices.input),
    outputDollarsPerMillion: Number(process.env.COPILOT_OPENAI_OUTPUT_PER_MILLION || prices.output),
    extraDollars: searches * WEB_SEARCH_DOLLARS_PER_CALL,
  });

  const elapsed = Date.now() - started;
  const ttft = firstTokenAt > 0 ? firstTokenAt - started : -1;
  log('api/openai', `${tag} model=${FAST_RESEARCH_MODEL} ttftMs=${ttft} totalMs=${elapsed} sources=${sources.length} chars=${accumulated.length} in=${usage?.input_tokens ?? 0} out=${usage?.output_tokens ?? 0} searches=${searches}`);
  return { text: accumulated, sources };
}
