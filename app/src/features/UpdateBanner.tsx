import { useState } from 'react';
import { create } from 'zustand';
import { platform, type UpdateState } from '../platform';

/**
 * What the Mac app's updater last reported, shared by the banner here and the
 * card in Settings. In a browser there is no updater and this never changes.
 */
interface Updates extends UpdateState {
  /** False in a browser and in a development run. */
  enabled: boolean;
  /** The version that is running now. */
  current: string;
  auto: boolean;
}

export const updater = platform.updater;

export const useUpdates = create<Updates>(() => ({ phase: 'idle', enabled: false, current: '', auto: false }));

if (updater) {
  // The whole state is replaced each time, so a cleared error does not linger.
  const report = (state: UpdateState) => useUpdates.setState((old) => ({ ...state, enabled: old.enabled, current: old.current, auto: old.auto }), true);
  updater.onState(report);
  void updater.state().then(report).catch(() => {});
  void updater.info().then((info) => useUpdates.setState(info)).catch(() => {});
}

export function setAutoUpdate(on: boolean) {
  useUpdates.setState({ auto: on });
  void updater?.setAuto(on).then((auto) => useUpdates.setState({ auto }));
}

/** A small notice at the top of the window when a newer Scribe exists or is ready to switch to. */
export function UpdateBanner() {
  const { phase, version, percent, error } = useUpdates();
  // "Later" hides the notice until the next step (downloaded, or a newer version).
  const [hidden, setHidden] = useState('');
  if (!updater || (phase !== 'available' && phase !== 'downloading' && phase !== 'ready' && phase !== 'error')) return null;
  const key = `${phase} ${version ?? ''}`;
  if (hidden === key) return null;

  const name = version ? `Scribe ${version}` : 'A new version of Scribe';
  const main = 'rounded-md bg-accent px-2.5 py-1 font-medium text-paper';
  const later = (
    <button onClick={() => setHidden(key)} className="text-muted underline">
      Later
    </button>
  );

  return (
    <div
      role="status"
      data-testid="update-banner"
      data-phase={phase}
      className="fixed left-1/2 top-2 z-40 flex max-w-[92vw] -translate-x-1/2 items-center gap-3 rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-ink shadow-lg"
    >
      {phase === 'available' && (
        <>
          <span>{name} is available.</span>
          <button onClick={() => void updater.download()} className={main}>
            Update
          </button>
          {later}
        </>
      )}
      {phase === 'downloading' && (
        <span className="tabular-nums">
          Downloading {name}: {percent ?? 0}%
        </span>
      )}
      {phase === 'ready' && (
        <>
          <span>{name} is ready.</span>
          <button onClick={() => void updater.install()} className={main}>
            Restart
          </button>
          {later}
        </>
      )}
      {phase === 'error' && (
        <>
          <span className="text-danger">Update problem: {error}</span>
          <button onClick={() => void updater.download()} className={main}>
            Try again
          </button>
          {later}
        </>
      )}
    </div>
  );
}
