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

  // ─── GET /present — HTML dashboard ──────────────────────────────────
  router.get('/present', (_req, res) => {
    res.type('html').send(PRESENT_HTML);
  });

  // ─── GET /present/actions — JSON snapshot (live or stored session) ───
  router.get('/present/actions', (req, res) => {
    const sessionId = req.query.session as string | undefined;

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

  // ─── GET /present/transcript — transcript segments for stored session ─
  router.get('/present/transcript', (req, res) => {
    const sessionId = req.query.session as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'session query param required' });
      return;
    }

    const dbPath = join(homedir(), '.meeting-copilot', 'sessions', sessionId, 'session.db');
    if (!existsSync(dbPath)) {
      res.status(404).json({ error: 'Session not found', sessionId });
      return;
    }

    try {
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(
        `SELECT id, text, source, label, timestamp, duration, wordCount FROM transcript ORDER BY timestamp ASC`,
      ).all() as Array<{ id: string; text: string; source: string; label: string; timestamp: number; duration: number; wordCount: number }>;

      // Get session start time for relative timestamps
      const session = db.prepare('SELECT startedAt FROM session LIMIT 1').get() as { startedAt?: number } | undefined;
      db.close();

      res.json({ segments: rows, sessionId, startedAt: session?.startedAt ?? null });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read transcript', detail: String(err) });
    }
  });

  // ─── GET /present/sessions — list available sessions ────────────────
  // ?all=1 includes empty/orphan sessions (for cleanup)
  router.get('/present/sessions', (req, res) => {
    const sessionsDir = join(homedir(), '.meeting-copilot', 'sessions');
    const includeAll = req.query.all === '1';
    try {
      const allDirs = existsSync(sessionsDir)
        ? readdirSync(sessionsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
        : [];

      const sessions = allDirs.map((id: string) => {
        const hasDb = existsSync(join(sessionsDir, id, 'session.db'));
        if (!hasDb) {
          return { id, title: '(Empty session)', startedAt: null, endedAt: null, actionCount: 0, segmentCount: 0, empty: true };
        }
        try {
          const db = new Database(join(sessionsDir, id, 'session.db'), { readonly: true });
          const row = db.prepare('SELECT title, startedAt, endedAt FROM session LIMIT 1').get() as { title?: string; startedAt?: number; endedAt?: number } | undefined;
          const actionCount = (db.prepare('SELECT count(*) as c FROM action').get() as { c: number })?.c ?? 0;
          const segmentCount = (db.prepare('SELECT count(*) as c FROM transcript').get() as { c: number })?.c ?? 0;
          db.close();
          return {
            id,
            title: row?.title || 'Untitled',
            startedAt: row?.startedAt ? new Date(row.startedAt).toISOString() : null,
            endedAt: row?.endedAt ? new Date(row.endedAt).toISOString() : null,
            actionCount,
            segmentCount,
            empty: false,
          };
        } catch {
          return { id, title: 'Untitled', startedAt: null, endedAt: null, actionCount: 0, segmentCount: 0, empty: false };
        }
      }).filter((s: any) => includeAll || s.actionCount > 0 || s.segmentCount > 0)
        .sort((a: any, b: any) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── GET /present/events — SSE stream (fallback for replay) ─────────
  router.get('/present/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    res.write(':\n\n');
    sseClients.add(res);

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
<title>Meeting Copilot</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"><\/script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/gruvbox-light.min.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>
  /* ─── AnuPpuccin Gruvbox Light ─────────────────────────────── */
  :root {
    --gb-base:     rgb(249,245,215);
    --gb-mantle:   rgb(236,225,196);
    --gb-crust:    rgb(230,215,178);
    --gb-surface0: rgb(242,229,188);
    --gb-surface1: rgb(235,219,179);
    --gb-surface2: rgb(214,196,161);
    --gb-overlay0: rgb(189,174,147);
    --gb-overlay1: rgb(168,153,133);
    --gb-overlay2: rgb(149,131,106);
    --gb-text:     rgb(40,40,40);
    --gb-subtext1: rgb(80,73,69);
    --gb-subtext0: rgb(102,92,84);
    --gb-red:      rgb(204,36,29);
    --gb-maroon:   rgb(204,49,29);
    --gb-peach:    rgb(214,93,14);
    --gb-yellow:   rgb(215,153,33);
    --gb-green:    rgb(152,151,26);
    --gb-teal:     rgb(102,152,26);
    --gb-sky:      rgb(26,152,76);
    --gb-sapphire: rgb(26,133,152);
    --gb-blue:     rgb(69,133,136);
    --gb-lavender: rgb(146,111,175);
    --gb-mauve:    rgb(177,98,134);
    --gb-pink:     rgb(177,98,118);
    --gb-rosewater:rgb(243,128,25);
    --gb-flamingo: rgb(207,162,174);
  }

  * { margin:0; padding:0; box-sizing:border-box; }

  body {
    font-family: 'JetBrains Mono', monospace;
    background: var(--gb-base);
    color: var(--gb-text);
    line-height: 1.6;
    min-height: 100vh;
    font-size: 13px;
    overflow-x: hidden;
    max-width: 100vw;
  }

  /* ─── Header ───────────────────────────────────────────────── */
  .header {
    padding: 10px 20px;
    border-bottom: 1px solid var(--gb-surface2);
    display: flex;
    align-items: center;
    gap: 12px;
    position: sticky;
    top: 0;
    background: var(--gb-base);
    z-index: 100;
    height: 50px;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .header-left h1 {
    font-size: 15px;
    font-weight: 700;
    color: var(--gb-text);
  }

  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--gb-overlay0);
    flex-shrink: 0;
  }
  .status-dot.connected { background: var(--gb-green); animation: pulse 2s ease-in-out infinite; }
  .status-dot.disconnected { background: var(--gb-red); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  .header-center {
    flex: 1;
    text-align: center;
    font-size: 14px;
    font-weight: 600;
    color: var(--gb-subtext1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .state-pill {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 10px;
    border-radius: 10px;
    color: white;
  }
  .state-pill.idle { background: var(--gb-overlay2); }
  .state-pill.live { background: var(--gb-green); }
  .state-pill.priming, .state-pill.ending { background: var(--gb-blue); }
  .state-pill.degraded { background: var(--gb-yellow); }
  .state-pill.error { background: var(--gb-red); }
  .state-pill.archived { background: var(--gb-subtext0); }

  .session-timer {
    font-size: 16px;
    font-weight: 600;
    color: var(--gb-subtext0);
    font-variant-numeric: tabular-nums;
    min-width: 60px;
    text-align: right;
  }

  /* ─── Buttons ──────────────────────────────────────────────── */
  .btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-green { background: var(--gb-green); color: white; }
  .btn-red { background: var(--gb-red); color: white; }
  .btn-blue { background: var(--gb-blue); color: white; }
  .btn-ghost { background: transparent; border: 1px solid var(--gb-surface2); color: var(--gb-subtext0); }
  .btn-ghost:hover { background: var(--gb-surface1); }
  .btn-ghost-red { background: transparent; border: 1px solid var(--gb-surface2); color: var(--gb-red); }

  /* ─── Stats Bar ────────────────────────────────────────────── */
  .stats-bar {
    display: none;
    padding: 8px 24px;
    gap: 12px;
    border-bottom: 1px solid var(--gb-surface2);
    background: var(--gb-base);
  }
  .stats-bar.visible { display: flex; }

  .stat-tile {
    flex: 1;
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-radius: 6px;
    padding: 8px 14px;
    text-align: center;
  }
  .stat-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--gb-overlay2);
  }
  .stat-value {
    font-size: 18px;
    font-weight: 700;
    color: var(--gb-text);
    line-height: 1.2;
  }

  /* ─── Layout ───────────────────────────────────────────────── */
  .layout {
    display: grid;
    grid-template-columns: 1fr;
    height: calc(100vh - 50px);
    overflow: hidden;
  }
  .layout .transcript-col,
  .layout .toc {
    display: none;
  }
  .layout.three-col {
    grid-template-columns: 260px minmax(0, 1fr) 280px;
  }
  .layout.three-col .transcript-col,
  .layout.three-col .toc {
    display: flex;
  }

  @media (max-width: 1400px) {
    .layout.three-col { grid-template-columns: 1fr 260px; }
    .layout.three-col .transcript-col { display: none; }
  }
  @media (max-width: 1100px) {
    .layout.three-col { grid-template-columns: 1fr; }
    .layout.three-col .transcript-col { display: none; }
    .layout.three-col .toc { display: none; }
  }

  /* ─── Transcript Column ────────────────────────────────────── */
  .transcript-col {
    background: var(--gb-mantle);
    border-right: 1px solid var(--gb-surface2);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }

  .transcript-header {
    padding: 12px 14px 8px;
    border-bottom: 1px solid var(--gb-surface2);
    flex-shrink: 0;
  }

  .transcript-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .transcript-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--gb-overlay2);
  }

  .segment-count {
    font-size: 10px;
    font-weight: 600;
    color: var(--gb-overlay1);
    background: var(--gb-surface1);
    padding: 1px 7px;
    border-radius: 8px;
  }

  .filter-row {
    display: flex;
    gap: 4px;
    margin-bottom: 6px;
  }

  .filter-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid var(--gb-surface2);
    background: transparent;
    color: var(--gb-subtext0);
    cursor: pointer;
    transition: all 0.15s;
  }
  .filter-btn.active {
    background: var(--gb-surface2);
    color: var(--gb-text);
  }
  .filter-btn:hover:not(.active) {
    background: var(--gb-surface1);
  }

  .transcript-search {
    width: 100%;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 5px 10px;
    border: 1px solid var(--gb-surface2);
    border-radius: 4px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
  }
  .transcript-search:focus { border-color: var(--gb-blue); }
  .transcript-search::placeholder { color: var(--gb-overlay1); }

  .transcript-feed {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
    scrollbar-width: thin;
    scrollbar-color: var(--gb-overlay0) transparent;
  }
  .transcript-feed::-webkit-scrollbar { width: 4px; }
  .transcript-feed::-webkit-scrollbar-thumb { background: var(--gb-overlay0); border-radius: 2px; }

  .seg {
    padding: 5px 8px;
    border-left: 3px solid transparent;
    margin-bottom: 4px;
    border-radius: 0 4px 4px 0;
    transition: background 0.1s;
  }
  .seg:hover { background: var(--gb-surface0); }
  .seg.mic { border-left-color: var(--gb-blue); }
  .seg.meeting { border-left-color: var(--gb-yellow); }

  .seg-top {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
  }
  .seg-source {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .seg-source.mic { background: rgba(69,133,136,0.12); color: var(--gb-blue); }
  .seg-source.meeting { background: rgba(215,153,33,0.12); color: var(--gb-yellow); }

  .seg-time {
    font-size: 10px;
    color: var(--gb-overlay2);
    margin-left: auto;
  }

  .seg-text {
    font-size: 12px;
    color: var(--gb-subtext1);
    line-height: 1.5;
  }

  .signal-tag {
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 1px 4px;
    border-radius: 2px;
    letter-spacing: 0.04em;
  }
  .signal-tag.action { background: rgba(152,151,26,0.12); color: var(--gb-green); }
  .signal-tag.decision { background: rgba(69,133,136,0.12); color: var(--gb-blue); }
  .signal-tag.question { background: rgba(146,111,175,0.12); color: var(--gb-lavender); }
  .signal-tag.risk { background: rgba(204,36,29,0.12); color: var(--gb-red); }

  /* ─── Main Column ──────────────────────────────────────────── */
  .main {
    padding: 24px 32px;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--gb-overlay2);
    font-size: 14px;
  }

  /* ─── Idle State ───────────────────────────────────────────── */
  .idle-overlay {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
  }

  .idle-card {
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-radius: 10px;
    padding: 40px;
    text-align: center;
    max-width: 440px;
    width: 100%;
  }

  .idle-card h2 {
    font-size: 18px;
    font-weight: 700;
    color: var(--gb-text);
    margin-bottom: 6px;
  }
  .idle-card p {
    color: var(--gb-subtext0);
    font-size: 12px;
    margin-bottom: 20px;
  }

  .idle-form { text-align: left; margin-bottom: 16px; }
  .idle-form label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-overlay2);
    display: block;
    margin-bottom: 4px;
    margin-top: 10px;
  }
  .idle-form input, .idle-form textarea {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--gb-surface2);
    border-radius: 5px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
    resize: vertical;
  }
  .idle-form input:focus, .idle-form textarea:focus { border-color: var(--gb-blue); }

  .proj-grid {
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid var(--gb-surface2);
    border-radius: 5px;
    padding: 8px 10px;
    background: var(--gb-surface1);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px 16px;
  }
  .proj-item {
    display: flex !important;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 12px !important;
    font-weight: 400 !important;
    text-transform: none !important;
    letter-spacing: 0 !important;
    cursor: pointer;
    color: var(--gb-text) !important;
    overflow: hidden;
  }
  .proj-item input[type="checkbox"] {
    accent-color: var(--gb-green);
    flex-shrink: 0;
    width: 14px;
    height: 14px;
  }
  .proj-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--gb-text);
  }
  .proj-badge {
    font-size: 8px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    flex-shrink: 0;
    margin-left: auto;
  }
  .proj-badge.ios {
    background: rgba(69,133,136,0.12);
    color: var(--gb-blue);
  }

  /* Context manager */
  .ctx-section { margin-top: 10px; }
  .ctx-list {
    max-height: 140px;
    overflow-y: auto;
    border: 1px solid var(--gb-surface2);
    border-radius: 5px;
    padding: 4px 8px;
    background: var(--gb-surface1);
  }
  .ctx-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    font-size: 12px;
    border-bottom: 1px solid var(--gb-surface2);
  }
  .ctx-item:last-child { border-bottom: none; }
  .ctx-item input[type="checkbox"] {
    accent-color: var(--gb-green);
    flex-shrink: 0;
    width: 14px;
    height: 14px;
  }
  .ctx-icon {
    font-size: 11px;
    color: var(--gb-overlay2);
    flex-shrink: 0;
    width: 14px;
    text-align: center;
  }
  .ctx-name {
    color: var(--gb-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .ctx-path {
    color: var(--gb-overlay1);
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 140px;
    flex-shrink: 1;
  }
  .ctx-remove {
    background: none;
    border: none;
    color: var(--gb-overlay1);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
    flex-shrink: 0;
    border-radius: 3px;
  }
  .ctx-remove:hover { color: var(--gb-red); background: rgba(204,36,29,0.08); }
  .ctx-add-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .ctx-add-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 4px 10px;
    border: 1px dashed var(--gb-surface2);
    border-radius: 5px;
    background: transparent;
    color: var(--gb-overlay2);
    cursor: pointer;
    flex: 1;
  }
  .ctx-add-btn:hover { border-color: var(--gb-blue); color: var(--gb-blue); }
  .ctx-input-row {
    display: flex;
    gap: 4px;
    margin-top: 6px;
  }
  .ctx-input-row input {
    flex: 1;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 5px 8px;
    border: 1px solid var(--gb-blue);
    border-radius: 5px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
  }
  .ctx-input-row button {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 5px;
    border: none;
    cursor: pointer;
  }
  .ctx-input-row .ctx-submit { background: var(--gb-green); color: var(--gb-bg); }
  .ctx-input-row .ctx-cancel { background: var(--gb-surface2); color: var(--gb-text); }
  .ctx-empty {
    color: var(--gb-overlay1);
    font-size: 11px;
    font-style: italic;
    padding: 8px 0;
    text-align: center;
  }
  .ctx-error {
    color: var(--gb-red);
    font-size: 11px;
    margin-top: 4px;
  }
  .ctx-input-row input.drag-over {
    border-color: var(--gb-green);
    background: rgba(152,151,26,0.06);
  }

  .idle-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    margin-top: 16px;
  }

  .sessions-link {
    color: var(--gb-blue);
    font-size: 12px;
    cursor: pointer;
    margin-top: 14px;
    display: inline-block;
  }
  .sessions-link:hover { text-decoration: underline; }

  /* ─── Session History ──────────────────────────────────────── */
  .session-list {
    max-width: 560px;
    margin: 0 auto;
    padding: 24px 0;
  }
  .session-list h3 {
    font-size: 14px;
    font-weight: 700;
    color: var(--gb-text);
    margin-bottom: 14px;
  }
  .session-item {
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: border-color 0.15s;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .session-item:hover { border-color: var(--gb-blue); }
  .session-item-title { font-weight: 600; color: var(--gb-text); font-size: 13px; }
  .session-item-meta { font-size: 11px; color: var(--gb-subtext0); }
  .session-item-stats { font-size: 10px; color: var(--gb-overlay2); text-align: right; }
  .session-delete-btn {
    background: none; border: none; color: var(--gb-overlay2); cursor: pointer;
    font-size: 14px; padding: 4px 8px; border-radius: 4px; transition: all 0.15s;
    flex-shrink: 0; margin-left: 8px;
  }
  .session-delete-btn:hover { background: var(--gb-red); color: #fff; }
  .session-toolbar {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
  }
  .session-toolbar .btn-sm {
    font-size: 11px; padding: 4px 10px; border-radius: 4px;
  }
  .session-select-cb { margin-right: 10px; flex-shrink: 0; cursor: pointer; accent-color: var(--gb-blue); }
  .session-bulk-bar {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    background: var(--gb-surface1); border-radius: 6px; margin-bottom: 10px; font-size: 12px;
  }
  .session-confirm-bar {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: #fbeaea; border: 1px solid var(--gb-red); border-radius: 6px;
    margin-bottom: 10px; font-size: 12px; color: var(--gb-text);
  }
  .session-confirm-bar .btn { font-size: 11px; padding: 4px 12px; }

  /* ─── Quick Actions ────────────────────────────────────────── */
  .quick-actions {
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 16px;
  }
  .quick-actions-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-overlay2);
    margin-bottom: 8px;
  }
  .quick-actions-input {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--gb-surface2);
    border-radius: 4px;
    background: var(--gb-surface1);
    color: var(--gb-text);
    outline: none;
    margin-bottom: 8px;
  }
  .quick-actions-input:focus { border-color: var(--gb-blue); }
  .quick-actions-input::placeholder { color: var(--gb-overlay1); }
  .quick-actions-row { display: flex; gap: 6px; }

  /* ─── Cards ────────────────────────────────────────────────── */
  .card {
    background: var(--gb-surface0);
    border: 1px solid var(--gb-surface2);
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 16px;
    transition: border-color 0.2s;
  }
  .card.suggested { border-color: var(--gb-yellow); background: rgba(215,153,33,0.05); }
  .card.running { border-color: var(--gb-blue); animation: border-pulse 1.5s ease-in-out infinite; }
  @keyframes border-pulse { 0%,100%{border-color:var(--gb-blue)} 50%{border-color:var(--gb-surface2)} }

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  .card-type {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 7px;
    border-radius: 4px;
  }
  .card-type.research { background: rgba(152,151,26,0.12); color: var(--gb-green); }
  .card-type.summary { background: rgba(215,153,33,0.12); color: var(--gb-yellow); }
  .card-type.mockup { background: rgba(177,98,134,0.12); color: var(--gb-mauve); }
  .card-type.codegen { background: rgba(69,133,136,0.12); color: var(--gb-blue); }
  .card-type.analysis { background: rgba(214,93,14,0.12); color: var(--gb-peach); }
  .card-type.failed { background: rgba(204,36,29,0.12); color: var(--gb-red); }

  .card-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--gb-text);
    flex: 1;
    min-width: 0;
  }
  .card-time {
    font-size: 10px;
    color: var(--gb-overlay2);
    flex-shrink: 0;
  }

  .card-body {
    font-size: 13px;
    color: var(--gb-subtext1);
  }
  .card-body h1 { color: var(--gb-red); font-size: 18px; font-weight: 700; margin-top: 16px; margin-bottom: 6px; }
  .card-body h2 { color: var(--gb-peach); font-size: 15px; font-weight: 700; margin-top: 14px; margin-bottom: 6px; }
  .card-body h3 { color: var(--gb-sky); font-size: 14px; font-weight: 600; margin-top: 12px; margin-bottom: 4px; }
  .card-body h4 { color: var(--gb-blue); font-size: 13px; font-weight: 600; margin-top: 10px; margin-bottom: 4px; }
  .card-body p { margin-bottom: 8px; }
  .card-body ul, .card-body ol { padding-left: 18px; margin-bottom: 8px; }
  .card-body li { margin-bottom: 3px; }
  .card-body strong { color: var(--gb-text); }
  .card-body a { color: var(--gb-blue); text-decoration: none; }
  .card-body a:hover { text-decoration: underline; }
  .card-body pre { background: var(--gb-surface1); border: 1px solid var(--gb-surface2); border-radius: 5px; padding: 12px; overflow-x: auto; margin: 10px 0; font-size: 12px; line-height: 1.5; }
  .card-body code { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .card-body :not(pre) > code { background: var(--gb-surface1); color: var(--gb-peach); padding: 1px 5px; border-radius: 3px; }
  .card-body hr { border: none; border-top: 1px solid var(--gb-surface2); margin: 12px 0; }
  .card-body blockquote { border-left: 3px solid var(--gb-overlay0); padding-left: 12px; color: var(--gb-subtext0); margin: 8px 0; }
  .card-body table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12px; }
  .card-body th, .card-body td { border: 1px solid var(--gb-surface2); padding: 5px 10px; text-align: left; }
  .card-body th { background: var(--gb-surface1); font-weight: 600; color: var(--gb-text); }
  .card-body input[type="checkbox"] { accent-color: var(--gb-green); margin-right: 5px; }

  .card-trigger {
    font-size: 11px;
    font-style: italic;
    color: var(--gb-overlay2);
    margin: 8px 0;
    padding-left: 10px;
    border-left: 2px solid var(--gb-surface2);
  }

  .card-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .artifact-divider { border-top: 1px solid var(--gb-surface2); margin: 14px 0; padding-top: 10px; }
  .artifact-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--gb-overlay2); margin-bottom: 6px; }

  .spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid var(--gb-surface2);
    border-top-color: var(--gb-blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }
  @keyframes spin { to{transform:rotate(360deg)} }

  /* ─── TOC Sidebar ──────────────────────────────────────────── */
  .toc {
    min-width: 0;
    border-left: 1px solid var(--gb-surface2);
    overflow-y: auto;
    overflow-x: hidden;
    padding: 14px 16px 14px 12px;
    background: var(--gb-mantle);
    scrollbar-width: thin;
    scrollbar-color: var(--gb-overlay0) transparent;
    word-break: break-word;
    display: flex;
    flex-direction: column;
  }
  .toc::-webkit-scrollbar { width: 4px; }
  .toc::-webkit-scrollbar-thumb { background: var(--gb-overlay0); border-radius: 2px; }

  .toc-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gb-overlay2);
    margin-bottom: 10px;
    padding: 0 4px;
    white-space: nowrap;
  }

  .toc-section { margin-bottom: 2px; overflow: hidden; }

  .toc-card-title {
    padding: 4px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--gb-subtext1);
    cursor: pointer;
    transition: background 0.12s;
    line-height: 1.4;
  }
  .toc-card-title:hover { background: var(--gb-surface1); }
  .toc-card-title.active { background: var(--gb-surface1); color: var(--gb-text); }

  .toc-badge {
    font-size: 8px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 1px 4px; border-radius: 3px;
    display: inline; vertical-align: middle; margin-right: 3px;
  }
  .toc-badge.research { background: rgba(152,151,26,0.15); color: var(--gb-green); }
  .toc-badge.summary { background: rgba(215,153,33,0.15); color: var(--gb-yellow); }
  .toc-badge.mockup { background: rgba(177,98,134,0.15); color: var(--gb-mauve); }
  .toc-badge.codegen { background: rgba(69,133,136,0.15); color: var(--gb-blue); }
  .toc-badge.analysis { background: rgba(214,93,14,0.15); color: var(--gb-peach); }

  .toc-heading {
    display: block;
    padding: 2px 4px 2px 20px;
    font-size: 11px;
    color: var(--gb-subtext0);
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
    border-radius: 3px;
    text-decoration: none;
    line-height: 1.4;
  }
  .toc-heading.depth-3 { padding-left: 28px; }
  .toc-heading:hover { color: var(--gb-subtext1); background: var(--gb-surface1); }
  .toc-heading.active { color: var(--gb-text); background: rgba(69,133,136,0.1); border-left: 2px solid var(--gb-blue); padding-left: 16px; }
  .toc-heading.active.depth-3 { padding-left: 26px; }
