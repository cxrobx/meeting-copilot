import {
  buildKitPage,
  buildReaderPage,
  dropRepeatedTitle,
  escapeHtml,
  formatWhen,
  typeLabel,
  viewContent,
  withNoindex,
  type TocEntry,
  type ViewableAction,
} from '../present/view-page.js';
import { PENDING_NOTE } from '../workers/deep-follow-up.js';

/**
 * A card as a page someone outside the meeting can open. A markdown card goes
 * to an agent that rewrites it as the body of an HTML Artifact Kit page (the
 * look Chris's Onyx artifacts wear); the server supplies the kit's shell, so
 * the agent only ever writes content. A mockup is already a page and goes up
 * as it is. Whatever the agent returns is checked, and anything unusable falls
 * back to the plain reader page, so publishing never dead-ends on the agent.
 */

export type RunAgent = (prompt: string, system: string, signal: AbortSignal) => Promise<string>;

export interface PolishedPage {
  html: string;
  /** How the page was made: 'agent', 'fallback' (agent output unusable), or 'as-is' (a mockup). */
  via: 'agent' | 'fallback' | 'as-is';
  /** Why the agent's page was not used, when it wasn't. */
  reason?: string;
}

export const POLISH_SYSTEM = `You turn a result card from a live meeting copilot into the body of a polished, standalone web page that will be sent to someone outside the meeting.

The page shell, title, fonts and styles already exist (Chris's HTML Artifact Kit). You write ONLY the HTML that goes inside <main>: no <html>, <head>, <body>, <style>, <script>, style="" attributes or event handlers. Use these kit components and nothing else:
- Start with exactly one <h1> holding a clean, reader-facing title for the page (sentence case, no "Research:" prefix, fixed spelling). The server lifts it into the page header; use no other <h1>.
- <h2 id="short-slug"> for sections, <h3 id="…"> for subsections (every h2/h3 gets a unique lowercase id).
- <p>, <ul>/<ol>/<li>, <strong>, <em>, <code>, <pre><code>…</code></pre>, <blockquote>
- tables wrapped as <div class="table-scroll"><table>…</table></div>
- <div class="callout tip|note|warn|danger"><span class="label">Bottom line</span>…</div> for the key takeaway or a risk
- <div class="cards"><div class="card"><h4>…</h4><p>…</p></div>…</div> for side-by-side options
- <details><summary>…</summary>…</details> for depth a reader can skip
- <span class="badge accent|success|warning|danger">…</span> for short labels
- <a href="https://…">…</a> for every source. Keep every source link from the card, on the fact it supports.

Write for a reader who was not in the meeting. Lead with the answer in a callout, then the supporting detail. Keep every fact, number, name, price and source from the card; do not add facts that are not in it.

Remove anything internal to the meeting: quotes from the transcript, references to what someone "mentioned" or "said", notes about the copilot or its research process, coach notes, and placeholder notes such as "Deep research is still reading". Rephrase "your pain point" style wording into neutral wording.

Reply with the HTML fragment only. No markdown fences, no commentary.`;

const FORBIDDEN = /<\s*\/?\s*(script|style|iframe|frame|object|embed|form|input|button|link|meta|base|html|head|body|svg|math|template)\b|\son[a-z]+\s*=|\sstyle\s*=|javascript:|data:text\/html|srcdoc\s*=/i;
const MAX_BYTES = 1024 * 1024;

/** The agent's fragment, checked and given ids, or the reason it can't be used. */
export function checkFragment(raw: string): { html: string; toc: TocEntry[]; title?: string } | { error: string } {
  let html = raw.trim().replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  if (html.length < 40) return { error: 'agent returned almost nothing' };
  if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) return { error: 'agent page over 1 MB' };
  if (!html.startsWith('<')) return { error: 'agent returned prose, not HTML' };
  const bad = FORBIDDEN.exec(html);
  if (bad) return { error: `agent page contains ${bad[0].trim()}` };
  // The agent's clean title, lifted out of the body; any later h1 becomes a section.
  let title: string | undefined;
  const lead = /^<h1\b[^>]*>([\s\S]*?)<\/h1>\s*/i.exec(html);
  if (lead) {
    title = lead[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 160) || undefined;
    html = html.slice(lead[0].length);
  }
  if (/<h1\b/i.test(html)) html = html.replace(/<(\/?)h1\b/gi, '<$1h2');

  const used = new Set<string>();
  const toc: TocEntry[] = [];
  html = html.replace(/<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (_m, level: string, attrs: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const given = /\sid\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    let id = (given || text.toLowerCase()).toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    for (let n = 2; used.has(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
    used.add(id);
    toc.push({ id, text, level: Number(level) as 2 | 3 });
    const rest = attrs.replace(/\sid\s*=\s*"[^"]*"/i, '');
    return `<h${level} id="${escapeHtml(id)}"${rest}>${inner}</h${level}>`;
  });
  // External links open in a new tab and don't hand this page to the target.
  html = html.replace(/<a\s+([^>]*href\s*=\s*"https?:[^"]*"[^>]*)>/gi, (m, attrs: string) =>
    /\starget=/i.test(` ${attrs}`) ? m : `<a ${attrs} target="_blank" rel="noopener">`);
  if (html.trim().length < 40) return { error: 'agent returned almost nothing' };
  return { html, toc, title };
}

export function polishPrompt(action: ViewableAction, markdown: string): string {
  return `Card type: ${typeLabel(action.type)}\nCard title: ${action.title}\n\nCard content (markdown):\n\n${markdown}`;
}

export async function polishToPage(action: ViewableAction, runAgent: RunAgent, signal: AbortSignal): Promise<PolishedPage> {
  const content = viewContent(action);
  if (!content) throw new Error('This card has nothing to publish.');
  if (content.kind === 'html') return { html: withNoindex(content.html), via: 'as-is' };

  const markdown = dropRepeatedTitle(content.markdown.split(PENDING_NOTE).join('').trim(), action.title);
  const fallback = (reason: string): PolishedPage => ({
    html: buildReaderPage({ title: action.title, type: action.type, completedAt: action.completedAt, markdown, noindex: true }),
    via: 'fallback',
    reason,
  });

  let raw: string;
  try {
    raw = await runAgent(polishPrompt(action, markdown), POLISH_SYSTEM, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return fallback(`agent failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const checked = checkFragment(raw);
  if ('error' in checked) return fallback(checked.error);
  return {
    html: buildKitPage({
      title: checked.title || action.title,
      subtitle: typeLabel(action.type),
      date: formatWhen(action.completedAt),
      contentHtml: checked.html,
      toc: checked.toc,
      noindex: true,
    }),
    via: 'agent',
  };
}
