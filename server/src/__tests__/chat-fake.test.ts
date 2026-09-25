import { describe, expect, it } from 'vitest';
import { e2eFakeChatEnabled, fakeChatAnswerer, FAKE_CHAT_SLOW_MARKER } from '../chat/fake.js';

function request(user: string, signal = new AbortController().signal, deltas: string[] = []) {
  return {
    system: 'CHAT RULES\n\n# The meeting\nTitle: Northwind weekly with Rory\nAttendees: Rory',
    history: [],
    user,
    signal,
    onDelta: (t: string) => deltas.push(t),
    label: 'chat',
  };
}

describe('e2eFakeChatEnabled', () => {
  it('needs the flag', () => {
    expect(e2eFakeChatEnabled({}, '/tmp/mce2e-x', '/Users/me')).toBe(false);
    expect(e2eFakeChatEnabled({ COPILOT_E2E_FAKE_CHAT: '0' }, '/tmp/mce2e-x', '/Users/me')).toBe(false);
  });

  it('is refused under the real home, however it is spelled', () => {
    expect(e2eFakeChatEnabled({ COPILOT_E2E_FAKE_CHAT: '1' }, '/Users/me', '/Users/me')).toBe(false);
    expect(e2eFakeChatEnabled({ COPILOT_E2E_FAKE_CHAT: '1' }, '/Users/me/', '/Users/me')).toBe(false);
    expect(e2eFakeChatEnabled({ COPILOT_E2E_FAKE_CHAT: '1' }, '/Users/me/x/..', '/Users/me')).toBe(false);
  });

  it('is on under a temporary home', () => {
    expect(e2eFakeChatEnabled({ COPILOT_E2E_FAKE_CHAT: '1' }, '/tmp/mce2e-x', '/Users/me')).toBe(true);
  });
});

describe('fakeChatAnswerer', () => {
  it('streams a reply naming the meeting it was handed', async () => {
    const deltas: string[] = [];
    const out = await fakeChatAnswerer()(request('What was decided?', undefined, deltas));
    expect(out.text).toContain('"Northwind weekly with Rory"');
    expect(deltas.join('')).toBe(out.text);
    expect(deltas.length).toBeGreaterThan(3);
    expect(out).toMatchObject({ sources: [], via: 'e2e-fake' });
  });

  it('ends quietly on abort with what it streamed, as the openai SDK does', async () => {
    const abort = new AbortController();
    const deltas: string[] = [];
    const pending = fakeChatAnswerer()(request(`Go ${FAKE_CHAT_SLOW_MARKER}`, abort.signal, deltas));
    await new Promise((r) => setTimeout(r, 400));
    abort.abort();
    const out = await pending;
    expect(deltas.length).toBeGreaterThan(0);
    expect(out.text).toBe(deltas.join(''));
    expect(out.text.length).toBeLessThan(200);
  });
});
