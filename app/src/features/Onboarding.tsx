import { useState, type FormEvent } from 'react';
import { useStore } from '../store';
import { validEmail } from '../account';

export function Onboarding() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!validEmail(email)) return setError('Enter a valid email address.');
    try {
      await useStore.getState().signUp(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account.');
    }
  }

  return (
    <main className="flex h-full items-center justify-center p-6">
      <form onSubmit={submit} noValidate className="w-full max-w-sm">
        <img src="./icon.svg" alt="" className="-ml-2 h-20 w-20" />
        <h1 className="font-serif text-4xl">Scribe</h1>
        <p className="mt-3 text-muted">
          You talk, Scribe writes it down. Every word of the essay stays yours.
        </p>
        <label htmlFor="email" className="mt-8 block text-sm font-medium">
          Your email
        </label>
        <input
          id="email"
          type="email"
          autoFocus
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError('');
          }}
          placeholder="you@example.com"
          className="mt-2 w-full rounded-md border border-line bg-white px-3 py-2"
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" className="mt-4 w-full rounded-md bg-accent px-3 py-2 font-medium text-white">
          Create account
        </button>
        <p className="mt-4 text-sm text-muted">
          Asked once. It names your account on this Mac; nothing is sent anywhere.
        </p>
      </form>
    </main>
  );
}
