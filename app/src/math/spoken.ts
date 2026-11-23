/**
 * Spoken mathematics to LaTeX, by fixed rules. "x squared over two" becomes
 * x^{2}/2. It writes down what was said and nothing more: it never simplifies,
 * evaluates or solves. No model is involved.
 */

export interface SpokenMath {
  latex: string;
  /** Words that are not mathematics. A non-empty list means this was probably prose. */
  unknown: string[];
  /** True when at least one operator, power, function or similar was said. */
  structured: boolean;
}

const UNITS_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS_WORDS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINALS: Record<string, string> = {
  second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10', nth: 'n', kth: 'k',
};

const GREEK = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'rho', 'sigma', 'tau',
  'upsilon', 'phi', 'chi', 'psi', 'omega',
];
const CAPITAL_GREEK = new Set(['gamma', 'delta', 'theta', 'lambda', 'xi', 'pi', 'sigma', 'phi', 'psi', 'omega']);

const FUNCTIONS: Record<string, string> = {
  sine: '\\sin', sin: '\\sin', sign: '\\sin', cosine: '\\cos', cos: '\\cos', tangent: '\\tan', tan: '\\tan', secant: '\\sec', cosecant: '\\csc',
  cotangent: '\\cot', log: '\\log', logarithm: '\\log', ln: '\\ln', exp: '\\exp', arcsine: '\\arcsin', arccosine: '\\arccos', arctangent: '\\arctan',
};

/** Binary operators and relations, longest phrase first. */
const OPERATORS: [string[], string][] = [
  [['is', 'less', 'than', 'or', 'equal', 'to'], '\\leq'], [['less', 'than', 'or', 'equal', 'to'], '\\leq'],
  [['is', 'greater', 'than', 'or', 'equal', 'to'], '\\geq'], [['greater', 'than', 'or', 'equal', 'to'], '\\geq'],
  [['is', 'approximately', 'equal', 'to'], '\\approx'], [['approximately', 'equals'], '\\approx'], [['is', 'approximately'], '\\approx'],
  [['is', 'proportional', 'to'], '\\propto'], [['proportional', 'to'], '\\propto'],
  [['is', 'not', 'equal', 'to'], '\\neq'], [['not', 'equal', 'to'], '\\neq'], [['does', 'not', 'equal'], '\\neq'],
  [['is', 'equal', 'to'], '='], [['equal', 'to'], '='], [['is', 'less', 'than'], '<'], [['less', 'than'], '<'],
  [['is', 'greater', 'than'], '>'], [['greater', 'than'], '>'], [['plus', 'or', 'minus'], '\\pm'], [['divided', 'by'], '\\div'],
  [['goes', 'to'], '\\to'], [['approaches'], '\\to'], [['approximately'], '\\approx'], [['implies'], '\\Rightarrow'],
  [['equals'], '='], [['equal'], '='], [['plus'], '+'], [['minus'], '-'], [['times'], '\\times'], [['cross'], '\\times'],
];

const UNIT_SYMBOLS: Record<string, string> = {
  meter: 'm', metre: 'm', kilogram: 'kg', gram: 'g', second: 's', newton: 'N', joule: 'J', watt: 'W', volt: 'V', ampere: 'A', amp: 'A',
  ohm: '\\Omega', hertz: 'Hz', pascal: 'Pa', kelvin: 'K', coulomb: 'C', tesla: 'T', farad: 'F', mole: 'mol', liter: 'L', litre: 'L',
  radian: 'rad', centimeter: 'cm', millimeter: 'mm', kilometer: 'km', nanometer: 'nm', micrometer: '\\mu m', millisecond: 'ms',
  kilojoule: 'kJ', kilowatt: 'kW', hour: 'h', minute: 'min', electronvolt: 'eV',
};
const unitOf = (word: string) => UNIT_SYMBOLS[word] ?? UNIT_SYMBOLS[word.replace(/s$/, '')];

// Short words that are English, not a product of two letters.
const NOT_LETTER_PAIRS = new Set([
  'is', 'of', 'to', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'it', 'me', 'my', 'no', 'on', 'or', 'so', 'up', 'us', 'we', 'an', 'am', 'oh', 'ok', 'hi',
]);

interface Term {
  latex: string;
  /** Came from "the quantity ..." or brackets, so it can be a fraction's top or bottom. */
  group?: string;
  number?: boolean;
}

class Parser {
  private i = 0;
  unknown: string[] = [];
  structured = false;

  constructor(private raw: string[], private t: string[]) {}

