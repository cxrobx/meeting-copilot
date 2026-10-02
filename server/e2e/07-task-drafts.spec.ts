import { expect, test } from '@playwright/test';
import { run, watchPage } from './helpers.js';

const TASK = '[task]'; // chat/fake.ts FAKE_CHAT_TASK_MARKER

// Catches: a draft that files without the user's click, edits that never reach
// the filing, a filed task that reads as a draft again after a reload, and the
// pulse's + Task opening nothing. The server's filer is chat/fake.ts's: it
// hands out T9001, T9002… and never touches the real CXTasks.
test('a task drafted in the chat files only on File, with the edits, and stays filed', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(run.replayUrl);
  await page.locator('#chatBtn').click();
  await page.locator('#chatInput').fill(`Make a task to send Rory the deck ${TASK}`);
  await page.locator('#chatInput').press('Enter');

  const card = page.locator('#chatThread .chat-task').last();
  await expect(card).toHaveClass(/\bdraft\b/);
  await expect(card.locator('[data-task-field="title"]')).toHaveValue('Send Rory the Q4 deck');
  await expect(card).toContainText('Nothing is filed until you press File.');
  await card.screenshot({ path: test.info().outputPath('task-draft.png') });

  await card.locator('[data-task-field="title"]').fill('Send Rory the deck before the board');
  await card.locator('[data-task-field="priority"]').selectOption('1');
  await card.locator('[data-chat-act="task-file"]').click();

  const filed = page.locator('#chatThread .chat-task.done').last();
  await expect(filed).toContainText(/Filed as\s*T9\d{3}/);
  await expect(filed).toContainText('Send Rory the deck before the board');
  await expect(filed.locator('a')).toHaveAttribute('href', /^cxtasks:\/\/task\//);
  await filed.screenshot({ path: test.info().outputPath('task-filed.png') });

  await page.reload();
  await page.locator('#chatBtn').click();
  await expect(page.locator('#chatThread .chat-task.done').last()).toContainText('Send Rory the deck before the board');

  expect(watch.problems()).toEqual([]);
});

test('the pulse drafts a close-out item into the chat, and Dismiss drops it', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(run.replayUrl);
  const button = page.locator('#pulseSlot .closeout-list .pulse-task').first();
  await expect(button).toBeVisible();
  await button.click();

  await expect(page.locator('#chatDrawer')).toBeVisible();
  const card = page.locator('#chatThread .chat-task').last();
  await expect(card.locator('[data-task-field="title"]')).toHaveValue('Confirm who at Northwind has GA4 admin access');
  await expect(card).toContainText('From the pulse.');
  await card.locator('[data-chat-act="task-dismiss"]').click();
  await expect(page.locator('#chatThread .chat-task.dismissed').last()).toContainText('Confirm who at Northwind has GA4 admin access');

  expect(watch.problems()).toEqual([]);
});
