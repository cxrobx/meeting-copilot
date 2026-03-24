import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

// ─── Constants ─────────────────────────────────────────────────────────────

const COPILOT_DIR = join(homedir(), '.meeting-copilot');
const CONFIG_PATH = join(COPILOT_DIR, 'context-sources.json');
const LEGACY_CONFIG_PATH = join(COPILOT_DIR, 'context-dirs.json');
const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);
const DOC_MAX_CHARS = 8000;
const MAX_DOCS_PER_DIR = 20;
const MANIFEST_MAX_CHARS = 2000;
const CONTEXT_BLOCK_MAX_CHARS = 8000;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ContextItemConfig {
  path: string;
  label?: string;
  type: 'file' | 'folder';
}

/** @deprecated Use ContextItemConfig instead */
export interface ContextDirConfig {
  path: string;
  label?: string;
}

export interface ContextDoc {
  name: string;
  relativePath: string;
  dirPath: string;
  content: string;
  firstLine: string;
  sizeChars: number;
}

export interface ContextItemInfo {
  path: string;
  label: string;
  type: 'file' | 'folder';
  fileCount: number;
}

// ─── Config Persistence ────────────────────────────────────────────────────

function ensureCopilotDir(): void {
  if (!existsSync(COPILOT_DIR)) {
    mkdirSync(COPILOT_DIR, { recursive: true });
  }
}

export function loadContextConfig(): ContextItemConfig[] {
  // Try new config first
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (d: any) => typeof d.path === 'string' && d.path.length > 0,
      );
    } catch {
      return [];
    }
  }

  // Migrate legacy config (context-dirs.json → context-sources.json)
  if (existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const raw = readFileSync(LEGACY_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const migrated: ContextItemConfig[] = parsed
        .filter((d: any) => typeof d.path === 'string' && d.path.length > 0)
        .map((d: any) => ({ path: d.path, label: d.label, type: 'folder' as const }));
      // Write migrated config
      saveContextConfig(migrated);
      return migrated;
    } catch {
      return [];
    }
  }

  return [];
}

/** @deprecated Use loadContextConfig instead */
export function loadContextDirConfig(): ContextDirConfig[] {
  return loadContextConfig();
}

export function saveContextConfig(items: ContextItemConfig[]): void {
  ensureCopilotDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(items, null, 2), 'utf-8');
}

/** @deprecated Use saveContextConfig instead */
export function saveContextDirConfig(dirs: ContextDirConfig[]): void {
  const items: ContextItemConfig[] = dirs.map((d) => ({
    path: d.path,
    label: d.label,
    type: 'folder' as const,
  }));
  saveContextConfig(items);
}

export function addContextItem(item: ContextItemConfig): ContextItemConfig[] {
  const items = loadContextConfig();
  // Dedup by path
  if (items.some((i) => i.path === item.path)) {
    return items;
  }
  items.push(item);
  saveContextConfig(items);
  return items;
}

export function removeContextItem(path: string): ContextItemConfig[] {
  const items = loadContextConfig().filter((i) => i.path !== path);
  saveContextConfig(items);
  return items;
}

// ─── Item Info ─────────────────────────────────────────────────────────────

export function getContextItemInfo(item: ContextItemConfig): ContextItemInfo {
  const label = item.label ?? basename(item.path);

  if (item.type === 'file') {
    const readable = existsSync(item.path) &&
      SUPPORTED_EXTENSIONS.has(extname(item.path).toLowerCase());
    return {
      path: item.path,
      label,
      type: 'file',
      fileCount: readable ? 1 : 0,
    };
  }

  // folder
  const docs = scanContextDir(item.path);
  return {
    path: item.path,
    label,
    type: 'folder',
    fileCount: docs.length,
  };
}

// ─── File Reading ──────────────────────────────────────────────────────────

function readDocFile(filePath: string, dirPath: string, name: string): ContextDoc | null {
  try {
    let raw = readFileSync(filePath, 'utf-8');
    const sizeChars = raw.length;
    if (raw.length > DOC_MAX_CHARS) {
      raw = raw.slice(0, DOC_MAX_CHARS) + '\n\n[...truncated]';
    }
    const firstLine = raw.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
    return {
      name,
      relativePath: filePath.slice(dirPath.length + 1),
      dirPath,
      content: raw,
      firstLine: firstLine.replace(/^#+\s*/, '').slice(0, 120), // Strip markdown heading prefix
      sizeChars,
    };
  } catch {
    return null; // Skip unreadable files (encoding issues, permissions)
  }
}

export function loadContextFile(filePath: string): ContextDoc | null {
  if (!existsSync(filePath)) return null;
  if (!SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase())) return null;
  const dir = dirname(filePath);
  const name = basename(filePath);
  return readDocFile(filePath, dir, name);
}