</style>
</head>
<body>

<!-- ─── Header ─────────────────────────────────────────────── -->
<div class="header">
  <div class="header-left">
    <div class="status-dot" id="statusDot"></div>
    <h1>Meeting Copilot</h1>
  </div>
  <div class="header-center" id="headerTitle"></div>
  <div class="header-right">
    <span class="state-pill idle" id="statePill">Idle</span>
    <span class="session-timer" id="sessionTimer"></span>
    <button class="btn btn-ghost" id="newMeetingBtn" style="display:none" onclick="newMeeting()">&larr; New Meeting</button>
    <button class="btn btn-green" id="startStopBtn" style="display:none" onclick="toggleSession()">Start</button>
  </div>
</div>

<!-- ─── Stats Bar ──────────────────────────────────────────── -->
<div class="stats-bar" id="statsBar">
  <div class="stat-tile"><div class="stat-label">Words</div><div class="stat-value" id="statWords">0</div></div>
  <div class="stat-tile"><div class="stat-label">Pace</div><div class="stat-value" id="statPace">0/m</div></div>
  <div class="stat-tile"><div class="stat-label">You</div><div class="stat-value" id="statYou">0</div></div>
  <div class="stat-tile"><div class="stat-label">Meeting</div><div class="stat-value" id="statMeeting">0</div></div>
