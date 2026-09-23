import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WorkerResult } from '../workers/types.js';
import { PENDING_NOTE } from '../workers/deep-follow-up.js';

/**
 * A result card as its own page, for putting it in front of someone: the ↗
 * button opens it in a browser tab (GET /present/action/:id/view), and a
 * published link falls back to it when the polish agent's page is unusable.
 *
 * Two shapes. A mockup (or any `html` artifact) is the page itself and is
 * sent as-is. Anything else is markdown and goes into a reader page that
 * renders it in the browser with the same marked + DOMPurify the dashboard
 * uses; the markdown rides in as JSON, never as HTML the server built.
 */

export interface ViewableAction {
  id: string;
  type: string;
  title: string;
  completedAt?: number | string | null;
  result?: WorkerResult | null;
}

export type ViewContent =
  | { kind: 'html'; html: string }
  | { kind: 'markdown'; markdown: string; pending: boolean };

/** What the card shows, or null when there is nothing to open. */
export function viewContent(action: ViewableAction): ViewContent | null {
  const artifacts = action.result?.artifacts ?? [];
  const html = artifacts.find((a) => a.type === 'html');
  if (html?.content) return { kind: 'html', html: html.content };

  const parts: string[] = [];
  for (const a of artifacts) {
    if (!a.content) continue;
    const heading = a.title ? `### ${a.title}\n\n` : '';
    if (a.type === 'markdown' || a.type === 'text') parts.push(heading + a.content);
    else if (a.type === 'code') parts.push(heading + '```\n' + a.content + '\n```');
  }
  if (!parts.length && action.result?.summary) parts.push(action.result.summary);
  if (!parts.length) return null;
  const markdown = parts.join('\n\n---\n\n');
  return { kind: 'markdown', markdown, pending: markdown.includes(PENDING_NOTE) };
}

/** JSON that is safe inside a <script> element: no `</script>`, no `<!--`. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TYPE_LABELS: Record<string, string> = {
  'fast-research': 'Research',
  research: 'Research',
  analysis: 'Analysis',
  summary: 'Summary',
  review: 'Review',
  codegen: 'Code',
  mockup: 'Mockup',
};

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

function formatWhen(completedAt: ViewableAction['completedAt']): string {
  if (completedAt == null || completedAt === '') return '';
  const d = new Date(completedAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'js');
let inlineScriptsCache: string | null = null;

/** The vendored marked + DOMPurify, inlined, for a page that leaves this machine. */
function inlineScripts(): string {
  if (inlineScriptsCache === null) {
    const read = (name: string) => readFileSync(join(VENDOR_DIR, name), 'utf8').replace(/<\/script/gi, '<\\/script');
    inlineScriptsCache = `<script>${read('marked.min.js')}</script>\n<script>${read('purify.min.js')}</script>`;
  }
  return inlineScriptsCache;
}

export interface ReaderPageOptions {
  title: string;
  type: string;
  completedAt?: ViewableAction['completedAt'];
  markdown: string;
  /**
   * `link` loads the libraries from this server's /vendor (the local tab).
   * `inline` embeds them, for a published page with no server behind it.
   */
  scripts: 'link' | 'inline';
  /** Reload every few seconds, while a deep follow-up is still coming. */
  refresh?: boolean;
  /** Published pages ask search engines to stay out. */
  noindex?: boolean;
}

export function buildReaderPage(opts: ReaderPageOptions): string {
  const scripts = opts.scripts === 'inline'
    ? inlineScripts()
    : '<script src="/vendor/js/marked.min.js"></script>\n<script src="/vendor/js/purify.min.js"></script>';
  const meta = [typeLabel(opts.type), formatWhen(opts.completedAt)].filter(Boolean).join(' · ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${opts.noindex ? '<meta name="robots" content="noindex, nofollow">\n' : ''}${opts.refresh ? '<meta http-equiv="refresh" content="5">\n' : ''}<title>${escapeHtml(opts.title)}</title>
<style>
  :root {
    --bg: 248 247 245; --surface: 255 255 255; --text: 30 25 15; --muted: 110 104 94;
    --border: 30 25 15 / 0.12; --accent: 10 132 255;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: 28 26 23; --surface: 38 35 31; --text: 236 234 230; --muted: 160 156 150;
      --border: 255 255 255 / 0.10; --accent: 255 69 58;
    }
  }
  * { box-sizing: border-box; }
  html { background: rgb(var(--bg)); }
  body {
    margin: 0; padding: 48px 20px 80px; color: rgb(var(--text));
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; }
  .meta { font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: rgb(var(--muted)); margin-bottom: 8px; }
  h1.title { font-size: 30px; line-height: 1.2; margin: 0 0 28px; letter-spacing: -0.01em; }
  article h1 { font-size: 24px; } article h2 { font-size: 20px; } article h3 { font-size: 17px; }
  article h1, article h2, article h3 { margin: 1.6em 0 0.5em; line-height: 1.3; }
  article a { color: rgb(var(--accent)); }
  article code { font: 0.9em "SF Mono", ui-monospace, Menlo, monospace; background: rgb(var(--border)); padding: 1px 5px; border-radius: 4px; }
  article pre { background: rgb(var(--surface)); border: 1px solid rgb(var(--border)); border-radius: 8px; padding: 14px; overflow-x: auto; }
  article pre code { background: none; padding: 0; }
  article blockquote { margin: 1em 0; padding: 0 16px; border-left: 3px solid rgb(var(--accent)); color: rgb(var(--muted)); }
  article table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  article th, article td { border: 1px solid rgb(var(--border)); padding: 6px 10px; text-align: left; }
  article hr { border: 0; border-top: 1px solid rgb(var(--border)); margin: 2em 0; }
  article img { max-width: 100%; }
</style>
${scripts}
</head>
<body>
<main>
  <div class="meta">${escapeHtml(meta)}</div>
  <h1 class="title">${escapeHtml(opts.title)}</h1>
  <article id="content"></article>
</main>
<script>
  (function () {
    var md = ${scriptSafeJson(opts.markdown)};
    var el = document.getElementById('content');
    if (typeof marked === 'undefined') { el.textContent = md; return; }
    var html = marked.parse(md);
    el.innerHTML = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
    el.querySelectorAll('a[href^="http"]').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener'; });
  })();
</script>
</body>
</html>`;
}

/** Add `<meta name="robots" content="noindex">` to a whole HTML document. */
export function withNoindex(html: string): string {
  if (/<meta[^>]+name=["']robots["']/i.test(html)) return html;
  const tag = '<meta name="robots" content="noindex, nofollow">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  return `${tag}\n${html}`;
}
