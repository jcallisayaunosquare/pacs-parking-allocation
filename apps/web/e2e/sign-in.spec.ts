import { expect, test, type Page } from '@playwright/test';

/**
 * The two surfaces, reached the way a person reaches them.
 *
 * These are the flows that stop the product being usable at all if they break, which is
 * the bar for a suite that gates a merge: an administrator cannot see the register, or a
 * resident cannot see whether they hold a bay. Everything finer-grained is already
 * covered by 243 unit tests that do not need a browser.
 *
 * The accounts come from the offline sign-in stub (`core/auth/local-session.ts`), which
 * accepts any password because it authenticates nothing. The real Cognito flows - new
 * password challenge, MFA, reset - are not exercised here and cannot be: they need a
 * user pool. `smoke.mjs` covers the token path against the deployed stack.
 */

const signIn = async (page: Page, email: string): Promise<void> => {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  // Any password: the stub checks the address and nothing else.
  await page.locator('input[type="password"]').fill('whatever');
  await page.getByRole('button', { name: /sign in/i }).click();
};

test.describe('signing in', () => {
  test('an administrator lands on the register and can read it', async ({ page }) => {
    await signIn(page, 'admin@local');

    await expect(page).toHaveURL(/\/admin\/residents/);
    await expect(page.getByRole('heading', { name: 'Residents' })).toBeVisible();

    // The register is the point of the screen: rows, not an empty state.
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(5);

    // An administrator never holds a bay, so the resident half must not be offered.
    await expect(page.getByRole('link', { name: 'My parking' })).toHaveCount(0);
  });

  test('a resident lands on their own parking and is told where they stand', async ({ page }) => {
    await signIn(page, 'resident@local');

    await expect(page).toHaveURL('http://localhost:4200/');
    // Whatever the wording, a resident must be told their situation and their period.
    await expect(page.getByRole('main')).toContainText(/bay|waitlist|draw|period/i);

    // And must not be offered the administrator's screens.
    await expect(page.getByRole('link', { name: 'Residents' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Run the draw' })).toHaveCount(0);
  });

  test('a wrong account is refused rather than let through', async ({ page }) => {
    await signIn(page, 'nobody@local');

    // Still on the form, with something said about it. The one thing that must not
    // happen is a silent redirect into the product.
    await expect(page).toHaveURL(/\/login/);
  });
});
