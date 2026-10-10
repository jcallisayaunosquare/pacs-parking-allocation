import { expect, test, type Page } from '@playwright/test';

/**
 * The allocation surfaces an administrator actually operates.
 *
 * Not the arithmetic - `allocate.spec.ts` proves that 10 000 times without a browser -
 * but the things only a browser can answer: that each screen reaches its endpoint, that
 * the numbers arrive, and that the controls which change the building are present and
 * labelled for the person who has to press them.
 */

const signInAsAdmin = async (page: Page): Promise<void> => {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill('admin@local');
  await page.locator('input[type="password"]').fill('whatever');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/admin\/residents/);
};

test.describe('the administrator surfaces', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test('the bay inventory lists the building', async ({ page }) => {
    await page.getByRole('link', { name: 'Bays' }).click();
    await expect(page.getByRole('heading', { name: 'Bays' })).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
  });

  test('periods show a state, which is what the draw depends on', async ({ page }) => {
    await page.getByRole('link', { name: 'Periods' }).click();
    // `exact`, because the accessible name is matched as a substring by default and this
    // screen has two headings that contain the word: the h1 "Periods" and the h2 "All
    // periods" over the table.
    await expect(page.getByRole('heading', { name: 'Periods', exact: true })).toBeVisible();
    /*
     * The state machine is the whole screen: a period that shows no state is a period
     * nobody can act on. The stub seeds four periods around today, deliberately
     * relative to the clock rather than a fixed calendar - an earlier fixed one drifted
     * and the dashboard ended up announcing that registration was open and closed at
     * the same time.
     */
    await expect(page.getByRole('main')).toContainText(/in effect|ready to draw|registration/i);
  });

  test('the draw screen explains the rule before offering the button', async ({ page }) => {
    await page.getByRole('link', { name: 'Run the draw' }).click();
    await expect(page.getByRole('heading', { name: 'Run the draw' })).toBeVisible();
    // The ordering is the product's central promise, so it is stated where the
    // irreversible action is taken, not only in a document.
    await expect(page.getByRole('main')).toContainText(/waiting time|longest/i);
  });

  test('fairness reports the distribution it claims to protect', async ({ page }) => {
    await page.getByRole('link', { name: 'Fairness & rules' }).click();
    await expect(page.getByRole('heading', { name: 'Fairness' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText(/residents/i);
  });

  test('the lot draws the plan and reaches occupancy', async ({ page }) => {
    await page.getByRole('link', { name: 'The lot' }).click();
    await expect(page.getByRole('heading', { name: 'The lot' })).toBeVisible();
    // The counts come from the occupancy call, so a plan that renders without them is a
    // plan drawn from geometry alone.
    await expect(page.getByRole('main')).toContainText(/\d+ bays/);

    /*
     * The full bay code lives in the table view; the plan paints a short label inside
     * each cell because the level is already written across the top. Switching views is
     * worth doing here anyway - it is the only place the two halves of this screen can
     * be shown to agree.
     *
     * Bay codes must match the register's. They disagreed once, and a plan whose labels
     * do not match the list is worse than no plan.
     */
    await page.getByRole('button', { name: 'Table' }).click();
    await expect(page.getByRole('main')).toContainText(/B1-[A-D]\d{2}/);
  });

  test('reports offer the record of a period', async ({ page }) => {
    await page.getByRole('link', { name: 'Reports' }).click();
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await expect(page.getByRole('button', { name: /csv/i })).toBeVisible();
  });
});
