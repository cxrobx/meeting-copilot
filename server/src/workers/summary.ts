import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { claudeSuggest } from '../claude-cli.js';
import { getSettings } from '../settings.js';
import { buildMeetingFilename, formatMeetingDate } from './filename.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';

export class SummaryWorker implements Worker {
  public readonly name = 'summary';
  public readonly capabilities: WorkerCapabilities = {
    network: 'anthropic-only',
    filesystem: {
      read: [],
      write: ['~/Documents/CX/Meetings/**'],
    },
    subprocess: false,
    // Generous safety cap (~15 min): jobs run until done or the user cancels.
    maxDurationMs: 900_000,
    maxMemoryMB: 50,
  };

  async execute(
    params: Record<string, any>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const transcript = params.transcript as string | undefined;
    const scope = (params.scope as string) ?? 'full';
    const focus = params.focus as string | undefined;
    const title = params.title as string | undefined;
    const startedAt = params.startedAt as number | string | undefined;
    const attendees = params.attendees as string | undefined;

    if (!transcript) {
      return {
        success: false,
        data: null,
        summary: 'No transcript provided for summary',
        error: 'Missing required param: transcript',
      };
    }

    if (signal.aborted) {
      return {
        success: false,
        data: null,
        summary: 'Summary cancelled before start',
        error: 'Aborted',
      };
    }

    try {
      const systemPrompt = `You generate structured meeting notes from transcripts. Output well-formatted markdown with these sections:

# Meeting Notes - [Title/Date]

## Key Discussion Points
- Bullet points of main topics

## Decisions Made
- Any decisions reached

## Action Items
- [ ] Specific action items with owners if mentioned

## Open Questions
- Unresolved questions or follow-ups needed

## Summary
Brief 2-3 sentence summary of the meeting.

Be concise but thorough. Focus on substance, not filler.`;

      let userContent = `Generate meeting notes from this transcript:\n\n${transcript}`;
      if (scope === 'recent') {
        userContent = `Generate meeting notes focusing on the most recent discussion:\n\n${transcript}`;
      }
      if (focus) {
        userContent += `\n\nFocus particularly on: ${focus}`;
      }

      const onDelta = params._onDelta as ((text: string) => void) | undefined;
      const markdown = await claudeSuggest(userContent, systemPrompt, signal, undefined, { onDelta });

      if (signal.aborted) {
        return {
          success: false,
          data: null,
          summary: 'Summary cancelled during execution',
          error: 'Aborted',
        };
      }

      // Local time, from the meeting's own start — NEVER toISOString(), which
      // renders UTC and rolls an evening ET meeting onto the next day.
      const dateStr = formatMeetingDate(startedAt);

      // Auto-write to ~/Documents/CX/Meetings only when enabled in settings —
      // the artifact below is returned (and persisted with the session) either way.
      let filePath: string | null = null;
      if (getSettings().summaryAutoWrite) {
        // `<CATEGORY> <Who|Topic> <MM.DD.YY>.md` — see ~/Documents/CX/CLAUDE.md.
        // Stays in `Meetings/`: routing the note to a client folder would mean
        // widening this worker's write sandbox to the whole vault, and
        // notes4chris already owns filing.
        const filename = buildMeetingFilename({ title, attendees, startedAt });

        const meetingsDir = join(homedir(), 'Documents', 'CX', 'Meetings');
        await mkdir(meetingsDir, { recursive: true });

        filePath = join(meetingsDir, filename);
        await writeFile(filePath, markdown, 'utf-8');
      }

      return {
        success: true,
        data: { markdown, filePath },
        summary: filePath
          ? `Meeting notes saved to ${filePath}`
          : 'Meeting notes generated (auto-save to Documents is off)',
        artifacts: [
          {
            type: 'markdown',
            content: markdown,
            title: `Meeting Notes - ${dateStr}`,
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        summary: `Summary generation failed: ${message}`,
        error: message,
      };
    }
  }
}
