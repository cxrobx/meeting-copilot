import { Router, type Response } from 'express';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import type { WorkerRegistry } from '../workers/registry.js';
import type { ActionLifecycle } from '../workers/types.js';

export function createPresentRouter(registry: WorkerRegistry): Router {
  const router = Router();
  const sseClients = new Set<Response>();

  // ─── SSE Bridge: registry events → browser ────────────────────────────
  const onActionStatus = (action: ActionLifecycle) => {
    let eventName: string;
    if (action.state === 'suggested') {
      eventName = 'action.suggested';
    } else if (action.state === 'running') {
      eventName = 'action.running';
    } else if (action.state === 'completed' || action.state === 'failed') {
      eventName = 'action.completed';
    } else {
      return;
    }

    const payload = JSON.stringify({
      id: action.id,
      type: action.type,
      title: action.title,
      description: action.description,
      state: action.state,
      result: action.result ?? null,
      completedAt: action.completedAt ? new Date(action.completedAt).toISOString() : null,
    });

    for (const res of sseClients) {
      res.write(`event: ${eventName}\ndata: ${payload}\n\n`);
    }
  };

  registry.on('action.status', onActionStatus);

  // ─── GET /present — HTML presentation page ────────────────────────────
  router.get('/present', (_req, res) => {
    res.type('html').send(PRESENT_HTML);
  });

  // ─── GET /present/actions — JSON snapshot (live or from stored session) ──
  router.get('/present/actions', (req, res) => {
    const sessionId = req.query.session as string | undefined;

    // If a session ID is specified, load from disk
    if (sessionId) {
      const sessionDir = join(homedir(), '.meeting-copilot', 'sessions', sessionId);
      const dbPath = join(sessionDir, 'session.db');
      if (!existsSync(dbPath)) {
        res.status(404).json({ error: 'Session not found', sessionId });
        return;
      }

      try {
        const db = new Database(dbPath, { readonly: true });
        const rows = db.prepare(
          `SELECT id, type, title, description, state, result, completedAt FROM action ORDER BY createdAt ASC`,
        ).all() as Array<{ id: string; type: string; title: string; description: string; state: string; result: string | null; completedAt: number | null }>;
        db.close();

        const actions = rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          description: r.description,
          state: r.state,
          result: r.result ? JSON.parse(r.result) : null,
          completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
        }));

        res.json({ actions, sessionId });
      } catch (err) {
        res.status(500).json({ error: 'Failed to read session', detail: String(err) });
      }
      return;
    }

    // Default: live actions from in-memory registry
    const completed = registry.getActionsByState('completed');
    const failed = registry.getActionsByState('failed');
    const running = registry.getActionsByState('running');
    const suggested = registry.getActionsByState('suggested');

    const actions = [...completed, ...failed, ...running, ...suggested].map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      description: a.description,
      state: a.state,
      result: a.result ?? null,
      completedAt: a.completedAt ? new Date(a.completedAt).toISOString() : null,
    }));

    res.json({ actions });
  });

  // ─── GET /present/sessions — list available sessions ────────────────
  router.get('/present/sessions', (_req, res) => {
    const sessionsDir = join(homedir(), '.meeting-copilot', 'sessions');
    try {
      const dirs = existsSync(sessionsDir)
        ? readdirSync(sessionsDir).filter((d) => {
            return existsSync(join(sessionsDir, d, 'session.db'));
          })
        : [];

      const sessions = dirs.map((id: string) => {
        try {
          const db = new Database(join(sessionsDir, id, 'session.db'), { readonly: true });
          const row = db.prepare('SELECT title, startedAt, endedAt FROM session LIMIT 1').get() as { title?: string; startedAt?: number; endedAt?: number } | undefined;
          const actionCount = (db.prepare('SELECT count(*) as c FROM action').get() as { c: number })?.c ?? 0;
          db.close();
          return {
            id,
            title: row?.title || 'Untitled',
            startedAt: row?.startedAt ? new Date(row.startedAt).toISOString() : null,
            endedAt: row?.endedAt ? new Date(row.endedAt).toISOString() : null,
            actionCount,
          };
        } catch {
          return { id, title: 'Untitled', startedAt: null, endedAt: null, actionCount: 0 };
        }
      }).filter((s: any) => s.actionCount > 0);

      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── GET /present/events — SSE stream ─────────────────────────────────
  router.get('/present/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Initial heartbeat
    res.write(':\n\n');

    sseClients.add(res);

    // 30s heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(':\n\n');
    }, 30_000);

    req.on('close', () => {
      sseClients.delete(res);
      clearInterval(heartbeat);
    });
  });

  return router;
}

