import { expect, test } from '@playwright/test';
import { run, watchPage } from './helpers.js';

// Catches: the Settings microphone field (2026-10-02: the mic could only be
// changed with `defaults write`, found out mid-meeting). In the app's panel the
// native bridge lists the mics and Save sends a changed choice; a browser tab
// has no bridge and shows no field.
test('Settings lists the app’s microphones and Save sends a changed choice', async ({ page }) => {
  const watch = watchPage(page);
  await page.addInitScript(() => {
    const sent: string[] = [];
    (window as any).__micSent = sent;
    (window as any).__copilotNativeBridge = {
      listMics: () => Promise.resolve({
        devices: [
          { name: 'MacBook Pro Microphone', builtIn: true },
          { name: 'Chris’s AirPods Pro', builtIn: false },
        ],
        preference: 'builtin',
        current: null,
      }),
      setMic: (preference: string) => { sent.push(preference); return Promise.resolve(null); },
    };
  });
  await page.goto(`${run.base}/present`);
  await expect(page.locator('#statusDot')).toHaveClass(/\bconnected\b/);
  await page.locator('#settingsBtn').click();
  const select = page.locator('#setMic');
  await expect(select).toBeEnabled();
  await expect(select.locator('option')).toHaveText([
    'Built-in: MacBook Pro Microphone (recommended)',
    'System default input (follows macOS)',
    'Chris’s AirPods Pro',
  ]);
  await expect(select).toHaveValue('builtin');
  await page.screenshot({ path: test.info().outputPath('settings-mic.png') });

  // Unchanged: Save sends nothing.
  await page.locator('#settingsSave').click();
  await expect(page.locator('#settingsModal')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__micSent)).toEqual([]);

  await page.locator('#settingsBtn').click();
  await expect(page.locator('#setMic')).toBeEnabled();
  await page.locator('#setMic').selectOption('default');
  await page.locator('#settingsSave').click();
  expect(await page.evaluate(() => (window as any).__micSent)).toEqual(['default']);
  // The dashboard drops its own in-flight meeting-chat load when the meeting
  // list refreshes (WebKit reports it as cancelled, or as an access-control
  // failure); that is not this field's doing. Anything else is a problem.
  expect(watch.problems().filter((p) => !p.includes('/present/chat?'))).toEqual([]);
});

test('a browser tab without the app bridge shows no microphone field', async ({ page }) => {
  await page.goto(`${run.base}/present`);
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#settingsSave')).toBeVisible();
  await expect(page.locator('#setMic')).toHaveCount(0);
});
