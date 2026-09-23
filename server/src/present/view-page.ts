import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import vm from 'node:vm';
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
 * sent as-is. Anything else is markdown and goes into a reader page,
 * rendered on the server, in the house look (the HTML Artifact Kit below).
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

export function formatWhen(completedAt: ViewableAction['completedAt']): string {
  if (completedAt == null || completedAt === '') return '';
  const d = new Date(completedAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// ─── The house look: Chris's HTML Artifact Kit ─────────────────────────────
// Every page a card becomes wears the kit that Onyx's Artifacts wear
// (~/.claude/docs/html-design: Solarized cream, JetBrains Mono, headings
// coloured by level, dark mode by prefers-color-scheme). It is read live so
// a kit change reaches these pages too; server/vendor/artifact-kit is the
// snapshot used when that directory is missing (scripts/vendor-assets.sh).

const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor');

function kitFile(name: string): string {
  const live = join(homedir(), '.claude', 'docs', 'html-design', name);
  try {
    return readFileSync(live, 'utf8');
  } catch {
    return readFileSync(join(VENDOR_DIR, 'artifact-kit', name), 'utf8');
  }
}

export interface TocEntry { id: string; text: string; level: 2 | 3 }

export interface KitPageOptions {
  title: string;
  subtitle: string;
  /** The eyebrow and footer line. */
  date: string;
  /** Body HTML for <main>. Trusted: the caller built or sanitized it. */
  contentHtml: string;
  toc: TocEntry[];
  /** Reload every few seconds, while a deep follow-up is still coming. */
  refresh?: boolean;
  /** Published pages ask search engines to stay out. */
  noindex?: boolean;
}

/**
 * A page in the kit's own shell (template.html with style.css inlined). One
 * altitude, so the level radios go, as the template says to. The nav is
 * authored here from the headings, never left to the template's script: the
 * page has to read with JS off (house convention 4).
 */
export function buildKitPage(opts: KitPageOptions): string {
  const nav = opts.toc.length >= 3
    ? '        <nav class="toc">\n          <div class="label">Contents</div>\n          <ul>\n' +
      opts.toc.map((t) => `            <li class="h${t.level}"><a href="#${escapeHtml(t.id)}">${escapeHtml(t.text)}</a></li>`).join('\n') +
      '\n          </ul>\n        </nav>'
    : '';
  const head = [
    opts.noindex ? '<meta name="robots" content="noindex, nofollow">' : '',
    opts.refresh ? '<meta http-equiv="refresh" content="5">' : '',
  ].filter(Boolean).join('\n');
  // Function replacers throughout: a `$` in the content must not be read as a
  // replacement pattern.
  return kitFile('template.html')
    .replace(/<input type="radio" name="lvl"[^>]*>\n?/g, '')
    .replace('<meta name="viewport" content="width=device-width, initial-scale=1">', (m) => (head ? `${m}\n${head}` : m))
    .replace('{{STYLE}}', () => kitFile('style.css'))
    .replace('{{TOC}}', () => nav)
    .replace('{{CONTENT}}', () => opts.contentHtml)
    .replace(/{{TITLE}}/g, () => escapeHtml(opts.title))
    .replace(/{{SUBTITLE}}/g, () => escapeHtml(opts.subtitle))
    .replace(/{{DATE}}/g, () => escapeHtml(opts.date));
}

// ─── Markdown → HTML, on the server ────────────────────────────────────────
// The vendored browser build of marked, evaluated once in its own context
// (the package is ESM, so `require` can't load its UMD). Raw HTML in the
// markdown is shown as text and only web/mail links survive, so the page is
// safe without DOMPurify and needs no script to read.

let markedLib: any = null;
function markedModule(): any {
  if (!markedLib) {
    const ctx: Record<string, any> = {};
    ctx.globalThis = ctx;
    vm.runInNewContext(readFileSync(join(VENDOR_DIR, 'js', 'marked.min.js'), 'utf8'), ctx);
    markedLib = ctx.marked;
  }
  return markedLib;
}

const SAFE_HREF = /^(https?:|mailto:|#)/i;

function slugify(text: string, used: Set<string>): string {
  const base = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}

/** Card markdown as kit-ready HTML plus its h2/h3 outline. */
export function renderCardMarkdown(markdown: string): { html: string; toc: TocEntry[] } {
  const { Marked } = markedModule();
  // The page's own <h1> is the card title, so a card that uses `#` is shifted
  // down a level to keep one h1 and let its sections become the h2s.
  const shift = /^# /m.test(markdown) ? 1 : 0;
  const toc: TocEntry[] = [];
  const used = new Set<string>();
  const marked = new Marked({
    gfm: true,
    renderer: {
      html(token: { text: string }) {
        return escapeHtml(token.text);
      },
      heading(this: any, token: { tokens: unknown[]; depth: number }) {
        const level = Math.min(6, token.depth + shift);
        const inner = this.parser.parseInline(token.tokens);
        const text = inner.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        const id = slugify(text, used);
        if (level === 2 || level === 3) toc.push({ id, text, level });
        return `<h${level} id="${id}">${inner}</h${level}>\n`;
      },
      link(this: any, token: { href: string; title?: string | null; tokens: unknown[] }) {
        const inner = this.parser.parseInline(token.tokens);
        if (!SAFE_HREF.test(token.href)) return inner;
        const external = /^https?:/i.test(token.href);
        return `<a href="${escapeHtml(token.href)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}${external ? ' target="_blank" rel="noopener"' : ''}>${inner}</a>`;
      },
      image(token: { href: string; text: string }) {
        return /^https?:/i.test(token.href) ? `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}">` : escapeHtml(token.text);
      },
    },
  });
  const html = String(marked.parse(markdown))
    .replace(/<table>/g, '<div class="table-scroll"><table>')
    .replace(/<\/table>/g, '</table></div>');
  return { html, toc };
}

export interface ReaderPageOptions {
  title: string;
  type: string;
  completedAt?: ViewableAction['completedAt'];
  markdown: string;
  refresh?: boolean;
  noindex?: boolean;
}

/** Cards often open by restating their title; the page already shows it as the h1. */
export function dropRepeatedTitle(markdown: string, title: string): string {
  const norm = (s: string) => s.replace(/[*_`#:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const m = /^\s*(?:#{1,6}\s+(.+)|\*\*(.+)\*\*)\s*(?:\n|$)/.exec(markdown);
  if (!m || norm(m[1] ?? m[2]) !== norm(title)) return markdown;
  return markdown.slice(m[0].length).replace(/^\s+/, '');
}

/** A markdown card as a kit page. */
export function buildReaderPage(opts: ReaderPageOptions): string {
  const { html, toc } = renderCardMarkdown(dropRepeatedTitle(opts.markdown, opts.title));
  return buildKitPage({
    title: opts.title,
    subtitle: typeLabel(opts.type),
    date: formatWhen(opts.completedAt),
    contentHtml: html,
    toc,
    refresh: opts.refresh,
    noindex: opts.noindex,
  });
}

/** Add `<meta name="robots" content="noindex">` to a whole HTML document. */
export function withNoindex(html: string): string {
  if (/<meta[^>]+name=["']robots["']/i.test(html)) return html;
  const tag = '<meta name="robots" content="noindex, nofollow">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  return `${tag}\n${html}`;
}