  private at(...words: string[]): boolean {
    return words.every((w, k) => this.t[this.i + k] === w);
  }
  private take(...words: string[]): boolean {
    if (!this.at(...words)) return false;
    this.i += words.length;
    return true;
  }
  private done() {
    return this.i >= this.t.length;
  }

  private operator(): string | null {
    for (const [words, symbol] of OPERATORS) if (this.take(...words)) return symbol;
    return null;
  }

  /** Read terms and operators until the end or a stop word. `bounds` keeps "to" free for "from a to b". */
  expr(stop: (word: string) => boolean = () => false, bounds = false): string {
    const out: Term[] = [];
    const ops: (string | null)[] = [];
    let pendingOp: string | null = null;
    while (!this.done() && !stop(this.t[this.i])) {
      if (this.take('over') && out.length) {
        // "a over b": a simple slash, or a stacked fraction when either side is a grouped quantity.
        const top = out.pop()!;
        const bottom = this.term(bounds);
        this.structured = true;
        out.push({ latex: top.group || bottom.group ? `\\frac{${top.group ?? top.latex}}{${bottom.group ?? bottom.latex}}` : `${top.latex}/${bottom.latex}` });
        continue;
      }
      const start = this.i;
      const op = this.operator();
      if (op) {
        this.structured = true;
        if (op === '-' && (out.length === 0 || pendingOp)) {
          // A leading minus is a sign, not a subtraction.
          const next = this.term(bounds);
          out.push({ latex: `-${next.latex}` });
          ops.push(pendingOp);
          pendingOp = null;
        } else pendingOp = pendingOp ? `${pendingOp} ${op}` : op;
        continue;
      }
      if (this.take('comma')) {
        pendingOp = ',';
        continue;
      }
      const term = this.term(bounds);
      if (this.i === start) {
        // Nothing recognised: keep the word as text and note it.
        this.unknown.push(this.raw[this.i]);
        term.latex = `\\text{${this.raw[this.i]}}`;
        this.i++;
      }
      out.push(term);
      ops.push(pendingOp);
      pendingOp = null;
    }
    let latex = '';
    out.forEach((term, k) => {
      if (k > 0) latex += ops[k] ? (ops[k] === ',' ? ', ' : ` ${ops[k]} `) : ' ';
      latex += term.latex;
    });
    if (pendingOp) latex += ` ${pendingOp}`;
    return latex.trim();
  }

  private number(): string | null {
    const word = this.t[this.i];
    if (/^\d+(\.\d+)?$/.test(word)) {
      this.i++;
      return word;
    }
    let value: number | null = null;
    if (word in TENS_WORDS) {
      value = TENS_WORDS[word];
      this.i++;
      const next = this.t[this.i];
      if (next in UNITS_WORDS && UNITS_WORDS[next] > 0 && UNITS_WORDS[next] < 10) {
        value += UNITS_WORDS[next];
        this.i++;
      }
    } else if (word in UNITS_WORDS) {
      value = UNITS_WORDS[word];
      this.i++;
    }
    if (value === null) return null;
    if (this.take('hundred')) value *= 100;
    if (this.take('thousand')) value *= 1000;
    let text = String(value);
    if (this.at('point') && (this.t[this.i + 1] in UNITS_WORDS || /^\d+$/.test(this.t[this.i + 1] ?? ''))) {
      this.i++;
      text += '.';
      while (!this.done() && (this.t[this.i] in UNITS_WORDS || /^\d+$/.test(this.t[this.i]))) {
        text += this.t[this.i] in UNITS_WORDS ? UNITS_WORDS[this.t[this.i]] : this.t[this.i];
        this.i++;
      }
    }
    // "one half", "three quarters"
    const parts: Record<string, number> = { half: 2, halves: 2, third: 3, thirds: 3, quarter: 4, quarters: 4, fourth: 4, fourths: 4 };
    if (this.t[this.i] in parts && !text.includes('.')) {
      const bottom = parts[this.t[this.i]];
      this.i++;
      this.structured = true;
      return `\\frac{${text}}{${bottom}}`;
    }
    return text;
  }

  private units(): string | null {
    let out = '';
    const one = () => {
      const u = unitOf(this.t[this.i] ?? '');
      if (!u) return null;
      this.i++;
      const power = this.take('squared') ? '^{2}' : this.take('cubed') ? '^{3}' : '';
      return u + power;
    };
    const first = one();
    if (!first) return null;
    out = first;
    for (;;) {
      if (this.at('per') && unitOf(this.t[this.i + 1] ?? '')) {
        this.i++;
        out += `/${one()}`;
      } else {
        const next = one();
        if (!next) break;
        out += `\\,${next}`;
      }
    }
    return `\\,\\mathrm{${out}}`;
  }

