import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useStore } from '../store';
import { CURRENT_CYCLE, promptsFor, useColleges } from '../colleges/store';
import { isIpedsId, withoutLocal } from '../colleges/usColleges';
import type { CollegeRow, PrincipleRow, PromptRow, RubricRow } from '../db/schema';
import { DEFAULT_WEIGHTS, SECTIONS } from '../grading/rubric';

const inputClass = 'w-full rounded border border-line bg-surface px-2 py-1 text-sm';

/** A field that saves when you leave it, like everything else in Scribe. */
function Field(props: {
  label: string;
  value: string;
  onSave: (value: string) => void;
  rows?: number;
  type?: 'text' | 'number';
  placeholder?: string;
  className?: string;
}) {
  const common = {
    'aria-label': props.label,
    defaultValue: props.value,
    placeholder: props.placeholder,
    className: inputClass,
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.target.value !== props.value) props.onSave(e.target.value);
    },
  };
  return (
    <label className={`block text-xs font-medium text-muted ${props.className ?? ''}`}>
      {props.label}
      {props.rows ? <textarea rows={props.rows} {...common} /> : <input type={props.type ?? 'text'} {...common} />}
    </label>
  );
}

function Verified(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input type="checkbox" aria-label={props.label} checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      Verified on the official page for this cycle
      {!props.checked && <span className="rounded bg-warn-soft px-1.5 py-0.5 font-medium text-warn">unverified</span>}
    </label>
  );
}

const number = (v: string) => (v.trim() && Number(v) > 0 ? Math.round(Number(v)) : null);

function confirmDelete(title: string, items: string[], run: () => void | Promise<void>) {
  useStore.setState({
    confirm: { title, body: 'This removes it from your college database. Essays already written are not changed.', items, confirmLabel: 'Delete', onConfirm: run },
  });
}

function PromptCard({ prompt }: { prompt: PromptRow }) {
  // Each change is applied to the entry as it is now, so quick edits to two fields cannot undo each other.
  const save = (patch: Partial<PromptRow>) => {
    const s = useColleges.getState();
    void s.savePrompt({ ...(s.prompts.find((p) => p.id === prompt.id) ?? prompt), ...patch });
  };
  return (
    <li data-testid="prompt-card" className="space-y-2 rounded-md border border-line bg-surface p-3">
      <div className="flex items-end gap-2">
        <Field label="Label" value={prompt.label} onSave={(label) => save({ label })} className="flex-1" />
        <Field label="Min words" type="number" value={prompt.minWords?.toString() ?? ''} onSave={(v) => save({ minWords: number(v) })} className="w-24" />
        <Field label="Word limit" type="number" value={prompt.wordLimit?.toString() ?? ''} onSave={(v) => save({ wordLimit: number(v) })} className="w-24" />
        <button
          aria-label={`Delete prompt ${prompt.label}`}
          title="Delete this prompt"
          onClick={() => confirmDelete(`Delete the prompt "${prompt.label}"?`, [prompt.text], () => useColleges.getState().deletePrompt(prompt.id))}
          className="rounded p-1.5 text-muted hover:bg-panel hover:text-danger"
        >
          <Trash2 size={16} />
        </button>
      </div>
      <Field label="Prompt text" rows={3} value={prompt.text} onSave={(text) => save({ text })} />
      <Field label="Instructions" value={prompt.instructions} onSave={(instructions) => save({ instructions })} placeholder="Required, optional, choose 4 of 8…" />
      <div className="flex items-end gap-2">
        <Field label="Source URL" value={prompt.sourceUrl} onSave={(sourceUrl) => save({ sourceUrl })} className="flex-1" placeholder="https://…" />
        <Field label="Cycle" value={prompt.cycleYear} onSave={(cycleYear) => save({ cycleYear })} className="w-24" />
      </div>
      <Verified label={`${prompt.label} verified`} checked={prompt.verified} onChange={(verified) => save({ verified })} />
      {prompt.notes && <p className="text-xs text-muted">Note: {prompt.notes}</p>}
    </li>
  );
}

