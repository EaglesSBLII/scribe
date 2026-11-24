import { useEffect, useState } from 'react';
import { useStore } from './store';
import { flushPending } from './editorBus';
import { Onboarding } from './features/Onboarding';
import { Sidebar } from './features/Sidebar';
import { Editor } from './features/Editor';
import { History } from './features/History';
import { CounselorPanel } from './features/CounselorPanel';
import { useCounselor } from './llm/counselor';
import { CollegesAdmin } from './features/CollegesAdmin';
import { useColleges } from './colleges/store';
import { isIpedsId } from './colleges/usColleges';
import { useSettings } from './settings';
import { startStandby } from './dictation/session';
import { unlockAudio } from './voice/earcons';
import { startCoach } from './voice/coach';
import { SettingsScreen } from './features/SettingsScreen';
import { MemoryScreen } from './features/MemoryScreen';
import { useMemory } from './memory/store';
import { ConfirmDialog } from './features/ConfirmDialog';
import { ToastBar } from './features/ToastBar';
import { UpdateBanner } from './features/UpdateBanner';
import { SignIn } from './features/SignIn';
import { useUi } from './features/ui';
import { platform } from './platform';
import { startSync } from './sync';

export function App() {
  const ready = useStore((s) => s.ready);
  const account = useStore((s) => s.account);
  const historyOpen = useStore((s) => s.historyOpen);
  const counselorOpen = useCounselor((s) => s.open);
  const adminOpen = useColleges((s) => s.adminOpen);
  const collegesReady = useColleges((s) => s.ready);
  // Schools from the big US list that essays point at. Essays sync between devices; the college rows do not.
  const usCollegeIds = useStore((s) => [...new Set(s.essays.map((e) => e.collegeId).filter(isIpedsId))].sort().join(','));
  const memoryOpen = useMemory((s) => s.screenOpen);
  const settingsOpen = useSettings((s) => s.screenOpen);

  const navOpen = useUi((s) => s.navOpen);
  // On another device, nothing is shown until it has signed in to the Mac.
  const [mustSignIn, setMustSignIn] = useState(false);

  useEffect(() => {
    void (async () => {
      const session = await platform.session();
      if (!session.local && !session.signedIn) return setMustSignIn(true);
      if (!session.local && session.email) await useStore.getState().signInAs(session.email);
      else await useStore.getState().init();
      startSync(!session.local);
    })();
    startCoach();
  }, []);

  useEffect(() => {
    if (collegesReady && usCollegeIds) void useColleges.getState().resolveMissing(usCollegeIds.split(',')).catch(() => {});
  }, [collegesReady, usCollegeIds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useStore.getState().redo();
        else useStore.getState().undo();
      }
    };
    // Save anything still being typed when the window is hidden or closed.
    const onHide = () => flushPending();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  // With the wake word switched on, start waiting for "Jarvis" as soon as the
  // browser allows audio, which is at the first click or key press.
  const wakeWord = useSettings((s) => s.wakeWord);
  useEffect(() => {
    if (!account || !wakeWord) return;
    const begin = () => {
      unlockAudio();
      void startStandby();
    };
    begin();
    window.addEventListener('pointerdown', begin, { once: true });
    window.addEventListener('keydown', begin, { once: true });
    return () => {
      window.removeEventListener('pointerdown', begin);
      window.removeEventListener('keydown', begin);
    };
  }, [account, wakeWord]);

  if (mustSignIn) {
    return (
      <SignIn
        onSignedIn={async (email) => {
          await useStore.getState().signInAs(email);
          startSync(true);
          setMustSignIn(false);
        }}
      />
    );
  }
  if (!ready) return null;
  if (!account) return <Onboarding />;

  return (
    <div className="flex h-full">
      {adminOpen ? (
        <CollegesAdmin />
      ) : memoryOpen ? (
        <MemoryScreen />
      ) : settingsOpen ? (
        <SettingsScreen />
      ) : (
        <>
          <Sidebar />
          {navOpen && <button aria-label="Close the essay list" onClick={() => useUi.getState().setNavOpen(false)} className="fixed inset-0 z-30 bg-black/30 md:hidden" />}
          <Editor />
          {counselorOpen && <CounselorPanel />}
          {historyOpen && <History />}
        </>
      )}
      <ConfirmDialog />
      <ToastBar />
      <UpdateBanner />
    </div>
  );
}