  private differential(): string | null {
    const word = this.t[this.i];
    if (/^d[a-z]$/.test(word) && !NOT_LETTER_PAIRS.has(word)) {
      this.i++;
      return word;
    }
    if (word === 'd' && this.t[this.i + 1]) {
      const next = this.t[this.i + 1];
      if (/^[a-z]$/.test(next)) {
        this.i += 2;
        return `d${this.raw[this.i - 1]}`;
      }
      if (GREEK.includes(next)) {
        this.i += 2;
        return `d\\${next}`;
      }
    }
    return null;
  }

  private limits(symbol: string, bounds: boolean): Term {
    let latex = symbol;
    if (this.take('from')) {
      const low = this.expr((w) => w === 'to', true);
      this.take('to');
      const high = this.expr((w) => w === 'of' || /^d[a-z]$/.test(w), true);
      latex += `_{${low}}^{${high}}`;
    }
    this.take('of');
    const body = this.expr(() => false, bounds);
    return { latex: `${latex} ${body}`.trim() };
  }

  /** One thing that can be multiplied: a number, a symbol, a function, a bracket, an integral. Then its powers and marks. */
  private term(bounds: boolean): Term {
    const base = this.factor(bounds);
    if (!base.latex) return base;
    for (;;) {
      if (this.take('squared')) base.latex = `${wrap(base)}^{2}`;
      else if (this.take('cubed')) base.latex = `${wrap(base)}^{3}`;
      else if (this.take('to', 'the', 'power', 'of') || this.take('raised', 'to', 'the', 'power', 'of') || this.take('raised', 'to', 'the') || this.take('to', 'the', 'power')) {
        base.latex = `${wrap(base)}^{${this.exponent(bounds)}}`;
      } else if (!bounds && this.at('to', 'the') && this.t[this.i + 2] !== undefined) {
        this.i += 2;
        base.latex = `${wrap(base)}^{${this.exponent(bounds)}}`;
        this.take('power');
      } else if (this.take('sub')) base.latex = `${base.latex}_{${this.factor(bounds).latex}}`;
      else if (this.take('naught') || this.take('nought')) base.latex = `${base.latex}_{0}`;
      else if (this.take('prime')) base.latex = `${base.latex}'`;
      else if (this.take('hat')) base.latex = `\\hat{${base.latex}}`;
      else if (this.take('bar')) base.latex = `\\bar{${base.latex}}`;
      else if (this.take('double', 'dot')) base.latex = `\\ddot{${base.latex}}`;
      else if (this.at('vector') && !this.startsFactor(this.i + 1)) {
        // "F vector" marks F; in "m vector a" the word belongs to the a that follows.
        this.i++;
        base.latex = `\\vec{${base.latex}}`;
      }
      else if (this.take('factorial')) base.latex = `${base.latex}!`;
      else if (this.take('degrees') || this.take('degree')) base.latex = `${base.latex}^{\\circ}`;
      else if (this.at('dot') && !this.startsFactor(this.i + 1)) {
        // "x dot" with nothing after it is a time derivative; "a dot b" is a product.
        this.i++;
        base.latex = `\\dot{${base.latex}}`;
      } else if (this.take('dot')) {
        const right = this.term(bounds);
        base.latex = `${base.latex} \\cdot ${right.latex}`;
      } else break;
      base.group = undefined;
      this.structured = true;
    }
    if (base.number) {
      const unit = this.units();
      if (unit) {
        base.latex += unit;
        this.structured = true;
      }
    }
    return base;
  }

  private exponent(bounds: boolean): string {
    const word = this.t[this.i];
    if (word in ORDINALS) {
      this.i++;
      return ORDINALS[word];
    }
    if (this.take('minus') || this.take('negative')) return `-${this.factor(bounds).latex}`;
    const f = this.factor(bounds);
    return f.group ?? f.latex;
  }

  private startsFactor(index: number): boolean {
    const word = this.t[index];
    if (word === undefined) return false;
    return /^[a-z]$/.test(word) || /^\d/.test(word) || word in UNITS_WORDS || word in TENS_WORDS || GREEK.includes(word) || word === 'pi' || word in FUNCTIONS || word === 'the' || word === 'capital';
  }

