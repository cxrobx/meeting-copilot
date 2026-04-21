import Anthropic from '@anthropic-ai/sdk';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-6';

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

export function isAnthropicApiAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY ?? '').trim();
}

/**
 * Short JSON-only triage call via Haiku. Non-streaming, tight timeout.
 */
export async function anthropicTriageJson(
  prompt: string,
  systemPrompt: string,
  options: { signal?: AbortSignal; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const client = getClient();
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

  // Combine all text blocks in the response.
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
}): Promise<{ text: string; usage: Anthropic.Messages.Usage | null }> {
  const client = getClient();

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
    accumulated += delta;
    try {
      params.onDelta?.(delta);
    } catch {
      // Callback errors must not kill the stream.
    }
  });

  const finalMessage = await stream.finalMessage();
  return { text: accumulated, usage: finalMessage.usage ?? null };
}
