import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// scripts/*.sh run under macOS's /bin/bash 3.2, which reads a variable's name
// on through the first byte of a multibyte character: "$VERSION…" asks for a
// variable named VERSION plus 0xE2, which is never set. Under `set -u` that
// aborts the script, and with an EXIT trap bash 3.2 then exits 0, so a release
// or a capture self-test that died half-way read as a success (T230,
// 2026-10-02). Write ${VERSION}… instead. The scripts' EXIT traps now turn an
// unfinished run into exit 1 as well; this keeps the trigger out.
const SCRIPTS_DIR = fileURLToPath(new URL('../../../scripts', import.meta.url));
const UNBRACED_BEFORE_NON_ASCII = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;

describe('shell scripts', () => {
  const scripts = readdirSync(SCRIPTS_DIR).filter((name) => name.endsWith('.sh'));

  it('finds the scripts', () => {
    expect(scripts).toContain('ship.sh');
    expect(scripts).toContain('release.sh');
  });

  it.each(scripts)('%s never puts an unbraced $VAR right before a non-ASCII character', (name) => {
    const offending = readFileSync(join(SCRIPTS_DIR, name), 'utf8')
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter(({ text }) => !text.trimStart().startsWith('#') && UNBRACED_BEFORE_NON_ASCII.test(text));
    expect(offending).toEqual([]);
  });
});
