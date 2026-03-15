import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claudeSuggest } from '../claude-cli.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';

const execFileAsync = promisify(execFile);

const FILE_BLOCK_REGEX = /=== FILE: (.+?) ===\n([\s\S]*?)(?==== END FILE ===|$)/g;

export class CodeGenWorker implements Worker {
  public readonly name = 'codegen';
  public readonly capabilities: WorkerCapabilities = {
    network: 'anthropic-only',
    filesystem: {
      read: [],
      write: ['/tmp/meeting-copilot/**'],
    },
    subprocess: true,
    maxDurationMs: 300_000,
    maxMemoryMB: 300,
  };

  async execute(
    params: Record<string, any>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const task = params.task as string | undefined;
    const context = params.context as string | undefined;
    const language = params.language as string | undefined;
    const framework = params.framework as string | undefined;
    const style = (params.style as string) ?? 'complete';

    if (!task) {
      return {
        success: false,
        data: null,
        summary: 'No task provided for code generation',
        error: 'Missing required param: task',
      };
    }

    if (signal.aborted) {
      return {
        success: false,
        data: null,
        summary: 'Code generation cancelled before start',
        error: 'Aborted',
      };
    }

    try {
      const langHint = language ? `Language: ${language}` : 'Use the most appropriate language for the task.';
      const frameworkHint = framework ? `Framework: ${framework}` : '';

      let styleGuide: string;
      switch (style) {
        case 'scaffold':
          styleGuide = 'Generate a project scaffold with directory structure, config files (package.json/requirements.txt/etc), and stub implementations. Focus on getting the structure right.';
          break;
        case 'snippet':
          styleGuide = 'Generate a single focused function or code snippet. Keep it minimal and self-contained.';
          break;
        default:
          styleGuide = 'Generate a complete, working implementation with all necessary imports, error handling, and types.';
      }

      const systemPrompt = `You are a code generation assistant helping during a live meeting. Generate clean, production-quality code.

${langHint}
${frameworkHint}
${styleGuide}

Output format: Wrap each file in delimiters:

=== FILE: path/filename.ext ===
<file contents>
=== END FILE ===

If generating a single file, still use the delimiters. Include meaningful file paths (e.g., src/routes/api.ts, not just file1.ts).

Important:
- Write clean, well-structured code with appropriate comments
- Include necessary imports and type definitions
- Handle errors appropriately
- Follow conventions for the chosen language/framework`;

      const userContent = context
        ? `Generate code for: ${task}\n\nMeeting context:\n${context}`
        : `Generate code for: ${task}`;

      const text = await claudeSuggest(userContent, systemPrompt, signal);

      if (signal.aborted) {
        return {
          success: false,
          data: null,
          summary: 'Code generation cancelled during execution',
          error: 'Aborted',
        };
      }

      // Parse file blocks
      const files: Array<{ path: string; content: string }> = [];
      let match: RegExpExecArray | null;

      // Reset regex lastIndex
      FILE_BLOCK_REGEX.lastIndex = 0;
      while ((match = FILE_BLOCK_REGEX.exec(text)) !== null) {
        files.push({
          path: match[1]!.trim(),
          content: match[2]!.trim(),
        });
      }

      // Fallback: if no file blocks found, treat entire response as single file
      if (files.length === 0) {
        const ext = language ? getExtension(language) : 'txt';
        files.push({
          path: `generated.${ext}`,
          content: text.trim(),
        });
      }

      // Write files to disk
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputDir = join('/tmp', 'meeting-copilot', 'codegen', timestamp);
      await mkdir(outputDir, { recursive: true });

      for (const file of files) {
        const filePath = join(outputDir, file.path);
        await mkdir(join(filePath, '..'), { recursive: true });
        await writeFile(filePath, file.content, 'utf-8');
      }

      // Optional syntax validation (best-effort, non-blocking)
      const validationNotes = await this.validateFiles(files, outputDir);

      // Build artifacts
      const artifacts: WorkerResult['artifacts'] = files.map((file) => ({
        type: 'code' as const,
        content: file.content,
        title: file.path,
      }));

      if (validationNotes) {
        artifacts.push({
          type: 'text',
          content: validationNotes,
          title: 'Validation Notes',
        });
      }

      return {
        success: true,
        data: { task, files, outputDir },
        summary: `Generated ${files.length} file(s) in ${outputDir}`,
        artifacts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        summary: `Code generation failed: ${message}`,
        error: message,
      };
    }
  }

  private async validateFiles(
    files: Array<{ path: string; content: string }>,
    outputDir: string,
  ): Promise<string | null> {
    const issues: string[] = [];

    for (const file of files) {
      const filePath = join(outputDir, file.path);

      try {
        if (file.path.endsWith('.js') || file.path.endsWith('.mjs')) {
          await execFileAsync('node', ['--check', filePath], { timeout: 5_000 });
        } else if (file.path.endsWith('.py')) {
          await execFileAsync(
            'python3',
            ['-c', `compile(open("${filePath}").read(), "${filePath}", "exec")`],
            { timeout: 5_000 },
          );
        }
      } catch (error: any) {
        const msg = error.stderr?.trim() || error.message;
        issues.push(`${file.path}: ${msg}`);
      }
    }

    return issues.length > 0 ? issues.join('\n') : null;
  }
}

function getExtension(language: string): string {
  const map: Record<string, string> = {
    typescript: 'ts',
    javascript: 'js',
    python: 'py',
    rust: 'rs',
    go: 'go',
    java: 'java',
    swift: 'swift',
    ruby: 'rb',
    html: 'html',
    css: 'css',
    sql: 'sql',
    shell: 'sh',
    bash: 'sh',
  };
  return map[language.toLowerCase()] ?? 'txt';
}
