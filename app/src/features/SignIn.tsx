import { useState, type FormEvent } from 'react';
import { platform } from '../platform';
import { unlockAudio } from '../voice/earcons';

/** On another device (a phone): sign in to the account on the Mac. */
export function SignIn(props: { onSignedIn(email: string): void | Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // The first tap is also what lets the phone play sound later.
    unlockAudio();
    setBusy(true);
    setError('');
    try {
      await props.onSignedIn(await platform.login(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  const field = 'mt-2 w-full rounded-md border border-line bg-surface px-3 py-2';
  return (
    <main className="flex h-full items-center justify-center p-6">
      <form onSubmit={submit} noValidate className="w-full max-w-sm">
        <img src="./icon.svg" alt="" className="-ml-2 h-20 w-20" />
        <h1 className="font-serif text-4xl">Scribe</h1>
        <p className="mt-3 text-muted">Sign in to your Scribe on the Mac. Your essays stay on your own devices.</p>
        <label htmlFor="signin-email" className="mt-8 block text-sm font-medium">
          Email
        </label>
        <input id="signin-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
        <label htmlFor="signin-password" className="mt-4 block text-sm font-medium">
          Password
        </label>
        <input id="signin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="mt-4 w-full rounded-md bg-accent px-3 py-2 font-medium text-on-accent disabled:opacity-60">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="mt-4 text-sm text-muted">The password is the one you set on the Mac, in Settings, under “Phone access”.</p>
      </form>
    </main>
  );
}
