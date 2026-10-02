import { expect, test } from '@playwright/test';
import WebSocket from 'ws';
import { run, watchPage } from './helpers.js';

// Catches: Pause / Resume end to end. The dashboard's button reaches the
// server, every client hears session.paused (the app gates its audio on it),
// a reload while paused still shows the banner, and Resume leaves the gap
// line in the transcript.
test('pause and resume a live meeting from the dashboard', async ({ page }) => {
  const watch = watchPage(page);
  const app = new WebSocket(`ws://127.0.0.1:${run.port}`);
  const heard: Array<Record<string, any>> = [];
  app.on('message', (raw) => { try { heard.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
  await new Promise<void>((done, fail) => { app.once('open', () => done()); app.once('error', fail); });

  try {
    // Live before the page loads: an earlier spec's ended meeting would
    // otherwise open as its summary.
    app.send(JSON.stringify({ type: 'session.start', title: 'E2E pause check' }));
    await expect.poll(() => heard.some((m) => m.type === 'session.state' && m.state === 'live')).toBe(true);
    await page.goto(`${run.base}/present`);
    await expect(page.locator('#statePill')).toHaveText(/live/i);

    const pauseBtn = page.locator('#pauseBtn');
    await expect(pauseBtn).toHaveText('Pause');
    await pauseBtn.click();
    await expect(page.locator('#pauseBanner')).toBeVisible();
    await expect(page.locator('#audioLabel')).toHaveText('PAUSED');
    await expect(pauseBtn).toHaveText('Resume');
    await expect.poll(() => heard.some((m) => m.type === 'session.paused' && m.paused === true)).toBe(true);

    // A reload mid-pause: the connect snapshot brings it back.
    await page.reload();
    await expect(page.locator('#statePill')).toHaveText(/live/i);
    await expect(page.locator('#pauseBanner')).toBeVisible();
    await expect(page.locator('#pauseSince')).toContainText('Paused for');

    await page.locator('#pauseBanner [data-pause-act="resume"]').click();
    await expect(page.locator('#pauseBanner')).toBeHidden();
    await expect(page.locator('#audioLabel')).toHaveText('REC');
    await expect(page.locator('#transcriptFeed .seg.pause-mark')).toContainText('Nothing was recorded.');
    await expect.poll(() => heard.some((m) => m.type === 'session.paused' && m.paused === false && m.marker)).toBe(true);

    expect(watch.problems()).toEqual([]);
  } finally {
    app.send(JSON.stringify({ type: 'session.stop' }));
    await expect(page.locator('#statePill')).not.toHaveText(/live/i);
    app.close();
  }
});
