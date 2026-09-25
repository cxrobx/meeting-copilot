import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { snapshotKind, type StagedTab, type StagedTabSnapshotKind } from '../prep/staged.js';
import { buildKitPage, escapeHtml } from './view-page.js';

/**
 * Evidence tabs: a staged prep's live pages and snapshots, for switching to
 * mid-meeting and pasting into the call chat (prep/staged.ts has the format).
 *
 * The dashboard shows them as tabs atop its main column (Onyx's design), a
 * snapshot in place from /file. Its ↗ Browser tab rides the card ↗ path
 * (GET /present/action/:id/view): GET /present/evidence/:i/view is a
 * same-server page outside /present, which the app's navigation policy hands
 * to the default browser. A live URL goes there directly, since that is where
 * the logins are. The server only ever
 * serves a snapshot by its index in the session's own prep.json, never by a
 * path from the request.
 */

export interface EvidenceTabView {
  index: number;
  title: string;
  url: string | null;
  note: string;
  /** Null for a live-only tab, and for a snapshot whose file has gone. */
  snapshot: { kind: StagedTabSnapshotKind; name: string } | null;
}

export function sessionDirFor(sessionId: string): string {
  return join(homedir(), '.meeting-copilot', 'sessions', sessionId);
}

/** The file behind a tab, if it is still there and still a snapshot. */
export function snapshotFile(tab: StagedTab, exists: (p: string) => boolean = existsSync): { path: string; kind: StagedTabSnapshotKind } | null {
  if (!tab.path) return null;
  const kind = snapshotKind(tab.path);
  if (!kind || !exists(tab.path)) return null;
  try {
    if (!statSync(tab.path).isFile()) return null;
  } catch {
    return null;
  }
  return { path: tab.path, kind };
}

/** What the dashboard gets: no absolute paths, just what it can show. */
export function evidenceView(tabs: StagedTab[], exists?: (p: string) => boolean): EvidenceTabView[] {
  return tabs.map((tab, index) => {
    const file = snapshotFile(tab, exists);
    return {
      index,
      title: tab.title,
      url: tab.url,
      note: tab.note,
      snapshot: file ? { kind: file.kind, name: basename(file.path) } : null,
    };
  });
}

export type UrlOpener = (url: string) => Promise<void>;

/** macOS `open`: the default browser, with the user's own sessions. No shell. */
export const openInDefaultBrowser: UrlOpener = (url) => new Promise((resolve, reject) => {
  execFile('/usr/bin/open', [url], (err) => (err ? reject(err) : resolve()));
});

/**
 * Open every live tab on Start, one after another so the browser keeps their
 * order, each URL once. COPILOT_OPEN_EVIDENCE=0 turns it off. Returns how
 * many opened.
 */
export async function openLiveTabs(tabs: StagedTab[], open: UrlOpener = openInDefaultBrowser): Promise<number> {
  if (process.env.COPILOT_OPEN_EVIDENCE === '0') return 0;
  let opened = 0;
  const seen = new Set<string>();
  for (const tab of tabs) {
    // Two snapshots of one page share its URL: one browser tab is enough.
    if (!tab.url || seen.has(tab.url)) continue;
    seen.add(tab.url);
    try {
      await open(tab.url);
      opened++;
    } catch (err) {
      console.warn(`[Evidence] could not open ${tab.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return opened;
}

/**
 * A tab as its own page, in the kit shell the card reader wears: the note,
 * the snapshot (an image inline, a PDF embedded), and the live link. An html
 * snapshot is sent as itself, like a mockup, so it never reaches here.
 */
export function buildEvidencePage(tab: StagedTab, fileUrl: string | null, kind: StagedTabSnapshotKind | null): string {
  const parts: string[] = [];
  if (tab.note) parts.push(`<p>${escapeHtml(tab.note)}</p>`);
  if (tab.url) {
    parts.push(`<p><a href="${escapeHtml(tab.url)}" target="_blank" rel="noopener">Open the live page ↗</a></p>`);
  }
  if (fileUrl && kind === 'image') {
    parts.push(`<figure><img src="${escapeHtml(fileUrl)}" alt="${escapeHtml(tab.title)}" style="max-width:100%;height:auto"></figure>`);
  } else if (fileUrl && kind === 'pdf') {
    parts.push(`<p><a href="${escapeHtml(fileUrl)}">Open the PDF on its own</a></p>`);
    parts.push(`<embed src="${escapeHtml(fileUrl)}" type="application/pdf" style="width:100%;height:80vh">`);
  } else if (!tab.url) {
    parts.push('<p>The snapshot file is not there any more.</p>');
  }
  return buildKitPage({
    title: tab.title,
    subtitle: 'Evidence',
    date: '',
    contentHtml: parts.join('\n'),
    toc: [],
  });
}

/**
 * The script an html snapshot gets when the dashboard shows it in a frame
 * (`/file?frame=1`): it tells the dashboard what is selected inside, so the
 * selection toolbar (Fact check, Explain, Add to chat) works on evidence too.
 * The frame is sandboxed without allow-same-origin, so this can only post a
 * message up; the dashboard checks it came from its own frame.
 */
export const SELECTION_BRIDGE_SCRIPT = String.raw`(function () {
  var timer = null;
  function send() {
    var s = window.getSelection();
    var text = s && !s.isCollapsed ? String(s).replace(/\s+/g, ' ').trim().slice(0, 1500) : '';
    var rect = null;
    if (text && s.rangeCount) {
      var b = s.getRangeAt(0).getBoundingClientRect();
      rect = { left: b.left, top: b.top, width: b.width, height: b.height, bottom: b.bottom };
    }
    try { parent.postMessage({ mcEvidenceSelection: 1, text: text, rect: rect }, '*'); } catch (e) {}
  }
  document.addEventListener('mouseup', function () { setTimeout(send, 10); });
  document.addEventListener('keyup', function (e) { if (e.shiftKey) send(); });
  document.addEventListener('selectionchange', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { var s = window.getSelection(); if (!s || s.isCollapsed) send(); }, 150);
  });
  window.addEventListener('scroll', function () { var s = window.getSelection(); if (s && !s.isCollapsed) send(); }, { passive: true });
})();`;

/** An html snapshot with the selection bridge added at its end. */
export function withSelectionBridge(html: string): string {
  const tag = `<script>${SELECTION_BRIDGE_SCRIPT}</script>`;
  const at = html.search(/<\/body\s*>/i);
  return at < 0 ? html + tag : html.slice(0, at) + tag + html.slice(at);
}
