/**
 * Local account: an email entered once. No password and no network.
 * Chilaka's accounts live on a server; Scribe keeps the same idea on this machine only.
 */
import { db, type AccountRow } from './db/schema';
import { newId } from './doc/types';

const CURRENT = 'currentAccountId';

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export async function currentAccount(): Promise<AccountRow | null> {
  const row = await db.meta.get(CURRENT);
  if (!row || typeof row.value !== 'string') return null;
  return (await db.accounts.get(row.value)) ?? null;
}

/** Create the account, or reopen it if this email already has one on this machine. */
export async function createAccount(rawEmail: string): Promise<AccountRow> {
  const email = rawEmail.trim().toLowerCase();
  if (!validEmail(email)) throw new Error('Enter a valid email address.');
  return db.transaction('rw', db.accounts, db.meta, async () => {
    let account = await db.accounts.where('email').equals(email).first();
    if (!account) {
      account = { id: newId(), email, createdAt: Date.now() };
      await db.accounts.add(account);
    }
    await db.meta.put({ key: CURRENT, value: account.id });
    return account;
  });
}
