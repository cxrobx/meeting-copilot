import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const execFileAsync = promisify(execFile);

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
  const maxTurns = options.allowedTools?.length ? '8' : '1';
  const args = ['--print', '--output-format', 'json', '--no-session-persistence', '--max-turns', maxTurns];

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
 *   1. Gemini CLI (gemini-3-flash-preview) — fast + smart
 *   2. Claude Haiku — reliable fallback
 *   3. Codex CLI (gpt-5.4-mini) — last resort
 */
export async function claudeTriage(
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  // 1. Try Gemini Flash
  try {
    return await geminiTriage(prompt, systemPrompt, signal);
  } catch { /* fall through */ }

  // 2. Try Haiku
  try {
    return await claudeChat(prompt, {
      systemPrompt,
      model: 'claude-haiku-4-5-20251001',
      signal,
    });
  } catch { /* fall through */ }

  // 3. Try Codex
  return codexTriage(prompt, systemPrompt, signal);
}

/**
 * Triage via Gemini CLI (gemini-3-flash-preview).
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
    '-m', 'gemini-3-flash-preview',
    '-p', combinedPrompt,
    '-o', 'json',
  ], {
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30_000,
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
 * Triage via Codex CLI (gpt-5.4-mini).
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
    '-m', 'gpt-5.4-mini',
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
  options?: { onDelta?: (text: string) => void; model?: string },
): Promise<string> {
  const model = options?.model ?? 'claude-sonnet-4-6';
  const maxTurns = allowedTools?.length ? '8' : '1';

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',                  // required with stream-json
    '--include-partial-messages', // token-level deltas
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

  if (signal?.aborted) {
    throw new Error('Aborted');
  }

  const MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10MB, matches claudeChat
  const TIMEOUT_MS = 180_000;

  return new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, { env });

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
        const msg = stderr.trim() || `claude CLI exited with code ${code}`;
        done(new Error(msg));
        return;
      }
      // Prefer the CLI's authoritative result; fall back to accumulated deltas.
      done(null, finalResult || accumulated);
    });
  });
}
