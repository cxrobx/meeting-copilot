import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Where a published card lives: a public R2 bucket behind a custom domain.
 * The Cloudflare key never enters this process. Every call goes through
 * `secret run -k CF_API_KEY`, which injects it into one wrangler child, and
 * under `zsh -c`, because ~/.zshenv is where CF_EMAIL and CF_ACCOUNT_ID are
 * exported and a Finder-launched app has neither.
 */

export interface Uploader {
  put(key: string, html: string, signal?: AbortSignal): Promise<void>;
  remove(key: string, signal?: AbortSignal): Promise<void>;
}

export const SHARE_BUCKET = process.env.COPILOT_SHARE_BUCKET || 'mc-share';
export const SHARE_BASE_URL = (process.env.COPILOT_SHARE_BASE_URL || 'https://share.cxventures.io').replace(/\/+$/, '');

/** 128 random bits: the URL is the only thing keeping a page private. */
export function newShareKey(): string {
  return randomBytes(16).toString('base64url');
}

export function shareUrl(key: string): string {
  return `${SHARE_BASE_URL}/${key}`;
}

// $1 = wrangler subcommand (put|delete), $2 = bucket/key, $3 = file (put only).
// Positional arguments, so neither a key nor a path is ever parsed as shell.
const WRANGLER = [
  'export CLOUDFLARE_API_KEY="$CF_API_KEY" CLOUDFLARE_EMAIL="$CF_EMAIL" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" WRANGLER_SEND_METRICS=false',
  'if [ "$1" = put ]; then exec wrangler r2 object put "$2" --file "$3" --content-type "text/html; charset=utf-8" --remote',
  'else exec wrangler r2 object delete "$2" --remote; fi',
].join('\n');

function runWrangler(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/zsh',
      ['-c', 'exec secret run -k CF_API_KEY -- /bin/sh -c "$1" sh "${@:2}"', 'zsh', WRANGLER, ...args],
      { timeout: 90_000, signal, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        // wrangler's own error lines; never the environment.
        const reason = String(stderr || '').split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
          .filter((l) => /error|✘|failed|not found|enable r2/i.test(l)).slice(0, 3).join(' ');
        reject(new Error(reason || error.message));
      },
    );
  });
}

export const wranglerUploader: Uploader = {
  async put(key, html, signal) {
    const dir = mkdtempSync(join(tmpdir(), 'mc-share-'));
    const file = join(dir, 'page.html');
    try {
      writeFileSync(file, html, 'utf8');
      await runWrangler(['put', `${SHARE_BUCKET}/${key}`, file], signal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  async remove(key, signal) {
    await runWrangler(['delete', `${SHARE_BUCKET}/${key}`], signal);
  },
};
