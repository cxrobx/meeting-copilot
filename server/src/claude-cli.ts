import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  const maxTurns = options.allowedTools?.length ? '5' : '1';
  const args = ['--print', '--output-format', 'json', '--no-session-persistence', '--max-turns', maxTurns];

  if (options.systemPrompt) {
    args.push('--system-prompt', options.systemPrompt);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.maxTokens) {
    args.push('--max-tokens', String(options.maxTokens));
  }
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
      timeout: options.maxTokens ? 120_000 : 60_000,
      signal: controller.signal,
      env,
    });

    // --output-format json returns { result: "...", ... }
    try {
      const parsed = JSON.parse(stdout);
      return parsed.result ?? parsed.text ?? stdout;
    } catch {
      // If not valid JSON, return raw stdout
      return stdout.trim();
    }
  } catch (error: any) {
    if (error.code === 'ABORT_ERR' || error.killed) {
      throw new Error('Aborted');
    }
    throw error;
  }
}

/**
 * Quick triage call using the fastest available model.
 * Falls back to claude CLI if no API key is set.
 */
export async function claudeTriage(
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  return claudeChat(prompt, {
    systemPrompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 256,
    signal,
  });
}

/**
 * Full suggestion/analysis call using a capable model.
 */
export async function claudeSuggest(
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
  allowedTools?: string[],
): Promise<string> {
  return claudeChat(prompt, {
    systemPrompt,
    model: 'claude-sonnet-4-6',
    maxTokens: 2048,
    signal,
    allowedTools,
  });
}
