'use strict';
// Harness smoke: the throwaway server is up, seeded, and every page loads without a script error.
const { test, expect, ACCOUNTS, apiLogin } = require('./fixtures');

test('server is up on a seeded throwaway database in demo-payments mode', async ({ page }) => {
  const health = await (await page.request.get('/api/health')).json();
  expect(health.ok).toBe(true);
  expect(health.stripe).toBe(false);
  expect(health.delivery).toBe('mock');
  const products = await (await page.request.get('/api/products')).json();
  expect((products.products || products).length).toBeGreaterThan(5);
});

for (const path of ['/', '/services', '/apply', '/login', '/?view=sell', '/does-not-exist']) {
  test(`public page ${path} renders`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res.status()).toBeLessThan(path === '/does-not-exist' ? 500 : 400);
    await expect(page.locator('body')).toBeVisible();
  });
}

test('signed-in pages render for their owners', async ({ page }) => {
  await apiLogin(page, ACCOUNTS.admin);
  await page.goto('/admin');
  await expect(page.locator('body')).toContainText(/admin|shops|orders/i);
});
