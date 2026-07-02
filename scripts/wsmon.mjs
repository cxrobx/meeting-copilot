// Live WS monitor for debugging the suggestion lifecycle: connects to the
// dashboard WebSocket and prints card/status transitions as one-liners.
// Usage: node scripts/wsmon.mjs   (server must be running on :17890)
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:17890');
const seen = new Map();
ws.on('open', () => console.log('[mon] connected to dashboard WS'));
ws.on('message', (d) => {
  let m; try { m = JSON.parse(d.toString()); } catch { return; }
  if (m.type === 'action.suggested' && m.action) {
    const a = m.action, k = a.id.slice(0,8), prev = seen.get(a.id) || {};
    const notes = [];
    if (!prev.seen) notes.push('NEW-CARD');
    if (a.streaming) notes.push('streaming');
    if (a.paramsReady && !prev.paramsReady) notes.push('PARAMS-READY');
    if (a.pendingApproval && !prev.pending) notes.push('PRE-APPROVED');
    if (!a.streaming && prev.streaming) notes.push('FINAL');
    if (notes.length) console.log(`[${k}] ${notes.join(' ')} | "${(a.title||'').slice(0,52)}"`);
    seen.set(a.id, { seen:true, streaming:a.streaming, paramsReady:a.paramsReady, pending:a.pendingApproval });
  } else if (m.type === 'action.status') {
    console.log(`[${(m.actionId||'').slice(0,8)}] STATUS state=${m.state}${m.pendingApproval?' pending':''}`);
  }
});
ws.on('error', (e) => console.log('[mon] error', e.message));
