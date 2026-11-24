import { describe, expect, it } from 'vitest';
import seed from '../../src/colleges/seed.json';
import usFile from '../../src/colleges/us-colleges.json';
import { buildList, decodeCsv, normaliseWebsite, parseCsv } from '../../scripts/make-us-colleges.mjs';
import { collegeNotes } from '../../src/colleges/store';
import {
  RESEARCHED_UNITIDS, findUsCollege, hiddenUnitids, ipedsCollegeRow, isIpedsId, loadUsColleges, normaliseName,
  resolveCollege, searchColleges, unitidOf, withoutLocal, type LocalCollege, type UsCollege,
} from '../../src/colleges/usColleges';
import type { CollegeRow, PromptRow } from '../../src/db/schema';

const colleges = seed.colleges as CollegeRow[];
const prompts = seed.prompts as PromptRow[];
const US = usFile.rows as unknown as UsCollege[];
const local: LocalCollege[] = colleges.map((college) => ({
  college,
  verifiedPrompts: prompts.some((p) => p.verified && (p.collegeId === college.id || p.collegeId === college.promptsFrom)),
}));

const HEADER = 'UNITID,INSTNM,CITY,STABBR,WEBADDR,SECTOR,ICLEVEL,CYACTIVE,DEGGRANT,UGOFFER,INSTCAT';
const FIXTURE = [
  `﻿${HEADER}`,
  '3,"Zeta College, The","Smith ""Old"" Town","PA","WWW.Zeta.edu/Admit?x=1#top",2,1,1,1,1,2',
  '1,"Alpha University","Springfield","IL","http://www.alpha.edu",1,1,1,1,1,2',
  '2,"Beta Community College","Dover","DE","beta.edu",4,2,1,1,1,4',
  '4,"Closed College","Reno","NV","closed.edu",2,1,2,1,1,2',
  '5,"Graduate Institute","Boston","MA","grad.edu",2,1,1,1,2,1',
  '6,"No Degrees School","Austin","TX","nodeg.edu",3,1,1,2,1,6',
  '7,"Island University","San Juan","PR","island.edu",1,1,1,1,1,2',
  '8,"Mostly Associate College","Tampa","FL","assoc.edu",1,1,1,1,1,3',
  '9,"Delta College","Line one',
  'Line two","OR"," ",3,1,1,1,1,2',
].join('\r\n');

