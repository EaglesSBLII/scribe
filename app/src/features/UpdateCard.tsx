import { setAutoUpdate, updater as bridge, useUpdates } from './UpdateBanner';

const size = (n?: number) => (!n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/** Settings: the running version, and where a newer one is downloaded and switched to. Mac app only. */
export function UpdateCard() {
  const u = useUpdates();
  const updater = bridge;
  if (!updater) return null;

  const name = u.version ? `Scribe ${u.version}` : 'A new version of Scribe';
  const plain = 'rounded border border-line bg-paper px-3 py-1 text-sm disabled:opacity-50';
  const main = 'rounded bg-accent px-3 py-1 text-sm font-medium text-paper';
  const percent = u.percent ?? 0;

  return (
    <section aria-label="App update" data-testid="update-card" data-phase={u.phase} className="divide-y divide-line">
      <h3 className="pb-1 font-semibold">App update</h3>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2">
        <div className="min-w-0 max-w-md">
          <div className="text-sm font-medium">
            {u.phase === 'available' && `${name} is available`}
            {u.phase === 'downloading' && `Downloading ${name}`}
            {u.phase === 'ready' && `${name} is ready`}
            {u.phase === 'error' && 'The update did not work'}
            {(u.phase === 'idle' || u.phase === 'checking' || u.phase === 'up-to-date') && `You have Scribe ${u.current}`}
          </div>
          <div className="text-xs text-muted">
            {u.phase === 'idle' && (u.enabled ? 'Scribe looks for a newer version now and then.' : 'This is a development run, so it does not look for updates.')}
            {u.phase === 'checking' && 'Looking for a newer version.'}
            {u.phase === 'up-to-date' && 'This is the newest version.'}
            {u.phase === 'available' && `You have ${u.current}. ${u.size ? `The download is ${size(u.size)}. ` : ''}Your essays are kept.`}
            {u.phase === 'downloading' && (u.size ? `${size(u.received) || '0 MB'} of ${size(u.size)}` : 'Starting.')}
            {u.phase === 'ready' && 'Restart Scribe to switch to it. Your essays are kept.'}
          </div>
          {u.phase === 'error' && (
            <p role="alert" className="text-xs text-danger">
              {u.error}
            </p>
          )}
        </div>
        <div className="shrink-0">
          {(u.phase === 'idle' || u.phase === 'checking' || u.phase === 'up-to-date') && (
            <button onClick={() => void updater.check()} disabled={!u.enabled || u.phase === 'checking'} className={plain}>
              Check for updates
            </button>
          )}
          {u.phase === 'available' && (
            <button onClick={() => void updater.download()} className={main}>
              Download update
            </button>
          )}
          {u.phase === 'ready' && (
            <button onClick={() => void updater.install()} className={main}>
              Restart to finish
            </button>
          )}
          {u.phase === 'error' && (
            <button onClick={() => void updater.download()} className={plain}>
              Try again
            </button>
          )}
        </div>
        {u.phase === 'downloading' && (
          <div className="flex w-full items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-line">
              <div
                role="progressbar"
                aria-label="Download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
                style={{ width: `${Math.max(2, percent)}%` }}
              />
            </div>
            <span data-testid="update-percent" className="w-10 text-right text-sm font-medium tabular-nums">
              {percent}%
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-2">
        <div className="min-w-0 max-w-md">
          <div className="text-sm font-medium">Download updates automatically</div>
          <div className="text-xs text-muted">A new version is downloaded when it comes out. You still choose when to restart.</div>
        </div>
        <div className="shrink-0">
          <input type="checkbox" aria-label="Download updates automatically" checked={u.auto} disabled={!u.enabled} onChange={(e) => setAutoUpdate(e.target.checked)} />
        </div>
      </div>

      <p className="py-2 text-xs text-muted">
        Looking for and downloading an update is the only time Scribe contacts the internet. It asks GitHub for the newest version, and nothing you write is sent.
      </p>
    </section>
  );
}
