import { expect, test } from '@playwright/test';
import { run, watchPage } from './helpers.js';

const SLOW = '[slow]'; // chat/fake.ts FAKE_CHAT_SLOW_MARKER

// Catches: the 2026-09-25 Stop bug (a stopped answer saved as finished,
// gotcha #29), and a thread that does not survive a reload.
test('the chat answers with the meeting as context, keeps it across a reload, and Stop stops', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(run.replayUrl);
  await page.locator('#chatBtn').click();
  await expect(page.locator('#chatDrawer')).toBeVisible();

  await page.locator('#chatInput').fill('What was decided about Brightline?');
  await page.locator('#chatInput').press('Enter');
  const first = page.locator('#chatThread .chat-msg.assistant').last();
  await expect(first).toHaveClass(/\bdone\b/);
  // The fake answer quotes the title it found in the snapshot it was handed.
  await expect(first).toContainText(`Fake answer about "${run.title}"`);
  await expect(first.locator('.chat-meta')).toContainText('e2e-fake');

  await page.reload();
  await page.locator('#chatBtn').click();
  await expect(page.locator('#chatThread .chat-msg')).toHaveCount(2);
  await expect(page.locator('#chatThread .chat-msg.user')).toHaveText('What was decided about Brightline?');
  await expect(page.locator('#chatThread .chat-msg.assistant.done')).toContainText(`Fake answer about "${run.title}"`);

  // Stop, mid-answer.
  await page.locator('#chatInput').fill(`Walk me through all of it ${SLOW}`);
  await page.locator('#chatInput').press('Enter');
  const second = page.locator('#chatThread .chat-msg.assistant').last();
  await expect(second).toHaveClass(/\bstreaming\b/);
  await expect(second).toContainText('Fake answer about');
  await expect(page.locator('#chatSend')).toHaveText('Stop');
  await page.locator('#chatSend').click();
  await expect(second).toHaveClass(/\bcancelled\b/);
  await expect(second.locator('.chat-note')).toHaveText('Stopped');
  await expect(page.locator('#chatSend')).toHaveText('Send');

  // Stopped is what was saved, with what had streamed.
  await page.reload();
  await page.locator('#chatBtn').click();
  const saved = page.locator('#chatThread .chat-msg.assistant').last();
  await expect(saved).toHaveClass(/\bcancelled\b/);
  await expect(saved).toContainText('Fake answer about');
  await expect(saved).not.toContainText('streams slowly so it can be stopped. '.repeat(12).trim());

  expect(watch.problems()).toEqual([]);
});
