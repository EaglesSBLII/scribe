import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Send, Square, X } from 'lucide-react';
import { useStore } from '../store';
import { useSettings } from '../settings';
import { useCounselor } from '../llm/counselor';
import { judgedChecks, type JudgedChecks } from '../llm/finish';
import { splitQuotes } from '../llm/guard';
import { locate, mechanicalChecks, type Finding } from '../checks';
import { exportEssay, type ExportFormat } from '../export';
import { platform } from '../platform';
import { toggleDictation, useDictation } from '../dictation/session';
import { docText } from '../doc/types';
import type { EssayRow } from '../db/schema';
import { GradeCard } from './GradeCard';
import { useMemory } from '../memory/store';
import { viewOf, voiceFor } from './counselorView';
import { usePaper } from '../paper/store';
import { hasPaperParts } from '../paper/layout';

const QUICK_ASKS = ['What do you think about this?', 'What should I include?', 'Does this answer the prompt?'];

/** A counselor reply. Quotes of the student's own words are marked as theirs. */
function Reply({ text, studentText }: { text: string; studentText: string }) {
  return (
    <>
      {splitQuotes(text, studentText).map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : (
          <q key={i} title={part.yours ? 'Your words' : 'An example, not your words'} className={part.yours ? 'rounded bg-accent-soft px-0.5 font-serif' : 'italic text-muted'}>
            {part.text}
          </q>
        ),
      )}
    </>
  );
}

function ModelPicker() {
  const model = useSettings((s) => s.llmModel);
  const [models, setModels] = useState<string[] | null>(null);
  useEffect(() => {
    void platform.llmModels().then(setModels);
  }, []);
  const options = models && !models.includes(model) ? [model, ...models] : (models ?? [model]);
  return (
    <label className="flex items-center gap-1 text-xs text-muted">
      Model
      <select
        aria-label="Counselor model"
        value={model}
        onChange={(e) => void useSettings.getState().setModel(e.target.value)}
        className="max-w-36 rounded border border-line bg-surface px-1 py-0.5"
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      {models?.length === 0 && <span className="text-danger">Ollama is not running</span>}
    </label>
  );
}

