// Other devices (an iPhone) using this Mac as the brain.
//
// The server still listens on 127.0.0.1 only. A phone reaches it through a
// private tunnel (Tailscale) that forwards to that address. Any request that
// did not start on this Mac must be signed in with the account's password,
// which is set on the Mac itself. Nothing here talks to another machine.
//
// It also keeps the master copy of each account's writing, so devices can sync:
// one JSON file per account, every record with a revision number.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_DAYS = 30;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const MIN_PASSWORD = 8;
const COOKIE = 'scribe_session';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const fileKey = (email) => sha(email).slice(0, 24);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createRemote(dataDir) {
  const authFile = path.join(dataDir, 'auth.json');
  let auth = null;
  const stores = new Map();
  const failures = new Map();

  function write(file, value) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function read(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function loadAuth() {
    auth ??= read(authFile, { accounts: {}, sessions: {} });
    return auth;
  }

  const clean = (email) => String(email ?? '').trim().toLowerCase();

  /** True for a request made on this Mac itself, not one forwarded from another device. */
  function isLocal(req) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return false;
    const h = req.headers;
    return !h['x-forwarded-for'] && !h['x-forwarded-host'] && !h['x-forwarded-proto'] && !h.forwarded && !h['tailscale-user-login'];
  }

  function enabled() {
    return Object.keys(loadAuth().accounts).length > 0;
  }

  function status(email) {
    return { enabled: !!loadAuth().accounts[clean(email)] };
  }

  /** Set on the Mac only. Turns on access from other devices for this account. */
  function setPassword(rawEmail, password) {
    const email = clean(rawEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That account has no valid email.');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
    const a = loadAuth();
    const salt = crypto.randomBytes(16).toString('hex');
    a.accounts[email] = { salt, hash: hashPassword(password, salt) };
    // A new password signs every device out.
    for (const [key, s] of Object.entries(a.sessions)) if (s.email === email) delete a.sessions[key];
    write(authFile, a);
  }

  function disable(rawEmail) {
    const email = clean(rawEmail);
    const a = loadAuth();
    delete a.accounts[email];
    for (const [key, s] of Object.entries(a.sessions)) if (s.email === email) delete a.sessions[key];
    write(authFile, a);
  }

  /** Returns a session token, or throws. Five wrong passwords lock sign-in for 15 minutes. */
  function login(rawEmail, password, now = Date.now()) {
    const email = clean(rawEmail);
    const f = failures.get(email) ?? { count: 0, until: 0 };
    if (f.until > now) throw new Error('Too many wrong passwords. Try again in 15 minutes.');
    const a = loadAuth();
    const account = a.accounts[email];
    const given = hashPassword(String(password ?? ''), account?.salt ?? 'no-such-account');
    const ok = !!account && crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(account.hash, 'hex'));
    if (!ok) {
      f.count += 1;
      if (f.count >= MAX_FAILURES) {
        f.count = 0;
        f.until = now + LOCK_MS;
      }
      failures.set(email, f);
      throw new Error('Wrong email or password.');
    }
    failures.delete(email);
    const token = crypto.randomBytes(32).toString('hex');
    for (const [key, s] of Object.entries(a.sessions)) if (s.expires < now) delete a.sessions[key];
    a.sessions[sha(token)] = { email, expires: now + SESSION_DAYS * 86400_000 };
    write(authFile, a);
    return { token, email };
  }

  function tokenOf(req) {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
    return m ? m[1] : null;
  }

  /** The signed-in account for a request from another device, or null. */
  function sessionOf(req, now = Date.now()) {
    const token = tokenOf(req);
    if (!token) return null;
    const s = loadAuth().sessions[sha(token)];
    if (!s || s.expires < now || !loadAuth().accounts[s.email]) return null;
    return { email: s.email };
  }

  function logout(req) {
    const token = tokenOf(req);
    if (!token) return;
    const a = loadAuth();
    delete a.sessions[sha(token)];
    write(authFile, a);
  }

  function cookie(token, secure) {
    const life = token ? SESSION_DAYS * 86400 : 0;
    return `${COOKIE}=${token ?? ''}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${life}${secure ? '; Secure' : ''}`;
  }

  // ---- The master copy ----

  function storeOf(email) {
    const key = fileKey(email);
    if (!stores.has(key)) stores.set(key, read(path.join(dataDir, `store-${key}.json`), { rev: 0, records: {} }));
    return stores.get(key);
  }

  /**
   * One sync round for one device.
   *   since  the last revision this device has seen
   *   push   records it changed: { coll, key, value, updatedAt, deleted? }
   * The newer copy of a record wins. Returns what the device is missing,
   * including the winning copy of anything it pushed that lost.
   */
  function exchange(rawEmail, { since = 0, push = [] } = {}) {
    const email = clean(rawEmail);
    if (!email) throw new Error('No account.');
    const store = storeOf(email);
    const accepted = new Set();
    const lost = new Set();
    for (const p of Array.isArray(push) ? push : []) {
      if (!p || typeof p.coll !== 'string' || typeof p.key !== 'string') continue;
      const id = `${p.coll}|${p.key}`;
      const updatedAt = Number(p.updatedAt) || 0;
      const have = store.records[id];
      if (have && have.updatedAt > updatedAt) {
        lost.add(id);
        continue;
      }
      store.rev += 1;
      store.records[id] = { coll: p.coll, key: p.key, value: p.deleted ? null : p.value, deleted: !!p.deleted, updatedAt, rev: store.rev };
      accepted.add(id);
    }
    if (accepted.size) write(path.join(dataDir, `store-${fileKey(email)}.json`), store);
    const pull = [];
    for (const [id, r] of Object.entries(store.records)) {
      if (accepted.has(id)) continue;
      if (r.rev > since || lost.has(id)) pull.push(r);
    }
    pull.sort((a, b) => a.rev - b.rev);
    return { rev: store.rev, pull, accepted: [...accepted] };
  }

  return { isLocal, enabled, status, setPassword, disable, login, sessionOf, logout, cookie, exchange };
}

module.exports = { createRemote };
