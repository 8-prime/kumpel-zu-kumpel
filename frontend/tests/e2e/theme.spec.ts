import { expect, test, type Page } from '@playwright/test';

async function expectTheme(page: Page, theme: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
  await expect(page.locator('html')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(15, 23, 38)' : 'rgb(238, 243, 250)');
  await expect(page.locator('.workspace')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(23, 35, 55)' : 'rgb(255, 255, 255)');
}

test('defaults to the system theme and follows live system changes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveValue('system');
  await expectTheme(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(page, 'dark');
  expect(await page.evaluate(() => localStorage.getItem('kumpel-theme'))).toBeNull();
});

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} override survives reload and takes precedence over the system`, async ({ page }) => {
    const opposite = theme === 'dark' ? 'light' : 'dark';
    await page.emulateMedia({ colorScheme: opposite });
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
    await expectTheme(page, theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.emulateMedia({ colorScheme: opposite });
    await expectTheme(page, theme);
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveValue(theme);
    await expectTheme(page, theme);

    // The saved choice is applied even while the application bundle is unavailable.
    await page.route('**/src/main.tsx', route => route.abort());
    await page.reload();
    await expect(page.locator('#root')).toBeEmpty();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  });
}

test('returning to System clears the override and restores live updates after reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const picker = page.getByRole('combobox', { name: 'Theme' });
  await picker.selectOption('dark');
  await expectTheme(page, 'dark');
  await picker.selectOption('system');
  await expectTheme(page, 'light');
  expect(await page.evaluate(() => localStorage.getItem('kumpel-theme'))).toBeNull();
  await page.reload();
  await expect(picker).toHaveValue('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(page, 'dark');
});

test('an invalid saved theme falls back to System', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kumpel-theme', 'invalid'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveValue('system');
  await expectTheme(page, 'dark');
});

test('blocked storage still allows system theming and manual selection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('Storage blocked', 'SecurityError'); },
    });
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expectTheme(page, 'dark');
  const picker = page.getByRole('combobox', { name: 'Theme' });
  await picker.selectOption('light');
  await expectTheme(page, 'light');
  await picker.selectOption('system');
  await expectTheme(page, 'dark');
  await expect(page.getByRole('button', { name: 'Create share link' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('theme selection and error states remain usable on narrow screens', async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/?session=bad&role=receiver');
    for (const theme of ['light', 'dark'] as const) {
      const picker = page.getByRole('combobox', { name: 'Theme' });
      await picker.selectOption(theme);
      await picker.focus();
      await expect(picker).toBeFocused();
      await expectTheme(page, theme);
      await expect(page.getByRole('alert')).toContainText('incomplete');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/theme-${theme}-${width}-${test.info().project.name}.png`, fullPage: true });
    }
  }
});
