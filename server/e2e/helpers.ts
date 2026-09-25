import type { Locator, Page } from '@playwright/test';

/** What harness.ts set up for this run. */
export const run = {
  get base(): string { return need('MC_E2E_BASE'); },
  get port(): number { return Number(need('MC_E2E_PORT')); },
  get sessionId(): string { return need('MC_E2E_SESSION'); },
  get title(): string { return need('MC_E2E_TITLE'); },
  get replayUrl(): string { return `${this.base}/present?session=${encodeURIComponent(this.sessionId)}`; },
};

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: run the specs through e2e/playwright.config.ts (its global setup starts the server).`);
  return v;
}

/** Replay keeps an event stream open, so networkidle never comes: let late requests land. */
export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(300);
}

/**
 * Everything that went wrong on the page: console errors, uncaught
 * exceptions, requests that failed, and HTTP errors from our own server.
 */
export function watchPage(page: Page): { problems: () => string[] } {
  const problems: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
  page.on('requestfailed', (req) => {
    const why = req.failure()?.errorText ?? '?';
    // A replay's event stream never ends, so leaving the page cancels it.
    if (why === 'cancelled' && new URL(req.url()).pathname === '/present/events') return;
    problems.push(`failed request: ${req.method()} ${req.url()} (${why})`);
  });
  page.on('response', (res) => { if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`); });
  return { problems: () => problems.slice() };
}

/** Drag-select across the start of an element's text with the real mouse. */
export async function dragSelect(page: Page, target: Locator, fraction = 0.6): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('Nothing to select: the element has no box.');
  // First line only: a multi-line element's middle can fall between lines.
  const y = box.y + Math.min(box.height / 2, 8);
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * fraction, y, { steps: 8 });
  await page.mouse.up();
}

/**
 * How much of a popover actually painted: the share of pixels that change
 * between the popover hidden and shown, over its whole box and over each of
 * its rows (`rowSelector`, visible ones only). A popover that lays out and
 * hit-tests but never paints (gotcha #27) scores 0; one clipped to its
 * parent paints some rows and not others.
 */
export async function paintedShares(page: Page, popover: Locator, rowSelector: string): Promise<{ box: number; rows: number[] }> {
  const box = await popover.boundingBox();
  if (!box || box.width < 4 || box.height < 4) return { box: 0, rows: [] };
  const vp = page.viewportSize()!;
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const clip = { x, y, width: Math.min(vp.width, Math.ceil(box.x + box.width)) - x, height: Math.min(vp.height, Math.ceil(box.y + box.height)) - y };
  const rows = await popover.evaluate((el: HTMLElement, sel: string) => Array.from(el.querySelectorAll<HTMLElement>(sel))
    .filter((r) => r.offsetWidth > 0 && r.offsetHeight > 0)
    .map((r) => { const b = r.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }), rowSelector);
  const shot = () => page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  await popover.evaluate((el: HTMLElement) => { el.style.visibility = 'hidden'; });
  const hidden = await shot();
  await popover.evaluate((el: HTMLElement) => { el.style.visibility = ''; });
  const shown = await shot();
  const local = rows.map((r) => ({ x: Math.round(r.x - clip.x), y: Math.round(r.y - clip.y), w: Math.round(r.w), h: Math.round(r.h) }));
  return diffShares(page, hidden, shown, local);
}

/** Decode two same-size PNGs in a blank page; the share of changed pixels overall and in each rect. */
async function diffShares(page: Page, a: Buffer, b: Buffer, rects: Array<{ x: number; y: number; w: number; h: number }>): Promise<{ box: number; rows: number[] }> {
  const scratch = await page.context().newPage();
  try {
    return await scratch.evaluate(async ([pa, pb, rs]) => {
      const load = (src: string) => new Promise<HTMLImageElement>((done, fail) => {
        const img = new Image();
        img.onload = () => done(img);
        img.onerror = () => fail(new Error('could not decode the screenshot'));
        img.src = src;
      });
      const [ia, ib] = await Promise.all([load(pa), load(pb)]);
      const w = ia.naturalWidth;
      const h = ia.naturalHeight;
      const pixels = (img: HTMLImageElement) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, w, h).data;
      };
      const da = pixels(ia);
      const db = pixels(ib);
      // Screenshots are lossless: an unpainted pixel is identical, not close.
      const changed = (px: number, py: number) => {
        const i = (py * w + px) * 4;
        return Math.abs(da[i]! - db[i]!) + Math.abs(da[i + 1]! - db[i + 1]!) + Math.abs(da[i + 2]! - db[i + 2]!) > 3;
      };
      const share = (x0: number, y0: number, x1: number, y1: number) => {
        let n = 0;
        let hit = 0;
        for (let py = Math.max(0, y0); py < Math.min(h, y1); py++) {
          for (let px = Math.max(0, x0); px < Math.min(w, x1); px++) { n++; if (changed(px, py)) hit++; }
        }
        return n ? hit / n : 0;
      };
      return { box: share(0, 0, w, h), rows: rs.map((r) => share(r.x, r.y, r.x + r.w, r.y + r.h)) };
    }, [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`, rects] as const);
  } finally {
    await scratch.close();
  }
}
