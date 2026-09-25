import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import type { ChatAnswerer } from './service.js';

/**
 * A scripted chat answerer for the ship gate's browser tests (server/e2e/).
 * It spends nothing, and its reply names the meeting it was handed, which
 * proves the snapshot reached the answerer.
 *
 * On abort it resolves quietly with what it has streamed, the way the openai
 * SDK does (gotcha #29), so the e2e Stop test fails if the service stops
 * checking the signal after the answer returns.
 */

/** A question containing this streams slowly enough to press Stop mid-answer. */
export const FAKE_CHAT_SLOW_MARKER = '[slow]';

const FAST_STEP_MS = 30;
const SLOW_STEP_MS = 150;

/**
 * COPILOT_E2E_FAKE_CHAT=1 is honoured only when HOME is not the user's real
 * home. `userInfo().homedir` reads the password database, so an inherited or
 * forgotten flag can never swap the real app's chat for this one.
 */
export function e2eFakeChatEnabled(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  realHome: string = userInfo().homedir,
): boolean {
  return env.COPILOT_E2E_FAKE_CHAT === '1' && resolve(home) !== resolve(realHome);
}

export function fakeChatAnswerer(): ChatAnswerer {
  return async (req) => {
    const title = /^Title: (.*)$/m.exec(req.system)?.[1]?.trim() || '(no title)';
    const slow = req.user.includes(FAKE_CHAT_SLOW_MARKER);
    const reply = slow
      ? `Fake answer about "${title}". ` + 'This answer streams slowly so it can be stopped. '.repeat(12)
      : `Fake answer about "${title}". The meeting reached the chat.`;
    const words = reply.match(/\S+\s*/g) ?? [];
    let text = '';
    for (const word of words) {
      await sleep(slow ? SLOW_STEP_MS : FAST_STEP_MS, req.signal);
      if (req.signal.aborted) break;
      text += word;
      req.onDelta(word);
    }
    return { text, sources: [], via: 'e2e-fake' };
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const onAbort = () => { clearTimeout(timer); done(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); done(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
