import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { createHash } from 'node:crypto';

/**
 * Persistent (warm) `claude` sessions for the hot, frequent, *stateless*
 * realtime calls (triage / agenda / suggest).
 *
 * Why: cold-spawning `claude --print` per call boots a whole Node + Claude Code
 * runtime each time (~2.7s + cold-start CPU). Keeping ONE long-lived process
 * per (model, systemPrompt) and feeding it turns over stdin (stream-json)
 * amortizes that — warm turns land in ~1.5–2.5s on the subscription and, more
 * importantly, stop spawning a process every 15s during a meeting (CPU/battery).
 *
 * The catch (measured): a persistent session is ONE growing conversation, but
 * our calls are independent. Input tokens climb every turn, and old turns bleed
 * into new ones. So each session RECYCLES after a few turns to bound context,
 * and self-disposes when idle. Any failure falls back to the caller's existing
 * cold-spawn path, so this is strictly a fast-path optimization — never a
 * new failure mode.
 *
 * Auth note: same `claude` binary as the cold path → subscription/OAuth, because
 * spawnProcess() strips ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN from the child env.
 * (A *live* key in env makes the CLI bill the API console instead of the
 * subscription — that silently cost ~19M tokens on 2026-06-17, hence the strip.)
 * Built-in tools are NOT available here — tool-using calls must stay on the cold path.
 */

const TURNS_BEFORE_RECYCLE = Number(process.env.COPILOT_WARM_SESSION_TURNS) || 5;
const IDLE_DISPOSE_MS = Number(process.env.COPILOT_WARM_SESSION_IDLE_MS) || 120_000;
const TURN_TIMEOUT_MS = 180_000; // matches the cold-spawn ceiling in claude-cli.ts
const MAX_SESSIONS = 8;          // distinct (model, system) combos kept warm
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_CHARS = 8 * 1024;

const warmDisabled = process.env.COPILOT_DISABLE_WARM_SESSIONS === 'true';

export interface WarmRunOptions {
  model: string;
  system: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

interface PendingTurn {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  acc: string;
  finalResult: string;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  timeout: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

class WarmSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private dead = true;
  private turnCount = 0;
  private stdoutBytes = 0;
  private stderrBuf = '';
  private current: PendingTurn | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes turns: one conversation can only process one turn at a time. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly model: string,
    private readonly system: string,
  ) {}

  run(prompt: string, opts: { signal?: AbortSignal; onDelta?: (text: string) => void }): Promise<string> {
    const result = this.tail.then(
      () => this.execTurn(prompt, opts),
      () => this.execTurn(prompt, opts), // continue the chain even if a prior turn rejected
    );
    // Keep the chain alive regardless of this turn's outcome.
    this.tail = result.catch(() => undefined);
    return result;
  }

