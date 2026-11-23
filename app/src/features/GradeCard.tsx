import { useEffect, useState } from 'react';
import { useGrades } from '../llm/grader';
import { chooseWeights, SECTIONS, type Weights } from '../grading/rubric';
import { gradingWeightsFor, useColleges } from '../colleges/store';
import { locate } from '../checks';
import type { EssayRow, GradeRow } from '../db/schema';
import { dateTime } from './time';

export const GRADE_LABEL = 'Rubric-based estimate, not an admissions decision.';

function History({ history, shownId, onShow }: { history: GradeRow[]; shownId?: number; onShow: (g: GradeRow) => void }) {
  if (history.length === 0) return null;
  const w = 280;
  const h = 48;
  const x = (i: number) => (history.length === 1 ? w / 2 : 8 + (i * (w - 16)) / (history.length - 1));
  const y = (total: number) => h - 6 - (total / 100) * (h - 12);
  return (
    <div data-testid="score-history" className="space-y-1">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted">Score history</h4>
      {history.length > 1 && (
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Scores across drafts: ${history.map((g) => g.total).join(', ')}`} className="w-full">
          <polyline fill="none" stroke="var(--color-accent)" strokeWidth="2" points={history.map((g, i) => `${x(i)},${y(g.total)}`).join(' ')} />
          {history.map((g, i) => (
            <circle key={g.id} cx={x(i)} cy={y(g.total)} r={g.id === shownId ? 4 : 3} fill="var(--color-accent)" />
          ))}
        </svg>
      )}
      <ol className="space-y-0.5 text-xs">
        {[...history].reverse().map((g, i) => (
          <li key={g.id}>
            <button
              onClick={() => onShow(g)}
              aria-current={g.id === shownId ? 'true' : undefined}
              className={`flex w-full justify-between rounded px-1.5 py-0.5 text-left ${g.id === shownId ? 'bg-white font-medium' : 'hover:bg-white/60'}`}
            >
              <span>
                Draft {history.length - i} · {dateTime(g.ts)} · {g.wordCount} words
              </span>
              <span>{g.total}/100</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Grade the current draft, show the breakdown with the quoted lines, and the history across drafts. */
export function GradeCard({ essay }: { essay: EssayRow }) {
  const { history, busy, error, reused } = useGrades();
  const colleges = useColleges((s) => s.colleges);
  const [shown, setShown] = useState<GradeRow | null>(null);

  useEffect(() => {
    void useGrades.getState().load(essay.id).then(() => setShown(useGrades.getState().history.at(-1) ?? null));
  }, [essay.id]);

  const college = colleges.find((c) => c.id === essay.collegeId);
  const set = gradingWeightsFor(college, colleges);
  const choice = chooseWeights(set.weights as Partial<Weights> | undefined, set.name, essay.wordLimit ?? null, Boolean(essay.promptText?.trim()));

  async function grade() {
    const row = await useGrades.getState().grade({
      id: essay.id, title: essay.title, stage: essay.stage, promptText: essay.promptText ?? '', wordCount: essay.wordCount,
      wordLimit: essay.wordLimit ?? null, doc: essay.doc, weights: choice.weights, weightsSource: choice.source,
    });
    if (row) setShown(row);
  }

  return (
    <div className="space-y-3">
      <button onClick={() => void grade()} disabled={busy} className="w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white">
        {busy ? 'Grading…' : 'Grade this draft'}
      </button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {shown && (
        <div data-testid="grade" className="space-y-2 rounded-md bg-white p-3 shadow-sm">
          <div className="flex items-baseline justify-between">
            <span className="font-serif text-3xl" data-testid="grade-total">
              {shown.total}
              <span className="text-base text-muted">/100</span>
            </span>
            <span className="text-xs text-muted">{reused ? 'Same text as before: same score' : dateTime(shown.ts)}</span>
          </div>
          <p className="text-xs font-medium text-[#6b5310]">{GRADE_LABEL}</p>
          <ul className="space-y-2 text-sm">
            {shown.sections.map((s) => {
              const name = SECTIONS.find((x) => x.id === s.id)?.name ?? s.id;
              return (
                <li key={s.id} data-testid="grade-section">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{name}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {s.score}/100 · weight {s.weight}%
                    </span>
                  </div>
                  <div className="my-1 h-1.5 rounded bg-panel" aria-hidden="true">
                    <div className="h-1.5 rounded bg-accent" style={{ width: `${s.score}%` }} />
                  </div>
                  {s.quote ? (
                    <p>
                      <span className="mr-1 text-xs font-medium text-muted">{locate(essay.doc, s.quote) ?? 'earlier draft'}</span>
                      <q className="rounded bg-[#e3efe9] px-0.5 font-serif">{s.quote}</q>
                    </p>
                  ) : (
                    <p className="text-xs text-danger">The model did not point to an exact line for this score.</p>
                  )}
                  <p className="text-xs text-muted">{s.reason}</p>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted">
            {shown.weightsSource} Model {shown.model}, rubric {shown.rubricVersion}.
          </p>
        </div>
      )}
      <History history={history} shownId={shown?.id} onShow={setShown} />
    </div>
  );
}
