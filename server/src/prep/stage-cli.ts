// scripts/stage-prep.sh — the one way a prep gets into the staged folder.
//
//   stage-prep.sh <prep.json | ->    check, fill from the invite, write
//   stage-prep.sh --check <file>     check only, write nothing
//   stage-prep.sh --list             what is waiting
//   stage-prep.sh --remove <id>      drop one
//   stage-prep.sh --invites [days]   cxmail invites ahead (default 7), with their eventUid
//   stage-prep.sh --gather <uid>     what the user's own records say about an invite:
//                                    email threads, past meetings, vault notes (no model)
//
// Exit 0 = staged (warnings are printed but do not fail); 1 = nothing written.
// Works with Meeting Copilot closed: the start form reads the folder when it
// opens. See prep/staged.ts for the file format and skills/meeting-prep for
// the skill that writes the input.

import { readFileSync } from 'node:fs';
import { scanProjects } from '../project/index.js';
import {
  LIMITS,
  listStagedPreps,
  normalizeStagedInput,
  removeStagedPrep,
  saveStagedPrep,
  stagedDir,
  stagedPrepExpiry,
  type StagedPrep,
} from './staged.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function when(iso: string | null): string {
  if (!iso) return 'no time';
  return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function readInput(arg: string): unknown {
  const text = arg === '-' ? readFileSync(0, 'utf8') : readFileSync(arg, 'utf8');
  return JSON.parse(text);
}

interface InviteMatch {
  title: string;
  startsAt: string;
  endsAt: string | null;
  attendees: { name: string; email: string }[];
}

/** The invite for a uid, from cxmail's local DB. Null when absent or unreadable. */
async function findInvite(eventUid: string): Promise<{ invite: InviteMatch | null; note?: string }> {
  try {
    // Dynamic: better-sqlite3 is native, and an ABI mismatch must cost the
    // lookup, not the whole command.
    const { getUpcomingMeetings } = await import('../calendar/cxmail.js');
    const meetings = getUpcomingMeetings({ windowMs: WEEK_MS, limit: 200 });
    const m = meetings.find((x) => x.eventUid === eventUid);
    return { invite: m ? { title: m.title, startsAt: m.startsAt, endsAt: m.endsAt, attendees: m.attendees } : null };
  } catch (err) {
    return { invite: null, note: `could not read cxmail's calendar (${err instanceof Error ? err.message : String(err)})` };
  }
}

