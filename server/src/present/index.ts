import { Router, type Response } from 'express';
import type { WorkerRegistry } from '../workers/registry.js';
import type { ActionLifecycle } from '../workers/types.js';

export function createPresentRouter(registry: WorkerRegistry): Router {
  const router = Router();
  const sseClients = new Set<Response>();

  // ─── SSE Bridge: registry events → browser ────────────────────────────
  const onActionStatus = (action: ActionLifecycle) => {
    if (action.state !== 'completed' && action.state !== 'running' && action.state !== 'failed') return;

    const eventName = action.state === 'running' ? 'action.running' : 'action.completed';
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

  // ─── GET /present/actions — JSON snapshot ─────────────────────────────
  router.get('/present/actions', (_req, res) => {
    const completed = registry.getActionsByState('completed');
    const failed = registry.getActionsByState('failed');
    const running = registry.getActionsByState('running');

    const actions = [...completed, ...failed, ...running].map((a) => ({
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
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;
    background: #141415;
    color: rgba(255, 255, 255, 0.96);
    line-height: 1.6;
    min-height: 100vh;
  }

  .header {
    padding: 24px 40px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .header h1 {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4ade80;
    animation: pulse 2s ease-in-out infinite;
  }

  .status-dot.disconnected {
    background: #f87171;
    animation: none;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .container {
    max-width: 960px;
    margin: 0 auto;
    padding: 32px 40px;
  }

  .empty-state {
    text-align: center;
    padding: 80px 20px;
    color: rgba(255, 255, 255, 0.4);
    font-size: 16px;
  }

  .card {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 20px;
    transition: border-color 0.2s;
  }

  .card.running {
    border-color: #8cbdf5;
    animation: border-pulse 1.5s ease-in-out infinite;
  }

  @keyframes border-pulse {
    0%, 100% { border-color: #8cbdf5; }
    50% { border-color: rgba(140, 189, 245, 0.3); }
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
  }

  .card-type {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(140, 189, 245, 0.15);
    color: #8cbdf5;
  }

  .card-type.research { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
  .card-type.summary { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
  .card-type.mockup { background: rgba(168, 85, 247, 0.15); color: #a855f7; }
  .card-type.codegen { background: rgba(140, 189, 245, 0.15); color: #8cbdf5; }
  .card-type.analysis { background: rgba(251, 146, 60, 0.15); color: #fb923c; }
  .card-type.failed { background: rgba(248, 113, 113, 0.15); color: #f87171; }

  .card-title {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .card-time {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.35);
    margin-left: auto;
  }

  .card-body {
    font-size: 15px;
    color: rgba(255, 255, 255, 0.82);
  }

  .card-body h1, .card-body h2, .card-body h3 {
    color: rgba(255, 255, 255, 0.96);
    margin-top: 16px;
    margin-bottom: 8px;
  }

  .card-body h1 { font-size: 20px; }
  .card-body h2 { font-size: 17px; }
  .card-body h3 { font-size: 15px; }

  .card-body p { margin-bottom: 10px; }

  .card-body ul, .card-body ol {
    padding-left: 20px;
    margin-bottom: 10px;
  }

  .card-body li { margin-bottom: 4px; }

  .card-body a {
    color: #8cbdf5;
    text-decoration: none;
  }

  .card-body a:hover { text-decoration: underline; }

  .card-body pre {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 16px;
    overflow-x: auto;
    margin: 12px 0;
    font-size: 13px;
    line-height: 1.5;
  }

  .card-body code {
    font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
    font-size: 13px;
  }

  .card-body :not(pre) > code {
    background: rgba(255, 255, 255, 0.08);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .artifact-divider {
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    margin: 16px 0;
    padding-top: 12px;
  }

  .artifact-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(255, 255, 255, 0.35);
    margin-bottom: 8px;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(140, 189, 245, 0.3);
    border-top-color: #8cbdf5;
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

<div class="container" id="results">
  <div class="empty-state" id="emptyState">
    Waiting for results...
  </div>
</div>

<script>
(function() {
  const resultsEl = document.getElementById('results');
  const emptyEl = document.getElementById('emptyState');
  const statusDot = document.getElementById('statusDot');
  const actionCards = new Map();

  function renderMarkdown(text) {
    if (typeof marked !== 'undefined') {
      return marked.parse(text);
    }
    // Fallback: wrap in pre
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

  function renderAction(action) {
    if (emptyEl) emptyEl.remove();

    var existing = actionCards.get(action.id);
    if (existing) {
      existing.remove();
    }

    var card = document.createElement('div');
    card.className = 'card' + (action.state === 'running' ? ' running' : '');
    card.id = 'action-' + action.id;

    var typeClass = action.state === 'failed' ? 'failed' : action.type;

    var header = '<div class="card-header">' +
      '<span class="card-type ' + typeClass + '">' + escapeHtml(action.type) + '</span>' +
      '<span class="card-title">' + escapeHtml(action.title) + '</span>' +
      '<span class="card-time">' + formatTime(action.completedAt) + '</span>' +
      '</div>';

    var body = '';

    if (action.state === 'running') {
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
      body = '<div class="card-body"><p style="color:#f87171">' + escapeHtml(errMsg) + '</p></div>';
    }

    card.innerHTML = header + body;

    // Insert at top (newest first)
    resultsEl.insertBefore(card, resultsEl.firstChild);
    actionCards.set(action.id, card);

    highlightCode();
  }

  // Load existing actions
  fetch('/present/actions')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.actions && data.actions.length > 0) {
        // Render oldest first so newest ends up on top
        data.actions.reverse().forEach(renderAction);
      }
    })
    .catch(function(err) {
      console.error('Failed to load actions:', err);
    });

  // SSE for live updates
  var source = new EventSource('/present/events');

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
