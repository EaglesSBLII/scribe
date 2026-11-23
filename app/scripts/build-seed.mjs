// Builds src/colleges/seed.json from the research files in src/colleges/research/.
// Run with: node scripts/build-seed.mjs
// It checks every entry and downgrades anything that claims to be verified
// without an official source address. It never adds or rewrites content.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../src/colleges');
const files = fs.readdirSync(path.join(dir, 'research')).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) throw new Error('No research files found.');

const VERSION = '2026-27.1';
const official = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname.endsWith('.edu') || hostname === 'commonapp.org' || hostname.endsWith('.commonapp.org'));
  } catch {
    return false;
  }
};

const seed = { version: VERSION, retrievedOn: '', colleges: [], prompts: [], rubrics: [], principles: [] };
const problems = [];
const downgraded = [];
const leftOut = [];
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const int = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);

/** Verified only stands with an official https source. */
function checked(kind, id, verified, url, notes) {
  if (verified === true && !official(url)) {
    downgraded.push(`${kind} ${id}: no official source address`);
    return { verified: false, notes: [str(notes), 'Marked unverified: no official source address.'].filter(Boolean).join(' ') };
  }
  return { verified: verified === true, notes: str(notes) };
}

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'research', file), 'utf8'));
  seed.retrievedOn = str(data.retrievedOn) > seed.retrievedOn ? str(data.retrievedOn) : seed.retrievedOn;
  for (const c of data.colleges ?? []) {
    if (!str(c.id) || !str(c.name)) { problems.push(`${file}: college without id or name`); continue; }
    seed.colleges.push({
      id: str(c.id), name: str(c.name), appliesVia: str(c.appliesVia), promptsFrom: str(c.promptsFrom) || null,
      wants: str(c.wants), wantsSourceUrl: str(c.wantsSourceUrl), cycleYear: str(c.cycleYear) || '2026-27',
      ...checked('college', c.id, c.verified, c.wantsSourceUrl, c.notes),
    });
  }
  for (const p of data.prompts ?? []) {
    if (!str(p.id) || !str(p.collegeId)) { problems.push(`${file}: prompt ${p.id ?? '?'} has no id or college`); continue; }
    // A question whose wording the school does not publish is left out rather than guessed.
    if (!str(p.text)) { leftOut.push(`${p.id} (${str(p.label)}): the official page does not print the wording`); continue; }
    seed.prompts.push({
      id: str(p.id), collegeId: str(p.collegeId), label: str(p.label) || str(p.id), text: str(p.text), minWords: int(p.minWords),
      wordLimit: int(p.wordLimit), instructions: str(p.instructions), sourceUrl: str(p.sourceUrl), cycleYear: str(p.cycleYear) || '2026-27',
      ...checked('prompt', p.id, p.verified, p.sourceUrl, p.notes),
    });
  }
  for (const r of data.rubrics ?? []) {
    const criteria = (r.criteria ?? []).filter((c) => str(c.name)).map((c) => ({ name: str(c.name), description: str(c.description) }));
    if (!str(r.id) || !str(r.collegeId) || criteria.length === 0) { problems.push(`${file}: criteria ${r.id ?? '?'} incomplete; left out`); continue; }
    seed.rubrics.push({
      id: str(r.id), collegeId: str(r.collegeId), title: str(r.title), criteria, sourceUrl: str(r.sourceUrl), cycleYear: str(r.cycleYear) || '2026-27',
      ...checked('criteria', r.id, r.verified, r.sourceUrl, r.notes),
    });
  }
  for (const p of data.principles ?? []) {
    if (!str(p.id) || !str(p.text)) continue;
    const c = checked('principle', p.id, p.verified, p.sourceUrl, '');
    seed.principles.push({ id: str(p.id), text: str(p.text), sourceName: str(p.sourceName), sourceUrl: str(p.sourceUrl), verified: c.verified });
  }
}

// ---- Reviewed adjustments (22 Nov 2026). Each one is recorded in the entry's notes. ----
const adjustments = [];
const note = (row, text) => { row.notes = [row.notes, text].filter(Boolean).join(' '); };
const college = (id) => seed.colleges.find((c) => c.id === id);

