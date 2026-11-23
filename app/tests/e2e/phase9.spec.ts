import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Document, Packer, Paragraph, TextRun } from 'docx';

const BODY = 'The measured period agrees with the prediction to within two percent across all five of the masses that were used.';

/** A sample paper in a physics-journal style, as a real PDF. */
async function samplePdf(): Promise<string> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const page = pdf.addPage([612, 792]);
  let y = 720;
  const line = (text: string, size = 10, font = regular, x = 72) => {
    page.drawText(text, { x, y, size, font });
    y -= size * 1.2;
  };
  line('Oscillations of a Loaded Spring', 18, bold, 170);
  y -= 16;
  for (const [heading, equation, caption] of [
    ['I. INTRODUCTION', 'x(t) = A cos(wt + p)    (1)', 'FIG. 1. The apparatus used for the measurements.'],
    ['II. METHOD', 'T = 2 pi sqrt(m/k)    (2)', 'FIG. 2. Period against mass.'],
    ['III. RESULTS', 'k = 4 pi^2 m / T^2    (3)', 'FIG. 3. Residuals of the fit.'],
  ]) {
    y -= 8;
    line(heading, 11, bold);
    for (let i = 0; i < 5; i++) line(BODY);
    y -= 6;
    line(equation, 10, regular, 220);
    y -= 6;
    line(BODY);
    y -= 30;
    line(caption, 9, regular, 150);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-sample-')), 'journal-sample.pdf');
  fs.writeFileSync(file, await pdf.save());
  return file;
}

/** A sample lab report in a different style, as a real Word file. */
async function sampleDocx(): Promise<string> {
  const body = () => new Paragraph({ spacing: { line: 480 }, children: [new TextRun({ text: BODY, size: 24, font: 'Calibri' })] });
  const heading = (text: string) => new Paragraph({ children: [new TextRun({ text, bold: true, size: 28, font: 'Calibri' })] });
  const doc = new Document({
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1701, bottom: 1701, left: 1701, right: 1701 } } },
        children: [
          heading('1. Introduction'), body(), body(), body(),
          new Paragraph({ children: [new TextRun({ text: 'v = d/t (1.1)', size: 24, font: 'Calibri' })] }),
          new Paragraph({ children: [new TextRun({ text: 'Figure 1: Layout of the track.', size: 22, font: 'Calibri' })] }),
          heading('2. Method'), body(), body(),
          new Paragraph({ children: [new TextRun({ text: 'a = F/m (2.1)', size: 24, font: 'Calibri' })] }),
          new Paragraph({ children: [new TextRun({ text: 'Figure 2: The cart and the masses.', size: 22, font: 'Calibri' })] }),
          heading('3. Results'), body(),
        ],
      },
    ],
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-sample-')), 'lab-report.docx');
  fs.writeFileSync(file, await Packer.toBuffer(doc));
  return file;
}

const PAPER = [
  '# Introduction',
  'A mass on a spring obeys $F = -k x$ near rest.',
  '$$\\ddot{x} = -\\omega^{2} x$$',
  '## Energy',
  '$$E = \\frac{1}{2} k x^{2}$$',
  'Figure: The spring at rest.',
];

async function start(page: Page, paragraphs: string[]) {
  await page.addInitScript(() => {
    // Record a request to print instead of opening the system dialog.
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => { (window as unknown as { printed: number }).printed++; };
  });
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).click();
  for (const [i, text] of paragraphs.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.insertText(text);
    await page.waitForTimeout(600);
  }
  // Click away so nothing is being edited.
  await page.getByLabel('Essay title').first().click();
}

const finish = (page: Page) => page.getByRole('list', { name: 'Essay stage' }).getByRole('button', { name: '4. Finish' }).click();
const download = async (page: Page, label: string) => {
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: label, exact: true }).click()]);
  return fs.readFileSync(await d.path());
};

test('mathematics is drawn with KaTeX, equations are numbered, and a click returns to the text', async ({ page }) => {
  await start(page, PAPER);
  const views = page.getByTestId('rich-view');
  await expect(views).toHaveCount(6);
  await expect(views.nth(0)).toHaveAttribute('data-kind', 'heading1');
  await expect(views.nth(0)).toHaveText('Introduction');
  // Inline mathematics inside a sentence.
  await expect(views.nth(1).getByTestId('math')).toHaveAttribute('data-latex', 'F = -k x');
  await expect(views.nth(1).locator('.katex')).toBeVisible();
  // Display equations, numbered in order.
  await expect(views.nth(2)).toContainText('(1)');
  await expect(views.nth(4)).toContainText('(2)');
  await expect(views.nth(4).locator('.katex .mfrac')).toBeVisible();
  await expect(views.nth(5)).toHaveAttribute('data-kind', 'caption');
  // A formula counts as one word: headings 1 + 1, the sentence 8 + its formula 1, two equations 1 + 1, caption 5.
  await expect(page.getByTestId('word-count')).toHaveText('18 words');

  // Clicking shows the plain text for editing; leaving draws it again.
  await views.nth(2).click();
  const editor = page.getByRole('textbox', { name: 'Paragraph 3', exact: true });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('$$\\ddot{x} = -\\omega^{2} x$$');
  await page.getByLabel('Essay title').first().click();
  await expect(page.getByTestId('rich-view')).toHaveCount(6);

  // It all survives a reload unchanged.
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByTestId('rich-view')).toHaveCount(6);
  await expect(page.getByTestId('rich-view').nth(4).getByTestId('math')).toHaveAttribute('data-latex', 'E = \\frac{1}{2} k x^{2}');
});