// ─── Directory Scanning ────────────────────────────────────────────────────

export function scanContextDir(dirPath: string): ContextDoc[] {
  if (!existsSync(dirPath)) return [];

  const docs: Array<{ doc: ContextDoc; mtime: number }> = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const doc = readDocFile(fullPath, dirPath, entry.name);
        if (doc) {
          const mtime = statSync(fullPath).mtimeMs;
          docs.push({ doc, mtime });
        }
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        // One level of subdirectories
        try {
          const subEntries = readdirSync(fullPath, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isFile() && SUPPORTED_EXTENSIONS.has(extname(subEntry.name).toLowerCase())) {
              const subPath = join(fullPath, subEntry.name);
              const doc = readDocFile(subPath, dirPath, `${entry.name}/${subEntry.name}`);
              if (doc) {
                const mtime = statSync(subPath).mtimeMs;
                docs.push({ doc, mtime });
              }
            }
          }
        } catch {
          // Skip unreadable subdirectories
        }
      }
    }
  } catch {
    return [];
  }

  // Sort by modification time (newest first), cap at limit
  docs.sort((a, b) => b.mtime - a.mtime);
  return docs.slice(0, MAX_DOCS_PER_DIR).map((d) => d.doc);
}

// ─── Loading ───────────────────────────────────────────────────────────────

export function loadContextDocs(items: ContextItemConfig[]): ContextDoc[] {
  const allDocs: ContextDoc[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (item.type === 'file') {
      const doc = loadContextFile(item.path);
      if (doc && !seen.has(item.path)) {
        seen.add(item.path);
        allDocs.push(doc);
      }
    } else {
      const docs = scanContextDir(item.path);
      for (const doc of docs) {
        const key = `${doc.dirPath}/${doc.relativePath}`;
        if (!seen.has(key)) {
          seen.add(key);
          allDocs.push(doc);
        }
      }
    }
  }

  return allDocs;
}

// ─── Formatting ────────────────────────────────────────────────────────────

/**
 * Compact manifest for Haiku triage — file names + first-line summaries.
 * Capped at MANIFEST_MAX_CHARS to keep the triage prompt lean.
 */
export function buildContextManifest(docs: ContextDoc[]): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (const doc of docs) {
    const line = `- ${doc.name}: ${doc.firstLine}`;
    if (totalChars + line.length + 1 > MANIFEST_MAX_CHARS) break;
    lines.push(line);
    totalChars += line.length + 1;
  }

  return lines.join('\n');
}

/**
 * Full context block for Sonnet suggestions and workers.
 * Selects top docs by keyword relevance to the hint, or most recent if no hint.
 * Capped at CONTEXT_BLOCK_MAX_CHARS.
 */
export function buildContextBlock(docs: ContextDoc[], relevanceHint?: string): string {
  let ranked: ContextDoc[];

  if (relevanceHint && relevanceHint.length > 0) {
    // Score docs by keyword overlap with the relevance hint
    const hintWords = new Set(
      relevanceHint.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
    );

    const scored = docs.map((doc) => {
      const docText = `${doc.name} ${doc.firstLine} ${doc.content}`.toLowerCase();
      let score = 0;
      for (const word of hintWords) {
        if (docText.includes(word)) score++;
      }
      return { doc, score };
    });

    scored.sort((a, b) => b.score - a.score);
    ranked = scored.map((s) => s.doc);
  } else {
    ranked = docs; // Already sorted by mtime from scanContextDir
  }

  const blocks: string[] = [];
  let totalChars = 0;
  const maxDocs = 3;

  for (const doc of ranked.slice(0, maxDocs)) {
    const block = `### ${doc.name}\n${doc.content}`;
    if (totalChars + block.length > CONTEXT_BLOCK_MAX_CHARS) {
      // Try to fit a truncated version
      const remaining = CONTEXT_BLOCK_MAX_CHARS - totalChars;
      if (remaining > 200) {
        blocks.push(block.slice(0, remaining) + '\n[...truncated]');
      }
      break;
    }
    blocks.push(block);
    totalChars += block.length + 1;
  }

  return blocks.join('\n\n');
}
