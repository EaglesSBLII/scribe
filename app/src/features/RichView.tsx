import katex from 'katex';
import { paraText, type Inline } from '../doc/types';
import { kindOf } from '../paper/layout';

/** LaTeX drawn by KaTeX. A formula it cannot read is shown as written, in red, rather than hidden. */
export function Math({ latex, display }: { latex: string; display?: boolean }) {
  const html = katex.renderToString(latex, { throwOnError: false, displayMode: display, output: 'html' });
  return <span data-testid="math" data-latex={latex} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) =>
        n.t === 'math' ? <Math key={i} latex={n.latex} display={n.display} /> : <span key={i} className={n.t === 'flag' ? 'flag' : undefined}>{n.text}</span>,
      )}
    </>
  );
}

/**
 * How a paragraph with mathematics, a heading or a caption looks when it is
 * not being edited. Clicking it shows the plain text again for editing.
 */
export function RichView({ nodes, equationNo, onActivate }: { nodes: Inline[]; equationNo?: number; onActivate: () => void }) {
  const kind = kindOf(nodes);
  const text = paraText({ id: '', nodes });
  const common = { onClick: onActivate, 'data-testid': 'rich-view', 'data-kind': kind, className: 'cursor-text' };
  if (kind === 'heading1') return <h2 {...common} className="cursor-text font-sans text-2xl font-semibold">{text.replace(/^#\s+/, '')}</h2>;
  if (kind === 'heading2') return <h3 {...common} className="cursor-text font-sans text-xl font-semibold">{text.replace(/^##\s+/, '')}</h3>;
  if (kind === 'caption') return <p {...common} className="cursor-text text-center font-serif text-base italic text-muted">{text}</p>;
  if (kind === 'equation') {
    const math = nodes.find((n) => n.t === 'math') as Extract<Inline, { t: 'math' }>;
    return (
      <div {...common} className="flex cursor-text items-center gap-4 py-1 text-lg">
        <div className="flex-1 text-center">
          <Math latex={math.latex} display />
        </div>
        <span className="shrink-0 font-serif text-muted">({equationNo})</span>
      </div>
    );
  }
  return (
    <p {...common} className="cursor-text whitespace-pre-wrap font-serif text-lg leading-relaxed">
      <InlineNodes nodes={nodes} />
    </p>
  );
}
