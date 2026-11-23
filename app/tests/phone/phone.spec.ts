import { expect, test } from '@playwright/test';

// One browser plays the Mac, another plays an iPhone-sized device that reaches
// the Mac the way a phone does: through a forwarding tunnel, so the Mac sees it
// as another device. The recording played into the phone's microphone says:
// "um, so I, uh, went to the the dock. I love boats, period. The Jurassic period was huge."

const EMAIL = 'writer@example.com';
const PASSWORD = 'correct horse battery';

test('a phone signs in to the Mac, syncs both ways, keeps a losing copy, and records offline', async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000);
  const phoneContext = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone'],
    extraHTTPHeaders: { 'X-Forwarded-For': '100.64.0.2' },
  });
  const phone = await phoneContext.newPage();

  // Until phone access is switched on at the Mac, another device gets nothing.
  expect((await phoneContext.request.get('/api/health')).status()).toBe(403);

  // ---- On the Mac ----
  await page.goto('/');
  await page.getByLabel('Your email').fill(EMAIL);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  const macP1 = page.getByRole('textbox', { name: 'Paragraph 1', exact: true });
  await macP1.click();
  await page.keyboard.type('Written on the Mac.');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Phone access password').fill('short');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('Use a password of at least 8 characters.')).toBeVisible();
  await page.getByLabel('Phone access password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('On: your phone can sign in')).toBeVisible();
  await page.getByRole('button', { name: 'Back to essays' }).click();

  // Some other website open in a browser on the Mac cannot drive Scribe either.
  expect((await page.request.post('/api/remote', { headers: { Origin: 'https://elsewhere.example' }, data: { email: EMAIL, password: 'taken over 123' } })).status()).toBe(403);
  expect((await page.request.post('/api/sync', { headers: { Origin: 'https://elsewhere.example' }, data: { email: EMAIL, since: 0, push: [] } })).status()).toBe(403);

  // Switched on, but not signed in: still nothing but the sign-in page.
  expect((await phoneContext.request.get('/api/health')).status()).toBe(401);
  expect((await phoneContext.request.post('/api/sync', { data: { email: EMAIL, since: 0, push: [] } })).status()).toBe(401);
  expect((await phoneContext.request.post('/api/asr', { data: 'x' })).status()).toBe(401);
  expect((await phoneContext.request.post('/api/llm/chat', { data: {} })).status()).toBe(401);
  expect((await phoneContext.request.post('/api/remote', { data: { email: EMAIL, password: 'taken over 123' } })).status()).toBe(401);

  // ---- On the phone ----
  await phone.goto('/');
  await phone.getByLabel('Email').fill(EMAIL);
  await phone.getByLabel('Password').fill('not the password');
  await phone.getByRole('button', { name: 'Sign in' }).click();
  await expect(phone.getByRole('alert')).toHaveText('Wrong email or password.');
  await phone.getByLabel('Password').fill(PASSWORD);
  await phone.getByRole('button', { name: 'Sign in' }).click();

  // The essay written on the Mac arrives.
  const phoneP1 = phone.getByRole('textbox', { name: 'Paragraph 1', exact: true });
  await expect(phoneP1).toHaveText('Written on the Mac.', { timeout: 30_000 });

  // Even signed in, a phone cannot change phone access: that is done at the Mac only.
  expect((await phoneContext.request.post('/api/remote', { data: { email: EMAIL, password: 'taken over 123' } })).status()).toBe(403);
  // And it reaches its own account only, whatever it asks for.
  const other = await (await phoneContext.request.post('/api/sync', { data: { email: 'someone@else.example', since: 0, push: [] } })).json();
  expect(other.pull.some((r: { coll: string }) => r.coll === 'essays')).toBe(true);

  // The layout fits a 390 x 844 screen: nothing spills sideways, essays are in a drawer,
  // there is one large microphone button, and the counselor is a sheet at the bottom.
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(phone.getByRole('navigation', { name: 'Essays' })).toBeHidden();
  const mic = phone.getByTestId('big-mic');
  await expect(mic).toBeVisible();
  expect((await mic.boundingBox())!.width).toBeGreaterThanOrEqual(72);
  await phone.getByRole('button', { name: 'Show essays' }).click();
  await expect(phone.getByTestId('essay-tab')).toHaveCount(1);
  await phone.getByRole('button', { name: 'Close the essay list' }).click({ position: { x: 370, y: 420 } });
  await expect(phone.getByRole('navigation', { name: 'Essays' })).toBeHidden();
  await phone.getByRole('button', { name: 'Open counselor' }).click();
  const sheet = (await phone.getByRole('complementary', { name: 'Counselor' }).boundingBox())!;
  expect(Math.round(sheet.width)).toBe(390);
  expect(Math.round(sheet.y + sheet.height)).toBe(844);
  expect(sheet.y).toBeGreaterThan(150);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await phone.getByRole('button', { name: 'Close counselor' }).first().click();

  // It can be installed: a manifest with icons, and a service worker that keeps the app on the device.
  const manifest = await (await phoneContext.request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect((await phoneContext.request.get('/icon-192.png')).status()).toBe(200);
  expect(await phone.evaluate(async () => (await navigator.serviceWorker.ready).active !== null)).toBe(true);

  // ---- Phone to Mac ----
  await phoneP1.click();
  await phone.keyboard.press('End');
  await phone.keyboard.type(' Added on the phone.');
  await expect(macP1).toHaveText('Written on the Mac. Added on the phone.', { timeout: 30_000 });
  // On the Mac the update is an ordinary edit: undo takes it back, and that travels to the phone.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(macP1).toHaveText('Written on the Mac.');
  await expect(phoneP1).toHaveText('Written on the Mac.', { timeout: 30_000 });

  // ---- Both changed it: the newer one wins, the older is kept as a version ----
  await page.context().setOffline(true);
  await macP1.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed on the Mac while cut off.');
  await page.waitForTimeout(1500);
  await phoneP1.click();
  await phone.keyboard.press('End');
  await phone.keyboard.type(' Typed later on the phone.');
  await phone.waitForTimeout(6000);
  await page.context().setOffline(false);
  await expect(macP1).toHaveText('Written on the Mac. Typed later on the phone.', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Version history' })).toContainText('Before an update from another device');
  await page.getByRole('button', { name: 'Close version history' }).click();

  // ---- The phone out of reach of the Mac ----
  await phoneContext.setOffline(true);
  await mic.click();
  await expect(phone.getByTestId('sync-note')).toContainText('saved on this device', { timeout: 40_000 });
  // Let the recording finish, then stop. Nothing has been written yet.
  await phone.waitForTimeout(12_000);
  await mic.click();
  await expect(phoneP1).toHaveText('Written on the Mac. Typed later on the phone.');
  // With no connection the app still opens, and the recordings are still waiting.
  await phone.reload();
  await expect(phoneP1).toHaveText('Written on the Mac. Typed later on the phone.', { timeout: 30_000 });
  await expect(phone.getByTestId('sync-note')).toContainText('saved on this device');

  // Back in reach: the recordings are transcribed on the Mac, in order, into the essay.
  await phoneContext.setOffline(false);
  const whole = 'Written on the Mac. Typed later on the phone. So I went to the dock. I love boats. The Jurassic period was huge.';
  await expect(phoneP1).toHaveText(whole, { timeout: 90_000 });
  await expect(phone.getByTestId('sync-note')).toHaveCount(0);
  await expect(macP1).toHaveText(whole, { timeout: 30_000 });

  // Signing out on the phone ends its access.
  await phone.getByRole('button', { name: 'Show essays' }).click();
  await phone.getByRole('button', { name: 'Settings' }).click();
  await phone.getByRole('button', { name: 'Sign out' }).click();
  await expect(phone.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect((await phoneContext.request.get('/api/health')).status()).toBe(401);
  await phoneContext.close();
});
