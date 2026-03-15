import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROJECTS_DIR = join(homedir(), 'Projects');
const XCODE_DIR = join(PROJECTS_DIR, 'xcode');
const BRIEF_MAX_CHARS = 4000;

export interface ProjectInfo {
  name: string;
  path: string;
  category: 'project' | 'xcode';
}

export interface ProjectContext {
  name: string;
  path: string;
  brief: string;
  fileTree: string;
}

export function scanProjects(): ProjectInfo[] {
  const projects: ProjectInfo[] = [];

  // Scan ~/Projects/
  if (existsSync(PROJECTS_DIR)) {
    try {
      for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'xcode') continue;
        const dirPath = join(PROJECTS_DIR, entry.name);
        if (existsSync(join(dirPath, 'CLAUDE.md'))) {
          projects.push({ name: entry.name, path: dirPath, category: 'project' });
        }
      }
    } catch {
      // Best effort
    }
  }

  // Scan ~/Projects/xcode/
  if (existsSync(XCODE_DIR)) {
    try {
      for (const entry of readdirSync(XCODE_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dirPath = join(XCODE_DIR, entry.name);
        if (existsSync(join(dirPath, 'CLAUDE.md'))) {
          projects.push({ name: entry.name, path: dirPath, category: 'xcode' });
        }
      }
    } catch {
      // Best effort
    }
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadProjectContext(name: string): Promise<ProjectContext | null> {
  const projects = scanProjects();
  const project = projects.find((p) => p.name === name);
  if (!project) return null;

  const claudeMdPath = join(project.path, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) return null;

  let brief: string;
  try {
    const raw = readFileSync(claudeMdPath, 'utf-8');
    brief = raw.length > BRIEF_MAX_CHARS
      ? raw.slice(0, BRIEF_MAX_CHARS) + '\n\n[...truncated]'
      : raw;
  } catch {
    return null;
  }

  let fileTree = '';
  try {
    const { stdout } = await execFileAsync('ls', ['-1', project.path]);
    fileTree = stdout.trim();
  } catch {
    fileTree = '(unable to list files)';
  }

  return { name: project.name, path: project.path, brief, fileTree };
}

export function formatProjectBrief(ctx: ProjectContext): string {
  return `## Project: ${ctx.name}
**Path:** ${ctx.path}

${ctx.brief}

### File Structure
${ctx.fileTree}`;
}