test('math mode is a per-essay switch that is remembered', async ({ page }) => {
  await start(page, ['Plain essay.']);
  const toggle = page.getByRole('button', { name: 'Math', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Math', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a format is learned from a sample PDF and applied on export', async ({ page }) => {
  const sample = await samplePdf();
  await start(page, PAPER);
  await finish(page);

  // Before any sample: Scribe's default layout.
  expect((await download(page, '.txt')).toString('utf8').split('\n\n').slice(0, 3)).toEqual(['Introduction', 'A mass on a spring obeys F = -k x near rest.', '    ẍ = -ω² x    (1)'.normalize('NFC')]);

  await page.getByLabel('Upload a sample paper').setInputFiles(sample);
  const notes = page.getByTestId('format-notes');
  await expect(notes).toBeVisible({ timeout: 30_000 });
  await expect(notes).toContainText('Learned from journal-sample.pdf. Only its formatting was kept.');
  await expect(notes).toContainText('Body text: 10 pt serif.');
  await expect(notes).toContainText('Headings: roman numerals (I., II.), 11 pt, bold, capitals.');
  await expect(notes).toContainText('Figure captions are labelled “FIG. 1.”.');
  await expect(notes).toContainText('Equations are numbered in one run, like (1).');
  await expect(page.getByLabel('Paper format')).toHaveValue(/.+/);

  // The same essay, now exported in the learned format. The words are untouched.
  const txt = (await download(page, '.txt')).toString('utf8').split('\n\n');
  expect(txt.slice(0, 6)).toEqual([
    'I. INTRODUCTION',
    'A mass on a spring obeys F = -k x near rest.',
    '    ẍ = -ω² x    (1)'.normalize('NFC'),
    'A. Energy',
    '    E = 1/2 k x²    (2)',
    'FIG. 1. The spring at rest.\n',
  ]);
  const docx = await download(page, '.docx');
  expect(docx.subarray(0, 2).toString()).toBe('PK');

  // PDF goes through the print path with typeset mathematics.
  await page.getByRole('button', { name: '.pdf', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  const root = page.locator('#print-root');
  await expect(root.locator('[data-block="heading"]').first()).toHaveText('I. INTRODUCTION');
  await expect(root.locator('[data-block="heading"]').nth(1)).toHaveText('A. Energy');
  await expect(root.locator('[data-block="equation"] [data-part="equation-number"]')).toHaveText(['(1)', '(2)']);
  await expect(root.locator('[data-block="equation"] .katex-display')).toHaveCount(2);
  await expect(root.locator('[data-block="caption"]')).toHaveText('FIG. 1. The spring at rest.');
  await expect(root).toHaveCSS('font-size', /13\.3/); // 10 pt
  const printed = await page.pdf({ format: 'Letter' });
  expect(printed.subarray(0, 5).toString()).toBe('%PDF-');
  expect(printed.length).toBeGreaterThan(5000);

  // The format belongs to the account and is still there after a reload; it can be forgotten.
  await page.reload();
  await page.getByRole('button', { name: 'Open counselor' }).click();
  await expect(page.getByLabel('Paper format')).toHaveValue(/.+/);
  await page.getByRole('button', { name: 'Forget this format' }).click();
  await expect(page.getByTestId('format-notes')).toHaveCount(0);
  await expect(page.getByLabel('Paper format').locator('option')).toHaveCount(1);
});

test('a format is learned from a sample Word file', async ({ page }) => {
  const sample = await sampleDocx();
  await start(page, PAPER);
  await finish(page);
  await page.getByLabel('Upload a sample paper').setInputFiles(sample);
  const notes = page.getByTestId('format-notes');
  await expect(notes).toBeVisible({ timeout: 30_000 });
  await expect(notes).toContainText('Body text: 12 pt sans-serif.');
  await expect(notes).toContainText('Page: A4, 1.2-inch margins, line spacing 2.');
  await expect(notes).toContainText('Headings: numbers (1., 2.), 14 pt, bold.');
  await expect(notes).toContainText('Figure captions are labelled “Figure 1:”.');
  await expect(notes).toContainText('Equations are numbered by section, like (2.1).');

  const txt = (await download(page, '.txt')).toString('utf8').split('\n\n');
  expect(txt.slice(0, 6)).toEqual([
    '1. Introduction',
    'A mass on a spring obeys F = -k x near rest.',
    '    ẍ = -ω² x    (1.1)'.normalize('NFC'),
    '1.1. Energy',
    '    E = 1/2 k x²    (1.2)',
    'Figure 1: The spring at rest.\n',
  ]);
});

test('a file that is not a paper is refused with a clear message, and an ordinary essay still exports as before', async ({ page }) => {
  await start(page, ['An ordinary essay.', 'With two paragraphs.']);
  await finish(page);
  const bogus = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-sample-')), 'notes.docx');
  fs.writeFileSync(bogus, 'this is not really a Word file');
  await page.getByLabel('Upload a sample paper').setInputFiles(bogus);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('format-notes')).toHaveCount(0);

  expect((await download(page, '.txt')).toString('utf8')).toBe('An ordinary essay.\n\nWith two paragraphs.\n');
  expect((await download(page, '.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(0);
});
