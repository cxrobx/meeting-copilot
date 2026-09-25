import { expect, test } from '@playwright/test';
import { run, watchPage } from './helpers.js';

// Catches: a dashboard script that does not parse (#22) or throws on first
// render (#24), a missing vendored asset, a native module the runtime Node
// cannot load (#14: the server would not have started at all).
test('the idle dashboard loads clean: socket up, start form drawn, nothing failing', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(`${run.base}/present`);

  await expect(page.locator('#statusDot')).toHaveClass(/\bconnected\b/);
  await expect(page.locator('#statePill')).toHaveText('Idle');
  await expect(page.locator('#startTitle')).toBeVisible();
  await expect(page.locator('#startAttendees')).toBeVisible();
  await expect(page.locator('#startActions button').first()).toBeVisible();

  // The vendored renderer, sanitizer and highlighter every card uses.
  expect(await page.evaluate(() => [typeof (window as any).marked, typeof (window as any).DOMPurify, typeof (window as any).hljs]))
    .toEqual(['object', 'function', 'object']);

  // Let the page's own follow-up requests (history, invites, published links) land.
  await page.waitForLoadState('networkidle');
  expect(watch.problems()).toEqual([]);
});
