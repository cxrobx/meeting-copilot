import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { runWarm } from './persistent-claude.js';
import { MODEL_CONFIG } from './model-config.js';
import { safeErrorMessage } from './logging.js';

const execFileAsync = promisify(execFile);

/**
 * Health signals from the CLI fallback layer. index.ts forwards these to the
 * dashboard as `intelligence.error` so tier degradation is visible instead of
 * silently eating latency.
 * Events: 'degraded' { source: 'cli', message, until } · 'recovered' { source: 'cli' }
 */
export const cliHealth = new EventEmitter();

// ─── Gemini circuit breaker ─────────────────────────────────────────────────
// Gemini is tier 1 of the triage chain but is a cold spawn — a hung binary
// used to stall every 15s eval cycle for up to 30s before Haiku got a chance.
// Two consecutive failures open the breaker for 5 minutes (Haiku serves
// directly); the next success closes it.
const GEMINI_TRIAGE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.GEMINI_TRIAGE_TIMEOUT_MS);
  // Default 12s: must fail comfortably inside one 15s eval cadence.
  return Number.isFinite(raw) && raw > 0 ? raw : 12_000;
})();
const GEMINI_BREAKER_FAILURES = 2;
const GEMINI_BREAKER_COOLDOWN_MS = 5 * 60_000;
let geminiConsecutiveFailures = 0;
let geminiDisabledUntil = 0;
let geminiBreakerOpen = false;

function noteGeminiFailure(err: unknown): void {
  geminiConsecutiveFailures++;
  if (geminiConsecutiveFailures >= GEMINI_BREAKER_FAILURES && !geminiBreakerOpen) {
    geminiBreakerOpen = true;
    geminiDisabledUntil = Date.now() + GEMINI_BREAKER_COOLDOWN_MS;
    const message = `Gemini triage circuit open after ${geminiConsecutiveFailures} failures (${safeErrorMessage(err)}) — using Haiku for ${Math.round(GEMINI_BREAKER_COOLDOWN_MS / 60_000)} min`;
    console.warn(`[CLI] ${message}`);
    cliHealth.emit('degraded', { source: 'cli', message, until: geminiDisabledUntil });
  }
}

function noteGeminiSuccess(): void {
  geminiConsecutiveFailures = 0;
  if (geminiBreakerOpen) {
    geminiBreakerOpen = false;
    geminiDisabledUntil = 0;
    console.log('[CLI] Gemini triage recovered — circuit closed');
    cliHealth.emit('recovered', { source: 'cli' });
  }
}

/**
 * Calls `claude` CLI in headless mode (--print) to use the user's
 * subscription instead of requiring an API key.
 *
 * Uses `--output-format json` for structured responses.
 */
export async function claudeChat(
  prompt: string,
  options: {
    systemPrompt?: string;
    model?: string;
    maxTokens?: number;
    signal?: AbortSignal;
    allowedTools?: string[];
  } = {},
): Promise<string> {
  // Warm fast-path: stateless, tool-less calls with a known model reuse a
  // persistent `claude` session (no per-call cold start). Falls through to the
  // cold spawn below on any warm failure, so behavior is never worse.
  if (!options.allowedTools?.length && options.model) {
    try {
      const text = await runWarm(prompt, {
        model: options.model,
        system: options.systemPrompt ?? '',
        signal: options.signal,
      });
      if (text && text.trim().length > 0) return text;
    } catch (err) {
      if (err instanceof Error && err.message === 'Aborted') throw err;
      // any other warm failure → cold spawn below
    }
  }

  const maxTurns = options.allowedTools?.length ? '8' : '1';
  // --strict-mcp-config: do NOT load the user's ~27 global MCP servers on every
  // spawn. They add ~6s of CPU cold-start per call and cause the concurrency
  // thrash that starved realtime suggestions (agenda latency blew up to ~45s).
  // Auth/subscription is unaffected; built-in tools (WebSearch/Bash/…) still work.
  const args = ['--print', '--output-format', 'json', '--strict-mcp-config', '--no-session-persistence', '--max-turns', maxTurns];

  if (options.systemPrompt) {
    args.push('--system-prompt', options.systemPrompt);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  // Note: Claude CLI has no --max-tokens flag; token limit is controlled by the model.
  // Use --max-budget-usd for cost control if needed.
  if (options.allowedTools?.length) {
    args.push('--allowedTools', ...options.allowedTools);
  }

  args.push('-p', prompt);

  const controller = new AbortController();

  // Forward external abort
  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error('Aborted');
    }
    options.signal.addEventListener('abort', () => controller.abort());
  }

  // Strip env vars that prevent nested Claude CLI invocations
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_PROJECT;
  // Force OAuth/subscription billing: the `claude` CLI must NEVER see an API key.
  // A live ANTHROPIC_API_KEY in its env makes the CLI bill the API console instead
  // of the subscription — this silently cost ~19M tokens on 2026-06-17. Direct-API
  // spend, if ever wanted, goes through the SDK paths (api/anthropic.ts), not here.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  try {
    const { stdout } = await execFileAsync('claude', args, {
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: options.allowedTools?.length ? 180_000 : 180_000,
      signal: controller.signal,
      env,
    });

    // --output-format json returns { type: "result", result: "...", ... }
    // CLI wraps output in terminal title escape sequences (OSC): \x1b]0;...\x1b\
    // Strip them, then extract the JSON envelope's `result` field.
    const stripped = stdout.replace(/\x1b\].*?(?:\x07|\x1b\\)/gs, '').trim();

    // Find the JSON object boundaries (more reliable than regex)
    const jsonStart = stripped.indexOf('{');
    const jsonEnd = stripped.lastIndexOf('}');
    const jsonStr = (jsonStart >= 0 && jsonEnd > jsonStart)
      ? stripped.slice(jsonStart, jsonEnd + 1)
      : stripped;

    try {
      const parsed = JSON.parse(jsonStr);
      const result = parsed.result ?? parsed.text ?? '';
      // When stop_reason is error_max_turns, result can be empty string "".
      // Treat empty/whitespace-only result as missing — don't return it.
      if (typeof result === 'string' && result.trim().length > 0) {
        return result;
      }
      // Fallback: return the raw JSON so callers can see what happened
      return jsonStr;
    } catch {
      return stripped;
    }
  } catch (error: any) {
    if (error.code === 'ABORT_ERR' || error.killed) {
      throw new Error('Aborted');
    }
    throw error;
  }
}

