import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests, run against the in-memory stub rather than against AWS.
 *
 * That is the whole design decision in this file, and it is deliberate. Running the
 * suite against the deployed stack would be slower, would cost a Rekognition call and a
 * stored frame per run, would fail whenever somebody else was using the dev
 * environment - and, as this project found out the hard way, it leaves rows behind: the
 * post-deploy smoke suites invented periods with names like 2235-Q1 that ended up
 * driving the administrator's "ready to draw" banner on a real screen.
 *
 * So these tests get a building that exists only for the length of the run. The stub
 * implements the same contract (`packages/contracts/openapi.yaml`) and seeds 72
 * residents, 56 bays and four periods around today; when the two disagree, the contract
 * is right and the stub is the bug.
 *
 * What this suite therefore does NOT prove: that the deployed system works. That is the
 * job of `smoke.mjs` and `smoke-plates.mjs`, which run after a deployment, against real
 * AWS, and are the only thing that can speak for Cognito, Rekognition or Postgres.
 */
export default defineConfig({
  testDir: './e2e',
  // One worker in CI: the two servers below hold a single in-memory building, so parallel
  // workers would be two tests mutating one register and blaming each other.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:4200',
    // Kept only for the runs that fail, which is when anybody looks at them.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /*
   * Both halves of the offline loop, started by Playwright and torn down with it.
   * `reuseExistingServer` locally, so a developer who already has them running does not
   * get a port clash; never in CI, where a stale server would mean testing yesterday's
   * build.
   */
  webServer: [
    {
      command: 'node ../api/scripts/local-api.mjs',
      url: 'http://localhost:4300/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
    },
    {
      command: 'npx ng serve --configuration offline --port 4200',
      url: 'http://localhost:4200',
      reuseExistingServer: !process.env.CI,
      // Angular's first build is not fast, and a CI runner is slower than a laptop.
      timeout: 180_000,
      stdout: 'pipe',
    },
  ],
});
