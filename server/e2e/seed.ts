/**
 * The meeting the replay specs read: a transcript, a finished research card,
 * a pulse, and a prep.json with an html evidence snapshot and a live tab.
 *
 * Runs in its own process (harness.ts), because SessionStore fixes its
 * sessions directory from HOME when it loads, and uses the server under test's
 * own SessionStore and better-sqlite3, so the schema is the shipped one.
 *
 *   node --import tsx e2e/seed.ts <server dir> <evidence html>
 *
 * Prints {"sessionId", "title"} as JSON.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SEED_TITLE = 'Northwind weekly with Rory';

const [serverDir, evidencePath] = process.argv.slice(2);
if (!serverDir || !evidencePath) {
  console.error('usage: seed.ts <server dir> <evidence html>');
  process.exit(2);
}
if (resolve(homedir()) === resolve(userInfo().homedir)) {
  console.error('seed.ts: refusing to write a test meeting into the real ~/.meeting-copilot');
  process.exit(1);
}

const { SessionStore } = await import(pathToFileURL(join(serverDir, 'dist', 'session', 'store.js')).href);

const store = new SessionStore();
store.createSession(SEED_TITLE, [], 'Brightline reporting\nKey events tracking\nTraining Portal timeline', 'Rory, Eli Park');
const t0: number = store.getSession().startedAt;

const lines: Array<['mic' | 'meeting', string, number]> = [
  ['meeting', 'Thanks for making time. Eli is joining in a minute.', 20],
  ['mic', 'No problem. I wanted to start with the Brightline report, the key events number looked off.', 45],
  ['meeting', 'Yeah, the Looker board shows zero key events for all of August. Brightline says they migrated tracking on August 3rd.', 80],
  ['mic', 'Zero for a whole month means the tag is not firing, or the events were never marked as key events in GA4.', 110],
  ['meeting', 'Can you look into it and tell us what to ask them for? We pay them fifteen thousand a quarter.', 150],
  ['mic', 'Yes. I will send a short list of what to ask Brightline by Friday.', 175],
  ['meeting', 'Also, for the Training Portal, can we get a first course live before the October board meeting?', 220],
  ['mic', 'The proposal has four weeks for the studio build, so if you sign this week, a first course by mid October is realistic.', 260],
  ['meeting', 'Great. Eli will review the proposal and get back to you by Tuesday.', 300],
];
for (const [source, text, sec] of lines) {
  store.addTranscript({
    id: randomUUID(),
    text,
    source,
    label: source === 'mic' ? '[You]' : '[Meeting]',
    timestamp: t0 + sec * 1000,
    duration: 5,
    wordCount: text.split(/\s+/).length,
  });
}

store.addAction({
  id: 'card-ga4',
  type: 'fast-research',
  title: 'GA4 key events vs conversions',
  description: '',
  triggerQuote: 'zero key events',
  state: 'completed',
  params: {},
  createdAt: t0 + 120_000,
});
store.updateAction('card-ga4', {
  state: 'completed',
  completedAt: t0 + 130_000,
  result: {
    success: true,
    data: null,
    summary: 'GA4 renamed conversions to key events in March 2024.',
    artifacts: [{
      type: 'markdown',
      content: 'GA4 renamed **conversions** to **key events** in March 2024. An event only counts as a key event after it is marked as one in Admin > Events. Imported Universal Analytics goals do not carry over.',
    }],
  },
});

store.addPulse({
  id: 'pulse-1',
  mode: 'pulse',
  trigger: 'timer',
  status: 'on_track',
  read: 'Good pace: reporting and the Academy timeline are covered; the ask for Brightline has an owner and a date.',
  escalations: [],
  closeOut: [{ text: 'Confirm who at Northwind has GA4 admin access', why: 'needed to check the key event settings' }],
  missed: [],
  minutesIn: 5,
  minutesLeft: null,
  latencyMs: 30_000,
  createdAt: t0 + 305_000,
});

writeFileSync(join(store.directory, 'prep.json'), JSON.stringify({
  origin: 'staged',
  brief: 'Rory is Northwind marketing lead; Eli Park signs off on spend. Brightline is the SEO agency Northwind pays $12k/quarter. Training Portal proposal ($5,000 one-time) is live.',
  tabs: [
    { title: 'Looker: 0 key events', url: null, path: resolve(evidencePath), note: "Brightline's own dashboard, August" },
    { title: 'Search Console', url: 'https://search.google.com/search-console', path: null, note: 'Live, needs login' },
  ],
}, null, 2));

store.updateState('ended');
store.close();
process.stdout.write(JSON.stringify({ sessionId: store.id, title: SEED_TITLE }));
