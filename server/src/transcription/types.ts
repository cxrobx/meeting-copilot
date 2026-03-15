export interface TranscriptSegment {
  id: string;
  text: string;
  source: 'mic' | 'meeting';
  label: string; // '[You]' or '[Meeting]'
  timestamp: number;
  duration: number;
  wordCount: number;
}

export interface TranscriptionProvider {
  transcribe(wavBuffer: Buffer): Promise<{ text: string }>;
  isAvailable(): Promise<boolean>;
}