describe('the generator that builds the US college list', () => {
  it('reads quoted commas, doubled quotes, line breaks inside quotes and a byte-order mark', () => {
    const rows = parseCsv(FIXTURE);
    expect(rows).toHaveLength(9);
    expect(rows[0].UNITID).toBe('3');
    expect(rows[0].INSTNM).toBe('Zeta College, The');
    expect(rows[0].CITY).toBe('Smith "Old" Town');
    expect(rows[8].CITY).toBe('Line one\r\nLine two');
  });

  it('decodes UTF-8 and falls back to Windows-1252', () => {
    expect(decodeCsv(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    expect(decodeCsv(new TextEncoder().encode('Université'))).toBe('Université');
    expect(decodeCsv(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
  });

  it('keeps only active four-year degree-granting undergraduate schools in a state or DC, sorted by name', () => {
    const { rows, sectors } = buildList(parseCsv(FIXTURE));
    expect(rows).toEqual([
      [1, 'Alpha University', 'Springfield', 'IL', 'https://www.alpha.edu/'],
      [9, 'Delta College', 'Line one Line two', 'OR', ''],
      [3, 'Zeta College, The', 'Smith "Old" Town', 'PA', 'https://www.zeta.edu/Admit?x=1'],
    ]);
    expect(sectors).toEqual({ 1: 1, 2: 1, 3: 1 });
  });

  it('refuses a file without the columns it filters on', () => {
    expect(() => buildList(parseCsv('UNITID,INSTNM\r\n1,"A"'))).toThrow(/missing these columns/);
  });

  it('writes every website as https://host/..., or leaves it empty', () => {
    expect(normaliseWebsite('www.aamu.edu/')).toBe('https://www.aamu.edu/');
    expect(normaliseWebsite('HTTP://WWW.Example.EDU')).toBe('https://www.example.edu/');
    expect(normaliseWebsite('https://example.edu/admissions/apply')).toBe('https://example.edu/admissions/apply');
    expect(normaliseWebsite('  example.edu/a#frag ')).toBe('https://example.edu/a');
    expect(normaliseWebsite('www.example.edu/austin#location=Austin, TX')).toBe('https://www.example.edu/austin');
    for (const bad of ['', ' ', '-2', 'not a site', 'localhost', 'javascript:alert(1)', 'user:pw@evil.example', 'example.edu:8080', undefined]) {
      expect(normaliseWebsite(bad), String(bad)).toBe('');
    }
  });
});

describe('the checked-in US college list', () => {
  it('names its source and holds only name, city, state and website', async () => {
    expect(usFile.sourceFile).toMatch(/^HD\d{4}\.csv$/i);
    expect(usFile.ipedsYear).toBeGreaterThanOrEqual(2022);
    expect(usFile.generatedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(usFile.count).toBe(US.length);
    expect(US.length).toBeGreaterThan(1800);
    expect(US.length).toBeLessThan(2400);
    const ids = new Set<number>();
    for (const u of US) {
      expect(u, String(u[0])).toHaveLength(5);
      expect(Number.isInteger(u[0]) && u[0] > 0, String(u[0])).toBe(true);
      expect(u[1].length, String(u[0])).toBeGreaterThan(1);
      expect(u[3], u[1]).toMatch(/^[A-Z]{2}$/);
      if (u[4]) expect(u[4], u[1]).toMatch(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\//);
      ids.add(u[0]);
    }
    expect(ids.size).toBe(US.length);
    expect((await loadUsColleges()).rows).toHaveLength(US.length);
  });

  it('has each researched school it is mapped to', () => {
    for (const [id, unitid] of Object.entries(RESEARCHED_UNITIDS)) {
      expect(colleges.some((c) => c.id === id), id).toBe(true);
      expect(US.some((u) => u[0] === unitid), id).toBe(true);
    }
  });
});

describe('a school already researched is not offered twice', () => {
  it('matches names that differ only in form', () => {
    expect(normaliseName('UC Berkeley')).toBe(normaliseName('University of California-Berkeley'));
    expect(normaliseName('The University of Chicago')).toBe(normaliseName('University of Chicago'));
    expect(normaliseName('Texas A & M University')).toBe(normaliseName('Texas A&M University'));
    expect(normaliseName('Pennsylvania State University-Main Campus')).toBe('pennsylvania state university');
  });

  it('hides the directory row of every researched school and keeps the researched entry', () => {
    const hidden = hiddenUnitids(colleges, US);
    for (const unitid of Object.values(RESEARCHED_UNITIDS)) expect(hidden.has(unitid), String(unitid)).toBe(true);
    const rest = withoutLocal(US, colleges);
    expect(rest).toHaveLength(US.length - 15);
    for (const name of ['University of Pennsylvania', 'Columbia University in the City of New York', 'University of California-Los Angeles', 'University of Washington-Seattle Campus', 'Pennsylvania State University-Main Campus']) {
      expect(rest.some((u) => u[1] === name), name).toBe(false);
    }
    // Systems and shared-prompt entries have no directory row of their own and stay as they are.
    expect(RESEARCHED_UNITIDS.commonapp).toBeUndefined();
    expect(RESEARCHED_UNITIDS.uc).toBeUndefined();
  });

  it('hides a school the user added by hand under the same name, and one already picked from the list', () => {
    const mudd = US.find((u) => u[1] === 'Harvey Mudd College')!;
    const stanford = US.find((u) => u[1] === 'Stanford University')!;
    const mine: CollegeRow[] = [
      { id: 'college-1a2b', name: 'harvey mudd college', appliesVia: '', promptsFrom: null, wants: '', wantsSourceUrl: '', cycleYear: '2026-27', verified: false },
      ipedsCollegeRow(stanford, '2026-27'),
    ];
    const hidden = hiddenUnitids(mine, US);
    expect([...hidden].sort()).toEqual([mudd[0], stanford[0]].sort());
    const found = searchColleges('harvey mudd', mine.map((college) => ({ college, verifiedPrompts: false })), US);
    expect(found.options.map((o) => o.id)).toEqual(['college-1a2b']);
  });

  it('does not hide several different schools that share one name', () => {
    const shared = US.filter((u) => u[1] === 'Columbia College');
    expect(shared.length).toBeGreaterThan(1);
    const mine: CollegeRow[] = [{ id: 'college-x', name: 'Columbia College', appliesVia: '', promptsFrom: null, wants: '', wantsSourceUrl: '', cycleYear: '2026-27', verified: false }];
    expect(hiddenUnitids(mine, US).size).toBe(0);
  });
});

describe('searching for a college', () => {
  const ids = (q: string, limit?: number) => searchColleges(q, local, US, limit).options.map((o) => o.id);

  it('lists researched schools first when nothing is typed, and never more than the limit', () => {
    const found = searchColleges('', local, US);
    expect(found.options).toHaveLength(50);
    expect(found.total).toBe(colleges.length + US.length - 15);
    expect(found.options.slice(0, colleges.length).every((o) => o.researched)).toBe(true);
    expect(found.options[colleges.length].researched).toBe(false);
    expect(searchColleges('university', local, US, 7).options).toHaveLength(7);
  });

  it('marks which schools have verified prompts', () => {
    const byId = new Map(searchColleges('', local, US, 5000).options.map((o) => [o.id, o]));
    expect(byId.get('commonapp')).toMatchObject({ researched: true, verifiedPrompts: true });
    expect(byId.get('uc-berkeley')).toMatchObject({ researched: true, verifiedPrompts: true });
    expect(byId.get('uiuc')).toMatchObject({ researched: true, verifiedPrompts: false });
    const stanford = [...byId.values()].find((o) => o.name === 'Stanford University')!;
    expect(stanford).toMatchObject({ researched: false, verifiedPrompts: false, place: 'Stanford, CA', website: 'https://www.stanford.edu/' });
    expect(stanford.id).toBe(`ipeds-${stanford.us![0]}`);
  });

  it('finds schools by name, and puts a researched match ahead of the rest', () => {
    expect(ids('common app')[0]).toBe('commonapp');
    expect(ids('UC Berkeley')[0]).toBe('uc-berkeley');
    expect(ids('ucla')).toEqual(['ucla']);
    const penn = ids('pennsylvania');
    expect(penn.slice(0, 2).sort()).toEqual(['penn', 'penn-state']);
    expect(penn.filter((id) => id === 'penn')).toHaveLength(1);
    expect(ids('stanford')[0]).toBe(`ipeds-${US.find((u) => u[1] === 'Stanford University')![0]}`);
    expect(ids('  MASSACHUSETTS   institute of tech ')[0]).toBe(`ipeds-${US.find((u) => u[1] === 'Massachusetts Institute of Technology')![0]}`);
  });

  it('finds a researched school by its official name, city or state too', () => {
    expect(ids('columbia university in the city')[0]).toBe('columbia');
    expect(ids('pennsylvania state')).toContain('penn-state');
    expect(ids('philadelphia')[0]).toBe('penn');
    expect(ids('seattle')[0]).toBe('uw');
  });

  it('finds schools by city or state, and ranks name matches above place matches', () => {
    const claremont = searchColleges('claremont', local, US).options;
    expect(claremont.map((o) => o.name)).toContain('Harvey Mudd College');
    const names = claremont.map((o) => o.name);
    expect(names.indexOf('Claremont McKenna College')).toBeLessThan(names.indexOf('Harvey Mudd College'));
    const vt = searchColleges('VT', local, US, 5000).options.filter((o) => !o.researched);
    expect(vt.length).toBeGreaterThan(3);
    expect(vt.slice(0, 3).every((o) => o.place.endsWith(', VT'))).toBe(true);
    expect(searchColleges('college vermont', local, US).options.every((o) => o.place.endsWith(', VT') || /vermont/i.test(o.name))).toBe(true);
  });

  it('returns nothing for text that matches no school', () => {
    expect(searchColleges('zzzzqqqq', local, US)).toEqual({ options: [], total: 0 });
  });
});

describe('a school picked from the big list', () => {
  const stanford = US.find((u) => u[1] === 'Stanford University')!;
  const id = `ipeds-${stanford[0]}`;

  it('reads the school number out of its id', () => {
    expect(unitidOf(id)).toBe(stanford[0]);
    expect(isIpedsId(id)).toBe(true);
    for (const other of ['penn', 'ipeds-', 'ipeds-12x', 'xipeds-12', '', null, undefined]) expect(isIpedsId(other), String(other)).toBe(false);
  });

  it('becomes an unverified row with no prompts and no guidance, pointing at the school website', () => {
    const row = ipedsCollegeRow(stanford, '2026-27');
    expect(row).toMatchObject({ id, name: 'Stanford University', verified: false, wants: '', promptsFrom: null, wantsSourceUrl: 'https://www.stanford.edu/', cycleYear: '2026-27' });
    expect(row.notes).toMatch(/prompts for this school have not been researched/i);
    expect(row.gradingWeights).toBeUndefined();
    expect(row.edited).toBeUndefined();
  });

  it('is found again from its id alone when a device has no row for it', () => {
    expect(findUsCollege(id, US)).toBe(stanford);
    expect(resolveCollege(id, colleges, US, '2026-27')).toEqual(ipedsCollegeRow(stanford, '2026-27'));
    expect(resolveCollege('ipeds-999999999', colleges, US, '2026-27')).toBeUndefined();
    expect(resolveCollege(id, colleges, [], '2026-27')).toBeUndefined();
    expect(resolveCollege(null, colleges, US, '2026-27')).toBeUndefined();
  });

  it('prefers the row this device already has', () => {
    const edited: CollegeRow = { ...ipedsCollegeRow(stanford, '2026-27'), name: 'Stanford', edited: true };
    expect(resolveCollege(id, [edited], US, '2026-27')).toBe(edited);
    expect(resolveCollege('penn', colleges, US, '2026-27')?.name).toBe('University of Pennsylvania');
  });

  it('gives the counselor no guidance about the school, only an instruction not to guess', () => {
    const notes = collegeNotes(ipedsCollegeRow(stanford, '2026-27'), seed.rubrics as never, []);
    expect(notes).toBe('College: Stanford University (2026-27 cycle).\nNothing this school has published about what it looks for is stored here. Do not state or guess what this school wants.');
  });
});
