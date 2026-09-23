import { isAnthropicApiAvailable, anthropicTriageJson } from '../api/anthropic.js';
import { isOpenAiApiAvailable, openaiStructuredJson } from '../api/openai.js';
import { claudeChat } from '../claude-cli.js';
import { log, safeErrorMessage } from '../logging.js';
import { LLM_CONFIG, MODEL_CONFIG } from '../model-config.js';

export interface LiveJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface LiveJsonResult {
  text: string;
  provider: 'openai' | 'anthropic' | 'claude-cli';
  model: string;
  latencyMs: number;
}

export interface LiveJsonRequest {
  prompt: string;
  systemPrompt: string;
  schema: LiveJsonSchema;
  openAiModel: string;
  label: string;
  signal?: AbortSignal;
  /** Deadline for each direct provider attempt. */
  providerTimeoutMs: number;
  /** Hard deadline across direct providers and the CLI fallback. */
  totalTimeoutMs: number;
  maxOutputTokens?: number;
  /** JSON text as the OpenAI path writes it. The fallbacks answer whole, without it. */
  onTextDelta?: (delta: string) => void;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof Error
      && (error.name === 'AbortError' || error.message === 'Aborted'));
}

/**
 * Low-latency structured inference for live meeting features.
 *
 * Direct APIs are tried before the subscription CLI because process startup
 * and CLI session scheduling are too variable for an in-meeting deadline.
 * The entire chain shares one abort deadline; a slow fallback can never turn
 * an already-stale answer into a UI interruption.
 */
export async function runLiveJson(request: LiveJsonRequest): Promise<LiveJsonResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  request.signal?.addEventListener('abort', relayAbort, { once: true });
  if (request.signal?.aborted) controller.abort();

  const timer = setTimeout(() => controller.abort(), request.totalTimeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    if (LLM_CONFIG.liveTransport !== 'cli' && isOpenAiApiAvailable()) {
      const providerStartedAt = Date.now();
      try {
        const text = await openaiStructuredJson(
          request.prompt,
          request.systemPrompt,
          request.schema,
          {
            signal: controller.signal,
            timeoutMs: Math.min(
              request.providerTimeoutMs,
              Math.max(1, request.totalTimeoutMs - (Date.now() - startedAt)),
            ),
            label: request.label,
            model: request.openAiModel,
            reasoningEffort: 'none',
            maxOutputTokens: request.maxOutputTokens,
            onTextDelta: request.onTextDelta,
          },
        );
        return {
          text,
          provider: 'openai',
          model: request.openAiModel,
          latencyMs: Date.now() - providerStartedAt,
        };
      } catch (error) {
        if (isAbort(error, controller.signal)) throw new Error('Aborted');
        log('live-json', `${request.label} openai failed: ${safeErrorMessage(error)}`);
      }
    }

    if (LLM_CONFIG.liveTransport !== 'cli' && isAnthropicApiAvailable()) {
      const providerStartedAt = Date.now();
      try {
        const text = await anthropicTriageJson(
          request.prompt,
          request.systemPrompt,
          {
            signal: controller.signal,
            timeoutMs: Math.min(
              request.providerTimeoutMs,
              Math.max(1, request.totalTimeoutMs - (Date.now() - startedAt)),
            ),
            maxTokens: request.maxOutputTokens,
            label: `${request.label}-fallback`,
            schema: request.schema.schema,
          },
        );
        return {
          text,
          provider: 'anthropic',
          model: MODEL_CONFIG.haiku,
          latencyMs: Date.now() - providerStartedAt,
        };
      } catch (error) {
        if (isAbort(error, controller.signal)) throw new Error('Aborted');
        log('live-json', `${request.label} anthropic failed: ${safeErrorMessage(error)}`);
      }
    }

    const providerStartedAt = Date.now();
    const text = await claudeChat(request.prompt, {
      systemPrompt: request.systemPrompt,
      model: MODEL_CONFIG.haiku,
      signal: controller.signal,
    });
    return {
      text,
      provider: 'claude-cli',
      model: MODEL_CONFIG.haiku,
      latencyMs: Date.now() - providerStartedAt,
    };
  } catch (error) {
    if (isAbort(error, controller.signal)) throw new Error('Aborted');
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', relayAbort);
  }
}