async function invites(daysArg: string | undefined): Promise<number> {
  const days = Math.max(1, Math.min(30, Number(daysArg) || 7));
  try {
    const { getUpcomingMeetings } = await import('../calendar/cxmail.js');
    const meetings = getUpcomingMeetings({ windowMs: days * 24 * 60 * 60 * 1000, limit: 50 });
    if (meetings.length === 0) console.log(`No invites in the next ${days} day(s) in cxmail's calendar.`);
    for (const m of meetings) {
      console.log(`${when(m.startsAt)}${m.endsAt ? ` → ${when(m.endsAt)}` : ''}  ${m.title}`);
      console.log(`  eventUid   ${m.eventUid ?? '(none — stage it by title and startsAt)'}`);
      if (m.attendees.length) console.log(`  attendees  ${m.attendees.map((a) => `${a.name} <${a.email}>`).join(', ')}`);
      if (m.description) console.log(`  invite     ${m.description.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    return 0;
  } catch (err) {
    console.error(`✗ Could not read cxmail's calendar: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** The start form's Prep gatherer, run on one invite and printed for the skill to read. */
async function gather(eventUid: string): Promise<number> {
  try {
    const { getUpcomingMeetings } = await import('../calendar/cxmail.js');
    const { gatherPrepContext, formatPrepContext, prepRequestFromBody } = await import('./gather.js');
    const meeting = getUpcomingMeetings({ windowMs: WEEK_MS, limit: 200 }).find((m) => m.eventUid === eventUid);
    if (!meeting) {
      console.error(`✗ No invite with eventUid ${eventUid} in the next 7 days (see --invites)`);
      return 1;
    }
    const request = prepRequestFromBody({ meeting });
    if (!request) {
      console.error('✗ That invite has nothing to gather from');
      return 1;
    }
    console.log(formatPrepContext(gatherPrepContext(request)));
    return 0;
  } catch (err) {
    console.error(`✗ Could not gather: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function appRunning(): Promise<boolean> {
  const port = process.env.COPILOT_PORT ?? '17890';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function printPrep(prep: StagedPrep): void {
  const line = (label: string, value: string) => console.log(`  ${label.padEnd(10)} ${value}`);
  line('id', prep.id);
  line('title', prep.title);
  line('when', prep.startsAt ? `${when(prep.startsAt)}${prep.endsAt ? ` → ${when(prep.endsAt)}` : ''}` : 'no time');
  line('invite', prep.eventUid ?? '(none)');
  line('attendees', prep.attendees.map((a) => a.email ? `${a.name} <${a.email}>` : a.name).join(', ') || '(none)');
  line('agenda', `${prep.agenda.length} item(s)`);
  prep.agenda.forEach((item, i) => console.log(`             ${i + 1}. ${item}`));
  line('goals', prep.goals ? `${prep.goals.length} chars (private, coach only)` : '(none)');
  line('projects', prep.projects.join(', ') || '(none)');
  line('context', prep.contextPaths.join('\n             ') || '(none)');
  line('brief', prep.brief ? `${prep.brief.length} / ${LIMITS.briefChars} chars` : '(none)');
  line('sources', String(prep.sources.length));
  line('offered', `until ${when(new Date(stagedPrepExpiry(prep)).toISOString())}`);
}

async function stage(file: string, checkOnly: boolean): Promise<number> {
  let input: unknown;
  try {
    input = readInput(file);
  } catch (err) {
    console.error(`✗ Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Fill what the invite knows and the input left out (times, attendee emails).
  const notes: string[] = [];
  if (input && typeof input === 'object' && typeof (input as Record<string, unknown>).eventUid === 'string') {
    const b = input as Record<string, unknown>;
    const { invite, note } = await findInvite(b.eventUid as string);
    if (note) notes.push(`Invite lookup skipped: ${note}`);
    else if (!invite) notes.push(`No invite with that eventUid in the next 7 days of cxmail's calendar — check the uid (the prep still works without it)`);
    else {
      if (!b.startsAt) { b.startsAt = invite.startsAt; notes.push('startsAt taken from the invite'); }
      if (!b.endsAt && invite.endsAt) { b.endsAt = invite.endsAt; notes.push('endsAt taken from the invite'); }
      if (!b.attendees) { b.attendees = invite.attendees; notes.push('attendees taken from the invite'); }
    }
  }

  const { prep, errors, warnings } = normalizeStagedInput(input, {
    knownProjects: scanProjects().map((p) => p.name),
  });
  for (const n of notes) console.log(`• ${n}`);
  for (const w of warnings) console.log(`⚠ ${w}`);
  if (!prep) {
    for (const e of errors) console.error(`✗ ${e}`);
    console.error('Nothing staged. Fix the errors above and run it again.');
    return 1;
  }

  if (checkOnly) {
    console.log('✓ Valid — nothing written (--check).');
    printPrep(prep);
    return 0;
  }

  const path = saveStagedPrep(prep);
  console.log(`✓ Staged ${path}`);
  printPrep(prep);
  console.log(await appRunning()
    ? 'Meeting Copilot is running: the start form fills itself the next time it is shown (or within 30 s if it is open).'
    : 'Meeting Copilot is not running: the start form fills itself when you open it.');
  return 0;
}

function list(): number {
  const { preps, skipped } = listStagedPreps();
  if (preps.length === 0) console.log(`No preps waiting in ${stagedDir()}`);
  preps.forEach((prep, i) => {
    console.log(i === 0 ? `Next up (fills the start form):` : `Also waiting:`);
    printPrep(prep);
  });
  for (const s of skipped) console.log(`⚠ Skipped ${s.file}: ${s.reason}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [first, second] = argv;
  if (first === '--list') return list();
  if (first === '--invites') return invites(second);
  if (first === '--gather') {
    if (!second) { console.error('Usage: stage-prep.sh --gather <eventUid>'); return 1; }
    return gather(second);
  }
  if (first === '--remove') {
    if (!second) { console.error('Usage: stage-prep.sh --remove <id>'); return 1; }
    const removed = removeStagedPrep(second);
    console.log(removed ? `✓ Removed ${second}` : `No prep with id ${second}`);
    return removed ? 0 : 1;
  }
  if (first === '--check') {
    if (!second) { console.error('Usage: stage-prep.sh --check <prep.json>'); return 1; }
    return stage(second, true);
  }
  if (!first || first.startsWith('--')) {
    console.error('Usage: stage-prep.sh <prep.json | -> | --check <file> | --list | --remove <id> | --invites [days] | --gather <uid>');
    return 1;
  }
  return stage(first, false);
}

main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
