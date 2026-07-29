import { appendFile, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const LOG_FILE = join(homedir(), '.meeting-copilot', 'server.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_BACKUPS = 3;
let queue: string[] = [];
let flushing = false;

function rotateIfNeeded(extraBytes: number): void {
  try {
    if (statSync(LOG_FILE).size + extraBytes < MAX_LOG_BYTES) return;
  } catch {
    return;
  }
  try {
    unlinkSync(`${LOG_FILE}.${MAX_BACKUPS}`);
  } catch {}
  for (let index = MAX_BACKUPS - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${LOG_FILE}.${index}`, `${LOG_FILE}.${index + 1}`);
    } catch {}
  }
  try {
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {}
}

function flush(): void {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const payload = queue.join('');
  queue = [];
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    rotateIfNeeded(Buffer.byteLength(payload));
  } catch {}
  appendFile(LOG_FILE, payload, () => {
    flushing = false;
    if (queue.length > 0) setImmediate(flush);
  });
}

export function log(scope: string, message: string): void {
  const safe = message.replace(/[\r\n]+/g, ' ').slice(0, 4_000);
  queue.push(`[${new Date().toISOString()}] [${scope}] ${safe}\n`);
  if (!flushing) setImmediate(flush);
}

/** Avoid leaking child-process arguments (which can contain transcript prompts). */
export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error';
  const coded = error as Error & { code?: string | number };
  if (error.message.startsWith('Command failed:')) {
    return `Child process failed${coded.code === undefined ? '' : ` (code ${coded.code})`}`;
  }
  return error.message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}
