/**
 * Session ids are directory names under ~/.meeting-copilot/sessions, and the
 * only thing that mints one is `new SessionStore()` — a v4 UUID. Every route
 * that turns a caller's id into a path checks it here first. Until 2026-09-22
 * the replay and export routes joined it in unchecked, and Express decodes
 * `%2F` in route params, so `/sessions/..%2F..%2Fx/export` reached
 * `new SessionStore('../../x')`, which creates directories.
 */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}
