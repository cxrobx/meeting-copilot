import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Files a CXTasks task by running CXTasks' own MCP server for one call.
 *
 * `cxtasks-mcp` opens the CXTasks database directly, so this works with the
 * app closed and needs no token (its HTTP server listens on the Tailscale
 * address only, behind a bearer token). Going through `file_task` keeps
 * CXTasks' own checks: unknown fields are refused, and `why` is required.
 *
 * Only the user's click files (invariant 3): callers pass a draft the user
 * confirmed. Never a seed `prompt` or a background-run field: a task's prompt
 * can reach the background runner, which has a shell.
 */

export const CXTASKS_MCP_BIN = '/Applications/CXTasks.app/Contents/MacOS/cxtasks-mcp';
const TIMEOUT_MS = 20_000;

export interface CxTaskInput {
  title: string;
  body?: string;
  /** 0 (most urgent) to 3. */
  priority?: number;
  /** ISO-8601 UTC with a trailing Z. */
  dueAt?: string;
  tags?: string[];
  /** An existing absolute directory; CXTasks refuses the call otherwise. */
  repoPath?: string;
}

export interface FiledTask {
  /** The T-number, e.g. "T232". */
  ref: string;
  id: string;
}

export type TaskFiler = (task: CxTaskInput) => Promise<FiledTask>;

/** The arguments file_task gets: only fields it knows, `why` always "chris-asked". */
export function fileTaskArgs(task: CxTaskInput): Record<string, unknown> {
  const args: Record<string, unknown> = { title: task.title, why: 'chris-asked' };
  if (task.body) args.body = task.body;
  if (typeof task.priority === 'number') args.priority = task.priority;
  if (task.dueAt) args.due_at = task.dueAt;
  if (task.tags?.length) args.tags = task.tags;
  if (task.repoPath && existsSync(task.repoPath)) args.repo_path = task.repoPath;
  return args;
}

/** "T232" and the UUID out of file_task's printout ("ref: T232", "id: …"). */
export function parseFiled(text: string): FiledTask | null {
  const ref = /^\s*ref:\s+(T\d+)\s*$/m.exec(text)?.[1];
  const id = /^\s*id:\s+([0-9a-f-]{36})\s*$/m.exec(text)?.[1];
  return ref && id ? { ref, id } : null;
}

/**
 * A due date the user picked (YYYY-MM-DD) as 17:00 local that day, in UTC.
 * Null for anything that is not a real date.
 */
export function dueDateToIso(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 17, 0, 0, 0);
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d.toISOString();
}

export function cxtasksFiler(bin: string = process.env.COPILOT_CXTASKS_MCP_BIN || CXTASKS_MCP_BIN): TaskFiler {
  return (task) => fileViaMcp(bin, fileTaskArgs(task));
}

/** One MCP session: initialize, call file_task, close. */
export function fileViaMcp(bin: string, args: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<FiledTask> {
  return new Promise((resolve, reject) => {
    if (!existsSync(bin)) {
      reject(new Error(`CXTasks is not installed (${bin} is missing).`));
      return;
    }
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let out = '';
    let err = '';
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already closed */ }
      // stdin closing ends it; a hung one is killed.
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000).unref();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`CXTasks did not answer within ${Math.round(timeoutMs / 1000)}s.`))), timeoutMs);
    const send = (msg: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

    child.on('error', (e) => finish(() => reject(new Error(`Could not start CXTasks: ${e.message}`))));
    child.on('exit', (code) => finish(() => reject(new Error(`CXTasks exited (${code}) before filing.${err.trim() ? ` ${err.trim().slice(-300)}` : ''}`))));
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      let nl: number;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: any; error?: { message?: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) { finish(() => reject(new Error(`CXTasks refused to start: ${msg.error?.message ?? 'unknown error'}`))); return; }
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/call', params: { name: 'file_task', arguments: args } });
        } else if (msg.id === 2) {
          if (msg.error) { finish(() => reject(new Error(`CXTasks refused the task: ${msg.error?.message ?? 'unknown error'}`))); return; }
          const text = ((msg.result?.content ?? []) as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
          if (msg.result?.isError) { finish(() => reject(new Error(`CXTasks refused the task: ${text.slice(0, 300)}`))); return; }
          const filed = parseFiled(text);
          finish(() => (filed ? resolve(filed) : reject(new Error('CXTasks filed nothing it could name.'))));
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'meeting-copilot', version: '1' } },
    });
  });
}
