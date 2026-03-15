import { claudeSuggest } from '../claude-cli.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';

export class AnalysisWorker implements Worker {
  public readonly name = 'analysis';
  public readonly capabilities: WorkerCapabilities = {
    network: 'anthropic-only',
    filesystem: { read: [], write: [] },
    subprocess: false,
    maxDurationMs: 90_000,
    maxMemoryMB: 100,
  };

  async execute(
    params: Record<string, any>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const topic = params.topic as string | undefined;
    const context = params.context as string | undefined;
    const compareOptions = params.compareOptions as string[] | undefined;

    if (!topic) {
      return {
        success: false,
        data: null,
        summary: 'No topic provided for analysis',
        error: 'Missing required param: topic',
      };
    }

    if (signal.aborted) {
      return {
        success: false,
        data: null,
        summary: 'Analysis cancelled before start',
        error: 'Aborted',
      };
    }

    try {
      const systemPrompt = `You are an analytical assistant helping during a live meeting. Provide structured, balanced analysis with clear reasoning. Use markdown formatting.

Structure your analysis as:
## Analysis: [Topic]
### Context
Brief context summary
### Key Findings
Numbered points with evidence/reasoning
### Comparison (if applicable)
Table or structured comparison of options
### Recommendation
Clear recommendation with rationale
### Caveats
Important limitations or unknowns`;

      let userContent = `Analyze the following topic: ${topic}`;
      if (context) {
        userContent += `\n\nMeeting context:\n${context}`;
      }
      if (compareOptions && compareOptions.length > 0) {
        userContent += `\n\nOptions to compare:\n${compareOptions.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
      }

      const text = await claudeSuggest(userContent, systemPrompt, signal);

      if (signal.aborted) {
        return {
          success: false,
          data: null,
          summary: 'Analysis cancelled during execution',
          error: 'Aborted',
        };
      }

      return {
        success: true,
        data: { topic, analysis: text },
        summary: `Analysis completed for: ${topic}`,
        artifacts: [
          {
            type: 'markdown',
            content: text,
            title: `Analysis: ${topic}`,
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        summary: `Analysis failed: ${message}`,
        error: message,
      };
    }
  }
}
