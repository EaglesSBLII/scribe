import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { isMathUtterance, spokenToLatex } from '../../src/math/spoken';

const tex = (s: string) => spokenToLatex(s).latex;

describe('the examples from the brief', () => {
  it('"x squared over two" becomes x²/2', () => {
    expect(tex('x squared over two')).toBe('x^{2}/2');
  });

  it('"integral from zero to pi of sine x dx" becomes an integral with limits', () => {
    expect(tex('integral from zero to pi of sine x dx')).toBe('\\int_{0}^{\\pi} \\sin x \\, dx');
  });

  it('handles the same phrases as Whisper tends to write them', () => {
    expect(tex('X squared over 2.')).toBe('X^{2}/2');
    expect(tex('Integral from 0 to pi of sin x dx.')).toBe('\\int_{0}^{\\pi} \\sin x \\, dx');
    expect(tex('um, x squared over two')).toBe('x^{2}/2');
  });
});

describe('algebra', () => {
  it.each([
    ['a plus b', 'a + b'],
    ['a minus b times c', 'a - b \\times c'],
    ['E equals m c squared', 'E = m c^{2}'],
    ['E equals mc squared', 'E = m c^{2}'],
    ['F equals ma', 'F = m a'],
    ['one half m v squared', '\\frac{1}{2} m v^{2}'],
    ['x cubed', 'x^{3}'],
    ['x to the fourth', 'x^{4}'],
    ['x to the power of n plus one', 'x^{n} + 1'],
    ['e to the minus x', 'e^{-x}'],
    ['two to the nth power', '2^{n}'],
    ['x sub zero', 'x_{0}'],
    ['v naught', 'v_{0}'],
    ['negative b plus or minus the square root of b squared', '-b \\pm \\sqrt{b^{2}}'],
    ['the quantity a plus b over c', '\\frac{a + b}{c}'],
    ['the quantity a plus b end quantity squared', '\\left(a + b\\right)^{2}'],
    ['fraction a plus b over c minus d end fraction', '\\frac{a + b}{c - d}'],
    ['open paren x plus one close paren times y', '\\left(x + 1\\right) \\times y'],
    ['three point one four', '3.14'],
    ['twenty one x', '21 x'],
    ['x is less than or equal to five', 'x \\leq 5'],
    ['a is not equal to b', 'a \\neq b'],
    ['y is proportional to x', 'y \\propto x'],
    ['n factorial', 'n!'],
    ['absolute value of x', '\\left|x\\right|'],
    ['a dot b', 'a \\cdot b'],
  ])('%s', (spoken, expected) => expect(tex(spoken)).toBe(expected));
});

describe('calculus and physics notation', () => {
  it.each([
    ['dy dx', '\\frac{dy}{dx}'],
    ['d y d x equals two x', '\\frac{dy}{dx} = 2 x'],
    ['the derivative of y with respect to x', '\\frac{dy}{dx}'],
    ['the second derivative of x with respect to t', '\\frac{d^{2}x}{dt^{2}}'],
    ['partial derivative of f with respect to x', '\\frac{\\partial f}{\\partial x}'],
    ['integral of x squared dx', '\\int x^{2} \\, dx'],
    ['sum from i equals one to n of i squared', '\\sum_{i = 1}^{n} i^{2}'],
    ['limit as x goes to zero of sine x over x', '\\lim_{x \\to 0} \\sin x/x'],
    ['sine squared theta plus cosine squared theta equals one', '\\sin^{2} \\theta + \\cos^{2} \\theta = 1'],
    ['natural log of x', '\\ln x'],
    ['x dot', '\\dot{x}'],
    ['x double dot equals negative omega squared x', '\\ddot{x} = -\\omega^{2} x'],
    ['vector F equals m vector a', '\\vec{F} = m \\vec{a}'],
    ['delta x over delta t', '\\Delta x/\\Delta t'],
    ['change in p', '\\Delta p'],
    ['h bar omega', '\\hbar \\omega'],
    ['capital omega', '\\Omega'],
    ['lowercase delta', '\\delta'],
    ['lambda equals h over p', '\\lambda = h/p'],
    ['theta equals forty five degrees', '\\theta = 45^{\\circ}'],
  ])('%s', (spoken, expected) => expect(tex(spoken)).toBe(expected));
});

describe('units', () => {
  it.each([
    ['nine point eight meters per second squared', '9.8\\,\\mathrm{m/s^{2}}'],
    ['five kilograms', '5\\,\\mathrm{kg}'],
    ['g equals nine point eight one meters per second squared', 'g = 9.81\\,\\mathrm{m/s^{2}}'],
    ['ten newton meters', '10\\,\\mathrm{N\\,m}'],
    ['three hundred kelvin', '300\\,\\mathrm{K}'],
    ['twelve volts', '12\\,\\mathrm{V}'],
  ])('%s', (spoken, expected) => expect(tex(spoken)).toBe(expected));

  it('treats a unit word as a unit only after a number', () => {
    expect(spokenToLatex('the second term').unknown).toContain('second');
  });
});

describe('it only writes down what was said', () => {
  it('never evaluates or simplifies', () => {
    expect(tex('two plus two')).toBe('2 + 2');
    expect(tex('x over x')).toBe('x/x');
    expect(tex('integral from zero to one of x dx')).toBe('\\int_{0}^{1} x \\, dx');
    expect(tex('the derivative of x squared with respect to x')).toBe('\\frac{dx^{2}}{dx}');
  });

  it('is deterministic', () => {
    const s = 'integral from zero to pi of sine x dx';
    expect(tex(s)).toBe(tex(s));
  });
});

describe('telling mathematics from prose', () => {
  it.each(['x squared over two', 'integral from zero to pi of sine x dx', 'F equals ma', 'E equals m c squared', 'nine point eight meters per second squared'])(
    'math: %s',
    (s) => expect(isMathUtterance(s)).toBe(true),
  );

  it.each([
    'So I went to the dock.',
    'The boat was gone.',
    'I had a notebook with forty three numbered steps.',
    'We measured the force three times.',
    'x',
    'Energy is conserved in this collision.',
  ])('prose: %s', (s) => expect(isMathUtterance(s)).toBe(false));

  it('reports the words that are not mathematics', () => {
    expect(spokenToLatex('x squared plus banana').unknown).toEqual(['banana']);
  });
});

describe('every result is valid LaTeX that KaTeX can draw', () => {
  it.each([
    'x squared over two', 'integral from zero to pi of sine x dx', 'the quantity a plus b over c', 'sum from i equals one to n of i squared',
    'limit as x goes to zero of sine x over x', 'x double dot equals negative omega squared x', 'nine point eight meters per second squared',
    'negative b plus or minus the square root of b squared', 'partial derivative of f with respect to x', 'vector F equals m vector a',
    'theta equals forty five degrees', 'h bar omega', 'fraction a plus b over c minus d end fraction',
  ])('%s', (spoken) => {
    expect(() => katex.renderToString(tex(spoken), { throwOnError: true })).not.toThrow();
  });
});
