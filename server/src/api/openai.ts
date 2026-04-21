import OpenAI from 'openai';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TRIAGE_MODEL = 'gpt-5.4-mini';
const FAST_RESEARCH_MODEL = 'gpt-5.4-mini';

const LOG_FILE = join(homedir(), '.meeting-copilot', 'server.log');
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
}

let cachedClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!cachedClient) cachedClient = new OpenAI();
  return cachedClient;
}

export function isOpenAiApiAvailable(): boolean {
  return !!(process.env.OPENAI_API_KEY ?? '').trim();
}

/**
 * Fast JSON-only triage call via GPT-5.4 Mini. Uses the Responses API with
 * a strict JSON schema so the response is guaranteed to parse.
 *
 * `schema` follows JSON Schema. `name` identifies the schema for OpenAI.
 */
export async function openaiTriageJson(
  prompt: string,
  systemPrompt: string,
  schema: {
    name: string;
    schema: Record<string, unknown>;
  },
  options: { signal?: AbortSignal; timeoutMs?: number; label?: string } = {},
): Promise<string> {
  const client = getClient();
  const tag = options.label ?? 'triage';
  const started = Date.now();
  const res = await client.responses.create(
    {
      model: TRIAGE_MODEL,
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
    },
    {
      timeout: options.timeoutMs ?? 10_000,
      maxRetries: 0,
      signal: options.signal,
    },
  );
  const elapsed = Date.now() - started;
  const u: any = res.usage;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  log(`[api/openai] ${tag} latencyMs=${elapsed} in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cached=${cached}`);

  return res.output_text;
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
 * Streaming fast research via GPT-5.4 Mini + the built-in web_search tool.
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
    },
    { signal: params.signal, maxRetries: 0 },
  );

  const sources: FastResearchSource[] = [];
  const seenUrls = new Set<string>();
  let accumulated = '';

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
    }
  }

  const elapsed = Date.now() - started;
  const ttft = firstTokenAt > 0 ? firstTokenAt - started : -1;
  log(`[api/openai] ${tag} ttftMs=${ttft} totalMs=${elapsed} sources=${sources.length} chars=${accumulated.length}`);
  return { text: accumulated, sources };
}
