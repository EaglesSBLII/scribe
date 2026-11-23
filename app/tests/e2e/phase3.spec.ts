import { expect, test } from '@playwright/test';

test('an unsure word is highlighted, and one click flips it either way', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  const para = page.getByRole('textbox', { name: 'Paragraph 1', exact: true });
  await expect(para).toBeVisible();
  await expect(page.getByTestId('save-state')).toContainText('Saved');

  // Put the essay in the state dictation leaves it in after
  // "I love boats period then we left" with no clear pause.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('scribe');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const store = db.transaction('essays', 'readwrite').objectStore('essays');
    const essay = await new Promise<Record<string, any>>((resolve) => {
      store.getAll().onsuccess = (e) => resolve((e.target as IDBRequest).result[0]);
    });
    essay.doc.paragraphs[0].nodes = [
      { t: 'text', text: 'I love boats' },
      { t: 'flag', text: '.', alt: ' period', cap: true },
      { t: 'text', text: ' Then we left.' },
    ];
    await new Promise((resolve) => (store.put(essay).onsuccess = resolve));
    db.close();
  });
  await page.reload();

  await expect(para).toHaveText('I love boats. Then we left.');
  const flag = para.locator('.flag');
  await expect(flag).toHaveText('.');

  await flag.click();
  await expect(para).toHaveText('I love boats period then we left.');
  await expect(flag).toHaveText('period');

  await flag.click();
  await expect(para).toHaveText('I love boats. Then we left.');

  // Typing elsewhere in the paragraph leaves the highlight in place; undo steps back through the flips.
  await para.press('End');
  await page.keyboard.type(' It rained.');
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await page.waitForTimeout(700);
  await expect(flag).toHaveText('.');
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(para).toHaveText('I love boats period then we left.');
});

test('with no speech engine, Dictate explains what to do instead of failing silently', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('button', { name: 'Start dictation' }).click();
  await expect(page.getByTestId('dictation-status')).toContainText('speech engine is not running');
});