function FinishChecks({ essay }: { essay: EssayRow }) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [judged, setJudged] = useState<JudgedChecks | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    setRunning(true);
    setError('');
    setJudged(null);
    setFindings(mechanicalChecks(essay.doc, essay.wordLimit ?? null));
    try {
      setJudged(await judgedChecks(viewOf(essay)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The prompt and typo checks could not run.');
    } finally {
      setRunning(false);
    }
  }

  const row = (level: 'ok' | 'warn', where: string | undefined, text: React.ReactNode, key: string) => (
    <li key={key} className="flex gap-2">
      <span aria-hidden="true" className={level === 'ok' ? 'text-accent' : 'text-danger'}>{level === 'ok' ? '✓' : '!'}</span>
      <span>
        {where && <span className="mr-1 font-medium">{where}</span>}
        {text}
      </span>
    </li>
  );

  return (
    <div className="space-y-3">
      <button onClick={() => void run()} disabled={running} className="w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent">
        {running ? 'Checking…' : 'Run final checks'}
      </button>
      {findings && (
        <ul data-testid="final-checks" className="space-y-1.5 text-sm">
          {findings.map((f, i) => row(f.level, f.where, f.text, `m${i}`))}
          {judged?.answersPrompt &&
            row(
              judged.answersPrompt.verdict === 'yes' ? 'ok' : 'warn',
              undefined,
              <>
                Answers the prompt: {judged.answersPrompt.verdict}. {judged.answersPrompt.why}
                {judged.answersPrompt.quote && <q className="ml-1 font-serif">{judged.answersPrompt.quote}</q>}
              </>,
              'prompt',
            )}
          {judged && !judged.answersPrompt && row('warn', undefined, 'No prompt is set, so “answers the prompt” was not checked.', 'noprompt')}
          {judged?.typos.map((t, i) => row('warn', locate(essay.doc, t.quote), <><q className="font-serif">{t.quote}</q> {t.issue}</>, `t${i}`))}
          {judged && judged.typos.length === 0 && row('ok', undefined, 'No typos found by the model.', 'notypos')}
        </ul>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {findings && <p className="text-xs text-muted">These are flagged for you to look at. Scribe does not fix them.</p>}
      <ExportBar essay={essay} />
    </div>
  );
}

/** Export, in Scribe's default layout or in a format learned from a sample paper. */
function ExportBar({ essay }: { essay: EssayRow }) {
  const { samples, busy, error } = usePaper();
  const chosen = samples.find((s) => s.id === essay.formatId);
  const paper = hasPaperParts(essay.doc);
  const store = useStore.getState();

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-1 text-muted">
          Format
          <select
            aria-label="Paper format"
            value={chosen?.id ?? ''}
            onChange={(e) => store.setFormat(essay.id, e.target.value || null)}
            className="min-w-0 flex-1 rounded border border-line bg-surface px-1 py-0.5 text-ink"
          >
            <option value="">Scribe default</option>
            {samples.map((s) => (
              <option key={s.id} value={s.id}>
                Like “{s.format.name}”
              </option>
            ))}
          </select>
        </label>
        <label className={`shrink-0 cursor-pointer rounded-md border border-line bg-surface px-2 py-1 ${busy ? 'opacity-50' : ''}`}>
          {busy ? 'Reading…' : 'Learn from a sample'}
          <input
            type="file"
            aria-label="Upload a sample paper"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="sr-only"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              const id = await usePaper.getState().learn(file);
              if (id) store.setFormat(essay.id, id);
            }}
          />
        </label>
      </div>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {chosen && (
        <div data-testid="format-notes" className="rounded-md bg-surface p-2 text-xs shadow-sm">
          <p className="font-medium">Learned from {chosen.fileName}. Only its formatting was kept.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
            {chosen.format.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <button
            onClick={() => {
              store.setFormat(essay.id, null);
              void usePaper.getState().remove(chosen.id);
            }}
            className="mt-1 text-danger underline"
          >
            Forget this format
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-muted">Export</span>
        {(['docx', 'pdf', 'txt'] as ExportFormat[]).map((f) => (
          <button key={f} onClick={() => void exportEssay(essay.title, essay.doc, f, chosen?.format ?? null)} className="rounded-md border border-line bg-surface px-2 py-1">
            .{f}
          </button>
        ))}
      </div>
      {(paper || chosen) && (
        <p className="text-xs text-muted">
          With mathematics or a learned format, .pdf opens the print window: choose “Save as PDF” there. In .docx, equations are written on one line in
          ordinary characters.
        </p>
      )}
    </div>
  );
}

export function CounselorPanel() {
  const essay = useStore((s) => s.essays.find((e) => e.id === s.currentId));
  const { messages, stories, streaming, busy, error } = useCounselor();
  const listening = useDictation((s) => s.on && s.target === 'counselor');
  const turn = useDictation((s) => s.turn);
  const [draft, setDraft] = useState('');
  const [gradeOpen, setGradeOpen] = useState(false);
  const memoryRows = useMemory((s) => s.rows);
  const memoryOn = useMemory((s) => s.enabled);
  const memoryBusy = useMemory((s) => s.busy);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streaming, turn]);

  if (!essay) return null;
  const counselor = useCounselor.getState();
  const view = viewOf(essay);
  const voice = voiceFor(essay);
  const ratingOf = (text: string) => memoryRows.find((r) => r.kind === 'feedback' && r.text === text)?.verdict;
  const studentText = [docText(essay.doc), ...messages.filter((m) => m.role === 'user').map((m) => m.text)].join('\n');
  const send = (text: string) => {
    setDraft('');
    void counselor.ask(text, view);
  };

  return (
    <aside
      aria-label="Counselor"
      className="fixed inset-x-0 bottom-0 z-30 flex h-[72dvh] flex-col rounded-t-2xl border-t border-line bg-panel shadow-2xl md:static md:h-auto md:w-96 md:shrink-0 md:rounded-none md:border-l md:border-t-0 md:shadow-none"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <h2 className="font-semibold">Counselor</h2>
        <ModelPicker />
        <button aria-label="Close counselor" onClick={() => counselor.setOpen(false)} className="rounded p-1 text-muted hover:bg-raised">
          <X size={16} />
        </button>
      </div>

      <div className="space-y-3 border-b border-line px-4 pb-3">
        <label className="block text-xs font-medium text-muted">
          Essay prompt
          <textarea
            key={`${essay.id}:${essay.promptId ?? ''}:${essay.promptText ?? ''}`}
            aria-label="Essay prompt"
            rows={2}
            defaultValue={essay.promptText ?? ''}
            placeholder="Paste the question this essay answers."
            onBlur={(e) => useStore.getState().setPromptText(essay.id, e.target.value)}
            className="mt-1 w-full resize-y rounded border border-line bg-surface px-2 py-1 text-sm font-normal text-ink"
          />
        </label>

        {essay.stage === 'brainstorm' && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <button disabled={busy} onClick={() => void counselor.startBrainstorm(view, { spoken: useDictation.getState().on })} className="flex-1 rounded-md bg-accent px-2 py-1.5 text-sm font-medium text-on-accent">
                {messages.length ? 'Ask me another' : 'Start brainstorm'}
              </button>
              <button disabled={busy} onClick={() => void counselor.mapStories(view)} className="flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm">
                Map my stories
              </button>
            </div>
            {stories.length > 0 && (
              <ul data-testid="stories" className="space-y-2">
                {stories.map((s) => (
                  <li key={s.id} className="rounded-md bg-surface p-2 text-sm shadow-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{s.title}</span>
                      <span className="shrink-0 text-xs text-muted" title="How well this story fits the prompt">
                        Fit {s.fit}/5
                      </span>
                    </div>
                    <q className="block font-serif text-ink">{s.quote}</q>
                    <p className="mt-1 text-xs text-muted">{s.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {essay.stage === 'draft' && <p className="text-sm text-muted">Drafting: just talk. The counselor stays quiet unless you ask.</p>}
        {essay.stage === 'refine' && (
          <div className="flex flex-wrap gap-1.5">
            {QUICK_ASKS.map((q) => (
              <button key={q} disabled={busy} onClick={() => send(q)} className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs">
                {q}
              </button>
            ))}
          </div>
        )}
        {essay.stage === 'finish' && <FinishChecks essay={essay} />}
        {(essay.stage === 'refine' || essay.stage === 'finish') && memoryOn && (
          <details data-testid="voice-check">
            <summary className="cursor-pointer text-sm font-medium">
              Voice check{voice.outliers.length ? ` (${voice.outliers.length})` : ''}
            </summary>
            <div className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1 text-sm">
              {!voice.profile.ready ? (
                <p className="text-muted">Scribe needs more of your writing (about 120 words) before it can tell what sounds like you.</p>
              ) : voice.outliers.length === 0 ? (
                <p className="text-muted">Nothing here sounds unlike the rest of your writing.</p>
              ) : (
                voice.outliers.map((o) => (
                  <div key={o.where}>
                    <p>
                      <span className="mr-1 text-xs font-medium text-muted">{o.where}</span>
                      <q className="font-serif">{o.text}</q>
                    </p>
                    <p className="text-xs text-muted">{o.why}</p>
                  </div>
                ))
              )}
              {voice.profile.ready && !memoryRows.some((r) => r.kind === 'tone') && (
                <button
                  disabled={memoryBusy}
                  onClick={() =>
                    void useMemory.getState().refreshFromWriting(
                      useStore.getState().essays.filter((x) => x.accountId === essay.accountId).map((x) => ({ essayId: x.id, title: x.title, text: docText(x.doc) })),
                    )
                  }
                  className="rounded-md border border-line bg-surface px-2 py-1 text-xs"
                >
                  {memoryBusy ? 'Reading your writing…' : 'Describe my voice, so feedback can protect it'}
                </button>
              )}
              {voice.profile.ready && voice.profile.typicalLines[0] && (
                <p className="text-xs text-muted">
                  A line that sounds like you: <q className="font-serif text-ink">{voice.profile.typicalLines[0]}</q>
                </p>
              )}
            </div>
          </details>
        )}
        {(essay.stage === 'refine' || essay.stage === 'finish') && (
          <details className="group" open={gradeOpen} onToggle={(e) => setGradeOpen(e.currentTarget.open)}>
            <summary className="cursor-pointer text-sm font-medium">Grade</summary>
            <div className="mt-2 max-h-[45vh] overflow-y-auto pr-1">{gradeOpen && <GradeCard essay={essay} />}</div>
          </details>
        )}
      </div>

      <div data-testid="chat" className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {messages.length === 0 && streaming === null && (
          <p className="text-muted">Ask anything about your essay, by typing or with the microphone. The counselor gives advice only.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} data-role={m.role} className={m.role === 'user' ? 'ml-8 rounded-lg bg-surface px-3 py-2 shadow-sm' : 'mr-4 whitespace-pre-wrap leading-relaxed'}>
            {m.role === 'user' ? m.text : <Reply text={m.text} studentText={studentText} />}
            {m.role === 'assistant' && memoryOn && (
              <div className="mt-1 flex gap-2 text-xs">
                {(['accepted', 'rejected'] as const).map((verdict) => (
                  <button
                    key={verdict}
                    aria-pressed={ratingOf(m.text) === verdict}
                    onClick={() => void useMemory.getState().rateFeedback(m.text, verdict, essay.id, essay.title)}
                    className={`rounded-full border px-2 py-0.5 ${ratingOf(m.text) === verdict ? 'border-accent bg-accent text-on-accent' : 'border-line bg-surface text-muted'}`}
                  >
                    {verdict === 'accepted' ? 'Useful' : 'Not for me'}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {turn && (
          <div data-testid="turn-so-far" className="ml-8 rounded-lg border border-dashed border-line px-3 py-2 text-muted">
            {turn} <span className="text-xs">· listening…</span>
          </div>
        )}
        {streaming !== null && (
          <div data-role="assistant" className="mr-4 whitespace-pre-wrap leading-relaxed text-muted">
            {streaming || 'Thinking…'}
          </div>
        )}
        {error && <p role="alert" className="text-danger">{error}</p>}
        <div ref={bottom} />
      </div>

      <form
        className="border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim() && !busy) send(draft);
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            aria-label="Ask the counselor"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask the counselor…"
            className="min-w-0 flex-1 resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            aria-label={listening ? 'Stop listening' : 'Ask by voice'}
            aria-pressed={listening}
            title={listening ? 'Stop listening' : 'Ask by voice'}
            onClick={() => toggleDictation('counselor')}
            className={`rounded-md p-2 ${listening ? 'bg-danger text-on-accent' : 'border border-line bg-surface'}`}
          >
            {listening ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          {busy ? (
            <button type="button" aria-label="Stop the reply" title="Stop the reply" onClick={() => counselor.stop()} className="rounded-md border border-line bg-surface p-2">
              <Square size={16} />
            </button>
          ) : (
            <button type="submit" aria-label="Send" title="Send" disabled={!draft.trim()} className="rounded-md bg-accent p-2 text-on-accent">
              <Send size={16} />
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">Advice only. Nothing said here is added to your essay.</p>
      </form>
    </aside>
  );
}
