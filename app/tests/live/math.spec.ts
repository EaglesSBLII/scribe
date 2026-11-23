import { expect, test } from '@playwright/test';

// The recording says, with pauses between:
//   "We measured the period five times."   (prose; "period" here is a word)
//   "x squared over two."
//   "Equation, integral from zero to pi of sine x d x."
//   "Heading, results."

test('math mode: spoken mathematics becomes typeset mathematics, through real Whisper', async ({ page }) => {
  const outside: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('data:')) return route.continue();
    outside.push(url);
    return route.abort();
  });
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('button', { name: 'Math', exact: true }).click();
  await page.getByRole('button', { name: 'Start dictation' }).click();

  // Prose stays prose, then the formula joins the sentence's paragraph as mathematics.
  const formulas = page.getByTestId('math');
  await expect(formulas.first()).toHaveAttribute('data-latex', /^[xX]\^\{2\}\/2$/, { timeout: 60_000 });
  await expect(page.getByTestId('rich-view').first()).toContainText('We measured the period five times.');

  // "Equation ..." becomes a numbered equation on its own line.
  await expect(formulas.nth(1)).toHaveAttribute('data-latex', '\\int_{0}^{\\pi} \\sin x \\, dx', { timeout: 60_000 });
  const equation = page.getByTestId('rich-view').filter({ has: page.locator('.katex-display') });
  await expect(equation).toContainText('(1)');

  // "Heading ..." becomes a heading.
  const heading = page.locator('[data-testid="rich-view"][data-kind="heading1"]');
  await expect(heading).toHaveText('Results', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Stop dictation' }).click();

  // Nothing was solved or added: only what was said is there.
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('scribe');
      open.onsuccess = () => resolve(open.result);
    });
    const rows = await new Promise<{ doc: { paragraphs: { nodes: { t: string; text?: string; latex?: string }[] }[] } }[]>((resolve) => {
      db.transaction('essays').objectStore('essays').getAll().onsuccess = (e) => resolve((e.target as IDBRequest).result);
    });
    db.close();
    return rows[0].doc.paragraphs.map((p) => p.nodes.map((n) => (n.t === 'math' ? `[${n.latex}]` : n.text)).join('')).filter(Boolean);
  });
  console.log('\n--- dictated in math mode ---\n' + stored.join('\n'));
  expect(stored).toHaveLength(3);
  expect(stored[2]).toBe('# Results');
  expect(outside).toEqual([]);
});