</div>

<!-- ─── Layout ─────────────────────────────────────────────── -->
<div class="layout" id="layout">

  <!-- Transcript Column -->
  <div class="transcript-col" id="transcriptCol">
    <div class="transcript-header">
      <div class="transcript-title-row">
        <span class="transcript-title">Transcript</span>
        <span class="segment-count" id="segCount">0</span>
      </div>
      <div class="filter-row">
        <button class="filter-btn active" onclick="setFilter('all',this)">All</button>
        <button class="filter-btn" onclick="setFilter('mic',this)">You</button>
        <button class="filter-btn" onclick="setFilter('meeting',this)">Meeting</button>
      </div>
      <input class="transcript-search" id="transcriptSearch" placeholder="Search transcript..." oninput="filterTranscript()">
    </div>
    <div class="transcript-feed" id="transcriptFeed"></div>
  </div>

  <!-- Main Column -->
  <div class="main" id="mainCol">
    <div id="idleOverlay"></div>
    <div id="quickActionsSlot"></div>
    <div id="results"></div>
  </div>

  <!-- TOC Sidebar -->
  <nav class="toc" id="toc">
    <div class="toc-title">Outline</div>
    <div id="tocEntries"></div>
  </nav>
</div>

<script>
(function() {
  // ─── DOM Refs ───────────────────────────────────────────────
  var statusDot = document.getElementById('statusDot');
  var headerTitle = document.getElementById('headerTitle');
  var statePill = document.getElementById('statePill');
  var sessionTimerEl = document.getElementById('sessionTimer');
  var startStopBtn = document.getElementById('startStopBtn');
  var newMeetingBtn = document.getElementById('newMeetingBtn');
  var statsBar = document.getElementById('statsBar');
  var layout = document.getElementById('layout');
  var transcriptCol = document.getElementById('transcriptCol');
  var transcriptFeed = document.getElementById('transcriptFeed');
  var segCountEl = document.getElementById('segCount');
  var mainCol = document.getElementById('mainCol');
  var idleOverlay = document.getElementById('idleOverlay');
  var quickActionsSlot = document.getElementById('quickActionsSlot');
  var resultsEl = document.getElementById('results');
  var tocEntries = document.getElementById('tocEntries');

  // ─── State ──────────────────────────────────────────────────
  var params = new URLSearchParams(window.location.search);
  var replaySessionId = params.get('session');
  var isReplay = !!replaySessionId;

  var ws = null;
  var sessionState = 'idle';
  var sessionId = null;
  var sessionTitle = '';
  var sessionStartTime = null;
  var timerInterval = null;
  var totalWords = 0;
  var micWords = 0;
  var meetingWords = 0;
  var segments = [];
  var currentFilter = 'all';
  var autoScroll = true;
  var actionCards = new Map();
  var headingIdCounter = 0;
  var availableProjects = [];
  var availableContextSources = [];

  // Pre-fetch projects and context sources for the start form
  fetch('/projects').then(function(r) { return r.json(); }).then(function(d) {
    availableProjects = d.projects || [];
  }).catch(function() {});
  fetch('/context-sources').then(function(r) { return r.json(); }).then(function(d) {
    availableContextSources = d.items || [];
  }).catch(function() {});

  // ─── Context Source Management ─────────────────────────────
  var ctxAddingType = null; // 'file' or 'folder' when input is visible
  var ctxError = ''; // error message to display

  window.refreshContextSources = function() {
    return fetch('/context-sources').then(function(r) { return r.json(); }).then(function(d) {
      availableContextSources = d.items || [];
      if (sessionState === 'idle' && !isReplay) renderContextList();
    }).catch(function() {});
  };

  window.showAddContext = function(type) {
    ctxAddingType = type;
    ctxError = '';
    renderContextList();
    var input = document.getElementById('ctxPathInput');
    if (input) {
      input.focus();
      // Drag-and-drop: extract file path from dragged Finder items
      input.addEventListener('dragover', function(e) { e.preventDefault(); input.classList.add('drag-over'); });
      input.addEventListener('dragleave', function() { input.classList.remove('drag-over'); });
      input.addEventListener('drop', function(e) {
        e.preventDefault();
        input.classList.remove('drag-over');
        // Try to get file path from drag data
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) {
          // In WKWebView/Electron, file.path gives the full path; in browsers, file.name is all we get
          var path = files[0].path || files[0].name;
          if (path) input.value = path;
        } else {
          var text = e.dataTransfer && e.dataTransfer.getData('text/plain');
          if (text) input.value = text.trim();
        }
      });
    }
  };

  window.cancelAddContext = function() {
    ctxAddingType = null;
    ctxError = '';
    renderContextList();
  };

  window.submitContextSource = function() {
    var input = document.getElementById('ctxPathInput');
    if (!input) return;
    var path = input.value.trim();
    // Client-side validation
    if (!path) { ctxError = 'Please enter a path'; renderContextList(); return; }
    if (!path.startsWith('/') && !path.startsWith('~')) { ctxError = 'Path must be absolute (start with / or ~)'; renderContextList(); return; }
    ctxError = '';
    fetch('/context-sources/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path, type: ctxAddingType || 'folder' })
    }).then(function(r) {
      return r.json().then(function(d) { return { ok: r.ok, data: d }; });
    }).then(function(res) {
      if (!res.ok || res.data.error) {
        ctxError = res.data.error || 'Failed to add — check that the path exists';
        renderContextList();
        return;
      }
      if (res.data.items) availableContextSources = res.data.items;
      ctxAddingType = null;
      ctxError = '';
      renderContextList();
    }).catch(function() {
      ctxError = 'Network error — is the server running?';
      renderContextList();
    });
  };

  window.removeContextSource = function(path) {
    fetch('/context-sources', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.items) availableContextSources = d.items;
      renderContextList();
    }).catch(function() {});
  };

  function renderContextList() {
    var container = document.getElementById('ctxContainer');
    if (!container) return;

    var html = '';
    if (availableContextSources.length > 0) {
      html += '<div class="ctx-list">';
      availableContextSources.forEach(function(s) {
        var icon = s.type === 'folder' ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
        var name = s.label || s.path.split('/').pop();
        var shortPath = s.path.replace(/^\\/Users\\/[^\\/]+/, '~');
        html += '<div class="ctx-item">' +
          '<input type="checkbox" class="ctx-cb" value="' + escapeHtml(s.path) + '" checked>' +
          '<span class="ctx-icon">' + icon + '</span>' +
          '<span class="ctx-name">' + escapeHtml(name) + '</span>' +
          '<span class="ctx-path" title="' + escapeHtml(s.path) + '">' + escapeHtml(shortPath) + '</span>' +
          '<button class="ctx-remove" onclick="removeContextSource(\\'' + escapeHtml(s.path).replace(/'/g, "\\\\'") + '\\')" title="Remove">\u00D7</button>' +
        '</div>';
      });
      html += '</div>';
    } else if (!ctxAddingType) {
      html += '<div class="ctx-empty">No context sources added yet</div>';
    }

    if (ctxAddingType) {
      html += '<div class="ctx-input-row">' +
        '<input id="ctxPathInput" placeholder="' + (ctxAddingType === 'folder' ? '/path/to/folder — or drag from Finder' : '/path/to/file.md — or drag from Finder') + '" onkeydown="if(event.key===\\'Enter\\')submitContextSource();if(event.key===\\'Escape\\')cancelAddContext()">' +
        '<button class="ctx-submit" onclick="submitContextSource()">Add</button>' +
        '<button class="ctx-cancel" onclick="cancelAddContext()">Cancel</button>' +
      '</div>';
      if (ctxError) html += '<div class="ctx-error">' + escapeHtml(ctxError) + '</div>';
    } else {
      html += '<div class="ctx-add-row">' +
        '<button class="ctx-add-btn" onclick="showAddContext(\\'folder\\')">+ Add Folder</button>' +
        '<button class="ctx-add-btn" onclick="showAddContext(\\'file\\')">+ Add File</button>' +
      '</div>';
    }

    container.innerHTML = html;
  }

  // ─── Signal Detection ──────────────────────────────────────
  var actionMarkers = ['action item','follow up','next step','send','share','create','draft','schedule','update','write','review','prepare','need to',"let's",'we should',"i'll",'i will','can you','could you','own that','take that'];
  var decisionMarkers = ['we decided','decision','agreed','approved',"we'll go with","let's do",'locking','move forward with','ship this','finalize'];
  var blockerMarkers = ['blocker','blocked','risk','concern','issue','problem',"can't",'cannot','stuck','delay','slip','waiting on'];
  var questionStarts = ['what','why','how','when','where','who','should','can','could','would','do we','are we'];

  function detectSignals(text) {
    var lower = text.toLowerCase();
    var signals = [];
    for (var i = 0; i < actionMarkers.length; i++) { if (lower.includes(actionMarkers[i])) { signals.push('action'); break; } }
    for (var i = 0; i < decisionMarkers.length; i++) { if (lower.includes(decisionMarkers[i])) { signals.push('decision'); break; } }
    for (var i = 0; i < blockerMarkers.length; i++) { if (lower.includes(blockerMarkers[i])) { signals.push('risk'); break; } }
    if (lower.includes('?')) {
      for (var i = 0; i < questionStarts.length; i++) { if (lower.startsWith(questionStarts[i]) || lower.includes(' ' + questionStarts[i] + ' ')) { signals.push('question'); break; } }
    }
    return signals;
  }

  // ─── Utilities ─────────────────────────────────────────────
  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function renderMarkdown(text) {
    if (typeof marked !== 'undefined') return marked.parse(text);
    return '<pre>' + escapeHtml(text) + '</pre>';
  }

  function highlightCode() {
    if (typeof hljs !== 'undefined') {
      document.querySelectorAll('.card-body pre code:not(.hljs)').forEach(function(b) { hljs.highlightElement(b); });
    }
  }

  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  }

  function formatDuration(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    if (m >= 60) {
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    }
    return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }

  function formatTimestamp(epochMs, baseMs) {
    if (baseMs) {
      var rel = Math.max(0, epochMs - baseMs);
      return formatDuration(rel);
    }
    return new Date(epochMs).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }

  // ─── Timer ─────────────────────────────────────────────────
  function startTimer() {
    stopTimer();
    timerInterval = setInterval(function() {
      if (sessionStartTime) {
        sessionTimerEl.textContent = formatDuration(Date.now() - sessionStartTime);
      }
    }, 1000);
  }
  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  // ─── Stats ─────────────────────────────────────────────────
  function updateStats() {
    document.getElementById('statWords').textContent = totalWords;
    document.getElementById('statYou').textContent = micWords;
    document.getElementById('statMeeting').textContent = meetingWords;
    var elapsed = sessionStartTime ? (Date.now() - sessionStartTime) / 60000 : 1;
    var pace = elapsed > 0.5 ? Math.round(totalWords / elapsed) : 0;
    document.getElementById('statPace').textContent = pace + '/m';
  }

  // ─── UI State Transitions ─────────────────────────────────
  function updateUI() {
    // State pill
    statePill.className = 'state-pill ' + sessionState;
    statePill.textContent = sessionState.charAt(0).toUpperCase() + sessionState.slice(1);

    // Header title
    headerTitle.textContent = sessionTitle || '';

    // Start/Stop button + New Meeting button
    if (!isReplay) {
      if (sessionState === 'archived') {
        // After a session ends, the setup form is no longer in the DOM, so the
        // header Start would launch a session with empty metadata. Hide it and
        // show "← New Meeting" instead, which resets back to the idle setup screen.
        startStopBtn.style.display = 'none';
        newMeetingBtn.style.display = '';
      } else {
        newMeetingBtn.style.display = 'none';
        startStopBtn.style.display = '';
        if (sessionState === 'live' || sessionState === 'degraded') {
          startStopBtn.textContent = 'Stop';
          startStopBtn.className = 'btn btn-red';
        } else {
          startStopBtn.textContent = 'Start';
          startStopBtn.className = 'btn btn-green';
        }
      }
    }

    // Stats bar
    var showStats = sessionState === 'live' || sessionState === 'degraded' || isReplay;
    statsBar.className = 'stats-bar' + (showStats ? ' visible' : '');

    // Layout columns
    var showCols = sessionState !== 'idle' || isReplay;
    layout.className = 'layout' + (showCols ? ' three-col' : '');

    // Idle overlay
    if (sessionState === 'idle' && !isReplay) {
      showIdleState();
    } else {
      idleOverlay.innerHTML = '';
    }

    // Quick actions
    if ((sessionState === 'live' || sessionState === 'degraded') && !isReplay) {
      showQuickActions();
    } else {
      quickActionsSlot.innerHTML = '';
    }
  }
  window.updateUI = updateUI;

  function showIdleState() {
    var wsConnected = ws && ws.readyState === WebSocket.OPEN;
    var btnDisabled = wsConnected ? '' : ' disabled';
    var statusMsg = wsConnected ? '' : '<p style="color:var(--gb-red);font-size:11px;margin-top:8px">Connecting to server...</p>';

    // Build project checkboxes
    var projectsHtml = '';
    if (availableProjects.length > 0) {
      projectsHtml = '<label>Projects <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>' +
        '<div class="proj-grid">';
      availableProjects.forEach(function(p) {
        var badge = p.category === 'xcode' ? ' <span class="proj-badge ios">iOS</span>' : '';
        projectsHtml += '<label class="proj-item">' +
          '<input type="checkbox" class="proj-cb" value="' + escapeHtml(p.name) + '">' +
          '<span class="proj-name">' + escapeHtml(p.name) + '</span>' + badge +
        '</label>';
      });
      projectsHtml += '</div>';
    }

    // Context sources section — always visible with add/remove UI
    var contextHtml = '<div class="ctx-section">' +
      '<label>Context Files &amp; Folders <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>' +
      '<div id="ctxContainer"></div>' +
    '</div>';

    idleOverlay.innerHTML = '<div class="idle-overlay"><div class="idle-card" style="max-width:500px">' +
      '<h2>No Active Meeting</h2>' +
      '<p>Start a session to begin capturing and analyzing your meeting.</p>' +
      '<div class="idle-form">' +
        '<label>Title</label><input id="startTitle" placeholder="Weekly sync, 1:1, etc.">' +
        '<label>Agenda</label><textarea id="startAgenda" rows="2" placeholder="Topics to discuss..."><\\/textarea>' +
        '<label>Attendees</label><input id="startAttendees" placeholder="Chris, Alex, Sam">' +
        projectsHtml +
        contextHtml +
      '</div>' +
      '<div class="idle-actions">' +
        '<button class="btn btn-green" id="startBtn" onclick="startSession()"' + btnDisabled + '>Start Session</button>' +
      '</div>' +
      statusMsg +
      '<span class="sessions-link" onclick="showSessionHistory()">View Past Sessions</span>' +
    '</div></div>';

    // Populate context list after DOM is built
    renderContextList();
  }

  function showQuickActions() {
    quickActionsSlot.innerHTML = '<div class="quick-actions">' +
      '<div class="quick-actions-title">Quick Actions</div>' +
      '<input class="quick-actions-input" id="quickPrompt" placeholder="Topic or prompt (optional)...">' +
      '<div class="quick-actions-row">' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'fast-research\\')" title="Haiku, streaming">\u26A1 Fast</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'research\\')">Research</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'summary\\')">Summary</button>' +
        '<button class="btn btn-ghost" onclick="triggerAction(\\'analysis\\')">Analysis</button>' +
      '</div>' +
    '</div>';
  }

  // ─── Session Controls ─────────────────────────────────────
  window.newMeeting = function() {
    // Reset client-side state from archived → idle so the setup form re-renders.
    // Server is already idle/archived; the next session.start will move it forward.
    sessionState = 'idle';
    sessionTitle = '';
    sessionStartTime = null;
    actionCards.clear();
    resultsEl.innerHTML = '';
    tocEntries.innerHTML = '';
    transcriptFeed.innerHTML = '';
    segments = [];
    totalWords = 0; micWords = 0; meetingWords = 0;
    segCountEl.textContent = '0';
    sessionTimerEl.textContent = '';
    updateUI();
  };

  window.toggleSession = function() {
    if (sessionState === 'live' || sessionState === 'degraded') {
      wsSend({ type: 'session.stop' });
    } else {
      // Start with values from form if available, otherwise empty
      startSession();
    }
  };

  window.startSession = function() {
    var title = (document.getElementById('startTitle') || {}).value || '';
    var agenda = (document.getElementById('startAgenda') || {}).value || '';
    var attendees = (document.getElementById('startAttendees') || {}).value || '';

    // Collect selected projects
    var selectedProjects = [];
    document.querySelectorAll('.proj-cb:checked').forEach(function(cb) {
      selectedProjects.push(cb.value);
    });

    // Collect selected context paths
    var selectedContextPaths = [];
    document.querySelectorAll('.ctx-cb:checked').forEach(function(cb) {
      selectedContextPaths.push(cb.value);
    });

    var msg = {
      type: 'session.start',
      title: title || undefined,
      agenda: agenda || undefined,
      attendees: attendees || undefined,
      projectNames: selectedProjects.length ? selectedProjects : undefined,
      contextPaths: selectedContextPaths.length ? selectedContextPaths : undefined,
    };
    wsSend(msg);
  };

  window.triggerAction = function(type) {
    var prompt = (document.getElementById('quickPrompt') || {}).value || '';
    wsSend({ type: 'action.trigger', actionType: type, prompt: prompt || undefined });
    var el = document.getElementById('quickPrompt');
    if (el) el.value = '';
  };

  window.approveAction = function(id) { wsSend({ type: 'action.approve', actionId: id }); };
  window.dismissAction = function(id) { wsSend({ type: 'action.dismiss', actionId: id }); };
  window.cancelAction = function(id) { wsSend({ type: 'action.cancel', actionId: id }); };

  // ─── Transcript ───────────────────────────────────────────
  function addSegment(seg) {
    segments.push(seg);
    var wc = seg.wordCount || (seg.text ? seg.text.split(/\\s+/).filter(Boolean).length : 0);
    totalWords += wc;
    if (seg.source === 'mic') micWords += wc;
    else meetingWords += wc;

    segCountEl.textContent = segments.length;
    updateStats();
    renderSegment(seg);
  }

  function renderSegment(seg) {
    if (!seg.text || seg.text.trim() === '') return;

    var srcClass = seg.source === 'mic' ? 'mic' : 'meeting';
    var srcLabel = seg.source === 'mic' ? 'You' : 'Meeting';
    var signals = detectSignals(seg.text);
    var ts = formatTimestamp(typeof seg.timestamp === 'string' ? new Date(seg.timestamp).getTime() : seg.timestamp, sessionStartTime);

    var el = document.createElement('div');
    el.className = 'seg ' + srcClass;
    el.dataset.source = seg.source;
    el.dataset.text = seg.text.toLowerCase();

    var signalHtml = signals.map(function(s) { return '<span class="signal-tag ' + s + '">' + s + '</span>'; }).join('');

    el.innerHTML = '<div class="seg-top">' +
      '<span class="seg-source ' + srcClass + '">' + srcLabel + '</span>' +
      signalHtml +
      '<span class="seg-time">' + ts + '</span>' +
    '</div>' +
    '<div class="seg-text">' + escapeHtml(seg.text) + '</div>';

    // Apply current filter
    if (currentFilter !== 'all' && seg.source !== currentFilter) {
      el.style.display = 'none';
    }

    transcriptFeed.appendChild(el);
    if (autoScroll) transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
  }

  window.setFilter = function(filter, btn) {
    currentFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.toggle('active', b === btn); });
    filterTranscript();
  };

  window.filterTranscript = function() {
    var search = (document.getElementById('transcriptSearch') || {}).value || '';
    search = search.toLowerCase();
    transcriptFeed.querySelectorAll('.seg').forEach(function(el) {
      var matchSource = currentFilter === 'all' || el.dataset.source === currentFilter;
      var matchSearch = !search || el.dataset.text.includes(search);
      el.style.display = (matchSource && matchSearch) ? '' : 'none';
    });
  };

  // ─── Action Card Rendering ────────────────────────────────
  function renderAction(action) {
    var existing = actionCards.get(action.id);
    if (existing) existing.remove();

    var card = document.createElement('div');
    card.className = 'card' + (action.state === 'running' && !isReplay ? ' running' : action.state === 'suggested' ? ' suggested' : '');
    card.id = 'action-' + action.id;

    var typeClass = action.state === 'failed' ? 'failed' : action.type;
    var header = '<div class="card-header">' +
      '<span class="card-type ' + typeClass + '">' + escapeHtml(action.type) + '</span>' +
      '<span class="card-title">' + escapeHtml(action.title) + '</span>' +
      '<span class="card-time">' + formatTime(action.completedAt) + '</span>' +
    '</div>';

    var body = '';

    if (action.state === 'suggested') {
      body = '<div class="card-body"><p>' + escapeHtml(action.description || '') + '</p>';
      if (action.triggerQuote) {
        body += '<div class="card-trigger">"' + escapeHtml(action.triggerQuote.slice(0, 120)) + (action.triggerQuote.length > 120 ? '...' : '') + '"</div>';
      }
      if (!isReplay) {
        body += '<div class="card-actions">' +
          '<button class="btn btn-green" onclick="approveAction(\\'' + action.id + '\\')">Approve</button>' +
          '<button class="btn btn-ghost" onclick="dismissAction(\\'' + action.id + '\\')">Dismiss</button>' +
        '</div>';
      }
      body += '</div>';
    } else if (action.state === 'running') {
      if (isReplay) {
        body = '<div class="card-body"><p style="color:var(--gb-overlay2)">Did not complete during session.</p></div>';
      } else {
        // Streaming-ready running body: placeholder shown until first delta,
        // then the streaming-text div is appended to by the action.stream handler.
        body = '<div class="card-body">' +
          '<div class="streaming-placeholder"><span class="spinner"></span> Running...</div>' +
          '<div class="streaming-text" style="white-space:pre-wrap;font-family:\\'JetBrains Mono\\',monospace;font-size:12px;line-height:1.5;color:var(--gb-text)"></div>' +
          '<div class="card-actions"><button class="btn btn-ghost-red" onclick="cancelAction(\\'' + action.id + '\\')">Cancel</button></div>' +
        '</div>';
      }
    } else if (action.result && action.result.artifacts && action.result.artifacts.length > 0) {
      body = '<div class="card-body">';
      action.result.artifacts.forEach(function(artifact, i) {
        if (i > 0) body += '<div class="artifact-divider"></div>';
        if (artifact.title) body += '<div class="artifact-label">' + escapeHtml(artifact.title) + '</div>';
        if (artifact.type === 'markdown') body += renderMarkdown(artifact.content);
        else if (artifact.type === 'code') body += '<pre><code>' + escapeHtml(artifact.content) + '</code></pre>';
        else body += '<pre>' + escapeHtml(artifact.content) + '</pre>';
      });
      body += '</div>';
    } else if (action.result && action.result.summary) {
      body = '<div class="card-body"><p>' + escapeHtml(action.result.summary) + '</p></div>';
    } else if (action.state === 'failed') {
      var errMsg = (action.result && action.result.error) || 'Unknown error';
      body = '<div class="card-body"><p style="color:var(--gb-red)">' + escapeHtml(errMsg) + '</p></div>';
    }

    card.innerHTML = header + body;
    resultsEl.appendChild(card);
    actionCards.set(action.id, card);
    highlightCode();
    rebuildToc();
  }

  // ─── TOC ──────────────────────────────────────────────────
  function rebuildToc() {
    tocEntries.innerHTML = '';
    resultsEl.querySelectorAll('.card').forEach(function(card) {
      var titleEl = card.querySelector('.card-title');
      var typeEl = card.querySelector('.card-type');
      if (!titleEl) return;

      var section = document.createElement('div');
      section.className = 'toc-section';

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
      label.style.cssText = '';
      cardLink.appendChild(label);
      cardLink.addEventListener('click', function() {
        document.getElementById(card.id).scrollIntoView({ behavior:'smooth', block:'start' });
      });
      section.appendChild(cardLink);

      card.querySelectorAll('.card-body h1, .card-body h2, .card-body h3').forEach(function(h) {
        if (!h.id) h.id = 'toc-h-' + (++headingIdCounter);
        var depth = parseInt(h.tagName.charAt(1), 10);
        var link = document.createElement('a');
        link.className = 'toc-heading' + (depth >= 3 ? ' depth-3' : '');
        link.textContent = h.textContent;
        link.href = '#' + h.id;
        link.addEventListener('click', function(e) {
          e.preventDefault();
          h.scrollIntoView({ behavior:'smooth', block:'start' });
        });
        section.appendChild(link);
      });

      tocEntries.appendChild(section);
    });
  }

  // Scroll spy for TOC
  var scrollRaf = null;
  window.addEventListener('scroll', function() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function() {
      scrollRaf = null;
      var scrollY = window.scrollY + 120;
      var activeHeadingId = null;
      var activeCardId = null;

      resultsEl.querySelectorAll('.card-body h1[id], .card-body h2[id], .card-body h3[id]').forEach(function(h) {
        if (h.getBoundingClientRect().top + window.scrollY <= scrollY) activeHeadingId = h.id;
      });
      resultsEl.querySelectorAll('.card').forEach(function(c) {
        if (c.getBoundingClientRect().top + window.scrollY <= scrollY) activeCardId = c.id;
      });

      tocEntries.querySelectorAll('.toc-heading').forEach(function(l) {
        l.classList.toggle('active', l.getAttribute('href') === '#' + activeHeadingId);
      });
      tocEntries.querySelectorAll('.toc-card-title').forEach(function(l) {
        l.classList.toggle('active', l.dataset.target === activeCardId);
      });
    });
  });

  // ─── Session History ──────────────────────────────────────
  var sessionManageMode = false;

  window.showSessionHistory = function() {
    sessionManageMode = false;
    idleOverlay.innerHTML = '<div class="idle-overlay"><div class="idle-card" style="max-width:560px">' +
      '<h2>Past Sessions</h2>' +
      '<div class="session-toolbar">' +
        '<p style="margin:0">Review or manage previous meetings.</p>' +
        '<button class="btn btn-ghost btn-sm" id="manageToggle" onclick="toggleManageMode()">Manage</button>' +
      '</div>' +
      '<div id="sessionBulkBar" style="display:none"></div>' +
      '<div id="sessionListItems" style="margin:8px 0"><p style="color:var(--gb-overlay2)">Loading...</p></div>' +
      '<button class="btn btn-ghost" onclick="updateUI()">Back</button>' +
    '</div></div>';

    loadSessionList();
  };

  function loadSessionList() {
    var sessUrl = '/present/sessions' + (sessionManageMode ? '?all=1' : '');
    fetch(sessUrl).then(function(r) { return r.json(); }).then(function(data) {
      var el = document.getElementById('sessionListItems');
      if (!el) return;
      if (!data.sessions || data.sessions.length === 0) {
        el.innerHTML = '<p style="color:var(--gb-overlay2);text-align:center;padding:20px">No sessions found.</p>';
        var bulkBar = document.getElementById('sessionBulkBar');
        if (bulkBar) bulkBar.style.display = 'none';
        var manageBtn = document.getElementById('manageToggle');
        if (manageBtn) manageBtn.style.display = 'none';
        return;
      }
      el.innerHTML = '';
      data.sessions.forEach(function(s) {
        var date = s.startedAt ? new Date(s.startedAt) : null;
        var endDate = s.endedAt ? new Date(s.endedAt) : null;
        var duration = '';
        if (date && endDate) {
          var mins = Math.round((endDate - date) / 60000);
          duration = mins >= 60 ? Math.floor(mins/60) + 'h ' + (mins%60) + 'm' : mins + ' min';
        }

        var item = document.createElement('div');
        item.className = 'session-item';
        item.dataset.sessionId = s.id;

        if (!sessionManageMode) {
          item.onclick = function() { window.location.href = '/present?session=' + s.id; };
        } else {
          item.style.cursor = 'default';
        }

        var titleStyle = s.empty ? 'color:var(--gb-overlay2);font-style:italic' : '';
        item.innerHTML =
          (sessionManageMode ? '<input type="checkbox" class="session-select-cb" data-id="' + s.id + '">' : '') +
          '<div style="min-width:0;flex:1">' +
            '<div class="session-item-title" style="' + titleStyle + '">' + escapeHtml(s.title) + '</div>' +
            '<div class="session-item-meta">' +
              (date ? date.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'}) + ' at ' +
                date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : 'Unknown date') +
              (duration ? '  &middot;  ' + duration : '') +
            '</div>' +
          '</div>' +
          '<div class="session-item-stats">' +
            '<div>' + (s.actionCount || 0) + ' actions</div>' +
            '<div>' + (s.segmentCount || 0) + ' segments</div>' +
          '</div>' +
          (sessionManageMode ? '<button class="session-delete-btn" title="Delete">&#x2715;</button>' : '');

        // Attach event listeners via DOM instead of inline onclick
        if (sessionManageMode) {
          var cb = item.querySelector('.session-select-cb');
          if (cb) cb.addEventListener('click', function(e) { e.stopPropagation(); updateBulkBar(); });
          var delBtn = item.querySelector('.session-delete-btn');
          if (delBtn) {
            (function(sid, stitle) {
              delBtn.addEventListener('click', function(e) { e.stopPropagation(); deleteSession(sid, stitle); });
            })(s.id, s.title);
          }
        }

        el.appendChild(item);
      });
      updateBulkBar();
    });
  }

  window.toggleManageMode = function() {
    sessionManageMode = !sessionManageMode;
    var btn = document.getElementById('manageToggle');
    if (btn) btn.textContent = sessionManageMode ? 'Done' : 'Manage';
    loadSessionList();
  };

  window.updateBulkBar = function() {
    var bar = document.getElementById('sessionBulkBar');
    if (!bar) return;
    if (!sessionManageMode) { bar.style.display = 'none'; return; }

    var checked = document.querySelectorAll('.session-select-cb:checked');
    if (checked.length === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    bar.innerHTML = '<span>' + checked.length + ' selected</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="selectAllSessions()">Select All</button>' +
      '<button class="btn btn-sm" style="background:var(--gb-red);color:#fff;border:none;margin-left:auto" onclick="deleteSelectedSessions()">Delete Selected</button>';
  };

  window.selectAllSessions = function() {
    var cbs = document.querySelectorAll('.session-select-cb');
    var allChecked = Array.from(cbs).every(function(cb) { return cb.checked; });
    cbs.forEach(function(cb) { cb.checked = !allChecked; });
    updateBulkBar();
  };

  // Inline confirmation (WKWebView blocks confirm()/alert())
  function showConfirmBar(message, onConfirm) {
    var bar = document.getElementById('sessionBulkBar');
    if (!bar) return;
    bar.style.display = 'flex';
    bar.className = 'session-confirm-bar';
    bar.innerHTML = '<span style="flex:1">' + escapeHtml(message) + '</span>' +
      '<button class="btn btn-ghost btn-sm" id="confirmCancel">Cancel</button>' +
      '<button class="btn btn-sm" style="background:var(--gb-red);color:#fff;border:none" id="confirmYes">Delete</button>';
    document.getElementById('confirmCancel').onclick = function() {
      bar.className = 'session-bulk-bar';
      updateBulkBar();
    };
    document.getElementById('confirmYes').onclick = function() {
      bar.className = 'session-bulk-bar';
      onConfirm();
    };
  }

  window.deleteSession = function(id, title) {
    showConfirmBar('Delete "' + title + '"?', function() {
      fetch('/sessions/' + id, { method: 'DELETE' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            var item = document.querySelector('[data-session-id="' + id + '"]');
            if (item) item.remove();
            var remaining = document.querySelectorAll('.session-item');
            if (remaining.length === 0) {
              var el = document.getElementById('sessionListItems');
              if (el) el.innerHTML = '<p style="color:var(--gb-overlay2);text-align:center;padding:20px">No sessions found.</p>';
              var manageBtn = document.getElementById('manageToggle');
              if (manageBtn) manageBtn.style.display = 'none';
            }
            updateBulkBar();
          }
        });
    });
  };

  window.deleteSelectedSessions = function() {
    var checked = document.querySelectorAll('.session-select-cb:checked');
    var ids = Array.from(checked).map(function(cb) { return cb.dataset.id; });
    if (ids.length === 0) return;

    showConfirmBar('Delete ' + ids.length + ' session(s)? This cannot be undone.', function() {
      fetch('/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids }),
      }).then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.deleted && data.deleted.length > 0) {
            loadSessionList();
          }
        });
    });
  };

  // ─── WebSocket ────────────────────────────────────────────
  var wsRetries = 0;
  var maxRetries = 20;

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn('[WS] Not connected, cannot send:', msg.type);
      // Try reconnecting
      if (!ws || ws.readyState === WebSocket.CLOSED) connectWS();
    }
  }

  function connectWS() {
    if (isReplay) return;

    var port = window.location.port || '17890';
    ws = new WebSocket('ws://localhost:' + port);

    ws.onopen = function() {
      wsRetries = 0;
      statusDot.className = 'status-dot connected';
      // Enable start button if on idle screen
      var startBtn = document.getElementById('startBtn');
      if (startBtn) startBtn.disabled = false;
      var connMsg = idleOverlay.querySelector('p[style*="red"]');
      if (connMsg) connMsg.remove();
      // Check current session state
      fetch('/health').then(function(r) { return r.json(); }).then(function(d) {
        if (d.session) {
          sessionState = 'live';
          sessionId = d.session;
          sessionStartTime = Date.now(); // approximate
          // Load existing transcript from server so refresh doesn't lose history
          fetch('/transcript').then(function(r) { return r.json(); }).then(function(t) {
            if (t.segments && t.segments.length > 0) {
              // Clear any duplicates from WS messages received during fetch
              transcriptFeed.innerHTML = '';
              segments = [];
              totalWords = 0; micWords = 0; meetingWords = 0;
              t.segments.forEach(function(seg) { addSegment(seg); });
              setTimeout(function() { transcriptFeed.scrollTop = transcriptFeed.scrollHeight; }, 100);
            }
          }).catch(function() {});
        }
        updateUI();
      }).catch(function() { updateUI(); });
    };

    ws.onclose = function() {
      statusDot.className = 'status-dot disconnected';
      if (wsRetries < maxRetries) {
        wsRetries++;
        var delay = Math.min(1000 * Math.pow(1.5, wsRetries), 30000);
        setTimeout(connectWS, delay);
      }
    };

    ws.onerror = function() {};

    ws.onmessage = function(evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      switch (msg.type) {
        case 'session.state':
          sessionState = msg.state;
          sessionId = msg.sessionId || sessionId;
          if (msg.state === 'live' && !sessionStartTime) {
            sessionStartTime = Date.now();
            startTimer();
          } else if (msg.state === 'idle' || msg.state === 'archived') {
            stopTimer();
            sessionStartTime = null;
            totalWords = 0; micWords = 0; meetingWords = 0;
            segments = [];
            transcriptFeed.innerHTML = '';
            segCountEl.textContent = '0';
          }
          updateUI();
          break;

        case 'transcript.update':
          if (msg.segment) addSegment(msg.segment);
          break;

        case 'action.suggested':
          if (msg.action) renderAction({
            id: msg.action.id,
            type: msg.action.type,
            title: msg.action.title,
            description: msg.action.description,
            triggerQuote: msg.action.triggerQuote,
            estimatedDurationSec: msg.action.estimatedDurationSec,
            state: msg.action.state || 'suggested',
            completedAt: null,
            result: null,
          });
          break;

        case 'action.status':
          var existing = actionCards.get(msg.actionId);
          if (existing) {
            // Re-render with updated state
            renderAction({
              id: msg.actionId,
              type: existing.querySelector('.card-type') ? existing.querySelector('.card-type').textContent : '',
              title: existing.querySelector('.card-title') ? existing.querySelector('.card-title').textContent : '',
              description: '',
              state: msg.state,
              result: msg.result || null,
              completedAt: msg.state === 'completed' || msg.state === 'failed' ? new Date().toISOString() : null,
            });
          }
          break;

        case 'action.stream':
          var streamCard = actionCards.get(msg.actionId);
          if (streamCard) {
            var streamText = streamCard.querySelector('.streaming-text');
            if (streamText) {
              // Hide the "Running..." placeholder on first delta
              var placeholder = streamCard.querySelector('.streaming-placeholder');
              if (placeholder && streamText.textContent === '') {
                placeholder.style.display = 'none';
              }
              streamText.textContent += msg.delta;
              if (autoScroll) {
                resultsEl.scrollTop = resultsEl.scrollHeight;
              }
            }
          }
          break;
      }
    };
  }

  // ─── SSE Fallback (for replay or if WS unavailable) ───────
  function connectSSE() {
    var source = new EventSource('/present/events');
    source.addEventListener('action.suggested', function(e) { renderAction(JSON.parse(e.data)); });
    source.addEventListener('action.completed', function(e) { renderAction(JSON.parse(e.data)); });
    source.addEventListener('action.running', function(e) { renderAction(JSON.parse(e.data)); });
    source.onopen = function() { statusDot.className = 'status-dot connected'; };
    source.onerror = function() { statusDot.className = 'status-dot disconnected'; };
  }

  // ─── Init ─────────────────────────────────────────────────
  if (isReplay) {
    // Replay mode: load from stored session
    sessionState = 'archived';
    statePill.className = 'state-pill archived';
    statePill.textContent = 'Replay';
    startStopBtn.style.display = 'none';

    // Load actions
    fetch('/present/actions?session=' + encodeURIComponent(replaySessionId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.actions && data.actions.length > 0) {
          data.actions.forEach(renderAction);
        }
        headerTitle.innerHTML = '<span style="cursor:pointer;color:var(--gb-blue);margin-right:8px" onclick="window.location.href=\\'/present\\'">&larr; Back</span> Session Replay';
      });

    // Load transcript
    fetch('/present/transcript?session=' + encodeURIComponent(replaySessionId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.segments) {
          sessionStartTime = data.startedAt || (data.segments.length > 0 ? data.segments[0].timestamp : null);
          data.segments.forEach(function(seg) { addSegment(seg); });
          // Scroll transcript to bottom for replay (delay for DOM render)
          setTimeout(function() { transcriptFeed.scrollTop = transcriptFeed.scrollHeight; }, 100);
          sessionTimerEl.textContent = segments.length > 0 ? formatDuration(
            (segments[segments.length-1].timestamp || 0) - (sessionStartTime || 0)
          ) : '';
        }
      });

    layout.className = 'layout three-col';
    statsBar.className = 'stats-bar visible';
    connectSSE();
  } else {
    // Live mode
    updateUI();
    connectWS();

    // Also load any existing live actions
    fetch('/present/actions')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.actions && data.actions.length > 0) {
          data.actions.forEach(renderAction);
        }
      });
  }
})();
<\/script>
</body>
</html>`;
