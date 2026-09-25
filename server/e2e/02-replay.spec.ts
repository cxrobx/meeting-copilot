import { expect, test } from '@playwright/test';
import { run, settle, watchPage } from './helpers.js';

// Catches: a replay that no longer renders the stored meeting, and prep.json
// evidence handling (the tabs, the sandboxed html snapshot and its bridge).
test('a past meeting replays: transcript, card, pulse and both evidence tabs', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(run.replayUrl);

  await expect(page.locator('#statePill')).toHaveText('Replay');
  await expect(page.locator('#transcriptFeed .seg')).toHaveCount(9);
  await expect(page.locator('#transcriptFeed')).toContainText('the Looker board shows zero key events');
  await expect(page.locator('#action-card-ga4')).toContainText('GA4 key events vs conversions');
  await expect(page.locator('#action-card-ga4 .card-body')).toContainText('marked as one in Admin > Events');
  await expect(page.locator('#pulseSlot')).toContainText('Good pace');

  const tabs = page.locator('#evTabStrip .ev-tab');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(0)).toHaveText('Meeting');

  // The html snapshot: sandboxed, served with the selection bridge.
  await tabs.filter({ hasText: 'Looker: 0 key events' }).click();
  const frameEl = page.locator('#evView iframe.ev-frame');
  await expect(frameEl).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frameEl).toHaveAttribute('src', /\/present\/evidence\/0\/file\?.*frame=1/);
  await expect(page.frameLocator('#evView iframe.ev-frame').locator('h1')).toHaveText('Northwind site performance (Looker Studio)');
  const frame = page.frames().find((f) => f.url().includes('/present/evidence/0/file'));
  expect(frame, 'the evidence frame').toBeTruthy();
  expect(await frame!.evaluate(() => document.documentElement.outerHTML.includes('mcEvidenceSelection'))).toBe(true);

  // The live tab: it needs a login, so it offers the browser instead.
  await tabs.filter({ hasText: 'Search Console' }).click();
  await expect(page.locator('#evView .ev-live-card')).toContainText('search.google.com/search-console');
  await tabs.filter({ hasText: 'Meeting' }).click();
  await expect(page.locator('#evView iframe')).toHaveCount(0);

  await settle(page);
  expect(watch.problems()).toEqual([]);
});
