import OpenAI from 'openai';
import { paidApiDisabled } from './killswitch.js';
import { log } from '../logging.js';
import { MODEL_CONFIG } from '../model-config.js';
import { beginLlmRequest, recordLlmUsage } from './budget.js';

const TRIAGE_MODEL = MODEL_CONFIG.triage;
const FAST_RESEARCH_MODEL = MODEL_CONFIG.fastResearch;
// `low` ships. Set higher to trade first-token latency for more searches per
// answer; `npm run eval:research` measures both sides of that trade.
const FAST_RESEARCH_EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];
export function fastResearchEffort(): ReasoningEffort {
  const value = process.env.COPILOT_RESEARCH_EFFORT as ReasoningEffort | undefined;
  return value && FAST_RESEARCH_EFFORTS.includes(value) ? value : 'low';
}

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
// Processing) bills Sol at 2x these rates.
//
// Opt-in priority processing. OpenAI accepts `service_tier: "fast"` on Luna and
// reports it back as billed `priority` (probed 2026-09-21). Unset = the
// default tier. Read per call so an eval can A/B it without a restart.
function serviceTier(): string | undefined {
  const tier = (process.env.COPILOT_OPENAI_SERVICE_TIER ?? '').trim();
  return tier && tier !== 'default' ? tier : undefined;
}

// Priority bills at 2x (the Sol rate above; not re-checked for Luna). Applied
// to the budget so the ceiling stays pessimistic when the tier is on.
function tierMultiplier(): number {
  return serviceTier() ? 2 : 1;
}

export function tokenPrices(model: string): { input: number; output: number } {
  const m = tierMultiplier();
  const base = baseTokenPrices(model);
  return { input: base.input * m, output: base.output * m };
}

function baseTokenPrices(model: string): { input: number; output: number } {
  if (model.includes('gpt-6-luna')) return { input: 0.1, output: 0.5 };
  if (model.includes('gpt-6-sol')) return { input: 2, output: 10 };
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
    /** Per-call token usage, for evals that report spend and cache hits. */
    onUsage?: (usage: { inputTokens: number; outputTokens: number; cachedTokens: number; latencyMs: number }) => void;
    /**
     * Stream the JSON as it is written. For a caller that shows a field before
     * the object closes (Coach Ask shows the phrasing as it is written). Same
     * request, same schema; the returned text is the same.
     */
    onTextDelta?: (delta: string) => void;
  } = {},
): Promise<string> {
  const client = getClient();
  beginLlmRequest();
  const tag = options.label ?? 'triage';
  const model = options.model ?? TRIAGE_MODEL;
  const started = Date.now();
  const body: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
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
      ...(serviceTier() ? { service_tier: serviceTier() as any } : {}),
      ...(options.maxOutputTokens
        ? { max_output_tokens: options.maxOutputTokens }
        : {}),
  };
  const timeoutMs = options.timeoutMs ?? 10_000;
  let text: string;
  let u: any;
  let firstTokenMs = 0;
  if (options.onTextDelta) {
    // The SDK's `timeout` stops covering a stream once it opens, so the
    // deadline rides the signal instead.
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const stream = await client.responses.create({ ...body, stream: true }, { maxRetries: 0, signal });
    text = '';
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        if (!firstTokenMs) firstTokenMs = Date.now() - started;
        text += event.delta;
        try {
          options.onTextDelta(event.delta);
        } catch {
          // A display callback must not fail the call.
        }
      } else if (event.type === 'response.completed') {
        u = event.response.usage;
      }
    }
  } else {
    const res = await client.responses.create(body, {
      timeout: timeoutMs,
      maxRetries: 0,
      signal: options.signal,
    });
    text = res.output_text;
    u = res.usage;
  }
  const elapsed = Date.now() - started;
  const prices = tokenPrices(model);
  recordLlmUsage({
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    inputDollarsPerMillion: Number(process.env.COPILOT_OPENAI_INPUT_PER_MILLION || prices.input),
    outputDollarsPerMillion: Number(process.env.COPILOT_OPENAI_OUTPUT_PER_MILLION || prices.output),
  });
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  log('api/openai', `${tag} model=${model} latencyMs=${elapsed}${firstTokenMs ? ` ttftMs=${firstTokenMs}` : ''} in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cached=${cached}`);
  options.onUsage?.({
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cachedTokens: cached,
    latencyMs: elapsed,
  });

  return text;
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

/**
 * Tokens for a stream that never reported its usage. An aborted stream (Stop,
 * a closed highlight-to-ask panel) ends without `response.completed`, and it
 * was billed up to the abort, so counting it as zero let the session's dollar
 * ceiling fall behind. Three characters a token errs high, as the prices do.
 */
export function estimatedUsage(inputChars: number, outputChars: number): { input_tokens: number; output_tokens: number } {
  return { input_tokens: Math.ceil(inputChars / 3), output_tokens: Math.ceil(outputChars / 3) };
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
  /** Earlier turns of a conversation (the meeting chat), oldest first. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Defaults to the fast-research model. */
  model?: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  label?: string;
}): Promise<FastResearchResult> {
  const client = getClient();
  beginLlmRequest();
  const tag = params.label ?? 'fast-research';
  const model = params.model ?? FAST_RESEARCH_MODEL;
  const started = Date.now();
  let firstTokenAt = 0;

  const stream = await client.responses.create(
    {
      model,
      tools: [{ type: 'web_search' }],
      input: [
        { role: 'system', content: params.systemPrompt },
        ...(params.history ?? []).map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: params.userContent },
      ],
      stream: true,
      reasoning: { effort: fastResearchEffort() },
      ...(serviceTier() ? { service_tier: serviceTier() as any } : {}),
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
  const prices = tokenPrices(model);
  if (!usage) {
    const inputChars = params.systemPrompt.length + params.userContent.length
      + (params.history ?? []).reduce((n, m) => n + m.content.length, 0);
    usage = estimatedUsage(inputChars, accumulated.length) as OpenAI.Responses.ResponseUsage;
  }
  recordLlmUsage({
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    inputDollarsPerMillion: Number(process.env.COPILOT_OPENAI_INPUT_PER_MILLION || prices.input),
    outputDollarsPerMillion: Number(process.env.COPILOT_OPENAI_OUTPUT_PER_MILLION || prices.output),
    extraDollars: searches * WEB_SEARCH_DOLLARS_PER_CALL,
  });

  const elapsed = Date.now() - started;
  const ttft = firstTokenAt > 0 ? firstTokenAt - started : -1;
  log('api/openai', `${tag} model=${model} ttftMs=${ttft} totalMs=${elapsed} sources=${sources.length} chars=${accumulated.length} in=${usage?.input_tokens ?? 0} out=${usage?.output_tokens ?? 0} searches=${searches}`);
  return { text: accumulated, sources };
}
