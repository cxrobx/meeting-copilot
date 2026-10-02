import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Node 24.19+ aborts the process (SIGABRT, `Assertion failed: (env) != nullptr`
// in node::RemoveEnvironmentCleanupHook) when V8's garbage collector frees a
// better-sqlite3 11.x or 12.x statement: their node::ObjectWrap destructor runs
// with no context entered (nodejs/node#65446). On 2026-10-02 it killed the
// packaged server as a meeting started, a few hours after T230 pinned Node 24.
// 13.x is built on Node-API and has no such destructor. A GC soak did not
// reproduce the abort on demand, so the check is the version pair itself.
const require = createRequire(import.meta.url);
const FETCH_NODE = fileURLToPath(new URL('../../../scripts/fetch-node.sh', import.meta.url));

function major(version: string): number {
  return Number(version.replace(/^v/, '').split('.')[0]);
}

describe('better-sqlite3 under the pinned Node', () => {
  it('is a release that survives Node 24 garbage collection', () => {
    const pinned = /^NODE_VERSION="?(v?[\d.]+)"?/m.exec(readFileSync(FETCH_NODE, 'utf8'))?.[1];
    expect(pinned, 'NODE_VERSION in scripts/fetch-node.sh').toBeTruthy();
    const sqlite = (require('better-sqlite3/package.json') as { version: string }).version;
    if (major(pinned!) >= 24) expect(major(sqlite)).toBeGreaterThanOrEqual(13);
  });

  it('loads and runs under this Node', () => {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(':memory:');
    expect(db.prepare('select 1 as x').get()).toEqual({ x: 1 });
    db.close();
  });
});
