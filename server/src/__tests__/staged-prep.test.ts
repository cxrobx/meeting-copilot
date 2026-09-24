import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LIMITS,
  attachPrepToSession,
  listStagedPreps,
  normalizeStagedInput,
  prepBriefDoc,
  readSessionTabs,
  saveStagedPrep,
  stagedPrepExpiry,
  stagedPrepId,
  type StagedPrep,
} from '../prep/staged.js';
import { buildContextBlock, type ContextDoc } from '../context/index.js';

const NOW = new Date('2026-09-23T13:00:00.000Z');

const INPUT = {
  title: 'Northwind weekly with Rory',
  eventUid: 'abc-123@google.com',
  startsAt: '2026-09-23T18:00:00.000Z',
  endsAt: '2026-09-23T18:30:00.000Z',
  attendees: [{ name: 'Rory', email: 'rory@northwind.example' }, 'Eli Park'],
  agenda: ['- Brightline audit findings', '2. Training Portal proposal status', 'Brightline audit findings'],
  goals: ['Get a yes/no on the $5,000 Academy proposal', 'Do not discount the retainer'],
  projects: ['CXVentures'],
  contextPaths: ['~/clients/northwind/STATUS.md'],
  brief: '### Who they are\n- Rory runs marketing at Northwind.',
  sources: [{ title: 'Northwind', url: 'https://northwind.example' }, { title: 'bad', url: 'javascript:alert(1)' }],
};

const opts = {
  now: NOW,
  home: '/Users/test',
  knownProjects: ['cxventures', 'finance-app'],
  pathExists: (p: string) => p === '/Users/test/clients/northwind/STATUS.md',
};

function stage(overrides: Record<string, unknown> = {}) {
  return normalizeStagedInput({ ...INPUT, ...overrides }, opts);
}

