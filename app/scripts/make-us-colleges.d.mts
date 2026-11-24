// Types for make-us-colleges.mjs, so its unit tests are type-checked.
export type UsCollegeRow = [unitid: number, name: string, city: string, state: string, website: string];
export const STATES: Set<string>;
export const SECTOR_NAMES: Record<string, string>;
export function decodeCsv(bytes: Uint8Array): string;
export function parseCsv(text: string): Record<string, string>[];
export function normaliseWebsite(raw: unknown): string;
export function keep(record: Record<string, string>): boolean;
export function buildList(records: Record<string, string>[]): { rows: UsCollegeRow[]; sectors: Record<string, number> };
