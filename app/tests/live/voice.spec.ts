import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { looksDrafted } from '../../src/llm/guard';

// Real Ollama. The student writes in short plain sentences; one paragraph is
// added in a long, stock style. Does the feedback notice, and protect the voice?

const essay = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/essays/essay1.txt'), 'utf8').trim().split(/\n\s*\n/);
const LONG = 'Throughout the entirety of that long and difficult summer I slowly came to appreciate that a plethora of lessons about patience and humility can be found in the process of repairing an engine.';

test('voice-aware feedback with the real model', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).click();
  for (const para of [...essay, LONG]) {
    if (para !== essay[0]) await page.keyboard.press('Enter');
    await page.keyboard.insertText(para);
    await page.waitForTimeout(650);
  }
  const everything = [...essay, LONG].join('\n');

  // 1. The model describes the voice; every note it keeps rests on a real line.
  await page.getByRole('button', { name: 'My voice and memory' }).click();
  await page.getByRole('button', { name: 'Describe my voice from my essays' }).click();
  const tone = page.getByTestId('memory-tone');
  await expect(tone.first()).toBeVisible({ timeout: 120_000 });
  const notes = await tone.evaluateAll((els) => els.map((el) => ({ note: el.querySelector('textarea')!.value, quote: el.querySelector('q')?.textContent ?? '' })));
  console.log('\n--- tone notes ---\n' + notes.map((n) => `${n.note}  <-  "${n.quote}"`).join('\n'));
  for (const n of notes) expect(everything.toLowerCase()).toContain(n.quote.toLowerCase().replace(/[.,;:!?…"]+$/, ''));
  console.log('--- stories ---\n' + (await page.getByTestId('memory-story').evaluateAll((els) => els.map((el) => el.querySelector('textarea')!.value).join(' | '))));

  // 2. The counselor is asked about the odd paragraph.
  await page.getByRole('button', { name: 'Back to essays' }).click();
  await page.getByRole('list', { name: 'Essay stage' }).getByRole('button', { name: '3. Refine' }).click();
  await expect(page.getByTestId('voice-check').locator('summary')).toHaveText('Voice check (1)');
  await page.getByLabel('Ask the counselor').fill('Does the last paragraph sound like me?');
  await page.getByLabel('Ask the counselor').press('Enter');
  const reply = page.getByTestId('chat').locator('[data-role="assistant"]').first();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 120_000 });
  const text = (await reply.innerText()).replace(/\s*Useful\s*Not for me\s*$/, '').trim();
  console.log('\n--- "Does the last paragraph sound like me?" ---\n' + text);

  expect(looksDrafted(text, everything + '\nDoes the last paragraph sound like me?').drafted).toBe(false);
  // It should say the paragraph is unlike the student, not praise it as more polished.
  expect(text).toMatch(/P6|last paragraph|plethora|longer|unlike|less like|not like|doesn't sound|does not sound|different/i);
  // The essay is untouched.
  await expect(page.getByRole('textbox', { name: 'Paragraph 6', exact: true })).toHaveText(LONG);
  await expect(page.getByTestId('word-count')).toHaveText('174 words');
});