describe('normalizeStagedInput', () => {
  it('normalizes a complete prep', () => {
    const { prep, errors, warnings } = stage();
    expect(errors).toEqual([]);
    expect(prep).not.toBeNull();
    expect(prep!.agenda).toEqual(['Brightline audit findings', 'Training Portal proposal status']);
    expect(prep!.attendees).toEqual([
      { name: 'Rory', email: 'rory@northwind.example' },
      { name: 'Eli Park', email: null },
    ]);
    expect(prep!.goals).toBe('Get a yes/no on the $5,000 Academy proposal\nDo not discount the retainer');
    expect(prep!.projects).toEqual(['cxventures']); // canonical case from the picker
    expect(prep!.contextPaths).toEqual(['/Users/test/clients/northwind/STATUS.md']); // ~ expanded
    expect(prep!.sources).toEqual([{ title: 'Northwind', url: 'https://northwind.example' }]);
    expect(prep!.createdBy).toBe('claude');
    expect(prep!.version).toBe(1);
    expect(warnings).toContain('Dropped 1 empty or duplicate agenda item(s)');
  });

  it('refuses what it cannot fix, instead of cutting it', () => {
    expect(stage({ title: '' }).errors).toContain('title is required');
    expect(stage({ agenda: [] }).errors).toContain('agenda needs at least one item');
    expect(stage({ agenda: Array.from({ length: 11 }, (_, i) => `Item ${i}`) }).errors[0]).toMatch(/11 items; the limit is 10/);
    expect(stage({ agenda: ['x'.repeat(151)] }).errors[0]).toMatch(/151 characters/);
    expect(stage({ brief: 'x'.repeat(LIMITS.briefChars + 1) }).errors[0]).toMatch(/tighten it/);
    expect(stage({ goals: 'x'.repeat(LIMITS.goalsChars + 1) }).errors[0]).toMatch(/goals is 1001/);
    expect(stage({ startsAt: 'tomorrow-ish' }).errors[0]).toMatch(/startsAt is not a date/);
    expect(stage({ endsAt: '2026-09-23T17:00:00.000Z' }).errors).toContain('endsAt must be after startsAt');
    expect(stage({ startsAt: '2026-09-23T11:00:00Z', endsAt: '2026-09-23T12:00:00Z' }).errors[0]).toMatch(/already ended/);
    expect(normalizeStagedInput('nope', opts).errors).toEqual(['Expected a JSON object']);
    expect(stage({ title: '' }).prep).toBeNull();
  });

  it('drops what it can drop, and says so', () => {
    const { prep, warnings } = stage({
      projects: ['cxventures', 'no-such-repo'],
      contextPaths: ['relative/notes.md', '/Users/test/missing.md', '~/clients/northwind/STATUS.md'],
      goal: 'typo field',
    });
    expect(prep!.projects).toEqual(['cxventures']);
    expect(prep!.contextPaths).toEqual(['/Users/test/clients/northwind/STATUS.md']);
    expect(warnings).toEqual(expect.arrayContaining([
      'Ignored unknown field "goal"',
      'Dropped unknown project "no-such-repo" (not in the start form\'s project list)',
      'Dropped context path "relative/notes.md": it must be absolute',
      'Dropped context path "/Users/test/missing.md": it does not exist',
    ]));
  });

  it('rejects a context file the copilot cannot read', () => {
    const { prep, warnings } = normalizeStagedInput(
      { ...INPUT, contextPaths: ['/Users/test/proposal.pdf'] },
      { ...opts, pathExists: () => true },
    );
    expect(prep!.contextPaths).toEqual([]);
    expect(warnings.some((w) => w.includes('only reads .md'))).toBe(true);
  });

  describe('evidence tabs', () => {
    const PNG = '/Users/test/evidence/zero-key-events.png';
    const tabOpts = { ...opts, pathExists: (p: string) => p === PNG || opts.pathExists(p) };
    const withTabs = (tabs: unknown) => normalizeStagedInput({ ...INPUT, tabs }, tabOpts);

    it('keeps a live URL, a snapshot, and a snapshot with its live page', () => {
      const { prep, warnings } = withTabs([
        { title: 'Looker: key events', url: 'https://lookerstudio.google.com/reporting/abc/page/p1', note: 'Brightline shows 0 key events' },
        { title: 'Landing pages', path: '~/evidence/zero-key-events.png' },
        { url: 'https://lookerstudio.google.com/x', path: PNG },
      ]);
      expect(warnings.filter((w) => /tab/i.test(w))).toEqual([]);
      expect(prep!.tabs).toEqual([
        { title: 'Looker: key events', url: 'https://lookerstudio.google.com/reporting/abc/page/p1', path: null, note: 'Brightline shows 0 key events' },
        { title: 'Landing pages', url: null, path: PNG, note: '' }, // ~ expanded
        { title: 'zero-key-events.png', url: 'https://lookerstudio.google.com/x', path: PNG, note: '' }, // title from the file
      ]);
    });

    it('drops what is unusable, and says so', () => {
      const { prep, warnings } = withTabs([
        { title: 'No target' },
        { title: 'Bad scheme', url: 'javascript:alert(1)' },
        { title: 'Missing file', path: '/Users/test/evidence/gone.png' },
        { title: 'Relative', path: 'evidence/zero-key-events.png' },
        { title: 'Wrong kind', path: '/Users/test/clients/northwind/STATUS.md' },
        { title: 'Bad path, good url', path: '/Users/test/nope.png', url: 'https://example.com', kind: 'live' },
        'just a string',
      ]);
      expect(prep!.tabs).toEqual([{ title: 'Bad path, good url', url: 'https://example.com', path: null, note: '' }]);
      expect(warnings).toEqual(expect.arrayContaining([
        'Dropped Tab 1: it needs a url or a snapshot path',
        'Tab 2: dropped url "javascript:alert(1)": it must start with http:// or https://',
        'Tab 3: dropped path "/Users/test/evidence/gone.png": it does not exist',
        'Tab 4: dropped path "evidence/zero-key-events.png": it must be absolute',
        'Tab 5: dropped path "/Users/test/clients/northwind/STATUS.md": a snapshot must be png, jpg, gif, webp, pdf or html',
        'Tab 6: ignored unknown field "kind"',
        'Dropped Tab 7: expected {title, url, path, note}',
      ]));
    });

    it('caps the count and the text, and ignores a non-list', () => {
      const many = Array.from({ length: LIMITS.tabs + 2 }, (_, i) => ({ title: `T${i}`, url: `https://x.y/${i}` }));
      const capped = withTabs(many);
      expect(capped.prep!.tabs).toHaveLength(LIMITS.tabs);
      expect(capped.warnings).toContain(`Kept the first ${LIMITS.tabs} of ${LIMITS.tabs + 2} tabs`);
      const long = withTabs([{ title: 'x'.repeat(200), note: 'y'.repeat(500), url: 'https://x.y' }]).prep!.tabs[0];
      expect(long.title).toHaveLength(LIMITS.tabTitleChars);
      expect(long.note).toHaveLength(LIMITS.tabNoteChars);
      expect(withTabs({ url: 'https://x.y' }).warnings).toContain('Ignored tabs: expected a list of {title, url, path, note}');
      expect(stage().prep!.tabs).toEqual([]);
      expect(stage().warnings.some((w) => w.includes('unknown field "tabs"'))).toBe(false);
    });
  });

  it('accepts attendees as one string and agenda as lines', () => {
    const { prep } = stage({ attendees: 'Rory, Eli Park; rory', agenda: 'First\nSecond\n' });
    expect(prep!.attendees.map((a) => a.name)).toEqual(['Rory', 'Eli Park']);
    expect(prep!.agenda).toEqual(['First', 'Second']);
  });

  it('keys the id on the invite, so re-staging replaces the prep', () => {
    const a = stage().prep!;
    const b = stage({ title: 'Renamed', agenda: ['Different'] }).prep!;
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{12}$/);
    expect(stagedPrepId('Coffee', null, '2026-09-23T18:00:00.000Z')).not.toBe(stagedPrepId('Coffee', null, '2026-09-24T18:00:00.000Z'));
  });
});

