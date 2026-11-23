/**
 * Loads the starter college data into the local database. Entries the user
 * has edited are never overwritten by a newer seed.
 */
import { db, type CollegeRow, type PrincipleRow, type PromptRow, type RubricRow } from '../db/schema';
import seedJson from './seed.json';

export interface SeedData {
  /** Bump when the seed changes, so installed copies pick up the new entries. */
  version: string;
  retrievedOn: string;
  colleges: CollegeRow[];
  prompts: PromptRow[];
  rubrics: RubricRow[];
  principles: PrincipleRow[];
}

export const SEED = seedJson as SeedData;

export async function applySeed(seed: SeedData = SEED): Promise<void> {
  const current = await db.meta.get('seedVersion');
  if (current?.value === seed.version) return;
  await db.transaction('rw', [db.colleges, db.prompts, db.rubrics, db.principles, db.meta], async () => {
    // An entry the user has edited is kept as they left it.
    for (const row of seed.colleges) if (!(await db.colleges.get(row.id))?.edited) await db.colleges.put(row);
    for (const row of seed.prompts) if (!(await db.prompts.get(row.id))?.edited) await db.prompts.put(row);
    for (const row of seed.rubrics) if (!(await db.rubrics.get(row.id))?.edited) await db.rubrics.put(row);
    for (const row of seed.principles) if (!(await db.principles.get(row.id))?.edited) await db.principles.put(row);
    await db.meta.put({ key: 'seedVersion', value: seed.version });
  });
}