  private execTurn(
    prompt: string,
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void },
  ): Promise<string> {
    this.clearIdleTimer();
    if (opts.signal?.aborted) return Promise.reject(new Error('Aborted'));
    if (this.dead || !this.child || !this.child.stdin.writable) {
      this.spawnProcess(); // throws synchronously on spawn failure → falls back to cold
    }

    return new Promise<string>((resolve, reject) => {
      const turn: PendingTurn = {
        resolve,
        reject,
        acc: '',
        finalResult: '',
        onDelta: opts.onDelta,
        signal: opts.signal,
        timeout: null,
        settled: false,
      };
      this.current = turn;

      turn.timeout = setTimeout(() => {
        this.settle(turn, new Error(`warm turn timed out after ${TURN_TIMEOUT_MS}ms`));
        this.dispose('timeout');
      }, TURN_TIMEOUT_MS);

      if (opts.signal) {
        turn.abortHandler = () => {
          this.settle(turn, new Error('Aborted'));
          this.dispose('abort');
        };
        opts.signal.addEventListener('abort', turn.abortHandler, { once: true });
      }

      try {
        const line = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
        this.child!.stdin.write(line);
      } catch (err) {
        this.settle(turn, err instanceof Error ? err : new Error(String(err)));
        this.dispose('write-failed');
      }
    });
  }

  private spawnProcess(): void {
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',                  // required with stream-json
      '--include-partial-messages', // token-level deltas
      '--strict-mcp-config',        // skip the user's MCP fleet (the cold-start killer)
      '--no-session-persistence',
      '--model', this.model,
    ];
    if (this.system) {
      args.push('--system-prompt', this.system);
    }

    // Strip env vars that prevent nested Claude CLI invocations (matches claude-cli.ts).
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_PROJECT;
    // Force OAuth/subscription billing — never let the warm `claude` see an API key
    // (a live ANTHROPIC_API_KEY in env bills the API console instead; see claude-cli.ts).
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const child = spawn('claude', args, { env });
    this.child = child;
    this.dead = false;
    this.turnCount = 0;
    this.stdoutBytes = 0;
    this.stderrBuf = '';

    child.on('error', (err) => this.onProcessFailure(err));
    child.on('close', (code) => this.onProcessClose(code));
    // Swallow stdin EPIPE etc. so a dead pipe can't crash the server; the
    // close/error handlers own the state transition.
    child.stdin.on('error', (err) => {
      if (this.current) this.settle(this.current, err instanceof Error ? err : new Error(String(err)));
      this.dispose('stdin-error');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.stderrBuf.length < MAX_STDERR_CHARS) this.stderrBuf += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > MAX_STDOUT_BYTES) {
        if (this.current) this.settle(this.current, new Error('warm stdout exceeded limit'));
        this.dispose('stdout-overflow');
      }
    });

    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      return; // non-JSON line; ignore defensively
    }
    const turn = this.current;
    if (!turn || turn.settled) return; // init/system frames before a turn, or late frames

    // Partial text deltas (requires --include-partial-messages)
    if (
      evt?.type === 'stream_event' &&
      evt.event?.delta?.type === 'text_delta' &&
      typeof evt.event.delta.text === 'string'
    ) {
      const chunk = evt.event.delta.text;
      turn.acc += chunk;
      if (turn.onDelta) {
        try { turn.onDelta(chunk); } catch { /* callback errors must not kill the stream */ }
      }
      return;
    }

    // Terminal frame for this turn.
    if (evt?.type === 'result') {
      turn.finalResult = typeof evt.result === 'string' ? evt.result : '';
      const text = turn.finalResult || turn.acc;
      if (evt.subtype === 'success' || text.trim().length > 0) {
        this.settle(turn, null, text);
      } else {
        // Error result with no text (e.g. error_max_turns): reject so the caller
        // falls back to a cold spawn. The process itself is still healthy and
        // protocol-synced, so we keep it for the next turn.
        this.settle(turn, new Error(`warm result error: ${evt.subtype ?? 'unknown'}`));
      }
    }
  }

  private settle(turn: PendingTurn, err: Error | null, text?: string): void {
    if (turn.settled) return;
    turn.settled = true;
    if (turn.timeout) clearTimeout(turn.timeout);
    if (turn.signal && turn.abortHandler) turn.signal.removeEventListener('abort', turn.abortHandler);
    if (this.current === turn) this.current = null;

    if (err) {
      turn.reject(err);
      return;
    }
    this.turnCount += 1;
    turn.resolve(text ?? '');
    if (this.turnCount >= TURNS_BEFORE_RECYCLE) {
      this.dispose('recycle'); // bound context growth; next run() respawns lazily
    } else {
      this.scheduleIdleDispose();
    }
  }

  private onProcessClose(code: number | null): void {
    // Expected teardown nulls this.child first and removes listeners, so this
    // only fires for an UNEXPECTED exit.
    if (!this.child) return;
    const err = new Error(`warm claude exited (code=${code}) ${this.stderrBuf.slice(0, 200)}`.trim());
    if (this.current) this.settle(this.current, err);
    this.dead = true;
    this.child = null;
  }

  private onProcessFailure(err: Error): void {
    if (this.current) this.settle(this.current, err);
    this.dead = true;
    this.child = null;
  }

  private scheduleIdleDispose(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.dispose('idle'), IDLE_DISPOSE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  dispose(reason: string): void {
    this.clearIdleTimer();
    if (this.current && !this.current.settled) {
      this.settle(this.current, new Error(`warm session disposed: ${reason}`));
    }
    this.dead = true;
    const child = this.child;
    this.child = null;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (child) {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdin?.removeAllListeners();
      child.removeAllListeners('close');
      child.removeAllListeners('error');
      try { child.stdin.end(); } catch { /* best effort */ }
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
      // Escalate to SIGKILL if the process hangs on SIGTERM (guards against the
      // zombie-process gotcha). No-op if it already exited (ESRCH is swallowed).
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 3000);
      killTimer.unref?.();
    }
  }
}

// ─── Pool ────────────────────────────────────────────────────────────────────

const pool = new Map<string, WarmSession>();

function keyOf(model: string, system: string): string {
  return createHash('sha1').update(`${model} ${system}`).digest('hex');
}

/**
 * Run one stateless turn on a warm session for (model, system). Resolves with
 * the assistant's text (same contract as the cold-path helpers return). Rejects
 * on any warm failure — callers should catch and fall back to a cold spawn.
 * Rejects with message 'Aborted' when the signal fires (callers should rethrow,
 * not fall back).
 */
export function runWarm(prompt: string, opts: WarmRunOptions): Promise<string> {
  if (warmDisabled) return Promise.reject(new Error('warm sessions disabled'));

  const key = keyOf(opts.model, opts.system);
  let session = pool.get(key);
  if (!session) {
    if (pool.size >= MAX_SESSIONS) {
      // Pool full and this is a new combo — let the caller use the cold path
      // rather than churning sessions.
      return Promise.reject(new Error('warm pool at capacity'));
    }
    session = new WarmSession(opts.model, opts.system);
    pool.set(key, session);
  }
  return session.run(prompt, { signal: opts.signal, onDelta: opts.onDelta });
}

/** Kill every warm process. Call on graceful shutdown to avoid orphans. */
export function disposeAllWarmSessions(): void {
  for (const session of pool.values()) {
    session.dispose('shutdown');
  }
  pool.clear();
}