function RubricCard({ rubric }: { rubric: RubricRow }) {
  const save = (patch: Partial<RubricRow>) => {
    const s = useColleges.getState();
    void s.saveRubric({ ...(s.rubrics.find((r) => r.id === rubric.id) ?? rubric), ...patch });
  };
  const asText = rubric.criteria.map((c) => `${c.name}: ${c.description}`).join('\n');
  const parse = (text: string) =>
    text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const at = l.indexOf(':');
      return at < 0 ? { name: l, description: '' } : { name: l.slice(0, at).trim(), description: l.slice(at + 1).trim() };
    });
  return (
    <li className="space-y-2 rounded-md border border-line bg-surface p-3">
      <div className="flex items-end gap-2">
        <Field label="Criteria title" value={rubric.title} onSave={(title) => save({ title })} className="flex-1" />
        <button
          aria-label={`Delete criteria ${rubric.title}`}
          title="Delete these criteria"
          onClick={() => confirmDelete(`Delete "${rubric.title}"?`, rubric.criteria.map((c) => c.name), () => useColleges.getState().deleteRubric(rubric.id))}
          className="rounded p-1.5 text-muted hover:bg-panel hover:text-danger"
        >
          <Trash2 size={16} />
        </button>
      </div>
      <Field label="Criteria, one per line as Name: description" rows={Math.min(12, rubric.criteria.length + 1)} value={asText} onSave={(v) => save({ criteria: parse(v) })} />
      <div className="flex items-end gap-2">
        <Field label="Source URL" value={rubric.sourceUrl} onSave={(sourceUrl) => save({ sourceUrl })} className="flex-1" />
        <Field label="Cycle" value={rubric.cycleYear} onSave={(cycleYear) => save({ cycleYear })} className="w-24" />
      </div>
      <Verified label={`${rubric.title} verified`} checked={rubric.verified} onChange={(verified) => save({ verified })} />
      <p className="text-xs text-muted">Only criteria the school itself has published belong here.</p>
    </li>
  );
}

