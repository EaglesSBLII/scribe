/**
 * Almost every four-year US college, by name, city, state and website, from
 * the federal IPEDS directory. The list is large, so it is only loaded when
 * someone opens the college picker or an essay points at one of its schools.
 * It holds no essay prompts: those are never made up.
 */
import type { CollegeRow } from '../db/schema';

/** One school in us-colleges.json. */
export type UsCollege = readonly [unitid: number, name: string, city: string, state: string, website: string];

export interface UsCollegeFile {
  sourceFile: string;
  ipedsYear: number;
  generatedOn: string;
  count: number;
  rows: UsCollege[];
}

let loading: Promise<UsCollegeFile> | null = null;

/** Reads the big list the first time it is needed. Kept out of the main bundle. */
export function loadUsColleges(): Promise<UsCollegeFile> {
  loading ??= import('./us-colleges.json')
    .then((m) => m.default as unknown as UsCollegeFile)
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

const ID = /^ipeds-(\d+)$/;
export const ipedsId = (unitid: number) => `ipeds-${unitid}`;
/** The federal school number in an id like "ipeds-166027", or null for any other id. */
export const unitidOf = (id: string | null | undefined): number | null => {
  const m = ID.exec(id ?? '');
  return m ? Number(m[1]) : null;
};
export const isIpedsId = (id: string | null | undefined): id is string => unitidOf(id) !== null;

/**
 * The researched entries that are the same school as a directory row, where
 * the two names differ too much to match by name (Columbia, UW, Penn State, UCLA).
 */
export const RESEARCHED_UNITIDS: Readonly<Record<string, number>> = {
  penn: 215062,
  columbia: 190150,
  uchicago: 144050,
  'uc-berkeley': 110635,
  'uc-davis': 110644,
  'uc-irvine': 110653,
  ucla: 110662,
  'uc-merced': 445188,
  'uc-riverside': 110671,
  'uc-san-diego': 110680,
  'uc-santa-barbara': 110705,
  'uc-santa-cruz': 110714,
  uiuc: 145637,
  uw: 236948,
  'penn-state': 214777,
};

/** A name reduced to what matters for telling two schools apart: "UC Berkeley" and "University of California-Berkeley" come out the same. */
export function normaliseName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/^uc\b/, 'university of california')
    .replace(/ main campus$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The federal school numbers that must not be offered from the big list,
 * because the same school is already in the local database. The local entry wins.
 */
export function hiddenUnitids(local: readonly CollegeRow[], us: readonly UsCollege[]): Set<number> {
  const hidden = new Set<number>();
  const names = new Set<string>();
  for (const c of local) {
    const own = unitidOf(c.id) ?? RESEARCHED_UNITIDS[c.id];
    if (own) hidden.add(own);
    if (!isIpedsId(c.id)) names.add(normaliseName(c.name));
  }
  // A name shared by several schools (there are two called "Columbia College")
  // cannot say which one a local entry means, so none of them is hidden.
  const byName = new Map<string, number[]>();
  for (const u of us) {
    const key = normaliseName(u[1]);
    if (!names.has(key)) continue;
    byName.set(key, [...(byName.get(key) ?? []), u[0]]);
  }
  for (const ids of byName.values()) if (ids.length === 1) hidden.add(ids[0]);
  return hidden;
}

/** The big list without the schools the local database already has. */
export function withoutLocal(us: readonly UsCollege[], local: readonly CollegeRow[]): UsCollege[] {
  const hidden = hiddenUnitids(local, us);
  return us.filter((u) => !hidden.has(u[0]));
}

export const UNRESEARCHED_NOTE =
  'From the federal IPEDS directory: name, city, state and website only. Essay prompts for this school have not been researched.';

/** The local database row for a school picked from the big list. It carries no prompts and no guidance. */
export function ipedsCollegeRow(u: UsCollege, cycleYear: string): CollegeRow {
  return {
    id: ipedsId(u[0]),
    name: u[1],
    appliesVia: '',
    promptsFrom: null,
    wants: '',
    wantsSourceUrl: u[4],
    cycleYear,
    verified: false,
    notes: `${UNRESEARCHED_NOTE} ${u[2]}, ${u[3]}.`,
  };
}

/** Finds the school an id like "ipeds-166027" points at. */
export function findUsCollege(id: string | null | undefined, us: readonly UsCollege[]): UsCollege | undefined {
  const unitid = unitidOf(id);
  return unitid === null ? undefined : us.find((u) => u[0] === unitid);
}

/**
 * The row for an essay's college: the local one when there is one, otherwise
 * built from the big list (essays reach other devices, the local college
 * database does not).
 */
export function resolveCollege(
  id: string | null | undefined,
  local: readonly CollegeRow[],
  us: readonly UsCollege[],
  cycleYear: string,
): CollegeRow | undefined {
  if (!id) return undefined;
  const row = local.find((c) => c.id === id);
  if (row) return row;
  const found = findUsCollege(id, us);
  return found ? ipedsCollegeRow(found, cycleYear) : undefined;
}

const STATE_NAMES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
  NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** A local entry as the picker sees it. */
export interface LocalCollege {
  college: CollegeRow;
  /** At least one of its prompts is confirmed on an official page. */
  verifiedPrompts: boolean;
}

/** One line in the college picker. */
export interface CollegeOption {
  id: string;
  name: string;
  /** "City, ST" when known. */
  place: string;
  website: string;
  /** In the local database with researched content, as opposed to name and website only. */
  researched: boolean;
  verifiedPrompts: boolean;
  /** Set for a school that is not in the local database yet. */
  us?: UsCollege;
}

export interface CollegeSearch {
  options: CollegeOption[];
  /** How many schools matched before the list was cut to the limit. */
  total: number;
}

const plain = (s: string) => normaliseName(s);
/** Every word of the query must start a word of the text. */
const wordsMatch = (text: string, tokens: string[]) => tokens.every((t) => ` ${text}`.includes(` ${t}`));

/**
 * 0: the name starts with what was typed. 1: a word of the name does.
 * 2: the words are all in the name. 3: found by city or state only. -1: no match.
 */
function rank(q: string, tokens: string[], names: string[], place: string, state: string): number {
  if (tokens.length === 0) return 0;
  let best = -1;
  const better = (r: number) => {
    if (best < 0 || r < best) best = r;
  };
  for (const name of names) {
    if (name.startsWith(q)) better(0);
    else if (` ${name}`.includes(` ${q}`)) better(1);
    else if (wordsMatch(name, tokens)) better(2);
  }
  // Typing exactly a state ("PA" or "Pennsylvania") lists that state's schools near the top.
  if (state && (q === state.toLowerCase() || q === plain(STATE_NAMES[state] ?? ''))) better(1);
  if (best < 0 && wordsMatch(`${names.join(' ')} ${place}`, tokens)) better(3);
  return best;
}

/**
 * The schools to offer for what has been typed, by name, city or state.
 * Researched entries come first, then the best matches, then by name.
 */
export function searchColleges(query: string, local: readonly LocalCollege[], us: readonly UsCollege[], limit = 50): CollegeSearch {
  const q = plain(query);
  const tokens = q ? q.split(' ') : [];
  const byUnitid = new Map(us.map((u) => [u[0], u]));
  const hidden = hiddenUnitids(local.map((l) => l.college), us);
  const found: { option: CollegeOption; tier: number; rank: number }[] = [];

  for (const { college, verifiedPrompts } of local) {
    // The directory row for the same school, so "Philadelphia" finds Penn.
    const twin = byUnitid.get(unitidOf(college.id) ?? RESEARCHED_UNITIDS[college.id] ?? -1);
    const names = [plain(college.name), ...(twin ? [plain(twin[1])] : [])];
    const place = twin ? plain(`${twin[2]} ${twin[3]} ${STATE_NAMES[twin[3]] ?? ''}`) : '';
    const r = rank(q, tokens, names, place, twin?.[3] ?? '');
    if (r < 0) continue;
    const researched = !isIpedsId(college.id) || verifiedPrompts;
    found.push({
      option: {
        id: college.id, name: college.name, place: twin ? `${twin[2]}, ${twin[3]}` : '',
        website: twin?.[4] ?? '', researched, verifiedPrompts,
      },
      tier: researched ? 0 : 1,
      rank: r,
    });
  }

  for (const u of us) {
    if (hidden.has(u[0])) continue;
    const r = rank(q, tokens, [plain(u[1])], plain(`${u[2]} ${u[3]} ${STATE_NAMES[u[3]] ?? ''}`), u[3]);
    if (r < 0) continue;
    found.push({
      option: { id: ipedsId(u[0]), name: u[1], place: `${u[2]}, ${u[3]}`, website: u[4], researched: false, verifiedPrompts: false, us: u },
      tier: 1,
      rank: r,
    });
  }

  found.sort((a, b) => a.tier - b.tier || a.rank - b.rank || a.option.name.localeCompare(b.option.name) || a.option.id.localeCompare(b.option.id));
  return { options: found.slice(0, Math.max(0, limit)).map((f) => f.option), total: found.length };
}
