/**
 * One-at-a-time lane for the long, background `claude` CLI calls that run on
 * a timer (the rolling summary, the meeting pulse). Concurrent CLI spawns
 * thrashed the server in June (agenda latency blew to 45s), so timer-driven
 * calls take turns. User-approved workers and the live lanes do not queue
 * here: they are latency-bound and already gated elsewhere.
 */
let tail: Promise<unknown> = Promise.resolve();

export function inCliLane<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  // The lane continues whether this call succeeds or fails.
  tail = run.catch(() => undefined);
  return run;
}
