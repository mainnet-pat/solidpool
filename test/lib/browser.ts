// The Playwright the browser tests drive: this project's own, or PLAYWRIGHT_PATH (a playwright index.mjs) to use
// another. Its Chromium comes from `npx playwright install chromium`, once on each machine.
export async function playwright(): Promise<any> {
  if (process.env.PLAYWRIGHT_PATH) return import(process.env.PLAYWRIGHT_PATH);
  return import('playwright');
}
