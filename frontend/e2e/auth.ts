import { expect, type Page } from '@playwright/test';

/**
 * Dev sign-in for the real stack. The API limits POST /v1/dev/login per IP per minute (by design), and the full suite
 * signs in many times, so a refused sign-in waits out the window and tries again instead of failing the test. Any other
 * failure still fails: only the "Too many sign-in attempts" alert is retried.
 */
export async function devSignIn(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.goto('/login?dev=1');
    await page.getByTestId('dev-login-button').click();
    const home = expect(page).toHaveURL(/\/home$/, { timeout: 10_000 });
    try {
      await home;
      return;
    } catch (e) {
      const limited = await page.getByText('Too many sign-in attempts').isVisible().catch(() => false);
      if (!limited) throw e;
      await page.waitForTimeout(10_000);
    }
  }
  throw new Error('dev sign-in stayed rate limited');
}
