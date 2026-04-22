/**
 * Shared audio chunk configuration.
 *
 * These constants MUST stay in sync with Swift-side constants in
 * `app/MeetingCopilot/Sources/Core/Audio/AudioCaptureManager.swift`
 * (`chunkDurationSeconds`, `chunkOverlapSeconds`). Replay tooling reads
 * from here so latency comparisons against production are apples-to-apples.
 */

export const CHUNK_DURATION_SECONDS = 4;
export const CHUNK_OVERLAP_SECONDS = 1;
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2; // 16-bit PCM
export const CHANNELS = 1;

export const BYTES_PER_CHUNK =
  CHUNK_DURATION_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS;
