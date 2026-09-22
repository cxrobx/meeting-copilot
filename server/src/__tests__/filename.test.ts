import { describe, it, expect } from 'vitest';
import {
  buildMeetingFilename,
  formatMeetingDate,
  parseAttendees,
  topicFromTitle,
  FILENAME_LIMIT,
} from '../workers/filename.js';

describe('formatMeetingDate', () => {
  it('uses LOCAL time, not UTC', () => {
    // 2026-04-28 23:58 UTC is 19:58 ET — the meeting happened on the 28th.
    // toISOString().slice(0, 10) would say 2026-04-28 here, but the bug this
    // pins is the other side of midnight: anything after 20:00 ET.
    const evening = new Date('2026-04-28T23:58:00Z');
    expect(evening.toISOString().slice(0, 10)).toBe('2026-04-28');
    expect(formatMeetingDate(evening)).toBe('04.28.26');
  });

  it('does not roll an evening ET meeting onto the next day', () => {
    // 2026-06-17T01:21:00Z = 2026-06-16 21:21 ET. The old code named this
    // `2026-06-17-call-w-marcus.md` for a call held on the 16th.
    const lateEvening = new Date('2026-06-17T01:21:00Z');
    expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-06-17');
    expect(formatMeetingDate(lateEvening)).toBe('06.16.26');
  });

  it('accepts epoch ms (the shape SessionRecord.startedAt has)', () => {
    expect(formatMeetingDate(new Date(2026, 3, 28, 19, 58).getTime())).toBe('04.28.26');
  });

  it('falls back to now when startedAt is missing or unparseable', () => {
    expect(formatMeetingDate(undefined)).toMatch(/^\d{2}\.\d{2}\.\d{2}$/);
    expect(formatMeetingDate('not a date')).toMatch(/^\d{2}\.\d{2}\.\d{2}$/);
  });
});

describe('parseAttendees', () => {
  it('drops self — Chris attends everything', () => {
    expect(parseAttendees('Chris, Marcus')).toEqual(['Marcus']);
    expect(parseAttendees('cxuser, Remi')).toEqual(['Remi']);
  });

  it('keeps first names only', () => {
    expect(parseAttendees('Chris, Phillip Adams')).toEqual(['Phillip']);
  });

  it('skips honorifics', () => {
    expect(parseAttendees('Chris, Mr Park')).toEqual(['Park']);
  });

  it('rejects non-people labels', () => {
    expect(parseAttendees('Chris, Audience, Unknown speaker')).toEqual([]);
  });

  it('drops the slot when it is mostly raw usernames', () => {
    expect(parseAttendees('guest4, guest321, Phillip Adams, cxuser, guest.s')).toEqual([]);
  });

  it('deduplicates', () => {
    expect(parseAttendees('Marcus, marcus, Chris')).toEqual(['Marcus']);
  });
});

describe('topicFromTitle', () => {
  it('drops words the people slot already says', () => {
    expect(topicFromTitle('Call w Marcus', ['Marcus'])).toBe('');
  });

  it('strips calendar cruft', () => {
    expect(topicFromTitle('Accepted: Kickoff', [])).toBe('Kickoff');
  });

  it('applies topic aliases', () => {
    expect(topicFromTitle('business-development', [])).toBe('Biz Dev');
    expect(topicFromTitle('Development', [])).toBe('Dev');
  });
});

describe('buildMeetingFilename', () => {
  const startedAt = new Date('2026-04-28T23:58:00Z'); // 19:58 ET
  // Category optional: the catch-all folder has no code, so it is earned or absent.
  const CONVENTION = /^(?:[A-Z0-9]{2,5} )?\S.* \d{2}\.\d{2}\.\d{2}\.md$/;

  it('emits <CATEGORY> <Who> <MM.DD.YY>.md when the content earns a code', () => {
    expect(buildMeetingFilename({ title: 'Globex Sync', attendees: 'Chris, Marcus', startedAt }))
      .toBe('Globex Marcus 04.28.26.md');
  });

  it('carries no prefix when nothing earns one — CXV is not a default', () => {
    expect(buildMeetingFilename({ title: 'AI Skill Sharing', attendees: 'Chris', startedAt }))
      .toBe('AI Skill Sharing 04.28.26.md');
    expect(buildMeetingFilename({ title: 'Interview', attendees: 'Chris, Dana', startedAt }))
      .toBe('Dana 04.28.26.md');
  });

  it('earns the specific code over CXV, and from the attendees too', () => {
    // Only the words that earned THIS code are dropped — cxnotes gives the same.
    expect(buildMeetingFilename({ title: 'CX Ventures Atlas IQ sync', attendees: 'Chris', startedAt }))
      .toBe('AIQ CX Ventures Sync 04.28.26.md');
    expect(buildMeetingFilename({ title: 'Portal review', attendees: 'Chris, Marcus (Globex)', startedAt }))
      .toBe('Globex Marcus 04.28.26.md');
  });

  it('does not repeat the words that earned the code', () => {
    expect(buildMeetingFilename({ title: 'Globex Portal Sync', attendees: 'Chris', startedAt }))
      .toBe('Globex Portal Sync 04.28.26.md');
  });

  it('names two counterparts, then et al', () => {
    expect(buildMeetingFilename({ title: '', attendees: 'Chris, Marcus, Michael', startedAt }))
      .toBe('Marcus, Michael 04.28.26.md');
    expect(buildMeetingFilename({ title: '', attendees: 'Chris, Marcus, Michael, Amy', startedAt }))
      .toBe('Marcus et al 04.28.26.md');
  });

  it('truncates an over-budget topic instead of replacing it with "Meeting"', () => {
    // cxnotes' 09-08 bug, which this mirror carried verbatim: `Meeting` sat on
    // the ladder ahead of truncation and always fits, so a topic a few
    // characters over became the word "Meeting". The old budget test passed
    // WITH the bug because it checked the shape, not that a word survived.
    const name = buildMeetingFilename({
      title: 'CX Ventures Quarterly Architecture Review',
      attendees: 'Chris',
      startedAt,
    });
    expect(name).toBe('CXV Quarterly Architecture 04.28.26.md');
    expect(name).not.toMatch(/ Meeting /);
  });

  it('stays inside the 40-char budget and never truncates the date', () => {
    const name = buildMeetingFilename({
      title: 'Quarterly Partner Portal Architecture Review And Roadmap',
      attendees: 'Chris',
      startedAt,
    });
    expect(name.length).toBeLessThanOrEqual(FILENAME_LIMIT);
    expect(name.endsWith(' 04.28.26.md')).toBe(true);
    expect(name).toMatch(/Quarterly/);
  });

  it('uses "Meeting" only when the middle is genuinely empty', () => {
    expect(buildMeetingFilename({ title: 'Meeting', attendees: 'Chris', startedAt }))
      .toBe('Meeting 04.28.26.md');
  });

  it('matches the vault convention regex', () => {
    for (const title of ['Globex Portal Sync', 'e2e', 'Accepted: Kickoff', '', 'Untitled']) {
      expect(buildMeetingFilename({ title, attendees: 'Chris, Marcus', startedAt })).toMatch(CONVENTION);
    }
  });
});
