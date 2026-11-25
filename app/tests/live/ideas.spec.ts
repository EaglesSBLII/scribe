import { expect, test } from '@playwright/test';
import { repeatsItself } from '../../src/llm/guard';

// The counselor listens to a whole idea: real Whisper, real Ollama, real Kokoro.
// The recording (scripts/make-ideas-recording.mjs) says "Jarvis, conversation mode.",
// then one idea in four pieces with pauses of 1.2 to 1.5 seconds between them,
// then, after the answer, an afterthought that trails off ("Wait, also, um,")
// for two seconds before it is finished.

test('a long idea spoken with pauses is heard as one turn and answered once', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByLabel('College').fill('Common App');
  await page.locator('[role="option"][data-college-id="commonapp"]').click();
  await page.getByLabel('Prompt').selectOption('commonapp-2');
  await page.waitForTimeout(500);

  await page.getByRole('button', { name: 'Open counselor' }).click();
  await page.getByRole('button', { name: 'Start dictation' }).click();
  await expect(page.getByTestId('command-chip')).toContainText('Conversation mode', { timeout: 60_000 });

  const chat = page.getByTestId('chat');
  const said = chat.locator('[data-role="user"]');
  const replies = chat.locator('[data-role="assistant"]');

  // While the idea is still being told, it is shown as heard so far and nothing is answered.
  await expect(page.getByTestId('turn-so-far')).toContainText(/boat/i, { timeout: 60_000 });
  await expect(replies).toHaveCount(0);

  await expect(replies).toHaveCount(2, { timeout: 150_000 });
  await page.waitForTimeout(15_000);

  const turns = await said.allTextContents();
  const answers = await replies.allTextContents();
  console.log('WHAT THE STUDENT SAID:\n  ' + turns.join('\n  '));
  console.log('WHAT THE COUNSELOR SAID:\n  ' + answers.map((a) => a.replace(/\s+/g, ' ')).join('\n  '));

  // Two turns, not six: the pauses did not split the idea.
  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatch(/boat/i);
  expect(turns[0]).toMatch(/engine/i);
  expect(turns[0]).toMatch(/cord/i);
  expect(turns[0]).toMatch(/not in my hands/i);
  expect(turns[1]).toMatch(/also/i);
  expect(turns[1]).toMatch(/trusting instructions/i);
  // Each was answered once, in full, with something new, and nothing went wrong.
  expect(answers).toHaveLength(2);
  for (const a of answers) expect(a).not.toContain('[interrupted]');
  expect(repeatsItself(answers[1], [answers[0]])).toBe(false);
  await expect(chat.getByRole('alert')).toHaveCount(0);
  // Nothing said to the counselor went into the essay.
  await expect(page.getByRole('textbox', { name: 'Paragraph 1', exact: true })).toHaveText('');
});
