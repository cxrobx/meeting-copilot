import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSettings, updateSettings, _resetSettingsCache } from '../settings.js';
import { WorkerRegistry } from '../workers/registry.js';
import { IntelligenceEngine } from '../intelligence/index.js';

describe('settings', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-settings-'));
    process.env.COPILOT_SETTINGS_DIR = dir;
    _resetSettingsCache();
  });

  afterEach(() => {
    delete process.env.COPILOT_SETTINGS_DIR;
    _resetSettingsCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns defaults when no file exists', () => {
    const s = getSettings();
    expect(s.evalCadenceMs).toBe(15_000);
    expect(s.suggestionTtlMs).toBe(60_000);
    expect(s.monitorDefaults).toEqual({ coach: false, factcheck: false });
    expect(s.summaryAutoWrite).toBe(true);
  });

  it('persists updates atomically and reloads them', () => {
    updateSettings({ evalCadenceMs: 20_000, monitorDefaults: { coach: true, factcheck: false } });
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);

    _resetSettingsCache();
    const s = getSettings();
    expect(s.evalCadenceMs).toBe(20_000);
    expect(s.monitorDefaults.coach).toBe(true);

    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'));
    expect(onDisk.evalCadenceMs).toBe(20_000);
  });

  it('clamps out-of-range values', () => {
    const s = updateSettings({ evalCadenceMs: 1, suggestionTtlMs: 999_999_999, retentionDays: 2 });
    expect(s.evalCadenceMs).toBe(10_000); // min clamp
    expect(s.suggestionTtlMs).toBe(300_000); // max clamp
    expect(s.retentionDays).toBe(7); // min clamp
  });

  it('falls back to defaults on a corrupt settings file', () => {
    writeFileSync(join(dir, 'settings.json'), '{not json', 'utf-8');
    _resetSettingsCache();
    const s = getSettings();
    expect(s.evalCadenceMs).toBe(15_000);
  });

  it('partial monitorDefaults update preserves the other flag', () => {
    updateSettings({ monitorDefaults: { coach: true, factcheck: false } });
    const s = updateSettings({ monitorDefaults: { factcheck: true } as any });
    expect(s.monitorDefaults).toEqual({ coach: true, factcheck: true });
  });
});

describe('settings application points', () => {
  it('registry honors setSuggestionTtl for new suggestions', async () => {
    const registry = new WorkerRegistry();
    registry.setSuggestionTtl(50); // 50ms
    const action = registry.suggest({
      type: 'research',
      title: 'Short lived suggestion',
      description: '',
      triggerQuote: '',
      estimatedDurationSec: 5,
      params: { q: 'ttl' },
    })!;
    expect(action.state).toBe('suggested');
    await new Promise((r) => setTimeout(r, 120));
    expect(action.state).toBe('expired');
  });

  it('intelligence setEvalCadence updates the base interval', () => {
    const engine = new IntelligenceEngine();
    engine.setEvalCadence(30_000);
    expect((engine as any).baseEvalIntervalMs).toBe(30_000);
    engine.setEvalCadence(0); // invalid → ignored
    expect((engine as any).baseEvalIntervalMs).toBe(30_000);
  });
});
