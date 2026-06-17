import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { paidApiDisabled } from './killswitch.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-6';

const LOG_FILE = join(homedir(), '.meeting-copilot', 'server.log');
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
}

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
  options: { signal?: AbortSignal; maxTokens?: number; timeoutMs?: number; label?: string } = {},
): Promise<string> {
  const client = getClient();
  const tag = options.label ?? 'haiku';
  const started = Date.now();
  const res = await client.messages.create(
    {
      model: HAIKU_MODEL,
      max_tokens: options.maxTokens ?? 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      timeout: options.timeoutMs ?? 10_000,
      maxRetries: 0,
      signal: options.signal,
    },
  );
  const elapsed = Date.now() - started;
  const u = res.usage;
  log(`[api/anthropic] ${tag} latencyMs=${elapsed} in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cacheRead=${u?.cache_read_input_tokens ?? 0} cacheWrite=${u?.cache_creation_input_tokens ?? 0}`);

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
  log(`[api/anthropic] ${tag} latencyMs=${elapsed} in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cacheRead=${u?.cache_read_input_tokens ?? 0} cacheWrite=${u?.cache_creation_input_tokens ?? 0}`);

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
      max_tokens: params.maxTokens ?? 2048,
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
  log(`[api/anthropic] ${tag} ttftMs=${ttft} totalMs=${elapsed} in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cacheRead=${u?.cache_read_input_tokens ?? 0} cacheWrite=${u?.cache_creation_input_tokens ?? 0}`);
  return { text: accumulated, usage: finalMessage.usage ?? null };
}
