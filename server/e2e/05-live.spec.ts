import { expect, test } from '@playwright/test';
import WebSocket from 'ws';
import { run, watchPage } from './helpers.js';

const LIVE_TITLE = 'E2E live check';

// Catches: the live socket path, end to end. A fake app client starts the
// meeting and asks from "the menu bar"; the dashboard must follow the meeting
// and open its chat with the question and the answer.
test('a live meeting from the app: chat.send from the menu bar opens the drawer with the answer', async ({ page }) => {
  const watch = watchPage(page);
  const app = new WebSocket(`ws://127.0.0.1:${run.port}`);
  const heard: Array<Record<string, any>> = [];
  app.on('message', (raw) => { try { heard.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
  await new Promise<void>((done, fail) => { app.once('open', () => done()); app.once('error', fail); });

  try {
    await page.goto(`${run.base}/present`);
    await expect(page.locator('#statusDot')).toHaveClass(/\bconnected\b/);
    await expect(page.locator('#statePill')).toHaveText('Idle');

    app.send(JSON.stringify({ type: 'session.start', title: LIVE_TITLE, agenda: 'Pricing\nNext steps', attendees: 'Dana' }));
    await expect(page.locator('#statePill')).toHaveText(/live/i);
    await expect(page.locator('#chatDrawer')).toBeHidden();

    app.send(JSON.stringify({ type: 'chat.send', text: 'What is on the agenda?', origin: 'menubar' }));
    await expect(page.locator('#chatDrawer')).toBeVisible();
    await expect(page.locator('#chatThread .chat-msg.user .chat-origin')).toHaveText('From the menu bar');
    const answer = page.locator('#chatThread .chat-msg.assistant').last();
    await expect(answer).toHaveClass(/\bdone\b/);
    await expect(answer).toContainText(`Fake answer about "${LIVE_TITLE}"`);

    // The app hears the same finished answer (the popover shows it).
    await expect.poll(() => heard.some((m) => m.type === 'chat.message' && m.message?.role === 'assistant'
      && m.message?.state === 'done' && String(m.message?.content).includes(LIVE_TITLE))).toBe(true);

    expect(watch.problems()).toEqual([]);
  } finally {
    app.send(JSON.stringify({ type: 'session.stop' }));
    await expect(page.locator('#statePill')).not.toHaveText(/live/i);
    app.close();
  }
});