function CollegeDetail({ college }: { college: CollegeRow }) {
  const { colleges, prompts, rubrics } = useColleges();
  const api = useColleges.getState();
  const save = (patch: Partial<CollegeRow>) => {
    const s = useColleges.getState();
    void s.saveCollege({ ...(s.colleges.find((c) => c.id === college.id) ?? college), ...patch });
  };
  const shared = college.promptsFrom ? colleges.find((c) => c.id === college.promptsFrom) : undefined;
  const own = prompts.filter((p) => p.collegeId === college.id).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const ownRubrics = rubrics.filter((r) => r.collegeId === college.id);

  return (
    <div key={college.id} className="mx-auto max-w-3xl space-y-6 p-6">
      <section className="space-y-2">
        <div className="flex items-end gap-2">
          <Field label="College name" value={college.name} onSave={(name) => name.trim() && save({ name: name.trim() })} className="flex-1" />
          <Field label="Cycle" value={college.cycleYear} onSave={(cycleYear) => save({ cycleYear })} className="w-24" />
          <button
            onClick={() => confirmDelete(`Delete ${college.name}?`, [`${own.length} prompts and ${ownRubrics.length} sets of criteria stored for it`], () => api.deleteCollege(college.id))}
            className="rounded-md border border-line px-2 py-1 text-sm text-danger"
          >
            Delete college
          </button>
        </div>
        <Field label="Applies through" value={college.appliesVia} onSave={(appliesVia) => save({ appliesVia })} />
        <label className="block text-xs font-medium text-muted">
          Uses the prompts of
          <select aria-label="Uses the prompts of" value={college.promptsFrom ?? ''} onChange={(e) => save({ promptsFrom: e.target.value || null })} className={inputClass}>
            <option value="">Its own prompts</option>
            {colleges.filter((c) => c.id !== college.id && !c.promptsFrom).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <Field label="What the school says it wants applicants to convey" rows={3} value={college.wants} onSave={(wants) => save({ wants })} />
        <Field label="Source URL for that" value={college.wantsSourceUrl} onSave={(wantsSourceUrl) => save({ wantsSourceUrl })} placeholder="https://…" />
        <Verified label={`${college.name} verified`} checked={college.verified} onChange={(verified) => save({ verified })} />
        {college.notes && <p className="text-xs text-muted">Note: {college.notes}</p>}
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">Grading weights</h3>
        <p className="text-sm text-muted">
          How much each part of Scribe's rubric counts for essays to this school. These are your settings, not the school's scoring. They are scaled to add
          up to 100.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          {SECTIONS.map((s) => (
            <Field
              key={`${s.id}:${college.gradingWeights?.[s.id] ?? 'd'}`}
              label={s.name}
              type="number"
              value={String((college.gradingWeights ?? DEFAULT_WEIGHTS)[s.id] ?? DEFAULT_WEIGHTS[s.id])}
              onSave={(v) => save({ gradingWeights: { ...DEFAULT_WEIGHTS, ...college.gradingWeights, [s.id]: Math.max(0, Number(v) || 0) } })}
              className="w-28"
            />
          ))}
          {college.gradingWeights && (
            <button onClick={() => save({ gradingWeights: undefined })} className="rounded-md border border-line px-2 py-1 text-sm">
              Use the defaults
            </button>
          )}
        </div>
        {!college.gradingWeights && <p className="text-xs text-muted">Using the default weights.</p>}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Prompts</h3>
          <button
            onClick={() =>
              void api.savePrompt({
                id: `${college.id}-${crypto.randomUUID().slice(0, 8)}`, collegeId: college.id, label: 'New prompt', text: '', minWords: null,
                wordLimit: null, instructions: '', sourceUrl: '', cycleYear: college.cycleYear || CURRENT_CYCLE, verified: false,
              })
            }
            className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-sm font-medium text-on-accent"
          >
            <Plus size={14} /> Add prompt
          </button>
        </div>
        {shared && (
          <p className="text-sm text-muted">
            {college.name} uses the {promptsFor(college, prompts).length} prompts stored under {shared.name}. Edit them there.
          </p>
        )}
        <ul className="space-y-3">
          {own.map((p) => (
            <PromptCard key={p.id} prompt={p} />
          ))}
        </ul>
        {!shared && own.length === 0 && <p className="text-sm text-muted">No prompts stored yet.</p>}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Published criteria</h3>
          <button
            onClick={() =>
              void api.saveRubric({
                id: `${college.id}-criteria-${crypto.randomUUID().slice(0, 8)}`, collegeId: college.id, title: 'New criteria', criteria: [],
                sourceUrl: '', cycleYear: college.cycleYear || CURRENT_CYCLE, verified: false,
              })
            }
            className="flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-sm"
          >
            <Plus size={14} /> Add criteria
          </button>
        </div>
        <ul className="space-y-3">
          {ownRubrics.map((r) => (
            <RubricCard key={r.id} rubric={r} />
          ))}
        </ul>
        {ownRubrics.length === 0 && <p className="text-sm text-muted">None stored. Scribe does not make these up.</p>}
      </section>
    </div>
  );
}

function Principles() {
  const principles = useColleges((s) => s.principles);
  const api = useColleges.getState();
  const save = (p: PrincipleRow, patch: Partial<PrincipleRow>) => {
    const s = useColleges.getState();
    void s.savePrinciple({ ...(s.principles.find((x) => x.id === p.id) ?? p), ...patch });
  };
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">What great essays do</h3>
          <p className="text-sm text-muted">Short principles from published admissions guidance, each with its source. No sample essays are stored.</p>
        </div>
        <button
          onClick={() => void api.savePrinciple({ id: `p-${crypto.randomUUID().slice(0, 8)}`, text: '', sourceName: '', sourceUrl: '', verified: false })}
          className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-sm font-medium text-on-accent"
        >
          <Plus size={14} /> Add principle
        </button>
      </div>
      <ul className="space-y-3">
        {principles.map((p) => (
          <li key={p.id} data-testid="principle" className="space-y-2 rounded-md border border-line bg-surface p-3">
            <Field label="Principle" rows={2} value={p.text} onSave={(text) => save(p, { text })} />
            <div className="flex items-end gap-2">
              <Field label="Source" value={p.sourceName} onSave={(sourceName) => save(p, { sourceName })} className="w-48" />
              <Field label="Source URL" value={p.sourceUrl} onSave={(sourceUrl) => save(p, { sourceUrl })} className="flex-1" />
              <button
                aria-label="Delete principle"
                title="Delete this principle"
                onClick={() => confirmDelete('Delete this principle?', [p.text], () => api.deletePrinciple(p.id))}
                className="rounded p-1.5 text-muted hover:bg-panel hover:text-danger"
              >
                <Trash2 size={16} />
              </button>
            </div>
            <Verified label="Principle verified" checked={p.verified} onChange={(verified) => save(p, { verified })} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Add schools, and update prompts each cycle. Everything here is stored on this Mac. */
export function CollegesAdmin() {
  const allColleges = useColleges((s) => s.colleges);
  const prompts = useColleges((s) => s.prompts);
  const us = useColleges((s) => s.us);
  const usedIds = useStore((s) => s.essays.map((e) => e.collegeId ?? '').join('|'));
  const [selected, setSelected] = useState<string>('');
  const api = useColleges.getState();
  // A school picked from the big US list is only listed here once it is edited, has prompts, or an essay uses it.
  const colleges = useMemo(() => {
    const used = new Set(usedIds.split('|'));
    return allColleges.filter((c) => !isIpedsId(c.id) || c.edited || used.has(c.id) || c.id === selected || prompts.some((p) => p.collegeId === c.id));
  }, [allColleges, prompts, usedIds, selected]);
  const college = colleges.find((c) => c.id === selected);
  const moreUs = useMemo(() => (us ? withoutLocal(us, colleges).length : 0), [us, colleges]);

  useEffect(() => {
    void useColleges.getState().loadUs().catch(() => {});
  }, []);

  async function addCollege() {
    const id = `college-${crypto.randomUUID().slice(0, 8)}`;
    await api.saveCollege({ id, name: 'New college', appliesVia: '', promptsFrom: null, wants: '', wantsSourceUrl: '', cycleYear: CURRENT_CYCLE, verified: false });
    setSelected(id);
  }

  return (
    <div className="flex min-w-0 flex-1">
      <nav aria-label="Colleges" className="flex w-72 shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center justify-between px-3 py-3">
          <button onClick={() => api.setAdminOpen(false)} className="flex items-center gap-1 text-sm text-accent">
            <ArrowLeft size={14} /> Back to essays
          </button>
          <button onClick={() => void addCollege()} className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-sm font-medium text-on-accent">
            <Plus size={14} /> Add college
          </button>
        </div>
        <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          <li>
            <button onClick={() => setSelected('')} aria-current={!college ? 'page' : undefined} className={`w-full rounded-md px-3 py-2 text-left text-sm ${!college ? 'bg-surface shadow-sm' : 'hover:bg-raised'}`}>
              What great essays do
            </button>
          </li>
          {colleges.map((c) => {
            const count = promptsFor(c, prompts).length;
            const anyUnverified = !c.verified || promptsFor(c, prompts).some((p) => !p.verified);
            return (
              <li key={c.id}>
                <button
                  data-testid="college-row"
                  onClick={() => setSelected(c.id)}
                  aria-current={c.id === selected ? 'page' : undefined}
                  className={`w-full rounded-md px-3 py-2 text-left ${c.id === selected ? 'bg-surface shadow-sm' : 'hover:bg-raised'}`}
                >
                  <span className="block truncate text-sm font-medium">{c.name}</span>
                  <span className="block text-xs text-muted">
                    {c.cycleYear} · {count} {count === 1 ? 'prompt' : 'prompts'}
                    {anyUnverified && <span className="ml-1 rounded bg-warn-soft px-1 text-warn">unverified</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {moreUs > 0 && (
          <p data-testid="us-colleges-count" className="border-t border-line px-4 py-2 text-xs text-muted">
            {moreUs.toLocaleString()} more US colleges can be chosen by name when you set an essay's college. Their prompts are not stored: you paste your own.
          </p>
        )}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">{college ? <CollegeDetail college={college} /> : <Principles />}</main>
    </div>
  );
}
