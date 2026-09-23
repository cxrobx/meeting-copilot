import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokProvider } from '../transcription/grok.js';
import { FallbackProvider } from '../transcription/fallback.js';
import { createProvider, resolveTranscription } from '../transcription/index.js';
import type { TranscriptionProvider, TranscriptionProviderInfo } from '../transcription/types.js';

function stub(mode: TranscriptionProviderInfo['mode'], transcribe: TranscriptionProvider['transcribe']): TranscriptionProvider {
  return {
    transcribe,
    isAvailable: async () => true,
    getInfo: () => ({
      mode,
      supportsPrompt: false,
      supportsKeyterms: false,
      supportsPartials: false,
      streaming: false,
      supportsDiarization: false,
      audioStorage: 'memory-only',
    }),
  };
}

const ENV_KEYS = [
  'TRANSCRIPTION_PROVIDER',
  'COPILOT_CLOUD_TRANSCRIPTION',
  'COPILOT_ALLOW_CLOUD_AUDIO',
  'COPILOT_DISABLE_PAID_API',
  'XAI_API_KEY',
  'DEEPGRAM_API_KEY',
  'COPILOT_GROK_STREAMING',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('GrokProvider', () => {
  it('posts multipart to /v1/stt with key terms and the file last', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: '  hello Marcus  ', language: 'en', duration: 1 }), { status: 200 }),
    );
    const out = await new GrokProvider('k').transcribe(Buffer.from('RIFF'), { prompt: 'Marcus, Atlas IQ;\nACME' });

    expect(out.text).toBe('hello Marcus');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/stt');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const form = init!.body as FormData;
    expect(form.get('model')).toBe('grok-voice-transcribe-2.0');
    expect(form.get('language')).toBe('en');
    expect(form.getAll('keyterm')).toEqual(['Marcus', 'Atlas IQ', 'ACME']);
    expect([...form.keys()].at(-1)).toBe('file');
  });

  it('throws on a non-2xx so the fallback can take over', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }));
    await expect(new GrokProvider('k').transcribe(Buffer.from('RIFF'))).rejects.toThrow(/429/);
  });
});

describe('FallbackProvider', () => {
  it('uses the local backend when the cloud fails, then skips the cloud during cooldown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 0;
    const cloud = vi.fn(async () => { throw new Error('down'); });
    const local = vi.fn(async () => ({ text: 'local' }));
    const p = new FallbackProvider(stub('grok', cloud), stub('parakeet', local), 60_000, () => now);

    expect(await p.transcribe(Buffer.alloc(0))).toEqual({ text: 'local', mode: 'parakeet' });
    now = 30_000;
    await p.transcribe(Buffer.alloc(0));
    expect(cloud).toHaveBeenCalledTimes(1);
    now = 61_000;
    await p.transcribe(Buffer.alloc(0));
    expect(cloud).toHaveBeenCalledTimes(2);
  });

  it('reports which backend produced the text', async () => {
    const p = new FallbackProvider(stub('grok', async () => ({ text: 'cloud' })), stub('parakeet', async () => ({ text: 'x' })));
    expect(await p.transcribe(Buffer.alloc(0))).toEqual({ text: 'cloud', mode: 'grok' });
    expect(p.getInfo()).toMatchObject({ mode: 'grok', fallback: 'parakeet' });
  });
});

describe('createProvider gating', () => {
  function build() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    return createProvider().getInfo();
  }

  it('defaults to streaming Grok, with Parakeet taking the chunks', () => {
    process.env.TRANSCRIPTION_PROVIDER = 'parakeet';
    process.env.COPILOT_ALLOW_CLOUD_AUDIO = 'true';
    process.env.XAI_API_KEY = 'k';
    delete process.env.COPILOT_CLOUD_TRANSCRIPTION;
    delete process.env.COPILOT_DISABLE_PAID_API;
    delete process.env.COPILOT_GROK_STREAMING;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const plan = resolveTranscription();
    expect(plan.streaming?.info).toMatchObject({ mode: 'grok', streaming: true, supportsPartials: true });
    expect(plan.provider.getInfo().mode).toBe('parakeet');
  });

  it('COPILOT_GROK_STREAMING=0 goes back to per-chunk Grok in front of Parakeet', () => {
    process.env.TRANSCRIPTION_PROVIDER = 'parakeet';
    process.env.COPILOT_ALLOW_CLOUD_AUDIO = 'true';
    process.env.XAI_API_KEY = 'k';
    process.env.COPILOT_GROK_STREAMING = '0';
    delete process.env.COPILOT_CLOUD_TRANSCRIPTION;
    delete process.env.COPILOT_DISABLE_PAID_API;
    expect(build()).toMatchObject({ mode: 'grok', fallback: 'parakeet' });
  });

  it('stays local without explicit consent', () => {
    process.env.TRANSCRIPTION_PROVIDER = 'parakeet';
    delete process.env.COPILOT_ALLOW_CLOUD_AUDIO;
    process.env.XAI_API_KEY = 'k';
    expect(build().mode).toBe('parakeet');
  });

  it('stays local under the paid-API kill switch', () => {
    process.env.TRANSCRIPTION_PROVIDER = 'parakeet';
    process.env.COPILOT_ALLOW_CLOUD_AUDIO = 'true';
    process.env.XAI_API_KEY = 'k';
    process.env.COPILOT_DISABLE_PAID_API = '1';
    expect(build().mode).toBe('parakeet');
    expect(resolveTranscription().streaming).toBeNull();
  });

  it('stays local without a key, or when cloud is off', () => {
    process.env.TRANSCRIPTION_PROVIDER = 'parakeet';
    process.env.COPILOT_ALLOW_CLOUD_AUDIO = 'true';
    delete process.env.COPILOT_DISABLE_PAID_API;
    delete process.env.XAI_API_KEY;
    expect(build().mode).toBe('parakeet');
    process.env.XAI_API_KEY = 'k';
    process.env.COPILOT_CLOUD_TRANSCRIPTION = 'off';
    expect(build().mode).toBe('parakeet');
  });

  it('still honours an explicit deepgram selection', () => {
    process.env.TRANSCRIPTION_PROVIDER = 'deepgram';
    process.env.COPILOT_ALLOW_CLOUD_AUDIO = 'true';
    process.env.DEEPGRAM_API_KEY = 'k';
    delete process.env.COPILOT_DISABLE_PAID_API;
    expect(build()).toMatchObject({ mode: 'deepgram', fallback: 'whisper-server' });
  });
});
