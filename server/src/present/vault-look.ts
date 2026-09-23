/**
 * The dashboard in the vault's colours — the same look Onyx wears.
 *
 * Onyx's Obsidian plugin measures the vault's reading view and file explorer and
 * posts bounded snapshots to the Onyx server, which derives an app-wide palette
 * from them (`ask-widget/src/ask_widget/vault_look.py`). This module takes that
 * palette over HTTP, re-validates every value, and re-expresses it in the
 * dashboard's own token names — so `/present` wears the vault while "Match vault
 * appearance" is on, and falls back to the CX family tokens the moment anything
 * is missing.
 *
 * Two rules hold the design together:
 *
 *  1. **Nothing Onyx sends is pasted into the page.** Values are parsed, checked
 *     against the grammar below, and re-emitted from our own numbers. A vault
 *     theme can change the dashboard's colours; it can never introduce a rule.
 *
 *  2. **The vault layer only ever OVERRIDES.** Its declarations land on
 *     `:root.vault-look` (specificity 0,2,0), on top of the full
 *     `[data-theme="light|dark"]` block (0,1,0) selected by the vault's own mode.
 *     Anything the vault has no opinion about — the semantic colours, shadows,
 *     radii, the mono face — keeps the value it has today, so an unmapped token
 *     can never come out unset.
 *
 * Losing the palette is not an error state: Onyx being down, Obsidian never
 * having synced, or the switch being off all land on the same fallback, which is
 * the dashboard exactly as it shipped.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { getSettings } from '../settings.js';

export type VaultMode = 'light' | 'dark';

/** A validated palette: Onyx's tokens, ours to re-express. */
export interface VaultPalette {
  mode: VaultMode;
  /** Onyx token name (without `--`) → validated value. */
  tokens: Record<string, string>;
  /** Onyx's own revision hash for the palette. */
  revision: string;
}

export interface VaultLook {
  /** The "Match vault appearance" setting. */
  enabled: boolean;
  /** A usable palette exists (whether or not it is being worn). */
  available: boolean;
  mode: VaultMode | null;
  /** Changes whenever the worn CSS would change; the page re-takes it on a new value. */
  revision: string;
  /** `:root.vault-look{…}`, or '' when the dashboard wears its own palette. */
  css: string;
  /**
   * The same palette as `css`, as data: dashboard token name (without `--`) →
   * value, `{}` when the dashboard wears its own palette. For the native menu
   * bar popover, which wears the vault too and must never parse CSS.
   */
  tokens: Record<string, string>;
  source: 'onyx' | 'cache' | 'none';
}

const ONYX_URL = process.env.ONYX_URL ?? 'http://127.0.0.1:8899';
/** Short: a page load must not wait on a service that may be stopped. */
const FETCH_TIMEOUT_MS = 400;
const MEMORY_TTL_MS = 60_000;
/** Bumped when the mapping below changes, so a cached page re-takes the new CSS. */
const TRANSLATOR_VERSION = 1;

// ─── Grammar ────────────────────────────────────────────────────────────────
// Onyx validates harder than this on the way in (markdown_theme._UNSAFE, and a
// palette built only from parsed numbers). We re-check anyway: this module is
// the boundary, and it is one process away from the page.