// 1. UW's page reprints the seven Common App prompts. Keep one copy (under Common App) and
//    point UW at it. Where UW's text matches Common App's, take the word limits UW's page
//    states, because the commonapp.org pages that could be opened did not state them.
const uw = college('uw');
if (uw) {
  let matched = 0;
  for (let n = 1; n <= 7; n++) {
    const theirs = seed.prompts.find((p) => p.id === `uw-${n}`);
    const ours = seed.prompts.find((p) => p.id === `commonapp-${n}`);
    if (!theirs || !ours) continue;
    // Same words; only the style of apostrophes and quotation marks may differ.
    const plain = (s) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
    if (plain(theirs.text) === plain(ours.text)) {
      matched++;
      if (!ours.wordLimit && theirs.wordLimit) {
        ours.minWords = theirs.minWords;
        ours.wordLimit = theirs.wordLimit;
        note(ours, `Word limits (${theirs.minWords}-${theirs.wordLimit}) are as stated on the University of Washington admissions page (${theirs.sourceUrl}); the commonapp.org pages opened did not state them.`);
      }
    } else problems.push(`uw-${n} and commonapp-${n} do not have the same text; check both`);
    seed.prompts.splice(seed.prompts.indexOf(theirs), 1);
  }
  uw.promptsFrom = 'commonapp';
  adjustments.push(`UW: ${matched} of 7 Common App prompts matched word for word; duplicates removed, limits copied to Common App`);
}

// 2. Penn State accepts the Common App essay as its optional personal statement; its own
//    MyPennState wording is not published, so the Common App prompts are what can be offered.
const pennState = college('penn-state');
if (pennState && !pennState.promptsFrom) {
  pennState.promptsFrom = 'commonapp';
  note(pennState, 'Linked to the Common App prompts because Penn State accepts the Common App essay as its optional Personal Statement. The MyPennState wording is not published on public pages.');
  adjustments.push('Penn State: linked to the Common App prompts');
}

// 3. A note that was read only through a summarising tool, not from the page text, is not verified.
for (const c of seed.colleges) {
  if (c.verified && /WebFetch tool only|model summary/i.test(c.notes)) {
    c.verified = false;
    note(c, 'Marked unverified: the page text itself could not be read.');
    adjustments.push(`${c.id}: marked unverified (read through a summary only)`);
  }
}

// Structural checks.
for (const key of ['colleges', 'prompts', 'rubrics', 'principles']) {
  const ids = seed[key].map((x) => x.id);
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) problems.push(`duplicate ${key} id: ${id}`);
}
const collegeIds = new Set(seed.colleges.map((c) => c.id));
for (const p of seed.prompts) if (!collegeIds.has(p.collegeId)) problems.push(`prompt ${p.id} points at missing college ${p.collegeId}`);
for (const r of seed.rubrics) if (!collegeIds.has(r.collegeId)) problems.push(`criteria ${r.id} points at missing college ${r.collegeId}`);
for (const c of seed.colleges) if (c.promptsFrom && !collegeIds.has(c.promptsFrom)) problems.push(`${c.id} shares prompts with missing ${c.promptsFrom}`);

fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(seed, null, 2) + '\n');

const count = (list) => `${list.length} (${list.filter((x) => x.verified).length} verified, ${list.filter((x) => !x.verified).length} unverified)`;
console.log(`Wrote seed.json version ${VERSION} from ${files.join(', ')}`);
console.log(`colleges:   ${count(seed.colleges)}`);
console.log(`prompts:    ${count(seed.prompts)}`);
console.log(`criteria:   ${count(seed.rubrics)}`);
console.log(`principles: ${count(seed.principles)}`);
for (const c of seed.colleges) {
  const own = seed.prompts.filter((p) => p.collegeId === c.id || p.collegeId === c.promptsFrom);
  console.log(`  ${c.verified ? ' ' : '?'} ${c.id.padEnd(18)} ${String(own.length).padStart(2)} prompts${c.promptsFrom ? ` (incl. shared from ${c.promptsFrom})` : ''}`);
}
if (leftOut.length) console.log(`Left out:\n  ${leftOut.join('\n  ')}`);
if (adjustments.length) console.log(`Reviewed adjustments:\n  ${adjustments.join('\n  ')}`);
if (downgraded.length) console.log(`Downgraded to unverified:\n  ${downgraded.join('\n  ')}`);
if (problems.length) {
  console.error(`Problems:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
}
