import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isJevAvailable, redactForJev, noul, jevAsk } from '../api/jev.js';
import { jevMomentGate, alwaysOpenGate } from '../intelligence/moment-gate.js';
import { resetLlmBudget, setLlmBudgetExceededHandler, getLlmBudgetSnapshot } from '../api/budget.js';

const KEY = 'TYPESAFE_API_KEY';
const KILL = 'COPILOT_DISABLE_PAID_API';

function jevResponse(answers: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: 'jev-latest', answers, usage: { input_tokens: 900, output_tokens: 60 } }),
    text: async () => '',
  } as unknown as Response;
}

const nouls = (worth: number, asked: number, pushback: number) => ({
  worth_coaching: { type: 'noul', noul: worth },
  asked_of_user: { type: 'noul', noul: asked },
  needs_pushback: { type: 'noul', noul: pushback },
});

const TAIL = '[Meeting] So would you also develop that out for us as well?\n[You] Uh, I would need to check the scope on that.';

describe('jev availability gates', () => {
  const saved = { key: process.env[KEY], kill: process.env[KILL] };
  beforeEach(() => {
    resetLlmBudget();
    setLlmBudgetExceededHandler(() => {});
  });
  afterEach(() => {
    saved.key === undefined ? delete process.env[KEY] : (process.env[KEY] = saved.key);
    saved.kill === undefined ? delete process.env[KILL] : (process.env[KILL] = saved.kill);
    vi.restoreAllMocks();
  });

  it('is unavailable with no key', () => {
    delete process.env[KEY];
    expect(isJevAvailable()).toBe(false);
  });

  it('is unavailable when the paid-API killswitch is set, even with a key', () => {
    process.env[KEY] = 'sk-test';
    process.env[KILL] = '1';
    expect(isJevAvailable()).toBe(false);
  });

  it('sends NOTHING when the killswitch is set', async () => {
    process.env[KEY] = 'sk-test';
    process.env[KILL] = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(jevAsk('some transcript text', {})).rejects.toThrow(/paid API disabled/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends NOTHING when no key is present', async () => {
    delete process.env[KEY];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(jevAsk('some transcript text', {})).rejects.toThrow(/TYPESAFE_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('redaction before anything leaves the machine', () => {
  it('strips credential-shaped and identifying strings', () => {
    const out = redactForJev(
      'mail bob@example.com key sk-abcdefghijklmnop id 550e8400-e29b-41d4-a716-446655440000 acct 12345678 password: hunter2',
    );
    expect(out).not.toContain('bob@example.com');
    expect(out).not.toContain('sk-abcdefghijklmnop');
    expect(out).not.toContain('550e8400');
    expect(out).not.toContain('12345678');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('<email>');
  });

  it('redacts the state actually sent over the wire', async () => {
    process.env[KEY] = 'sk-test';
    delete process.env[KILL];
    resetLlmBudget();
    setLlmBudgetExceededHandler(() => {});
    let sentBody = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      sentBody = String((init as RequestInit).body);
      return jevResponse(nouls(0.1, 0.1, 0.1));
    });
    await jevAsk('reach me at bob@example.com', { worth: { type: 'noul', instructions: 'x' } } as never);
    expect(sentBody).not.toContain('bob@example.com');
    expect(sentBody).toContain('<email>');
    vi.restoreAllMocks();
  });

  it('leaves ordinary meeting speech alone', () => {
    expect(redactForJev(TAIL)).toBe(TAIL);
  });
});

describe('moment gate composition', () => {
  const saved = { key: process.env[KEY], kill: process.env[KILL] };
  beforeEach(() => {
    process.env[KEY] = 'sk-test';
    delete process.env[KILL];
    resetLlmBudget();
    setLlmBudgetExceededHandler(() => {});
  });
  afterEach(() => {
    saved.key === undefined ? delete process.env[KEY] : (process.env[KEY] = saved.key);
    saved.kill === undefined ? delete process.env[KILL] : (process.env[KILL] = saved.kill);
    vi.restoreAllMocks();
  });

  it('closes only when every signal is quiet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jevResponse(nouls(0.1, 0.05, 0.05)));
    const v = await jevMomentGate(TAIL);
    expect(v.open).toBe(false);
    expect(v.reason).toBe('quiet');
  });

  it('opens on ANY single signal — a question to the user is enough', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jevResponse(nouls(0.1, 0.92, 0.05)));
    expect((await jevMomentGate(TAIL)).open).toBe(true);
  });

  it('opens on pushback alone (the scope-expansion case)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jevResponse(nouls(0.2, 0.2, 0.53)));
    expect((await jevMomentGate(TAIL)).open).toBe(true);
  });

  // The gate may only ever SAVE a call. Every failure mode must let the
  // generative path run, or coaching goes silent for a reason nobody can see.
  it('fails OPEN when the request errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const v = await jevMomentGate(TAIL);
    expect(v.open).toBe(true);
    expect(v.reason).toBe('error');
  });

  it('fails OPEN on a non-200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    } as unknown as Response);
    expect((await jevMomentGate(TAIL)).open).toBe(true);
  });

  it('fails OPEN when the answers are unreadable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jevResponse({ worth_coaching: { type: 'choice', choice: 'x' } }));
    const v = await jevMomentGate(TAIL);
    expect(v.open).toBe(true);
    expect(v.reason).toBe('unparsed');
  });

  it('fails OPEN when Jev is unavailable, without calling out', async () => {
    delete process.env[KEY];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const v = await jevMomentGate(TAIL);
    expect(v.open).toBe(true);
    expect(v.reason).toBe('unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails OPEN when the budget ceiling is already spent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (let i = 0; i < 500; i++) {
      try {
        // burn the request ceiling
        (await import('../api/budget.js')).beginLlmRequest();
      } catch {
        break;
      }
    }
    const v = await jevMomentGate(TAIL);
    expect(v.open).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('counts its spend against the session budget', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jevResponse(nouls(0.9, 0.9, 0.9)));
    await jevMomentGate(TAIL);
    const snap = getLlmBudgetSnapshot();
    expect(snap.requests).toBe(1);
    expect(snap.tokens).toBe(960);
    expect(snap.estimatedDollars).toBeGreaterThan(0);
  });

  it('does not call out for a too-short tail', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const v = await jevMomentGate('hi');
    expect(v.open).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('alwaysOpenGate is the pre-existing behaviour', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await alwaysOpenGate(TAIL)).open).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('noul reader', () => {
  it('returns null for a missing or mistyped answer', () => {
    expect(noul({}, 'x')).toBeNull();
    expect(noul({ x: { type: 'choice', choice: 'a', probabilities: {}, confidence: 1 } }, 'x')).toBeNull();
    expect(noul({ x: { type: 'noul', noul: 0.42 } }, 'x')).toBe(0.42);
  });
});
