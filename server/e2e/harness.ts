/**
 * Global setup for the ship gate: a throwaway HOME, a seeded meeting, and the
 * server under test on a free port. Returns the teardown.
 *
 * The server gets a hand-built environment, not this process's: no API keys
 * of any kind, a PATH without the `claude` CLI or `wrangler`, transcription
 * pointed at a closed port, and the chat on the scripted answerer. Nothing it
 * does can spend money, use the subscription, or touch the live app.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, type FullConfig } from '@playwright/test';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC_DIR = resolve(E2E_DIR, '..');
const REPO_DIR = resolve(SERVER_SRC_DIR, '..');
const PACKAGED_SERVER = join(REPO_DIR, 'dist', 'Meeting Copilot.app', 'Contents', 'Resources', 'server');
// macOS caps a Unix socket path at 104 bytes; the server binds HOME/.meeting-copilot/copilot.sock.
const SOCKET_PATH_LIMIT = 104;
const CLOSED_PORT_URL = 'http://127.0.0.1:9';

/**
 * The Node to run the server under. A packaged server runs on the app's own
 * Node (Contents/Resources/node, the one ProcessSupervisor spawns), so the
 * gate tests that binary; ship.sh also names it in MC_E2E_NODE. A checkout's
 * server runs on the Node running this test, which is the pinned one under
 * ship.sh and must match the checkout's better-sqlite3 ABI anyway.
 */
export function runtimeNode(serverDir: string): string {
  const named = process.env.MC_E2E_NODE;
  if (named) {
    if (!existsSync(named)) throw new Error(`MC_E2E_NODE names a Node that does not exist: ${named}`);
    return named;
  }
  const bundled = join(serverDir, '..', 'node', 'bin', 'node');
  if (existsSync(bundled)) return bundled;
  return process.execPath;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tail(path: string, lines = 40): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no output)';
  }
}

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const serverDir = resolve(process.env.MC_E2E_SERVER ?? PACKAGED_SERVER);
  const entry = join(serverDir, 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`No server to test at ${entry}. Package it first (./scripts/build-app.sh), or set MC_E2E_SERVER.`);
  }
  const node = runtimeNode(serverDir);
  // Said plainly, rather than as six launch failures.
  if (!existsSync(webkit.executablePath())) {
    throw new Error('Playwright\'s WebKit is not installed. Run: cd server && npx playwright install webkit');
  }

  const home = realpathSync(mkdtempSync('/tmp/mce2e-'));
  if (home === realpathSync(userInfo().homedir)) {
    throw new Error(`Refusing to run: the test HOME resolves to the real home (${home}); the server would unlink the live app's socket.`);
  }
  const copilotDir = join(home, '.meeting-copilot');
  const socketPath = join(copilotDir, 'copilot.sock');
  if (Buffer.byteLength(socketPath) >= SOCKET_PATH_LIMIT) {
    throw new Error(`Test HOME too long for a Unix socket (${socketPath}).`);
  }
  mkdirSync(join(copilotDir, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'tmp'));
  // No coach (it would call a model), no vault look (it would ask Onyx), no
  // summary files: a deterministic dashboard with nothing to spend.
  writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({
    version: 1,
    monitorDefaults: { coach: false, factcheck: false },
    summaryAutoWrite: false,
    matchVaultAppearance: false,
  }, null, 2));
  const evidence = join(home, 'evidence', 'looker.html');
  mkdirSync(dirname(evidence));
  copyFileSync(join(E2E_DIR, 'fixtures', 'looker.html'), evidence);

  const nodeBin = dirname(node);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USER: process.env.USER,
    LANG: 'en_US.UTF-8',
    TMPDIR: join(home, 'tmp'),
    PATH: `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    COPILOT_DISABLE_PAID_API: '1',
    COPILOT_PULSE: '0',
    COPILOT_OPEN_EVIDENCE: '0',
    COPILOT_RESEARCH_DEEP_FOLLOWUP: '0',
    COPILOT_CLOUD_TRANSCRIPTION: 'off',
    COPILOT_E2E_FAKE_CHAT: '1',
    SHARE_TRANSCRIPT: 'false',
    TRANSCRIPTION_PROVIDER: 'parakeet',
    PARAKEET_URL: CLOSED_PORT_URL,
    ONYX_URL: CLOSED_PORT_URL,
  };

  // The seed runs under the same Node and the same server build as the test.
  const seeded = spawnSync(node, ['--import', 'tsx', join(E2E_DIR, 'seed.ts'), serverDir, evidence], {
    cwd: SERVER_SRC_DIR,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (seeded.status !== 0) {
    rmSync(home, { recursive: true, force: true });
    throw new Error(`Seeding failed (exit ${seeded.status}):\n${seeded.stderr || seeded.error}`);
  }
  const seed = JSON.parse(seeded.stdout) as { sessionId: string; title: string };

  const port = await freePort();
  const serverOut = join(home, 'server.out');
  const out = openSync(serverOut, 'a');
  const server: ChildProcess = spawn(node, [entry], {
    cwd: home, // dotenv's fallback reads ./.env; there is none here
    env: { ...env, COPILOT_PORT: String(port) },
    stdio: ['ignore', out, out],
  });
  closeSync(out);
  let exited: string | null = null;
  server.once('exit', (code, signal) => { exited = `exit ${code ?? signal}`; });
  // A run cut short (the global timeout, Ctrl-C) can skip the teardown; the
  // server must not outlive the runner either way.
  const killOnExit = () => { if (!exited) server.kill('SIGKILL'); rmSync(home, { recursive: true, force: true }); };
  process.once('exit', killOnExit);

  const base = `http://127.0.0.1:${port}`;
  const outputDir = config.projects[0]?.outputDir ?? join(REPO_DIR, 'dist', 'e2e');

  const teardown = async () => {
    if (!exited) {
      server.kill('SIGTERM');
      for (let i = 0; i < 30 && !exited; i++) await sleep(100);
      if (!exited) server.kill('SIGKILL');
    }
    // What the server said, next to any failure's screenshots and trace.
    try {
      mkdirSync(outputDir, { recursive: true });
      copyFileSync(serverOut, join(outputDir, 'server.out'));
      if (existsSync(join(copilotDir, 'server.log'))) copyFileSync(join(copilotDir, 'server.log'), join(outputDir, 'server.log'));
    } catch {
      /* the run's own result stands */
    }
    rmSync(home, { recursive: true, force: true });
    process.removeListener('exit', killOnExit);
  };

  let health: Record<string, unknown> | null = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !exited) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) { health = await r.json() as Record<string, unknown>; break; }
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  if (!health) {
    const why = exited ? `the server ${exited}` : 'no /health within 20 s';
    const log = tail(serverOut);
    await teardown();
    throw new Error(`Server under test did not start (${why}). Its output:\n${log}`);
  }
  if (health.fakeChat !== true || health.session !== null) {
    await teardown();
    throw new Error(`Server under test is not in e2e mode: /health said ${JSON.stringify(health)}`);
  }

  process.env.MC_E2E_BASE = base;
  process.env.MC_E2E_PORT = String(port);
  process.env.MC_E2E_SESSION = seed.sessionId;
  process.env.MC_E2E_TITLE = seed.title;
  console.log(`[e2e] ${serverDir}\n[e2e] server ${base} (node ${node}), HOME ${home}, seeded ${seed.sessionId}`);
  return teardown;
}
