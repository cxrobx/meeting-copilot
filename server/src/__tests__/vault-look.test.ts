import { describe, it, expect } from 'vitest';
import {
  accentInk,
  applyVaultLook,
  contrast,
  parseOnyxPalette,
  vaultLookCss,
  type VaultLook,
} from '../present/vault-look.js';

/**
 * A real /api/vault-look payload: the Solarized Light vault, as Onyx served it
 * on 2026-09-19. Trimmed to the first rule, which is the one we read.
 */
const SOLARIZED = {
  ok: true,
  enabled: true,
  available: true,
  mode: 'light',
  base: [253, 246, 227],
  revision: 'a1b2c3d4e5f6',
  css:
    ':root.vault-look{--bg-primary:253 246 227;--bg-sidebar:253 246 227;--bg-surface:241 234 210;' +
    '--bg-elevated:253 246 227;--bg-input:244 237 214;--ink:0 43 54;--secondary:68 98 101;' +
    '--muted:121 140 137;--faint:164 175 166;--line:rgb(0 43 54/.14);--line-soft:rgb(0 43 54/.07);' +
    '--selected:rgb(234 231 214);--accent:203 75 22;--accent-hover:152 67 30;--button-bg:0 43 54;' +
    '--button-hover:46 80 85;--button-ink:253 246 227;--ui-font:"JetBrains Mono", Inter, ui-sans-serif;' +
    'color-scheme:light}\n:root.vault-look body.obsidian-tree aside{--bg-primary:253 246 227}',
};

/** Every token the vault layer claims to define, so a rename can't drop one. */
const REQUIRED = [
  '--bg-primary',
  '--bg-sidebar',
  '--bg-surface',
  '--bg-elevated',
  '--bg-input',
  '--border-default',
  '--border-subtle',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--text-faint',
  '--accent',
  '--accent-hover',
  '--accent-ink',
];

describe('parseOnyxPalette', () => {
  it('reads the vault palette out of Onyx s stylesheet', () => {
    const palette = parseOnyxPalette(SOLARIZED);
    expect(palette).not.toBeNull();
    expect(palette!.mode).toBe('light');
    expect(palette!.tokens['bg-primary']).toBe('253 246 227');
    expect(palette!.tokens['ink']).toBe('0 43 54');
    expect(palette!.tokens['accent']).toBe('203 75 22');
    expect(palette!.tokens['ui-font']).toBe('"JetBrains Mono", Inter, ui-sans-serif');
  });

  it('stops at the first rule and never reads the sidebar block', () => {
    const palette = parseOnyxPalette(SOLARIZED)!;
    expect(Object.keys(palette.tokens)).not.toContain('obsidian-tree');
  });

  it('carries a revision that changes with the translator, not just the vault', () => {
    expect(parseOnyxPalette(SOLARIZED)!.revision).toMatch(/^a1b2c3d4e5f6-\d+$/);
  });

  // ─── The fallback cases: each must be "no palette", never a broken one ───

  it('returns null when Onyx has no snapshot', () => {
    expect(parseOnyxPalette({ ...SOLARIZED, available: false })).toBeNull();
  });

  it('returns null when the payload is not a vault-look response', () => {
    expect(parseOnyxPalette(null)).toBeNull();
    expect(parseOnyxPalette('{}')).toBeNull();
    expect(parseOnyxPalette({ ok: false })).toBeNull();
  });

  it('returns null on an unknown mode', () => {
    expect(parseOnyxPalette({ ...SOLARIZED, mode: 'sepia' })).toBeNull();
  });

  it('returns null when a required colour is missing', () => {
    expect(parseOnyxPalette({ ...SOLARIZED, css: SOLARIZED.css.replace('--ink:0 43 54;', '') })).toBeNull();
  });

  it('rejects a colour that is not a plain triplet', () => {
    const css = SOLARIZED.css.replace('--accent:203 75 22', '--accent:var(--evil)');
    expect(parseOnyxPalette({ ...SOLARIZED, css })).toBeNull();
  });

  it('cannot be made to carry a rule through the font', () => {
    // Two different defences, one outcome. A value with a resource function or a
    // variable is dropped by the grammar; a value that tries to CLOSE the rule
    // ends the block we read, so the payload after it is never parsed at all.
    for (const evil of ['Inter}body{display:none', 'url(http://x/f.woff)', 'var(--x)', 'Inter;color:red']) {
      const palette = parseOnyxPalette({
        ...SOLARIZED,
        css: SOLARIZED.css.replace('"JetBrains Mono", Inter, ui-sans-serif', evil),
      });
      if (!palette) continue;
      const css = vaultLookCss(palette);
      expect(css.slice(0, -1)).not.toContain('}');
      expect(css).not.toContain('display:none');
      expect(css).not.toContain('color:red');
      expect(css).not.toContain('url(');
      expect(css).not.toContain('var(');
    }
  });
});

