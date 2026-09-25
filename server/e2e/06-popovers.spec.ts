import { expect, test } from '@playwright/test';
import { dragSelect, paintedShares, run, settle, watchPage } from './helpers.js';

// A popover that lays out and hit-tests but never paints passes every "is it
// open, can I click it" check (gotcha #27), so this one looks at pixels.
// Unpainted scores exactly 0 (screenshots are lossless). A painted popover
// changes its whole box when its background differs from the page under it,
// and only its text and border when it matches (the card menu over a card,
// ~14%), so the box floor is low and every row must paint besides.
const MIN_BOX = 0.05;
const MIN_ROW = 0.02;

// Catches: the #27 class, for each popover the dashboard draws.
test('every popover actually paints: All tabs, the card menu, the selection toolbar', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(run.replayUrl);
  await expect(page.locator('#action-card-ga4 .card-body')).toBeVisible();
  const painted: Record<string, { box: number; rows: number[] }> = {};

  // All tabs, over the evidence snapshot.
  await page.locator('#evTabStrip .ev-tab', { hasText: 'Looker: 0 key events' }).click();
  await expect(page.frameLocator('#evView iframe.ev-frame').locator('h1')).toBeVisible();
  await page.locator('#evTabList').click();
  const allTabs = page.locator('.ev-menu');
  await expect(allTabs).toBeVisible();
  await expect(allTabs.getByRole('menuitem')).toHaveCount(3);
  painted.allTabs = await paintedShares(page, allTabs, '[role=menuitem]');
  await page.keyboard.press('Escape');
  await expect(allTabs).toHaveCount(0);
  await page.locator('#evTabStrip .ev-tab', { hasText: 'Meeting' }).click();

  // The card menu: right-click a card with nothing selected.
  await page.locator('#action-card-ga4 .card-title').click({ button: 'right' });
  const cardMenu = page.locator('.askmenu').filter({ hasText: 'Summarize' });
  await expect(cardMenu).toBeVisible();
  painted.cardMenu = await paintedShares(page, cardMenu, '.askmenu-item');
  await page.keyboard.press('Escape');
  await expect(cardMenu).toBeHidden();

  // The selection toolbar, over the transcript.
  await dragSelect(page, page.locator('#transcriptFeed .seg .seg-text').filter({ hasText: 'the Looker board shows zero key events' }));
  const bar = page.locator('.selbar');
  await expect(bar).toBeVisible();
  painted.selectionToolbar = await paintedShares(page, bar, '.selbar-btn');

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`[e2e] painted: ${Object.entries(painted).map(([k, v]) => `${k} ${pct(v.box)} (rows ${v.rows.map(pct).join(' ')})`).join('; ')}`);
  for (const [name, { box, rows }] of Object.entries(painted)) {
    expect(box, `${name} painted ${pct(box)} of its box`).toBeGreaterThanOrEqual(MIN_BOX);
    expect(rows.length, `${name} has rows`).toBeGreaterThan(1);
    rows.forEach((share, i) => expect(share, `${name} row ${i + 1} painted ${pct(share)}`).toBeGreaterThanOrEqual(MIN_ROW));
  }
  await settle(page);
  expect(watch.problems()).toEqual([]);
});