  private factor(bounds: boolean): Term {
    const word = this.t[this.i];
    if (word === undefined) return { latex: '' };

    if (this.take('negative')) return { latex: `-${this.term(bounds).latex}` };
    const n = this.number();
    if (n !== null) return { latex: n, number: true };

    // Brackets and grouped quantities.
    if (this.take('the', 'quantity') || this.take('quantity')) {
      const inner = this.expr((w) => w === 'end' || w === 'close' || w === 'over');
      if (this.take('end', 'quantity') || this.take('close', 'quantity')) { /* closed */ }
      this.structured = true;
      return { latex: `\\left(${inner}\\right)`, group: inner };
    }
    for (const open of [['open', 'parenthesis'], ['open', 'paren'], ['left', 'parenthesis'], ['left', 'paren'], ['open', 'bracket']]) {
      if (this.take(...open)) {
        const inner = this.expr((w) => w === 'close' || w === 'right');
        this.i += this.at('close') || this.at('right') ? 2 : 0;
        this.structured = true;
        return { latex: `\\left(${inner}\\right)`, group: inner };
      }
    }
    if (this.take('fraction')) {
      const top = this.expr((w) => w === 'over');
      this.take('over');
      const bottom = this.expr((w) => w === 'end');
      this.take('end', 'fraction');
      this.structured = true;
      return { latex: `\\frac{${top}}{${bottom}}` };
    }

    // Roots and absolute value.
    for (const [words, build] of [
      [['the', 'square', 'root', 'of'], (x: string) => `\\sqrt{${x}}`], [['square', 'root', 'of'], (x: string) => `\\sqrt{${x}}`],
      [['square', 'root'], (x: string) => `\\sqrt{${x}}`], [['root', 'of'], (x: string) => `\\sqrt{${x}}`],
      [['cube', 'root', 'of'], (x: string) => `\\sqrt[3]{${x}}`], [['the', 'absolute', 'value', 'of'], (x: string) => `\\left|${x}\\right|`],
      [['absolute', 'value', 'of'], (x: string) => `\\left|${x}\\right|`],
    ] as [string[], (x: string) => string][]) {
      if (this.take(...words)) {
        const inner = this.term(bounds);
        this.structured = true;
        return { latex: build(inner.group ?? inner.latex) };
      }
    }

    // Calculus.
    if (this.take('double', 'integral')) return this.structure(this.limits('\\iint', bounds));
    if (this.take('contour', 'integral')) return this.structure(this.limits('\\oint', bounds));
    if (this.take('the', 'integral') || this.take('integral')) return this.structure(this.limits('\\int', bounds));
    if (this.take('the', 'sum') || this.take('sum') || this.take('summation')) return this.structure(this.limits('\\sum', bounds));
    if (this.take('the', 'product') || this.take('product')) return this.structure(this.limits('\\prod', bounds));
    if (this.take('the', 'limit', 'as') || this.take('limit', 'as')) {
      const variable = this.expr((w) => w === 'goes' || w === 'approaches' || w === 'to', true);
      if (!this.take('goes', 'to') && !this.take('approaches')) this.take('to');
      const target = this.expr((w) => w === 'of', true);
      this.take('of');
      return this.structure({ latex: `\\lim_{${variable} \\to ${target}} ${this.expr(() => false, bounds)}`.trim() });
    }
    if (this.take('the', 'second', 'derivative', 'of') || this.take('second', 'derivative', 'of')) {
      const y = this.expr((w) => w === 'with');
      this.take('with', 'respect', 'to');
      const x = this.factor(bounds).latex;
      return this.structure({ latex: `\\frac{d^{2}${y}}{d${x}^{2}}` });
    }
    if (this.take('the', 'derivative', 'of') || this.take('derivative', 'of')) {
      const y = this.expr((w) => w === 'with');
      this.take('with', 'respect', 'to');
      const x = this.factor(bounds).latex;
      return this.structure({ latex: `\\frac{d${y}}{d${x}}` });
    }
    if (this.take('the', 'partial', 'derivative', 'of') || this.take('partial', 'derivative', 'of')) {
      const y = this.expr((w) => w === 'with');
      this.take('with', 'respect', 'to');
      const x = this.factor(bounds).latex;
      return this.structure({ latex: `\\frac{\\partial ${y}}{\\partial ${x}}` });
    }
    const mark = this.i;
    const d1 = this.differential();
    if (d1) {
      const d2 = this.differential();
      // "dy dx" is the derivative; a lone "dx" closes an integral.
      if (d2) return this.structure({ latex: `\\frac{${d1}}{${d2}}` });
      if (mark > 0) return this.structure({ latex: `\\, ${d1}` });
      this.i = mark;
    }

    // Functions.
    if (this.take('natural', 'log') || this.take('natural', 'logarithm')) return this.fn('\\ln', bounds);
    if (word in FUNCTIONS) {
      this.i++;
      return this.fn(FUNCTIONS[word], bounds);
    }

    // Symbols.
    if (this.take('pi')) return { latex: '\\pi' };
    if (this.take('infinity')) return { latex: '\\infty' };
    if (this.take('h', 'bar')) return { latex: '\\hbar' };
    if (this.take('nabla') || this.take('del')) return this.structure({ latex: '\\nabla' });
    if (this.take('partial')) return this.structure({ latex: '\\partial' });
    if (this.take('vector')) return this.structure({ latex: `\\vec{${this.factor(bounds).latex}}` });
    if (this.take('change', 'in')) return this.structure({ latex: `\\Delta ${this.factor(bounds).latex}` });
    if (this.at('capital') || this.at('uppercase')) {
      const next = this.t[this.i + 1] ?? '';
      if (CAPITAL_GREEK.has(next)) {
        this.i += 2;
        return { latex: `\\${next[0].toUpperCase()}${next.slice(1)}` };
      }
      if (/^[a-z]$/.test(next)) {
        this.i += 2;
        return { latex: next.toUpperCase() };
      }
    }
    if ((this.at('lowercase') || this.at('small')) && GREEK.includes(this.t[this.i + 1] ?? '')) {
      this.i += 2;
      return { latex: `\\${this.t[this.i - 1]}` };
    }
    // In physics, a spoken "delta" before a quantity is nearly always the capital: a change.
    if (this.take('delta')) return { latex: '\\Delta' };
    if (GREEK.includes(word)) {
      this.i++;
      return { latex: `\\${word}` };
    }
    if (/^[a-z]$/.test(word)) {
      this.i++;
      return { latex: this.raw[this.i - 1] };
    }
    // Whisper sometimes writes the notation itself ("x^2", "2x", "E=mc^2").
    if (/[\d^_=+*/()<>]/.test(word) && /^[\w^_=+\-*/().<>]+$/.test(word)) {
      this.i++;
      this.structured = this.structured || /[\^_=+*/<>]/.test(word);
      return { latex: this.raw[this.i - 1] };
    }
    // "ma", "mv": two letters said as a product.
    if (/^[a-z]{2}$/.test(word) && !NOT_LETTER_PAIRS.has(word)) {
      this.i++;
      return { latex: this.raw[this.i - 1].split('').join(' ') };
    }
    return { latex: '' };
  }

