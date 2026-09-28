import Anthropic from '@anthropic-ai/sdk';
import { paidApiDisabled } from './killswitch.js';
import { log } from '../logging.js';
import { MODEL_CONFIG, EFFORT_CONFIG } from '../model-config.js';
import { beginLlmRequest, recordLlmUsage } from './budget.js';

const HAIKU_MODEL = MODEL_CONFIG.haiku;
const SONNET_MODEL = MODEL_CONFIG.suggestion;

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

export function isAnthropicApiAvailable(): boolean {
  if (paidApiDisabled()) return false; // cost-safe test mode — force CLI
  return !!(process.env.ANTHROPIC_API_KEY ?? '').trim();
}

/**
 * Short JSON-only triage call via Haiku. Non-streaming, tight timeout.
 */
export async function anthropicTriageJson(
  prompt: string,
  systemPrompt: string,
  options: {
    signal?: AbortSignal;
    maxTokens?: number;
    timeoutMs?: number;
    label?: string;
    schema?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const client = getClient();
  beginLlmRequest();
  const tag = options.label ?? 'haiku';
  const started = Date.now();
  const res = await client.messages.create(
    {
      model: HAIKU_MODEL,
      max_tokens: options.maxTokens ?? 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      ...(options.schema
        ? {
            output_config: {
              format: { type: 'json_schema' as const, schema: options.schema },
            },
          }
        : {}),
    },
    {
      timeout: options.timeoutMs ?? 10_000,
      maxRetries: 0,
      signal: options.signal,
    },
  );
  const elapsed = Date.now() - started;
  const u = res.usage;
  recordLlmUsage({
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    inputDollarsPerMillion: Number(process.env.COPILOT_ANTHROPIC_INPUT_PER_MILLION || 2),
    outputDollarsPerMillion: Number(process.env.COPILOT_ANTHROPIC_OUTPUT_PER_MILLION || 10),
  });
  log('api/anthropic', `${tag} model=${HAIKU_MODEL} latencyMs=${elapsed} in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cacheRead=${u?.cache_read_input_tokens ?? 0} cacheWrite=${u?.cache_creation_input_tokens ?? 0}`);

  // Combine all text blocks in the response.
  let text = '';
  for (const block of res.content) {
    if (block.type === 'text') text += block.text;
  }
  return text;
}

/**
 * Streaming Haiku call with prompt caching on the system prompt and a
 * stable static context prefix. Used by the agenda tracker so the
 * system+agenda+project prefix is cached after the first call and later
 * calls only pay full input cost for the transcript window.
 */
export async function anthropicHaikuCachedJson(params: {
  systemPrompt: string;
  staticContext: string;
  dynamicTail: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
  label?: string;
}): Promise<string> {
  const client = getClient();
  beginLlmRequest();
  const tag = params.label ?? 'haiku-cached';
  const started = Date.now();

  const userBlocks: Anthropic.TextBlockParam[] = [];
  if (params.staticContext.trim().length > 0) {
    userBlocks.push({
      type: 'text',
      text: params.staticContext,
      cache_control: { type: 'ephemeral' },
    });
  }
  userBlocks.push({ type: 'text', text: params.dynamicTail });

  const res = await client.messages.create(
    {
      model: HAIKU_MODEL,
      max_tokens: params.maxTokens ?? 1024,
      system: [
        {
          type: 'text',
          text: params.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userBlocks }],
    },
    {
      timeout: params.timeoutMs ?? 15_000,
      maxRetries: 0,
      signal: params.signal,
    },
  );

  const elapsed = Date.now() - started;
  const u = res.usage;
  recordLlmUsage({
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    inputDollarsPerMillion: Number(process.env.COPILOT_ANTHROPIC_INPUT_PER_MILLION || 1),
    outputDollarsPerMillion: Number(process.env.COPILOT_ANTHROPIC_OUTPUT_PER_MILLION || 5),
  });
  log('api/anthropic', `${tag} model=${HAIKU_MODEL} latencyMs=${elapsed} in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cacheRead=${u?.cache_read_input_tokens ?? 0} cacheWrite=${u?.cache_creation_input_tokens ?? 0}`);

  let text = '';
  for (const block of res.content) {
    if (block.type === 'text') text += block.text;
  }
  return text;
}

/**
 * Streaming Sonnet suggestion with prompt caching on the system prompt and
 * the stable context prefix. The variable tail (trigger reason + transcript
 * window) is sent uncached so each call only pays full input cost for the
 * bit that changes.
 *
 * `staticContext` is everything that stays the same across calls in a session
 * (project brief, context documents, agenda). `dynamicTail` is the
 * call-specific payload (trigger info, transcript window).
 */
export async function anthropicSuggestStream(params: {
  systemPrompt: string;
  staticContext: string;
  dynamicTail: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  maxTokens?: number;
  label?: string;
}): Promise<{ text: string; usage: Anthropic.Messages.Usage | null }> {
  const client = getClient();
  beginLlmRequest();
  const tag = params.label ?? 'sonnet-suggest';
  const started = Date.now();
  let firstTokenAt = 0;

  const userBlocks: Anthropic.TextBlockParam[] = [];
  if (params.staticContext.trim().length > 0) {
    userBlocks.push({
      type: 'text',
      text: params.staticContext,
      cache_control: { type: 'ephemeral' },
    });
  }
  userBlocks.push({ type: 'text', text: params.dynamicTail });

  let accumulated = '';

  const stream = client.messages.stream(
    {
      model: SONNET_MODEL,
      // Thinking counts toward max_tokens, so leave room beyond the reply.
      max_tokens: params.maxTokens ?? 8192,
      // Sonnet 5.5 rejects `thinking: { type: 'disabled' }` with a 400, so
      // this keeps adaptive thinking at the suggestion effort, the same level
      // the subscription CLI path runs at.
      output_config: { effort: EFFORT_CONFIG.suggestion },
      system: [
        {
          type: 'text',
          text: params.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userBlocks }],
    },
    { signal: params.signal, maxRetries: 0 },
  );

  stream.on('text', (delta: string) => {
    if (firstTokenAt === 0) firstTokenAt = Date.now();
    accumulated += delta;
    try {
      params.onDelta?.(delta);
    } catch {
      // Callback errors must not kill the stream.
    }
  });

  const finalMessage = await stream.finalMessage();
  const elapsed = Date.now() - started;
  const ttft = firstTokenAt > 0 ? firstTokenAt - started : -1;
  const u = finalMessage.usage;
  recordLlmUsage({
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    inputDollarsPerMillion: Number(process.env.COPILOT_ANTHROPIC_INPUT_PER_MILLION || 2),
    outputDollarsPerMillion: Number(process.env.COPILOT_ANTHROPIC_OUTPUT_PER_MILLION || 10),
  });
  log('api/anthropic', `${tag} model=${SONNET_MODEL} ttftMs=${ttft} totalMs=${elapsed} in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cacheRead=${u?.cache_read_input_tokens ?? 0} cacheWrite=${u?.cache_creation_input_tokens ?? 0}`);
  return { text: accumulated, usage: finalMessage.usage ?? null };
}