/**
 * Triage call with fallback chain:
 *   1. Gemini CLI — fast + smart
 *   2. Claude Haiku — reliable fallback
 */
export async function claudeTriage(
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  // 1. Try Gemini Flash — unless the breaker is open (recent hang/failures).
  if (Date.now() >= geminiDisabledUntil) {
    try {
      const out = await geminiTriage(prompt, systemPrompt, signal);
      noteGeminiSuccess();
      return out;
    } catch (err) {
      // An external abort is the caller's doing, not a Gemini fault.
      if (signal?.aborted) throw new Error('Aborted');
      noteGeminiFailure(err);
      /* fall through */
    }
  }

  // 2. Try Haiku
  try {
    return await claudeChat(prompt, {
      systemPrompt,
      model: MODEL_CONFIG.haiku,
      signal,
    });
  } catch { /* fall through */ }

  throw new Error('Triage providers unavailable');
}

/**
 * Triage via Gemini CLI.
 */
async function geminiTriage(
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const combinedPrompt = `${systemPrompt}\n\n${prompt}`;

  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) throw new Error('Aborted');
    signal.addEventListener('abort', () => controller.abort());
  }

  const { stdout } = await execFileAsync('gemini', [
    '-m', MODEL_CONFIG.geminiTriage,
    '-p', combinedPrompt,
    '-o', 'json',
  ], {
    maxBuffer: 5 * 1024 * 1024,
    timeout: GEMINI_TRIAGE_TIMEOUT_MS,
    signal: controller.signal,
    env: { ...process.env },
  });

  // Gemini JSON output: { session_id, response, stats }
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.response && typeof parsed.response === 'string') {
      return parsed.response;
    }
  } catch { /* fall through */ }

  // Try to extract response from partial output
  const stripped = stdout.replace(/\x1b\].*?(?:\x07|\x1b\\)/gs, '').trim();
  const jsonStart = stripped.indexOf('{');
  const jsonEnd = stripped.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const parsed = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1));
    if (parsed.response) return parsed.response;
  }

  throw new Error('No response in gemini output');
}

/**
 * Triage via Codex CLI using the configured OpenAI triage model.
 */
async function codexTriage(
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const combinedPrompt = `${systemPrompt}\n\n${prompt}`;

  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) throw new Error('Aborted');
    signal.addEventListener('abort', () => controller.abort());
  }

  const { stdout } = await execFileAsync('codex', [
    'exec',
    '-m', MODEL_CONFIG.triage,
    '--ephemeral',
    '--skip-git-repo-check',
    '--json',
    combinedPrompt,
  ], {
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30_000,
    signal: controller.signal,
    env: { ...process.env },
  });

  // Parse JSONL output — find the agent_message item
  const lines = stdout.trim().split('\n');
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'item.completed' && evt.item?.type === 'agent_message' && evt.item?.text) {
        return evt.item.text;
      }
    } catch { /* skip non-JSON lines */ }
  }

  throw new Error('No agent_message in codex output');
}

/**
 * Full suggestion/analysis call using a capable model. Streams under the hood
 * via `claude --output-format stream-json --include-partial-messages`, but
 * returns the final concatenated text so blocking callers see unchanged
 * behavior. Pass `options.onDelta` to receive token chunks as they arrive.
 *
 * Event envelope (per Claude Code headless docs):
 *   { type: "stream_event", event: { delta: { type: "text_delta", text: "..." } } }
 * Final authoritative text arrives in:
 *   { type: "result", subtype: "success", result: "...", is_error: false }
 */