const TRIPLET = /^\d{1,3} \d{1,3} \d{1,3}$/;
const RGB_VALUE = /^rgb\((\d{1,3}) (\d{1,3}) (\d{1,3})(?:\s*\/\s*(\.?\d+(?:\.\d+)?))?\)$/;
const REVISION = /^[a-f0-9]{1,64}$/;
/** Mirrors markdown_theme._UNSAFE: no escapes, delimiters, comments or resource functions. */
// eslint-disable-next-line no-control-regex
const FONT_UNSAFE = /[;{}<>\\\u0000-\u001f]|\/\*|\*\/|(?:url|var|env|attr|expression)\s*\(/i;
const FONT_MAX = 512;

/** Onyx tokens we read, and the shape each must have. */
const TRIPLET_TOKENS = [
  'bg-primary',
  'bg-sidebar',
  'bg-surface',
  'bg-elevated',
  'bg-input',
  'ink',
  'secondary',
  'muted',
  'faint',
  'accent',
  'accent-hover',
] as const;
const RGB_TOKENS = ['line', 'line-soft'] as const;

type RGB = [number, number, number];

// ─── Colour helpers (ported from vault_look.py so the maths agrees) ─────────

function triplet(value: string): RGB | null {
  if (!TRIPLET.test(value)) return null;
  const parts = value.split(' ').map(Number) as RGB;
  return parts.every((v) => v >= 0 && v <= 255) ? parts : null;
}

function render(color: RGB): string {
  return color.map((v) => Math.round(v)).join(' ');
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function luminance(color: RGB): number {
  const channel = (raw: number): number => {
    const v = raw / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
}

/** WCAG contrast ratio between two sRGB colours. */
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A translucent `rgb(r g b / a)` as it is actually drawn on `ground`.
 *
 * The dashboard's border tokens are opaque triplets (rules wrap them in
 * `rgb(var(--border-default))`), while Onyx hands its lines over as ink at 14%
 * and 7%. Compositing here keeps both true: the same line the vault draws,
 * expressed the way the dashboard's 1,000+ rules already consume it.
 */
function composite(value: string, ground: RGB): RGB | null {
  const match = RGB_VALUE.exec(value);
  if (!match) return null;
  const color = [Number(match[1]), Number(match[2]), Number(match[3])] as RGB;
  if (color.some((v) => v > 255)) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
  return mix(ground, color, alpha);
}

// ─── Parsing Onyx's stylesheet ──────────────────────────────────────────────

/**
 * The declarations of Onyx's own `:root.vault-look` block, validated.
 *
 * `/api/vault-look` returns built CSS rather than a token map, so the tokens are
 * read back out of the first rule. A block that is missing a ground, an ink or an
 * accent is treated as no palette at all — the same answer as Onyx being down.
 */
export function parseOnyxPalette(payload: unknown): VaultPalette | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (body.ok !== true || body.available !== true) return null;

  const mode = body.mode;
  if (mode !== 'light' && mode !== 'dark') return null;

  const css = typeof body.css === 'string' ? body.css : '';
  const open = css.indexOf(':root.vault-look{');
  if (open === -1) return null;
  const close = css.indexOf('}', open);
  if (close === -1) return null;
  const block = css.slice(open + ':root.vault-look{'.length, close);

  const raw = new Map<string, string>();
  for (const declaration of block.split(';')) {
    const at = declaration.indexOf(':');
    if (at === -1) continue;
    const name = declaration.slice(0, at).trim();
    if (!name.startsWith('--')) continue;
    raw.set(name.slice(2), declaration.slice(at + 1).trim());
  }

  const tokens: Record<string, string> = {};
  for (const name of TRIPLET_TOKENS) {
    const value = raw.get(name);
    if (!value || !triplet(value)) return null;
    tokens[name] = value;
  }
  for (const name of RGB_TOKENS) {
    const value = raw.get(name);
    // A line we cannot parse is not fatal — the mapping falls back to Onyx's own
    // ratios (ink at 14% / 7%), which is where these values come from anyway.
    if (value && RGB_VALUE.test(value)) tokens[name] = value;
  }
  const font = raw.get('ui-font');
  if (font && font.length <= FONT_MAX && !FONT_UNSAFE.test(font)) tokens['ui-font'] = font;

  const revision = typeof body.revision === 'string' && REVISION.test(body.revision) ? body.revision : '';
  return { mode, tokens, revision: `${revision}-${TRANSLATOR_VERSION}` };
}

// ─── Translation into the dashboard's tokens ────────────────────────────────

/**
 * The vault palette in the dashboard's own token names.
 *
 * Only the tokens the vault has an opinion about are emitted. The semantics
 * (`--success`/`--error`/`--warning`/`--ai-accent`/`--shadow-color`), the radii
 * and `--font-mono` stay the dashboard's own, inherited from the `[data-theme]`
 * block that the vault's mode selects.
 */
export function vaultLookCss(palette: VaultPalette): string {
  const declarations = [`color-scheme:${palette.mode}`];
  for (const [name, value] of Object.entries(vaultLookTokens(palette))) declarations.push(`--${name}:${value}`);
  return `:root.vault-look{${declarations.join(';')}}`;
}

/**
 * The mapping behind `vaultLookCss`, as data (token name without `--` → value).
 * One mapping for both consumers, so the page and the menu bar cannot drift.
 */
export function vaultLookTokens(palette: VaultPalette): Record<string, string> {
  const t = palette.tokens;
  const ground = triplet(t['bg-primary'])!;
  const ink = triplet(t['ink'])!;
  const accent = triplet(t['accent'])!;

  const line = (name: string, ratio: number): string =>
    render((t[name] ? composite(t[name], ground) : null) ?? mix(ground, ink, ratio));

  const tokens: Record<string, string> = {
    'bg-primary': t['bg-primary'],
    'bg-sidebar': t['bg-sidebar'],
    'bg-surface': t['bg-surface'],
    'bg-elevated': t['bg-elevated'],
    'bg-input': t['bg-input'],
    'border-default': line('line', 0.14),
    'border-subtle': line('line-soft', 0.07),
    'text-primary': t['ink'],
    'text-secondary': t['secondary'],
    'text-muted': t['muted'],
    'text-faint': t['faint'],
    accent: t['accent'],
    'accent-hover': t['accent-hover'],
    'accent-ink': render(accentInk(accent, ground, ink)),
  };
  // The vault's INTERFACE font (the explorer's), never its reading font: chrome
  // set in the reading face would read as part of a note. Mono is left alone —
  // it marks the places where character alignment carries meaning.
  if (t['ui-font']) tokens['font-sans'] = t['ui-font'];
  return tokens;
}

/**
 * The text that sits ON an accent fill (the primary button, the LIVE pill).
 *
 * Onyx never fills with its accent — it only holds the accent to 3:1 against the
 * vault's ground, which is enough to read as text but not to carry text of its
 * own. The dashboard does fill with it, so the ink on that fill is chosen here:
 * whichever of white, the vault's ground or the vault's ink reads best on it.
 */
export function accentInk(accent: RGB, ground: RGB, ink: RGB): RGB {
  const candidates: RGB[] = [[255, 255, 255], ground, ink];
  let best = candidates[0];
  let bestRatio = 0;
  for (const candidate of candidates) {
    const ratio = contrast(candidate, accent);
    // First candidate to clear AA wins, in preference order (white first, so a
    // dark vault keeps the button it has today).
    if (ratio >= 4.5) return candidate;
    if (ratio > bestRatio) [best, bestRatio] = [candidate, ratio];
  }
  return best;
}

// ─── Fetch, cache, fall back ────────────────────────────────────────────────

function cacheFile(): string {
  const dir = process.env.COPILOT_SETTINGS_DIR ?? join(homedir(), '.meeting-copilot');
  return join(dir, 'vault-look.json');
}

/**
 * What the last look-up found, good or bad, and when.
 *
 * A miss is remembered as deliberately as a hit: with Onyx hung rather than
 * refused, every uncached call costs the full timeout, and `/present/vault-look`
 * is pinged on every reconnect.
 */
let memory: { palette: VaultPalette | null; source: 'onyx' | 'cache' | 'none'; at: number } | null = null;

function writeCache(palette: VaultPalette): void {
  const file = cacheFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(palette), 'utf-8');
    renameSync(tmp, file);
  } catch {
    // A look we cannot cache is still a look — this is a convenience, not state.
  }
}

