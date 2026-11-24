import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Acceptance: grading the same essay 3 times gives identical scores.
// Real Ollama. The stored grade is deleted between runs, so each of the three
// is a fresh run of the model, not a remembered answer.

const essay = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/essays/essay1.txt'), 'utf8').trim().split(/\n\s*\n/);

async function clearGrades(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('scribe');
      open.onsuccess = () => resolve(open.result);
    });
    await new Promise((resolve) => (db.transaction('grades', 'readwrite').objectStore('grades').clear().onsuccess = resolve));
    db.close();
  });
}

async function readGrade(page: Page) {
  const total = await page.getByTestId('grade-total').innerText();
  const sections = await page.getByTestId('grade-section').evaluateAll((els) =>
    els.map((el) => ({
      line: (el.querySelector('div')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      quote: el.querySelector('q')?.textContent ?? null,
    })),
  );
  return { total: total.replace(/\s+/g, ''), sections };
}

test('grading the same essay three times gives identical scores', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).click();
  for (const [i, para] of essay.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.insertText(para);
    await page.waitForTimeout(700);
  }
  await expect(page.getByTestId('word-count')).toHaveText('141 words');
  await page.getByLabel('College').fill('Common App');
  await page.locator('[role="option"][data-college-id="commonapp"]').click();
  await page.getByLabel('Prompt').selectOption('commonapp-2');
  await page.getByRole('list', { name: 'Essay stage' }).getByRole('button', { name: '3. Refine' }).click();
  await page.getByText('Grade', { exact: true }).click();
  await page.waitForTimeout(500);

  const runs = [];
  for (let run = 1; run <= 3; run++) {
    await clearGrades(page);
    await page.reload();
    await page.getByRole('button', { name: 'Open counselor' }).click();
    await page.getByText('Grade', { exact: true }).click();
    await expect(page.getByTestId('grade')).toHaveCount(0);
    const started = Date.now();
    await page.getByRole('button', { name: 'Grade this draft' }).click();
    await expect(page.getByTestId('grade-total')).toBeVisible({ timeout: 180_000 });
    // A fresh run, not the remembered grade.
    await expect(page.getByTestId('grade')).not.toContainText('Same text as before');
    const grade = await readGrade(page);
    console.log(`run ${run}: ${grade.total} in ${((Date.now() - started) / 1000).toFixed(1)}s  ${grade.sections.map((s) => s.line.replace(/ · weight.*/, '')).join(' | ')}`);
    runs.push(grade);
  }
  for (const s of runs[0].sections) console.log(`  ${s.line}  ->  ${s.quote ?? '(no exact line)'}`);

  expect(runs[1]).toEqual(runs[0]);
  expect(runs[2]).toEqual(runs[0]);
  expect(runs[0].total).toMatch(/^\d{1,3}\/100$/);
  expect(runs[0].sections).toHaveLength(6);

  // And once a grade is stored, asking again returns it unchanged.
  await page.getByRole('button', { name: 'Grade this draft' }).click();
  await expect(page.getByTestId('grade')).toContainText('Same text as before: same score');
  expect((await readGrade(page)).total).toBe(runs[0].total);
});