export async function claudeSuggest(
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
  allowedTools?: string[],
  options?: {
    onDelta?: (text: string) => void;
    /** Each tool call the agent makes (e.g. WebSearch + its query), as it makes it. */
    onToolUse?: (name: string, input: Record<string, unknown>) => void;
    model?: string;
    /** Tool-using calls default to 8 turns. */
    maxTurns?: number;
    /**
     * Skip the warm session. A warm process keeps its earlier turns in context
     * (it recycles every few turns), which is fine for small stateless calls
     * and wrong for one whose prompt is most of a transcript: the next call
     * would read the previous transcript too.
     */
    cold?: boolean;
  },
): Promise<string> {
  const model = options?.model ?? MODEL_CONFIG.worker;

  // Warm fast-path: tool-less suggestions reuse a persistent session (deltas are
  // forwarded as they stream). Tool-using calls (research/analysis) skip this
  // and use the cold spawn below, which can load WebSearch/WebFetch/etc.
  if (!allowedTools?.length && !options?.cold) {
    try {
      const text = await runWarm(prompt, {
        model,
        system: systemPrompt,
        signal,
        onDelta: options?.onDelta,
      });
      if (text && text.trim().length > 0) return text;
    } catch (err) {
      if (err instanceof Error && err.message === 'Aborted') throw err;
      // any other warm failure → cold spawn below
    }
  }

  const maxTurns = allowedTools?.length ? String(options?.maxTurns ?? 8) : '1';

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',                  // required with stream-json
    '--include-partial-messages', // token-level deltas
    '--strict-mcp-config',        // skip the ~27 global MCP servers (see claudeChat)
    '--no-session-persistence',
    '--max-turns', maxTurns,
    '--model', model,
    '--system-prompt', systemPrompt,
  ];
  if (allowedTools?.length) {
    args.push('--allowedTools', ...allowedTools);
  }
  args.push('-p', prompt);

  // Strip env vars that prevent nested Claude CLI invocations
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_PROJECT;
  // Force OAuth/subscription billing: the `claude` CLI must NEVER see an API key.
  // A live ANTHROPIC_API_KEY in its env makes the CLI bill the API console instead
  // of the subscription — this silently cost ~19M tokens on 2026-06-17. Direct-API
  // spend, if ever wanted, goes through the SDK paths (api/anthropic.ts), not here.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  if (signal?.aborted) {
    throw new Error('Aborted');
  }

  const MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10MB, matches claudeChat
  const TIMEOUT_MS = 180_000;

  return new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, { env });
    // The prompt is passed via -p, so close stdin immediately. Otherwise the CLI
    // waits ~3s for piped input ("no stdin data received in 3s…") and can exit
    // non-zero, which tool workers (research/etc.) then surface as a failure.
    child.stdin.end();

    let accumulated = '';
    let finalResult = '';
    let stderr = '';
    let stdoutBytes = 0;
    let settled = false;
    let killedForLimit = false;

    const done = (err: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
      if (err) reject(err);
      else resolve(value ?? '');
    };

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      done(new Error(`claude CLI timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    const abortHandler = signal
      ? () => {
          child.kill('SIGTERM');
          done(new Error('Aborted'));
        }
      : undefined;
    if (signal && abortHandler) {
      signal.addEventListener('abort', abortHandler);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES && !killedForLimit) {
        killedForLimit = true;
        child.kill('SIGTERM');
        done(new Error(`claude CLI stdout exceeded ${MAX_STDOUT_BYTES} bytes`));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        // Non-JSON line (shouldn't happen with stream-json, but be defensive)
        return;
      }

      // Partial text deltas (requires --include-partial-messages)
      if (
        evt?.type === 'stream_event' &&
        evt.event?.delta?.type === 'text_delta' &&
        typeof evt.event.delta.text === 'string'
      ) {
        const chunk = evt.event.delta.text;
        accumulated += chunk;
        try {
          options?.onDelta?.(chunk);
        } catch {
          // Callback errors must not kill the stream
        }
        return;
      }

      // Completed assistant turns carry the tool calls the agent chose.
      if (evt?.type === 'assistant' && Array.isArray(evt.message?.content) && options?.onToolUse) {
        for (const block of evt.message.content) {
          if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
          try {
            options.onToolUse(block.name, block.input && typeof block.input === 'object' ? block.input : {});
          } catch {
            // Callback errors must not kill the stream
          }
        }
        return;
      }

      // Final authoritative result from CLI envelope
      if (
        evt?.type === 'result' &&
        evt.subtype === 'success' &&
        typeof evt.result === 'string' &&
        evt.result.length > 0
      ) {
        finalResult = evt.result;
      }
    });

    child.on('error', (err) => {
      done(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        done(new Error(`claude CLI exited with code ${code}${stderr.trim() ? ' (see server log)' : ''}`));
        return;
      }
      // Prefer the CLI's authoritative result; fall back to accumulated deltas.
      done(null, finalResult || accumulated);
    });
  });
}