// ─── Inline HTML Template ─────────────────────────────────────────────────

const PRESENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meeting Copilot — Present</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"><\/script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/gruvbox-light.min.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>
  /* ─── AnuPpuccin Gruvbox Light — exact values from vault ──── */
  :root {
    /* surfaces */
    --gb-base:    rgb(249, 245, 215);   /* ctp-ext-base */
    --gb-mantle:  rgb(236, 225, 196);   /* ctp-ext-mantle */
    --gb-crust:   rgb(230, 215, 178);   /* ctp-ext-crust */
    --gb-surface0: rgb(242, 229, 188);
    --gb-surface1: rgb(235, 219, 179);  /* ebdbb3 */
    --gb-surface2: rgb(214, 196, 161);  /* d6c4a1 */
    --gb-overlay0: rgb(189, 174, 147);
    --gb-overlay1: rgb(168, 153, 133);
    --gb-overlay2: rgb(149, 131, 106);
    /* text */
    --gb-text:     rgb(40, 40, 40);     /* ctp-ext-text */
    --gb-subtext1: rgb(80, 73, 69);
    --gb-subtext0: rgb(102, 92, 84);
    /* accents */
    --gb-red:      rgb(204, 36, 29);
    --gb-maroon:   rgb(204, 49, 29);
    --gb-peach:    rgb(214, 93, 14);    /* orange */
    --gb-yellow:   rgb(215, 153, 33);
    --gb-green:    rgb(152, 151, 26);
    --gb-teal:     rgb(102, 152, 26);
    --gb-sky:      rgb(26, 152, 76);
    --gb-sapphire: rgb(26, 133, 152);
    --gb-blue:     rgb(69, 133, 136);
    --gb-lavender: rgb(146, 111, 175);
    --gb-mauve:    rgb(177, 98, 134);
    --gb-pink:     rgb(177, 98, 118);
    --gb-rosewater:rgb(243, 128, 25);
    --gb-flamingo: rgb(207, 162, 174);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'JetBrains Mono', monospace;
    background: var(--gb-base);
    color: var(--gb-text);
    line-height: 1.6;
    min-height: 100vh;
    font-size: 14px;
  }

  .header {
    padding: 20px 40px;
    border-bottom: 1px solid var(--gb-surface2);
    display: flex;
    align-items: center;
    gap: 12px;
    position: sticky;
    top: 0;
    background: var(--gb-base);
    z-index: 100;
  }

  .header h1 {
    font-size: 18px;
    font-weight: 600;
    color: var(--gb-text);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--gb-green);
    animation: pulse 2s ease-in-out infinite;
  }

  .status-dot.disconnected {
    background: var(--gb-red);
    animation: none;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .layout {
    display: flex;
    min-height: calc(100vh - 61px);
  }

  .main {
    flex: 1;
    min-width: 0;
    max-width: 960px;
    margin: 0 auto;
    padding: 32px 40px;
  }

  /* ─── TOC Sidebar ──────────────────────────────────────────── */
  .toc {
    width: 280px;
    flex-shrink: 0;
    border-left: 1px solid var(--gb-surface2);
    position: sticky;
    top: 61px;
    height: calc(100vh - 61px);
    overflow-y: auto;
    padding: 16px 12px;
    background: var(--gb-mantle);
    scrollbar-width: thin;
    scrollbar-color: var(--gb-overlay0) transparent;
  }

  .toc::-webkit-scrollbar { width: 4px; }
  .toc::-webkit-scrollbar-track { background: transparent; }
  .toc::-webkit-scrollbar-thumb { background: var(--gb-overlay0); border-radius: 2px; }

  .toc-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--gb-overlay2);
    margin-bottom: 12px;
    padding-left: 8px;
  }

  .toc-section {
    margin-bottom: 2px;
  }

  .toc-card-title {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--gb-subtext1);
    cursor: pointer;
    transition: background 0.15s;
  }

  .toc-card-title:hover {
    background: var(--gb-surface1);
  }

  .toc-card-title.active {
    background: var(--gb-surface1);
    color: var(--gb-text);
  }

  .toc-badge {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .toc-badge.research { background: rgba(152, 151, 26, 0.15); color: var(--gb-green); }
  .toc-badge.summary { background: rgba(215, 153, 33, 0.15); color: var(--gb-yellow); }
  .toc-badge.mockup { background: rgba(177, 98, 134, 0.15); color: var(--gb-mauve); }
  .toc-badge.codegen { background: rgba(69, 133, 136, 0.15); color: var(--gb-blue); }
  .toc-badge.analysis { background: rgba(214, 93, 14, 0.15); color: var(--gb-peach); }

  .toc-heading {
    display: block;
    padding: 2px 8px 2px 20px;
    font-size: 12px;
    color: var(--gb-subtext0);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
    border-radius: 3px;
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .toc-heading.depth-3 {
    padding-left: 32px;
  }

  .toc-heading:hover {
    color: var(--gb-subtext1);
    background: var(--gb-surface1);
  }

  .toc-heading.active {
    color: var(--gb-text);
    background: rgba(69, 133, 136, 0.1);
    border-left: 2px solid var(--gb-blue);
    padding-left: 18px;
  }

  .toc-heading.active.depth-3 {
    padding-left: 30px;
  }

  @media (max-width: 1100px) {
    .toc { display: none; }
  }

  .empty-state {
    text-align: center;
    padding: 80px 20px;
    color: var(--gb-overlay2);
    font-size: 14px;
  }

  /* ─── Cards ────────────────────────────────────────────────── */
  .card {
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-radius: 8px;
    padding: 24px;
    margin-bottom: 20px;
    transition: border-color 0.2s;
  }

  .card.suggested {
    border-color: var(--gb-yellow);
    background: rgba(215, 153, 33, 0.06);
  }

  .card.running {
    border-color: var(--gb-blue);
    animation: border-pulse 1.5s ease-in-out infinite;
  }

  @keyframes border-pulse {
    0%, 100% { border-color: var(--gb-blue); }
    50% { border-color: var(--gb-surface2); }
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
  }

  .card-type {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(69, 133, 136, 0.12);
    color: var(--gb-blue);
  }

  .card-type.research { background: rgba(152, 151, 26, 0.12); color: var(--gb-green); }
  .card-type.summary { background: rgba(215, 153, 33, 0.12); color: var(--gb-yellow); }
  .card-type.mockup { background: rgba(177, 98, 134, 0.12); color: var(--gb-mauve); }
  .card-type.codegen { background: rgba(69, 133, 136, 0.12); color: var(--gb-blue); }
  .card-type.analysis { background: rgba(214, 93, 14, 0.12); color: var(--gb-peach); }
  .card-type.failed { background: rgba(204, 36, 29, 0.12); color: var(--gb-red); }

  .card-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--gb-text);
  }

  .card-time {
    font-size: 11px;
    color: var(--gb-overlay2);
    margin-left: auto;
  }

  .card-body {
    font-size: 14px;
    color: var(--gb-subtext1);
  }

  .card-body h1 {
    color: var(--gb-red);
    font-size: 20px;
    font-weight: 700;
    margin-top: 20px;
    margin-bottom: 8px;
  }

  .card-body h2 {
    color: var(--gb-peach);
    font-size: 17px;
    font-weight: 700;
    margin-top: 18px;
    margin-bottom: 8px;
  }

  .card-body h3 {
    color: var(--gb-sky);
    font-size: 15px;
    font-weight: 600;
    margin-top: 14px;
    margin-bottom: 6px;
  }

  .card-body h4 {
    color: var(--gb-blue);
    font-size: 14px;
    font-weight: 600;
    margin-top: 12px;
    margin-bottom: 4px;
  }

  .card-body h5 {
    color: var(--gb-lavender);
    font-size: 13px;
    font-weight: 600;
    margin-top: 10px;
    margin-bottom: 4px;
  }

  .card-body p { margin-bottom: 10px; }

  .card-body ul, .card-body ol {
    padding-left: 20px;
    margin-bottom: 10px;
  }

  .card-body li { margin-bottom: 4px; }

  .card-body strong { color: var(--gb-text); }

  .card-body a {
    color: var(--gb-blue);
    text-decoration: none;
  }

  .card-body a:hover { text-decoration: underline; }

  .card-body pre {
    background: var(--gb-surface1);
    border: 1px solid var(--gb-surface2);
    border-radius: 6px;
    padding: 16px;
    overflow-x: auto;
    margin: 12px 0;
    font-size: 13px;
    line-height: 1.5;
  }

  .card-body code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
  }

  .card-body :not(pre) > code {
    background: var(--gb-surface1);
    color: var(--gb-peach);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .card-body hr {
    border: none;
    border-top: 1px solid var(--gb-surface2);
    margin: 16px 0;
  }

  .card-body blockquote {
    border-left: 3px solid var(--gb-overlay0);
    padding-left: 14px;
    color: var(--gb-subtext0);
    margin: 10px 0;
  }

  .card-body table {
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0;
    font-size: 13px;
  }

  .card-body th, .card-body td {
    border: 1px solid var(--gb-surface2);
    padding: 6px 12px;
    text-align: left;
  }

  .card-body th {
    background: var(--gb-surface1);
    font-weight: 600;
    color: var(--gb-text);
  }

  .card-body input[type="checkbox"] {
    accent-color: var(--gb-green);
    margin-right: 6px;
  }

  .artifact-divider {
    border-top: 1px solid var(--gb-surface2);
    margin: 16px 0;
    padding-top: 12px;
  }

  .artifact-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--gb-overlay2);
    margin-bottom: 8px;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--gb-surface2);
    border-top-color: var(--gb-blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
</head>
<body>

<div class="header">
  <div class="status-dot" id="statusDot"></div>
  <h1>Meeting Copilot</h1>
</div>

<div class="layout">
  <div class="main" id="results">
    <div class="empty-state" id="emptyState">
      Waiting for results...
    </div>
  </div>
  <nav class="toc" id="toc">
    <div class="toc-title">Outline</div>
    <div id="tocEntries"></div>
  </nav>
</div>

<script>
(function() {
  var resultsEl = document.getElementById('results');
  var emptyEl = document.getElementById('emptyState');
  var statusDot = document.getElementById('statusDot');
  var tocEntries = document.getElementById('tocEntries');
  var actionCards = new Map();
  var headingIdCounter = 0;

  function renderMarkdown(text) {
    if (typeof marked !== 'undefined') {
      return marked.parse(text);
    }
    return '<pre>' + escapeHtml(text) + '</pre>';
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightCode() {
    if (typeof hljs !== 'undefined') {
      document.querySelectorAll('.card-body pre code:not(.hljs)').forEach(function(block) {
        hljs.highlightElement(block);
      });
    }
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    var d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ─── TOC ──────────────────────────────────────────────────

  function rebuildToc() {
    tocEntries.innerHTML = '';
    var cards = resultsEl.querySelectorAll('.card');
    cards.forEach(function(card) {
      var titleEl = card.querySelector('.card-title');
      var typeEl = card.querySelector('.card-type');
      if (!titleEl) return;

      var section = document.createElement('div');
      section.className = 'toc-section';

      // Card title row
      var cardLink = document.createElement('div');
      cardLink.className = 'toc-card-title';
      cardLink.dataset.target = card.id;

      if (typeEl) {
        var badge = document.createElement('span');
        badge.className = 'toc-badge ' + (typeEl.textContent || '').trim().toLowerCase();
        badge.textContent = (typeEl.textContent || '').trim().slice(0, 3);
        cardLink.appendChild(badge);
      }

      var label = document.createElement('span');
      label.textContent = titleEl.textContent;
      label.style.overflow = 'hidden';
      label.style.textOverflow = 'ellipsis';
      label.style.whiteSpace = 'nowrap';
      cardLink.appendChild(label);

      cardLink.addEventListener('click', function() {
        document.getElementById(card.id).scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      section.appendChild(cardLink);

      // Headings within the card body
      var headings = card.querySelectorAll('.card-body h1, .card-body h2, .card-body h3');
      headings.forEach(function(h) {
        if (!h.id) {
          h.id = 'toc-h-' + (++headingIdCounter);
        }
        var depth = parseInt(h.tagName.charAt(1), 10);
        var link = document.createElement('a');
        link.className = 'toc-heading' + (depth >= 3 ? ' depth-3' : '');
        link.textContent = h.textContent;
        link.href = '#' + h.id;
        link.addEventListener('click', function(e) {
          e.preventDefault();
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        section.appendChild(link);
      });

      tocEntries.appendChild(section);
    });
  }

  // Highlight active TOC entry on scroll
  var scrollRaf = null;
  window.addEventListener('scroll', function() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function() {
      scrollRaf = null;
      var headings = resultsEl.querySelectorAll('.card-body h1[id], .card-body h2[id], .card-body h3[id]');
      var activeId = null;
      var scrollY = window.scrollY + 100;

      headings.forEach(function(h) {
        if (h.getBoundingClientRect().top + window.scrollY <= scrollY) {
          activeId = h.id;
        }
      });

      // Also check card positions for card-title highlights
      var activeCardId = null;
      resultsEl.querySelectorAll('.card').forEach(function(card) {
        if (card.getBoundingClientRect().top + window.scrollY <= scrollY) {
          activeCardId = card.id;
        }
      });

      tocEntries.querySelectorAll('.toc-heading').forEach(function(link) {
        link.classList.toggle('active', link.getAttribute('href') === '#' + activeId);
      });
      tocEntries.querySelectorAll('.toc-card-title').forEach(function(link) {
        link.classList.toggle('active', link.dataset.target === activeCardId);
      });
    });
  });

  // ─── Render ───────────────────────────────────────────────

  function renderAction(action) {
    if (emptyEl) emptyEl.remove();

    var existing = actionCards.get(action.id);
    if (existing) {
      existing.remove();
    }

    var card = document.createElement('div');
    card.className = 'card' + (action.state === 'running' ? ' running' : action.state === 'suggested' ? ' suggested' : '');
    card.id = 'action-' + action.id;

    var typeClass = action.state === 'failed' ? 'failed' : action.type;

    var header = '<div class="card-header">' +
      '<span class="card-type ' + typeClass + '">' + escapeHtml(action.type) + '</span>' +
      '<span class="card-title">' + escapeHtml(action.title) + '</span>' +
      '<span class="card-time">' + formatTime(action.completedAt) + '</span>' +
      '</div>';

    var body = '';

    if (action.state === 'suggested') {
      body = '<div class="card-body"><p style="color:#b57614">' + escapeHtml(action.description || 'Waiting for approval...') + '</p></div>';
    } else if (action.state === 'running') {
      body = '<div class="card-body"><span class="spinner"></span> Running...</div>';
    } else if (action.result && action.result.artifacts && action.result.artifacts.length > 0) {
      body = '<div class="card-body">';
      action.result.artifacts.forEach(function(artifact, i) {
        if (i > 0) {
          body += '<div class="artifact-divider"></div>';
        }
        if (artifact.title) {
          body += '<div class="artifact-label">' + escapeHtml(artifact.title) + '</div>';
        }
        if (artifact.type === 'markdown') {
          body += renderMarkdown(artifact.content);
        } else if (artifact.type === 'code') {
          body += '<pre><code>' + escapeHtml(artifact.content) + '</code></pre>';
        } else {
          body += '<pre>' + escapeHtml(artifact.content) + '</pre>';
        }
      });
      body += '</div>';
    } else if (action.result && action.result.summary) {
      body = '<div class="card-body"><p>' + escapeHtml(action.result.summary) + '</p></div>';
    } else if (action.state === 'failed') {
      var errMsg = (action.result && action.result.error) || 'Unknown error';
      body = '<div class="card-body"><p style="color:#9d0006">' + escapeHtml(errMsg) + '</p></div>';
    }

    card.innerHTML = header + body;

    // Insert at top (newest first)
    resultsEl.insertBefore(card, resultsEl.firstChild);
    actionCards.set(action.id, card);

    highlightCode();
    rebuildToc();
  }

  // Pass ?session= query param through to the API
  var params = new URLSearchParams(window.location.search);
  var sessionParam = params.get('session');
  var actionsUrl = '/present/actions' + (sessionParam ? '?session=' + encodeURIComponent(sessionParam) : '');

  // Load existing actions
  fetch(actionsUrl)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.actions && data.actions.length > 0) {
        data.actions.reverse().forEach(renderAction);
      }
    })
    .catch(function(err) {
      console.error('Failed to load actions:', err);
    });

  // SSE for live updates
  var source = new EventSource('/present/events');

  source.addEventListener('action.suggested', function(e) {
    renderAction(JSON.parse(e.data));
  });

  source.addEventListener('action.completed', function(e) {
    renderAction(JSON.parse(e.data));
  });

  source.addEventListener('action.running', function(e) {
    renderAction(JSON.parse(e.data));
  });

  source.onopen = function() {
    statusDot.classList.remove('disconnected');
  };

  source.onerror = function() {
    statusDot.classList.add('disconnected');
  };
})();
<\/script>
</body>
</html>`;
