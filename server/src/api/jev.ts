/**
 * TypeSafe (Jev) System One client.
 *
 * Jev returns typed judgments with calibrated probabilities instead of text:
 * you send `state` plus named `questions`, and each comes back as a number your
 * code can threshold. It is ~11x cheaper per call than the Luna triage path and
 * ~64x cheaper than the Terra coach path, at ~175ms p50 versus 1.3-1.7s — which
 * is why it gates the expensive generative calls rather than replacing them.
 *
 * It CANNOT write prose. Jev decides whether a moment is worth interrupting
 * for; Terra still writes the coaching advice.
 *
 * Division of labor (from ~/Projects/zen-mcp/docs/jev.md, learned the hard way):
 *   - CODE NARROWS   — builds the state, enforces every hard rule
 *   - JEV JUDGES     — makes only the calls code cannot
 *   - CODE DECIDES   — thresholds turn probabilities into actions; a
 *                      probability may only ever STOP something, never widen it
 *
 * Everything sent here leaves the machine, so transcript text is redacted
 * before it goes. See `redactForJev`.
 */
import { paidApiDisabled } from './killswitch.js';
import { log } from '../logging.js';
import { beginLlmRequest, recordLlmUsage } from './budget.js';

const ENDPOINT = process.env.TYPESAFE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest';

// Dollars per million tokens. Input is TypeSafe's published rate. Output is
// NOT published at the time of writing; 10x input is a deliberately pessimistic
// placeholder so the per-session dollar ceiling errs toward stopping early.
// Output is 50-80 tokens per call in practice, so the guess barely moves the
// total either way. Override both if TypeSafe publishes real numbers.
const INPUT_PER_MILLION = Number(process.env.COPILOT_JEV_INPUT_PER_MILLION || 0.042);
const OUTPUT_PER_MILLION = Number(process.env.COPILOT_JEV_OUTPUT_PER_MILLION || 0.42);

export type JevQuestion =
  | { type: 'noul'; instructions: string | Record<string, unknown>; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string | Record<string, unknown>; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string | Record<string, unknown>; criteria: string[] };

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface JevResult {
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
}

export function isJevAvailable(): boolean {
  if (paidApiDisabled()) return false; // cost-safe test mode — no metered calls
  return !!(process.env.TYPESAFE_API_KEY ?? '').trim();
}

// Redaction mirrors zen-mcp's `redactText` (shared/src/nav-redact.ts). Meeting
// transcripts are the most sensitive thing this app holds, and the first live
// run of the zen-mcp integration leaked an account email before this existed.
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const AWS_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const SK_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const SECRET_PAIR_RE = /\b(pass(?:word)?|token|secret|api[_-]?key|auth)\s*[:=]\s*[^\s&;,]+/gi;
const LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const LONG_DIGITS_RE = /\b\d{6,}\b/g;

/** Strip credential-shaped and identifying strings before anything leaves. */
export function redactForJev(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(EMAIL_RE, '<email>')
    .replace(JWT_RE, '<jwt>')
    .replace(UUID_RE, '<uuid>')
    .replace(AWS_RE, '<aws-key>')
    .replace(SK_RE, '<secret-key>')
    .replace(SECRET_PAIR_RE, '$1=<redacted>')
    .replace(LONG_HEX_RE, '<hex>')
    .replace(LONG_DIGITS_RE, '<digits>');
}

/**
 * Ask Jev a set of independent questions about one piece of state.
 *
 * Questions in a single call run in parallel and cannot see one another's
 * answers, so only batch genuinely independent ones. `state` is redacted here;
 * callers do not need to pre-redact, and double-redaction is harmless.
 */
export async function jevAsk(
  state: string,
  questions: Record<string, JevQuestion>,
  options: { signal?: AbortSignal; timeoutMs?: number; label?: string } = {},
): Promise<JevResult> {
  const key = (process.env.TYPESAFE_API_KEY ?? '').trim();
  if (!key) throw new Error('TYPESAFE_API_KEY is not set');
  if (paidApiDisabled()) throw new Error('paid API disabled (COPILOT_DISABLE_PAID_API)');

  beginLlmRequest();
  const tag = options.label ?? 'jev';
  const started = Date.now();

  // Own timeout controller, chained to any caller signal, so a hung request
  // cannot outlive the moment it was judging.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_500);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: redactForJev(state), model: MODEL, questions }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`TypeSafe HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      answers: Record<string, JevAnswer>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const latencyMs = Date.now() - started;
    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
    recordLlmUsage({
      inputTokens,
      outputTokens,
      inputDollarsPerMillion: INPUT_PER_MILLION,
      outputDollarsPerMillion: OUTPUT_PER_MILLION,
    });
    log('api/jev', `${tag} model=${MODEL} latencyMs=${latencyMs} in=${inputTokens} out=${outputTokens}`);
    return { answers: json.answers, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, latencyMs };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Read a noul answer, or `null` when the question is missing or mistyped. */
export function noul(answers: Record<string, JevAnswer>, id: string): number | null {
  const a = answers[id];
  return a && a.type === 'noul' && Number.isFinite(a.noul) ? a.noul : null;
}
