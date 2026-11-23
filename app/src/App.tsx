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