describe('expiry', () => {
  it('ends at the meeting end, else start + 2h, else created + 24h', () => {
    const base = { createdAt: '2026-09-23T10:00:00.000Z', startsAt: null, endsAt: null };
    expect(stagedPrepExpiry({ ...base, startsAt: '2026-09-23T18:00:00.000Z', endsAt: '2026-09-23T18:30:00.000Z' }))
      .toBe(Date.parse('2026-09-23T18:30:00.000Z'));
    expect(stagedPrepExpiry({ ...base, startsAt: '2026-09-23T18:00:00.000Z' })).toBe(Date.parse('2026-09-23T20:00:00.000Z'));
    expect(stagedPrepExpiry(base)).toBe(Date.parse('2026-09-24T10:00:00.000Z'));
  });
});

describe('the staged folder', () => {
  let dir: string;
  let sessionDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'staged-test-'));
    sessionDir = mkdtempSync(join(tmpdir(), 'staged-session-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  function prep(overrides: Record<string, unknown>): StagedPrep {
    const result = normalizeStagedInput({ ...INPUT, ...overrides }, opts);
    if (!result.prep) throw new Error(result.errors.join('; '));
    return result.prep;
  }

  it('lists soonest first, undated last, and replaces on re-stage', () => {
    saveStagedPrep(prep({ eventUid: 'late', startsAt: '2026-09-23T20:00:00Z', endsAt: '2026-09-23T21:00:00Z' }), dir);
    saveStagedPrep(prep({ eventUid: 'soon', startsAt: '2026-09-23T14:00:00Z', endsAt: '2026-09-23T15:00:00Z' }), dir);
    saveStagedPrep(prep({ eventUid: null, title: 'Undated', startsAt: null, endsAt: null }), dir);
    saveStagedPrep(prep({ eventUid: 'soon', title: 'Soon (redone)', startsAt: '2026-09-23T14:00:00Z', endsAt: '2026-09-23T15:00:00Z' }), dir);

    const { preps, skipped } = listStagedPreps(dir, NOW);
    expect(skipped).toEqual([]);
    expect(preps.map((p) => p.title)).toEqual(['Soon (redone)', 'Northwind weekly with Rory', 'Undated']);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('hides a finished meeting and deletes it a day later', () => {
    const p = prep({});
    const file = saveStagedPrep(p, dir);
    expect(listStagedPreps(dir, new Date('2026-09-23T18:29:00Z')).preps).toHaveLength(1);
    expect(listStagedPreps(dir, new Date('2026-09-23T18:31:00Z')).preps).toHaveLength(0);
    expect(existsSync(file)).toBe(true);
    listStagedPreps(dir, new Date('2026-09-24T19:00:00Z'));
    expect(existsSync(file)).toBe(false);
  });

  it('skips a file from a newer app, and a broken one, and says why', () => {
    writeFileSync(join(dir, 'aaaaaaaaaaaa.json'), JSON.stringify({ version: 2, id: 'aaaaaaaaaaaa' }));
    writeFileSync(join(dir, 'bbbbbbbbbbbb.json'), '{not json');
    const { preps, skipped } = listStagedPreps(dir, NOW);
    expect(preps).toEqual([]);
    expect(skipped.map((s) => s.file).sort()).toEqual(['aaaaaaaaaaaa.json', 'bbbbbbbbbbbb.json']);
    expect(skipped.find((s) => s.file === 'aaaaaaaaaaaa.json')!.reason).toMatch(/update Meeting Copilot/);
  });

  it('reads a file staged before tabs existed', () => {
    const { tabs: _tabs, ...old } = prep({});
    writeFileSync(join(dir, `${old.id}.json`), JSON.stringify(old));
    expect(listStagedPreps(dir, NOW).preps[0].tabs).toEqual([]);
  });

  it('attaches a prep that brings tabs but no brief, and keeps its tabs with the session', () => {
    const p = { ...prep({ brief: '' }), tabs: [{ title: 'Looker', url: 'https://lookerstudio.google.com/x', path: null, note: '' }] };
    saveStagedPrep(p, dir);
    const attached = attachPrepToSession({ prepId: p.id }, sessionDir, dir);
    expect(attached).toEqual({ brief: '', tabs: p.tabs, origin: 'staged', prepId: p.id });
    expect(readSessionTabs(sessionDir)).toEqual(p.tabs);
    // The Prep button's brief has no tabs, and a session without a prep reads none.
    expect(readSessionTabs(dir)).toEqual([]);
  });

  it('moves a staged prep into the session, exactly once', () => {
    const p = prep({});
    saveStagedPrep(p, dir);
    const attached = attachPrepToSession({ prepId: p.id }, sessionDir, dir);
    expect(attached).toEqual({ brief: p.brief, tabs: [], origin: 'staged', prepId: p.id });
    expect(JSON.parse(readFileSync(join(sessionDir, 'prep.json'), 'utf8')).id).toBe(p.id);
    expect(listStagedPreps(dir, NOW).preps).toEqual([]);
    expect(attachPrepToSession({ prepId: p.id }, sessionDir, dir)).toBeNull();
  });

  it('hands the copilot the brief the form showed, and survives a missing file', () => {
    const p = prep({});
    saveStagedPrep(p, dir);
    // A re-prep on the prepped form replaced the brief: that one wins.
    expect(attachPrepToSession({ prepId: p.id, brief: '### Newer' }, sessionDir, dir))
      .toEqual({ brief: '### Newer', tabs: [], origin: 'staged', prepId: p.id });
    // The staged file is gone (already moved): the sent brief still lands.
    expect(attachPrepToSession({ prepId: p.id, brief: '### Newer' }, sessionDir, dir))
      .toEqual({ brief: '### Newer', tabs: [], origin: 'form', prepId: null });
  });

  it('records the Prep button brief, and ignores junk ids', () => {
    expect(attachPrepToSession({ prepId: '../../etc/passwd' }, sessionDir, dir)).toBeNull();
    expect(attachPrepToSession({}, sessionDir, dir)).toBeNull();
    const attached = attachPrepToSession({ brief: '  ### Who\n- A  ', sources: [{ title: 'x', url: 'https://x.y' }] }, sessionDir, dir);
    expect(attached).toEqual({ brief: '### Who\n- A', tabs: [], origin: 'form', prepId: null });
    const saved = JSON.parse(readFileSync(join(sessionDir, 'prep.json'), 'utf8'));
    expect(saved.origin).toBe('form');
    expect(saved.sources).toHaveLength(1);
  });
});

describe('the brief in the context block', () => {
  function doc(name: string, content: string): ContextDoc {
    return { name, relativePath: name, dirPath: '/x', content, firstLine: content.slice(0, 40), sizeChars: content.length };
  }

  it('leads even when other docs match the moment better', () => {
    const docs = [
      doc('pricing.md', 'retainer pricing discount retainer pricing'),
      doc('roadmap.md', 'retainer roadmap pricing'),
      doc('notes.md', 'retainer notes pricing'),
      prepBriefDoc('### Who they are\n- Rory runs marketing.', '/sessions/s1'),
    ];
    const block = buildContextBlock(docs, 'what about the retainer pricing discount');
    expect(block.startsWith('### Meeting prep brief\n')).toBe(true);
    expect(block).toContain('### pricing.md');
    expect(block).not.toContain('### notes.md'); // three docs max: the brief took one slot
  });
});

