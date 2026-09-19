import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROJECTS_DIR = join(homedir(), 'Projects');
const XCODE_DIR = join(PROJECTS_DIR, 'xcode');
// Client engagements live OUTSIDE ~/Projects. Leaving this out meant the start
// form could not offer globex / acme / impact at all — and 5 of the 10 recorded
// sessions were Globex meetings, so half the real meeting history had no project
// to attach. Added 2026-09-19.
const CLIENTS_DIR = join(homedir(), 'clients');
const BRIEF_MAX_CHARS = 4000;

export type ProjectCategory = 'project' | 'xcode' | 'client';

export interface ProjectInfo {
  name: string;
  path: string;
  category: ProjectCategory;
}

export interface ProjectContext {
  name: string;
  path: string;
  brief: string;
  fileTree: string;
}

/**
 * Every immediate subdirectory of `dir` that carries a CLAUDE.md, which is what
 * marks a directory as a real project rather than scratch space.
 */
function scanRoot(
  dir: string,
  category: ProjectCategory,
  skip: (name: string) => boolean = () => false,
): ProjectInfo[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !skip(entry.name))
      .map((entry) => ({ name: entry.name, path: join(dir, entry.name), category }))
      .filter((info) => existsSync(join(info.path, 'CLAUDE.md')));
  } catch {
    return []; // Best effort — an unreadable root must not break the others.
  }
}

export function scanProjects(): ProjectInfo[] {
  const found = [
    ...scanRoot(PROJECTS_DIR, 'project', (name) => name === 'xcode'),
    ...scanRoot(XCODE_DIR, 'xcode'),
    ...scanRoot(CLIENTS_DIR, 'client'),
  ];

  // Dedupe by path: a symlinked or nested root could otherwise list one project
  // twice, and the picker would show two identical-looking rows.
  const byPath = new Map<string, ProjectInfo>();
  for (const info of found) {
    if (!byPath.has(info.path)) byPath.set(info.path, info);
  }

  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
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