/**
 * The last palette Onyx gave us, re-validated.
 *
 * Stored as Onyx's tokens rather than as built CSS, so a change to the mapping
 * above takes effect on the next page load instead of waiting for Obsidian to
 * sync again.
 */
function readCache(): VaultPalette | null {
  const file = cacheFile();
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    // Re-shape into an /api/vault-look payload so there is exactly one validator.
    return parseOnyxPalette({
      ok: true,
      available: true,
      mode: raw.mode,
      revision: typeof raw.revision === 'string' ? raw.revision.split('-')[0] : '',
      css: `:root.vault-look{${Object.entries((raw.tokens ?? {}) as Record<string, string>)
        .map(([name, value]) => `--${name}:${value}`)
        .join(';')}}`,
    });
  } catch {
    return null;
  }
}

async function fetchPalette(): Promise<VaultPalette | null> {
  try {
    const response = await fetch(`${ONYX_URL}/api/vault-look`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return parseOnyxPalette(await response.json());
  } catch {
    // Onyx stopped, moved port, or is slower than the budget. Not an error here.
    return null;
  }
}

let loggedSource: string | null = null;

/**
 * The look the dashboard should wear right now.
 *
 * Fresh palette → last good (memory, then disk) → nothing. The ladder matters
 * mid-meeting: restarting Onyx must not repaint a dashboard someone is presenting.
 */
export async function getVaultLook(): Promise<VaultLook> {
  const enabled = getSettings().matchVaultAppearance;

  if (memory && Date.now() - memory.at < MEMORY_TTL_MS) {
    return dress(memory.palette, enabled, memory.source);
  }

  const fetched = await fetchPalette();
  if (fetched) return remember(fetched, 'onyx', enabled);

  // Onyx did not answer. The last good palette outlives it on purpose: restarting
  // Onyx, or quitting Obsidian, must not repaint a dashboard mid-meeting.
  const cached = memory?.palette ?? readCache();
  return cached ? remember(cached, 'cache', enabled) : remember(null, 'none', enabled);
}

function remember(
  palette: VaultPalette | null,
  source: 'onyx' | 'cache' | 'none',
  enabled: boolean,
): VaultLook {
  memory = { palette, source, at: Date.now() };
  if (palette && source === 'onyx') writeCache(palette);
  return dress(palette, enabled, source);
}

function dress(palette: VaultPalette | null, enabled: boolean, source: VaultLook['source']): VaultLook {
  note(source);
  if (!palette || !enabled) {
    return { enabled, available: palette !== null, mode: null, revision: '', css: '', tokens: {}, source };
  }
  return {
    enabled,
    available: true,
    mode: palette.mode,
    revision: palette.revision,
    css: vaultLookCss(palette),
    tokens: vaultLookTokens(palette),
    source,
  };
}

/** One line per change of source, so "why is it not wearing the vault" is answerable. */
function note(source: string): void {
  if (loggedSource === source) return;
  loggedSource = source;
  const detail =
    source === 'onyx'
      ? `wearing the vault palette from ${ONYX_URL}`
      : source === 'cache'
        ? `Onyx unreachable at ${ONYX_URL} — wearing the last cached vault palette`
        : `no vault palette (Onyx unreachable at ${ONYX_URL} and nothing cached) — wearing the CX family tokens`;
  console.log(`[VaultLook] ${detail}`);
}

/** Test seam: forget the in-memory palette so the next call re-fetches. */
export function resetVaultLookCache(): void {
  memory = null;
  loggedSource = null;
}

// ─── First paint ────────────────────────────────────────────────────────────

const HTML_TAG = '<html lang="en" data-theme="dark">';

/**
 * The page as it will look, before it is sent.
 *
 * The mode and the palette go into the markup itself rather than being fetched
 * and applied after paint — a dashboard that repaints a beat after it opens looks
 * broken, and in the WKWebView panel the flash is the first thing you see.
 */
export function applyVaultLook(html: string, look: VaultLook): string {
  if (!look.css || !look.mode) return html;
  if (!html.includes(HTML_TAG) || !html.includes('</head>')) {
    console.warn('[VaultLook] Dashboard template changed shape — serving it unstyled by the vault.');
    return html;
  }
  return html
    .replace(HTML_TAG, `<html lang="en" data-theme="${look.mode}" class="vault-look">`)
    .replace(
      '</head>',
      `<meta name="mc-vault-revision" content="${look.revision}">\n<style id="mcVaultLook">${look.css}</style>\n</head>`,
    );
}
