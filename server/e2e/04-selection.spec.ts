import { expect, test } from '@playwright/test';
import { dragSelect, run, watchPage } from './helpers.js';

// Catches: selection capture in the transcript, and the evidence frame's
// bridge (a selection inside the sandboxed snapshot reaching the page).
test('highlighting shows the toolbar and Add to chat makes a chip, in the transcript and inside an evidence frame', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(run.replayUrl);
  const bar = page.locator('.selbar');
  const chips = page.locator('#chatChips .chat-chip');

  const line = page.locator('#transcriptFeed .seg .seg-text').filter({ hasText: 'the Looker board shows zero key events' });
  await expect(line).toBeVisible();
  await dragSelect(page, line);
  await expect(bar).toBeVisible();
  await bar.locator('.selbar-btn', { hasText: 'Add to chat' }).click();
  await expect(bar).toBeHidden();
  await expect(page.locator('#chatDrawer')).toBeVisible();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText('“Yeah, the Looker');
  await expect(chips.first()).toHaveAttribute('title', /^Transcript: Yeah, the Looker/);
  await page.locator('#chatDrawer .chat-x').click();

  await page.locator('#evTabStrip .ev-tab', { hasText: 'Looker: 0 key events' }).click();
  const note = page.frameLocator('#evView iframe.ev-frame').locator('p').filter({ hasText: 'Note from Brightline' });
  await expect(note).toBeVisible();
  await dragSelect(page, note);
  await expect(bar).toBeVisible();
  await bar.locator('.selbar-btn', { hasText: 'Add to chat' }).click();
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(1)).toContainText('“Note from Brightline');
  await expect(chips.nth(1)).toHaveAttribute('title', /^Looker: 0 key events: Note from Brightline/);

  expect(watch.problems()).toEqual([]);
});
