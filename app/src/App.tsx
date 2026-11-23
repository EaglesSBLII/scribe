import { useEffect } from 'react';
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
import { useSettings } from './settings';
import { startStandby } from './dictation/session';
import { unlockAudio } from './voice/earcons';
import { MemoryScreen } from './features/MemoryScreen';
import { useMemory } from './memory/store';
import { ConfirmDialog } from './features/ConfirmDialog';
import { ToastBar } from './features/ToastBar';

export function App() {
  const ready = useStore((s) => s.ready);
  const account = useStore((s) => s.account);
  const historyOpen = useStore((s) => s.historyOpen);
  const counselorOpen = useCounselor((s) => s.open);
  const adminOpen = useColleges((s) => s.adminOpen);
  const memoryOpen = useMemory((s) => s.screenOpen);

  useEffect(() => {
    void useStore.getState().init();
  }, []);

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

  if (!ready) return null;
  if (!account) return <Onboarding />;

  return (
    <div className="flex h-full">
      {adminOpen ? (
        <CollegesAdmin />
      ) : memoryOpen ? (
        <MemoryScreen />
      ) : (
        <>
          <Sidebar />
          <Editor />
          {counselorOpen && <CounselorPanel />}
          {historyOpen && <History />}
        </>
      )}
      <ConfirmDialog />
      <ToastBar />
    </div>
  );
}
