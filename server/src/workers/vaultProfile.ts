import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The vault profile: the parts of note naming that are true of one person's
 * vault only — who "me" is, and which words earn which category code. None of
 * it is in the code. It is read from ~/.meeting-copilot/vault-profile.json
 * (COPILOT_SETTINGS_DIR moves it, as it does settings.json), and a missing or
 * malformed file means an empty profile: notes carry no category and only
 * "me"/"self" are dropped from the attendees.
 *
 *   {
 *     "selfNames": ["alex", "alex doe"],
 *     "categoryByContent": [{ "code": "BD", "keywords": ["business development", "biz dev"] }]
 *   }
 *
 * `categoryByContent` is matched whole-token over title + attendees, first hit
 * wins, so specific codes go first. It is a separate file, not a field of
 * settings.json, because a settings save rewrites that file from its known
 * fields only.
 */
export interface VaultProfile {
  selfNames: Set<string>;
  categoryByContent: Array<[string, string[]]>;
}

const BUILT_IN_SELF_NAMES = ['me', 'self'];

function profilePath(): string {
  const dir = process.env.COPILOT_SETTINGS_DIR ?? join(homedir(), '.meeting-copilot');
  return join(dir, 'vault-profile.json');
}

const cleanList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

/** Validate a raw profile. Never throws; malformed entries are dropped. */
export function normaliseVaultProfile(raw: unknown): VaultProfile {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const categoryByContent: Array<[string, string[]]> = [];
  for (const entry of Array.isArray(src.categoryByContent) ? src.categoryByContent : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { code, keywords } = entry as { code?: unknown; keywords?: unknown };
    const cleanCode = typeof code === 'string' ? code.trim() : '';
    const cleanKeywords = cleanList(keywords);
    if (cleanCode && cleanKeywords.length) categoryByContent.push([cleanCode, cleanKeywords]);
  }
  return {
    selfNames: new Set([...BUILT_IN_SELF_NAMES, ...cleanList(src.selfNames)]),
    categoryByContent,
  };
}

let cached: VaultProfile | null = null;
let warnedOnce = false;

/** The profile from disk, read once and cached. */
export function getVaultProfile(): VaultProfile {
  if (cached) return cached;
  let raw: unknown = {};
  try {
    if (existsSync(profilePath())) raw = JSON.parse(readFileSync(profilePath(), 'utf-8'));
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        `[VaultProfile] Could not parse ${profilePath()} — naming without one (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  cached = normaliseVaultProfile(raw);
  return cached;
}

/** Test hook: set a profile directly, or pass null to re-read disk next time. */
export function _setVaultProfileForTests(raw: unknown | null): void {
  cached = raw === null ? null : normaliseVaultProfile(raw);
}
