import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * User-tunable server settings, persisted to ~/.meeting-copilot/settings.json.
 *
 * Precedence per field: settings.json > env var (back-compat) > default.
 * Values are clamped on load AND on update so a hand-edited file can't put
 * the pipeline into a degenerate state (e.g. 0ms eval cadence).
 */
export interface CopilotSettings {
  /** Base intelligence eval cadence (backoff = 2× this). */
  evalCadenceMs: number;
  /** How long an unactioned suggestion lives before auto-expiring. */
  suggestionTtlMs: number;
  /** Whether live monitors start enabled on each new session. */
  monitorDefaults: { coach: boolean; factcheck: boolean };
  /** Session retention window in days. */
  retentionDays: number;
  /** Auto-write meeting summaries to ~/Documents/CX/Meetings. */
  summaryAutoWrite: boolean;
}

// Computed per call so tests can point COPILOT_SETTINGS_DIR at a temp dir.
function settingsDir(): string {
  return process.env.COPILOT_SETTINGS_DIR ?? join(homedir(), '.meeting-copilot');
}
function settingsPath(): string {
  return join(settingsDir(), 'settings.json');
}

const CLAMPS = {
  evalCadenceMs: { min: 10_000, max: 60_000 },
  suggestionTtlMs: { min: 30_000, max: 300_000 },
  retentionDays: { min: 7, max: 3650 },
} as const;

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

function envNumber(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function defaults(): CopilotSettings {
  return {
    evalCadenceMs: envNumber('EVAL_CADENCE_MS') ?? 15_000,
    suggestionTtlMs: envNumber('SUGGESTION_TTL_MS') ?? 60_000,
    // Coach is the primary in-meeting product loop. Fact-check remains opt-in
    // because it can invoke web verification and is materially more expensive.
    monitorDefaults: { coach: true, factcheck: false },
    retentionDays: envNumber('RETENTION_DAYS') ?? 90,
    summaryAutoWrite: true,
  };
}

function sanitize(raw: Partial<CopilotSettings>): CopilotSettings {
  const base = defaults();
  const merged: CopilotSettings = {
    evalCadenceMs:
      typeof raw.evalCadenceMs === 'number' && Number.isFinite(raw.evalCadenceMs)
        ? clamp(raw.evalCadenceMs, CLAMPS.evalCadenceMs)
        : base.evalCadenceMs,
    suggestionTtlMs:
      typeof raw.suggestionTtlMs === 'number' && Number.isFinite(raw.suggestionTtlMs)
        ? clamp(raw.suggestionTtlMs, CLAMPS.suggestionTtlMs)
        : base.suggestionTtlMs,
    monitorDefaults: {
      coach: typeof raw.monitorDefaults?.coach === 'boolean' ? raw.monitorDefaults.coach : base.monitorDefaults.coach,
      factcheck:
        typeof raw.monitorDefaults?.factcheck === 'boolean'
          ? raw.monitorDefaults.factcheck
          : base.monitorDefaults.factcheck,
    },
    retentionDays:
      typeof raw.retentionDays === 'number' && Number.isFinite(raw.retentionDays)
        ? clamp(Math.round(raw.retentionDays), CLAMPS.retentionDays)
        : base.retentionDays,
    summaryAutoWrite: typeof raw.summaryAutoWrite === 'boolean' ? raw.summaryAutoWrite : base.summaryAutoWrite,
  };
  return merged;
}

let cached: CopilotSettings | null = null;
let warnedOnce = false;

/** Effective settings (file > env > defaults). Loaded once, cached. */
export function getSettings(): CopilotSettings {
  if (cached) return cached;
  let raw: Partial<CopilotSettings> = {};
  try {
    if (existsSync(settingsPath())) {
      raw = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    }
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        `[Settings] Could not parse ${settingsPath()} — using defaults (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  cached = sanitize(raw);
  return cached;
}

/**
 * Merge, clamp, persist, and return the new effective settings. Atomic write
 * (tmp + rename) so a crash mid-write can't corrupt the file.
 */
export function updateSettings(partial: Partial<CopilotSettings>): CopilotSettings {
  const next = sanitize({
    ...getSettings(),
    ...partial,
    monitorDefaults: { ...getSettings().monitorDefaults, ...(partial.monitorDefaults ?? {}) },
  });
  cached = next;
  try {
    if (!existsSync(settingsDir())) mkdirSync(settingsDir(), { recursive: true });
    const tmp = `${settingsPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...next }, null, 2), 'utf-8');
    renameSync(tmp, settingsPath());
  } catch (err) {
    console.warn(`[Settings] Persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return next;
}

/** Test hook — drop the cache so the next getSettings() re-reads disk/env. */
export function _resetSettingsCache(): void {
  cached = null;
}