describe('vaultLookCss', () => {
  const css = vaultLookCss(parseOnyxPalette(SOLARIZED)!);

  it('emits one rule, scoped so it can only override', () => {
    expect(css.startsWith(':root.vault-look{')).toBe(true);
    expect(css.endsWith('}')).toBe(true);
    expect(css.slice(0, -1)).not.toContain('}');
  });

  it('defines every token it is responsible for', () => {
    for (const token of REQUIRED) expect(css).toContain(`${token}:`);
  });

  it('leaves the semantics, shadows and mono face to the app s own theme', () => {
    for (const token of ['--success', '--error', '--warning', '--ai-accent', '--shadow-color', '--font-mono']) {
      expect(css).not.toContain(token);
    }
  });

  it('maps Onyx s names onto the dashboard s', () => {
    expect(css).toContain('--text-primary:0 43 54');
    expect(css).toContain('--text-secondary:68 98 101');
    expect(css).toContain('--bg-surface:241 234 210');
    expect(css).toContain('color-scheme:light');
  });

  it('composites the translucent lines into the opaque triplets the rules expect', () => {
    // ink 0 43 54 at 14% over ground 253 246 227.
    expect(css).toContain('--border-default:218 218 203');
    expect(css).toContain('--border-subtle:235 232 215');
    expect(css).not.toContain('--border-default:rgb');
  });

  it('takes the vault s interface font for chrome', () => {
    expect(css).toContain('--font-sans:"JetBrains Mono", Inter, ui-sans-serif');
  });

  it('falls back to Onyx s own ratios when a line cannot be parsed', () => {
    const palette = parseOnyxPalette({
      ...SOLARIZED,
      css: SOLARIZED.css.replace('--line:rgb(0 43 54/.14);', ''),
    })!;
    expect(vaultLookCss(palette)).toContain('--border-default:218 218 203');
  });
});

describe('accentInk', () => {
  const cream: [number, number, number] = [253, 246, 227];
  const ink: [number, number, number] = [0, 43, 54];

  it('keeps white on an accent that carries it', () => {
    // Solarized orange: white reads at 4.6:1, so the button looks as it does
    // under the app's own themes.
    expect(accentInk([203, 75, 22], cream, ink)).toEqual([255, 255, 255]);
    expect(contrast([255, 255, 255], [203, 75, 22])).toBeGreaterThan(4.5);
  });

  it('switches to a dark ink where white would not clear AA', () => {
    // A pale accent is the obvious case; a mid-blue is the one that catches
    // people out (white on Apple blue is 3.6:1 — under AA for body text).
    for (const accent of [[240, 200, 60], [10, 132, 255]] as [number, number, number][]) {
      const chosen = accentInk(accent, cream, ink);
      expect(chosen).not.toEqual([255, 255, 255]);
      expect(contrast(chosen, accent)).toBeGreaterThan(contrast([255, 255, 255], accent));
    }
  });

  it('never returns an ink below the best available contrast', () => {
    // A mid-tone accent clears 4.5:1 against nothing; take the best on offer.
    const accent: [number, number, number] = [128, 128, 128];
    const chosen = accentInk(accent, cream, ink);
    const best = Math.max(
      contrast([255, 255, 255], accent),
      contrast(cream, accent),
      contrast(ink, accent),
    );
    expect(contrast(chosen, accent)).toBeCloseTo(best, 5);
  });
});

describe('applyVaultLook', () => {
  const page = '<!DOCTYPE html>\n<html lang="en" data-theme="dark">\n<head>\n<title>x</title>\n</head>\n<body></body>\n</html>';
  const look: VaultLook = {
    enabled: true,
    available: true,
    mode: 'light',
    revision: 'abc-1',
    css: ':root.vault-look{--bg-primary:253 246 227}',
    source: 'onyx',
  };

  it('dresses the page before it is sent, so nothing repaints after first frame', () => {
    const dressed = applyVaultLook(page, look);
    expect(dressed).toContain('<html lang="en" data-theme="light" class="vault-look">');
    expect(dressed).toContain('<style id="mcVaultLook">:root.vault-look{--bg-primary:253 246 227}</style>');
    expect(dressed).toContain('<meta name="mc-vault-revision" content="abc-1">');
    expect(dressed.indexOf('mcVaultLook')).toBeLessThan(dressed.indexOf('</head>'));
  });

  it('hands the page back untouched when there is no look to wear', () => {
    for (const empty of [
      { ...look, css: '', mode: null },
      { ...look, enabled: false, css: '' },
    ] as VaultLook[]) {
      expect(applyVaultLook(page, empty)).toBe(page);
    }
  });

  it('hands the page back untouched if the template has moved', () => {
    const moved = page.replace('data-theme="dark"', 'data-theme="auto"');
    expect(applyVaultLook(moved, look)).toBe(moved);
  });
});
