/**
 * Noise gate in front of the Grok stream: silence is billed ($0.20/hr per
 * channel, measured per sent audio second), so only speech is sent.
 *
 * Built so the first word is never clipped:
 *   - LOOKAHEAD: while closed, the last `preRollMs` of audio is kept and sent
 *     ahead of the frame that opened the gate, so a soft onset ("s", "f", "h")
 *     below the threshold still reaches Grok.
 *   - HOLD: mid-sentence pauses up to `holdMs` keep the gate open, so words
 *     around a breath are never cut.
 *   - CLOSE → finalize: Grok decides utterance ends from the audio it receives,
 *     so with nothing arriving it would glue the next utterance on. Closing
 *     tells the caller to send `finalize`.
 * Speech too quiet to open it (a whisper-level "yeah") is not transcribed.
 * Replaying three meetings put that at ~0.1% of words, below Grok's own
 * run-to-run variation; routing it to Parakeet instead mostly added duplicates.
 */

export interface GateOptions {
  /** Open this far above the tracked noise floor. */
  openDb?: number;
  /** Absolute floor for the threshold (RMS, 0–1), so digital silence isn't "noise". */
  minRms?: number;
  preRollMs?: number;
  holdMs?: number;
}

export interface GateFrame {
  pcm: Buffer;
  /** Wall-clock ms at which this frame's audio began. */
  at: number;
}

export interface GateResult {
  /** Frames to send now, oldest first (pre-roll + current on open). */
  send: GateFrame[];
  /** The gate just closed: end the utterance. */
  closed: boolean;
}

const FRAME_MS = 100;

export function frameRms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

export class NoiseGate {
  private floor = 0.002;
  private open = false;
  private holdLeft = 0;
  private preRoll: GateFrame[] = [];
  private readonly factor: number;
  private readonly minRms: number;
  private readonly preRollFrames: number;
  private readonly holdFrames: number;

  constructor(opts: GateOptions = {}) {
    this.factor = 10 ** ((opts.openDb ?? 12) / 20);
    this.minRms = opts.minRms ?? 0.004;
    this.preRollFrames = Math.max(0, Math.round((opts.preRollMs ?? 500) / FRAME_MS));
    this.holdFrames = Math.max(1, Math.round((opts.holdMs ?? 1_500) / FRAME_MS));
  }

  get isOpen(): boolean {
    return this.open;
  }

  process(frame: GateFrame): GateResult {
    const rms = frameRms(frame.pcm);
    // Track the noise floor: fall fast toward quiet frames, rise very slowly,
    // so speech never drags the floor up to its own level.
    this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.999 + rms * 0.001;
    const loud = rms > Math.max(this.minRms, this.floor * this.factor);

    if (!this.open) {
      if (!loud) {
        this.preRoll.push(frame);
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        return { send: [], closed: false };
      }
      this.open = true;
      this.holdLeft = this.holdFrames;
      const send = [...this.preRoll, frame];
      this.preRoll = [];
      return { send, closed: false };
    }

    if (loud) {
      this.holdLeft = this.holdFrames;
      return { send: [frame], closed: false };
    }
    this.holdLeft -= 1;
    if (this.holdLeft > 0) return { send: [frame], closed: false };
    this.open = false;
    return { send: [frame], closed: true };
  }

  reset(): void {
    this.open = false;
    this.holdLeft = 0;
    this.preRoll = [];
  }
}