  private structure(term: Term): Term {
    this.structured = true;
    return term;
  }

  private fn(name: string, bounds: boolean): Term {
    this.structured = true;
    const power = this.take('squared') ? '^{2}' : this.take('cubed') ? '^{3}' : '';
    this.take('of');
    const arg = this.term(bounds);
    return { latex: `${name}${power} ${arg.latex}`.trim() };
  }
}

/** Put brackets round a product before raising it to a power, so "the quantity a plus b squared" stays correct. */
function wrap(term: Term): string {
  return term.group !== undefined ? `\\left(${term.group}\\right)` : term.latex;
}

function tokenize(spoken: string): { raw: string[]; lower: string[] } {
  const raw = spoken
    .replace(/[“”"]/g, '')
    .replace(/(\d),(\d{3})/g, '$1$2')
    .split(/\s+/)
    .map((w) => w.replace(/^[,.;:!?]+|[,.;:!?]+$/g, ''))
    .filter(Boolean)
    // Hesitations are not mathematics.
    .filter((w) => !/^(um+|uh+|er+|erm|hmm+)$/i.test(w));
  return { raw, lower: raw.map((w) => w.toLowerCase().replace(/’/g, "'")) };
}

export function spokenToLatex(spoken: string): SpokenMath {
  const { raw, lower } = tokenize(spoken);
  const parser = new Parser(raw, lower);
  const latex = parser.expr();
  return { latex, unknown: parser.unknown, structured: parser.structured };
}

/** In math mode, an utterance made entirely of mathematics is written as mathematics. */
export function isMathUtterance(spoken: string): boolean {
  const { raw } = tokenize(spoken);
  if (raw.length < 2) return false;
  const result = spokenToLatex(spoken);
  return result.unknown.length === 0 && result.structured && result.latex.length > 0;
}
