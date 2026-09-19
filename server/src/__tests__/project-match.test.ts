import { describe, it, expect } from 'vitest';
import { suggestProjects, filterProjects } from '../project/match.js';
import type { ProjectInfo } from '../project/index.js';

// A fixed stand-in for the real scan, so these tests do not depend on what
// happens to be in ~/Projects today.
const PROJECTS: ProjectInfo[] = [
  { name: 'globex', path: '/c/globex', category: 'client' },
  { name: 'acme', path: '/c/acme', category: 'client' },
  { name: 'impact', path: '/c/impact', category: 'client' },
  { name: 'aimedia', path: '/p/aimedia', category: 'project' },
  { name: 'cxventures', path: '/p/cxventures', category: 'project' },
  { name: 'meeting-copilot', path: '/p/meeting-copilot', category: 'project' },
  { name: 'northwind-course-studio', path: '/p/northwind-course-studio', category: 'project' },
  { name: 'finance-app', path: '/p/finance-app', category: 'project' },
  { name: 'pocketbuddy', path: '/x/pocketbuddy', category: 'xcode' },
];

const top = (title: string) => suggestProjects(title, PROJECTS).map((m) => m.name);

describe('suggestProjects — real recorded meeting titles', () => {
  it('matches the Globex meetings', () => {
    expect(top('Globex Portal Sync')).toEqual(['globex']);
    expect(top('Globex Sync with Marcus')).toEqual(['globex']);
    expect(top('Globex Talk with Marcus')).toEqual(['globex']);
  });

  it('matches a spaced name against a squashed project name', () => {
    expect(top('AI Media')).toEqual(['aimedia']);
  });

  it('picks cxventures out of a multi-party title', () => {
    expect(top('Northwind Company / CX Ventures/ Keystone Partners')).toContain('cxventures');
  });

  it('suggests nothing for an internal meeting with no project', () => {
    expect(top('Ai Skill Sharing')).toEqual([]);
  });

  it('leaves a genuinely ambiguous title to the human', () => {
    // "Northwind" alone could be cxventures (which owns clients/northwind) or
    // northwind-course-studio. Scores 0.33, below the floor — deliberately no guess.
    expect(top('Northwind')).toEqual([]);
  });
});

describe('suggestProjects — the false positives that made this a module', () => {
  it('does NOT match meeting-copilot on the word "Meeting"', () => {
    expect(top('Globex Portal Meeting')).toEqual(['globex']);
  });

  it('ignores a title that is only meeting vocabulary', () => {
    expect(top('Weekly Sync')).toEqual([]);
    expect(top('Catch up call')).toEqual([]);
    expect(top('1:1')).toEqual([]);
  });

  it('does not match on a stopword shared with a project name', () => {
    // 'impact' is a real project; "high impact review" should still match it,
    // but "review" alone must not.
    expect(top('Quarterly Review')).toEqual([]);
  });

  it('returns nothing for empty or whitespace input', () => {
    expect(top('')).toEqual([]);
    expect(top('   ')).toEqual([]);
  });
});

describe('suggestProjects — scoring behaviour', () => {
  it('scores a direct name hit at 1', () => {
    const [m] = suggestProjects('pocketbuddy roadmap', PROJECTS);
    expect(m?.name).toBe('pocketbuddy');
    expect(m?.score).toBe(1);
  });

  it('carries path and category through, so the repo travels with the pick', () => {
    const [m] = suggestProjects('Globex Portal Sync', PROJECTS);
    expect(m?.path).toBe('/c/globex');
    expect(m?.category).toBe('client');
  });

  it('respects an explicit limit', () => {
    expect(suggestProjects('globex acme impact', PROJECTS, { limit: 2 })).toHaveLength(2);
  });

  it('a lower floor surfaces the ambiguous case rather than hiding it', () => {
    expect(suggestProjects('Northwind', PROJECTS, { minScore: 0.3 }).map((m) => m.name))
      .toContain('northwind-course-studio');
  });
});

describe('filterProjects — the autocomplete itself', () => {
  it('narrows on a substring', () => {
    expect(filterProjects('meet', PROJECTS).map((p) => p.name)).toEqual(['meeting-copilot']);
  });

  it('ignores separators so "financeapp" finds finance-app', () => {
    expect(filterProjects('financeapp', PROJECTS).map((p) => p.name)).toEqual(['finance-app']);
  });

  it('is case-insensitive', () => {
    expect(filterProjects('Globex', PROJECTS).map((p) => p.name)).toEqual(['globex']);
  });

  it('returns the whole list when empty, so browsing still works', () => {
    expect(filterProjects('', PROJECTS)).toHaveLength(PROJECTS.length);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(filterProjects('zzzz', PROJECTS)).toEqual([]);
  });
});
