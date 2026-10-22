'use strict';
/**
 * 07 · Phone (iPhone 14, WebKit) — the menu, the filter sheet, product →
 * basket → checkout, dashboards' tab bars, no sideways scrolling anywhere,
 * and thumb-sized primary buttons.
 */
const { test, expect, j, openDashboard, horizontalOverflow, randomMobile } = require('./helpers-services');
const { ACCOUNTS, uid } = require('./fixtures');

const NOOR = { email: 'noor@noorletters.ae', password: 'demo1234' };
const MIN_TAP = 44;

async function productId(page, name) {
  const all = (await j(page.request, 'GET', '/api/products')).data.products;
  const p = all.find((x) => x.name === name);
  expect(p, `${name} is live`).toBeTruthy();
  return p.id;
}
async function height(locator) {
  const box = await locator.boundingBox();
  expect(box, 'element is rendered').toBeTruthy();
  return Math.round(box.height * 10) / 10;
}

test('the hamburger menu opens, closes and navigates — storefront and Services Marketplace', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header.top nav.links')).toBeHidden();          // desktop links collapse on a phone
  const menuBtn = page.getByRole('button', { name: 'Open menu' });
  await menuBtn.click();
  const nav = page.locator('#mnav');
  await expect(nav).toHaveClass(/\bopen\b/);
  await expect(nav.locator('.mn-link')).toHaveText([/Shop all/, /Trove Collection/, /Marketplace/, /Services Marketplace/, /Sell on Trove/]);
  await nav.getByRole('button', { name: 'Close menu' }).click();
  await expect(nav).not.toHaveClass(/\bopen\b/);

  await menuBtn.click();
  await nav.locator('.mn-link', { hasText: 'Shop all' }).click();
  await expect(nav).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#view-shop')).toBeVisible();
  await expect(page.locator('#browseTitle')).toHaveText('Shop all');

  await menuBtn.click();
  await nav.locator('.mn-link', { hasText: 'Services Marketplace' }).click();
  await expect(page).toHaveURL(/\/services$/);
  await expect(page.locator('#audSwitch .audbtn')).toHaveCount(2);

  // The same menu on the Services Marketplace hands back to the storefront.
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('#mnav')).toHaveClass(/\bopen\b/);
  await page.locator('#mnav .mn-link', { hasText: 'Sell on Trove' }).click();
  await expect(page.locator('#view-sell')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // The search button opens the menu with its search box.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#mnav')).toHaveClass(/\bopen\b/);
  await page.locator('#mSearchInput').fill('candle');
  await page.locator('#mSearchInput').press('Enter');
  await expect(page.locator('#view-shop')).toBeVisible();
  await expect(page.locator('#shopGrid')).toContainText('Cedar & Smoke Candle');
});

test('the filter bottom sheet narrows the shop view', async ({ page }) => {
  await page.goto('/?view=shop');
  await expect(page.locator('#view-shop')).toBeVisible();
  const before = Number(await page.locator('#resCount').innerText());
  expect(before).toBeGreaterThan(5);
  const sheet = page.locator('#filtersPanel');
  await expect(sheet).not.toHaveClass(/\bopen\b/);
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(sheet).toHaveClass(/\bopen\b/);
  await expect(sheet.locator('h3')).toHaveText('Filter');
  await sheet.locator('label', { hasText: 'Under AED 80' }).click();
  const apply = page.locator('#sheetApply');
  await expect(apply).toBeVisible();
  expect(await height(apply)).toBeGreaterThanOrEqual(MIN_TAP);
  await apply.click();
  await expect(sheet).not.toHaveClass(/\bopen\b/);

  const after = Number(await page.locator('#resCount').innerText());
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThan(before);
  await expect(page.locator('#shopGrid .card')).toHaveCount(after);
  for (const t of await page.locator('#shopGrid .card .price').allInnerTexts()) {
    const nums = [...t.matchAll(/AED\s*([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
    expect(nums.at(-1), t).toBeLessThan(80);
  }
  // Closing with the X leaves the filter applied.
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await sheet.getByRole('button', { name: 'Close filters' }).click();
  await expect(sheet).not.toHaveClass(/\bopen\b/);
  expect(Number(await page.locator('#resCount').innerText())).toBe(after);
});

test('product page → basket → checkout works with a thumb, as a guest', async ({ page }) => {
  const id = await productId(page, 'Cedar & Smoke Candle');
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#view-pdp')).toBeVisible();
  await expect(page.locator('#pdpName')).toHaveText('Cedar & Smoke Candle');
  const add = page.locator('#pdpAdd');
  expect(await height(add)).toBeGreaterThanOrEqual(MIN_TAP);
  await add.click();
  await expect(page.locator('#toastMsg')).toContainText('added to your Trove');
  await expect(page.locator('#cartCount')).toHaveText('1');

  await page.locator('header.top .icon-btn[title=Cart]').click();
  await expect(page.locator('#drawer')).toHaveClass(/\bopen\b/);
  await expect(page.locator('#cartBody')).toContainText('Cedar & Smoke Candle');
  await expect(page.locator('#cartShip')).toContainText('AED 30');   // AED 88 ≤ 200 pays delivery
  const checkout = page.locator('#drawer .checkout');
  expect(await height(checkout)).toBeGreaterThanOrEqual(MIN_TAP);
  await checkout.click();

  await expect(page.locator('#view-checkout')).toBeVisible();
  await expect(page.locator('#coAcctBox')).toBeVisible();
  await page.locator('#coEmail').fill(`phone-${uid()}@e2e.test`);
  await page.locator('#coPhone').fill(randomMobile());
  await page.locator('#coNewName').fill('Reem Phone');
  await page.locator('#coNewLine').fill('Villa 3, Street 8');
  await page.locator('#coNewCity').fill('Al Raha');
  await page.locator('#coNewEmirate').selectOption('Abu Dhabi');
  await page.locator('#coAcctGuestLink a').click();
  await expect(page.locator('#coAcctPassWrap')).toBeHidden();
  await expect(page.locator('#coTotals')).toContainText('AED 118');
  const place = page.locator('.co-place');
  expect(await height(place)).toBeGreaterThanOrEqual(MIN_TAP);
  await place.click();
  await expect(page.locator('#view-confirm')).toBeVisible();
  await expect(page.locator('#confOrdId')).toHaveText(/^Order TRV-/);
  await expect(page.locator('#confHead')).toHaveText('Thank you, Reem.');
  await expect(page.locator('#cartCount')).toBeHidden();
});

test.describe('no sideways scrolling on a phone', () => {
  const PUBLIC = ['/', '/?view=shop', 'PDP', '/services', '/services/noor-letters', '/apply', '/apply?for=both', '/login'];
  for (const path of PUBLIC) {
    test(`public page ${path}`, async ({ page }) => {
      const url = path === 'PDP' ? `/?p=${await productId(page, 'Hand-Knotted Wool Throw')}` : path;
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const o = await horizontalOverflow(page);
      expect(o.over, `${path}: scrollWidth ${o.scrollWidth} > ${o.innerWidth} (${o.culprit})`).toBeLessThanOrEqual(0);
    });
  }

  const SIGNED_IN = [['/account', ACCOUNTS.buyer], ['/sell', ACCOUNTS.seller], ['/provider', NOOR], ['/admin', ACCOUNTS.admin]];
  for (const [path, account] of SIGNED_IN) {
    test(`signed-in page ${path}`, async ({ actor }) => {
      const page = await actor(account);
      await openDashboard(page, path);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      const o = await horizontalOverflow(page);
      expect(o.over, `${path}: scrollWidth ${o.scrollWidth} > ${o.innerWidth} (${o.culprit})`).toBeLessThanOrEqual(0);
    });
  }

  test('the booking sheet on a provider page', async ({ page }) => {
    await page.goto('/services/noor-letters');
    await page.locator('#pvGrid .svcard').first().click();
    await expect(page.locator('#svScrim')).toHaveClass(/\bopen\b/);
    const o = await horizontalOverflow(page);
    expect(o.over, `booking sheet (${o.culprit})`).toBeLessThanOrEqual(0);
    const send = page.locator('#bkSubmit');
    await send.scrollIntoViewIfNeeded();
    expect(await height(send)).toBeGreaterThanOrEqual(MIN_TAP);
  });
});

test.describe('dashboard tab bars on a phone', () => {
  test('seller dashboard: the scrolling tab bar switches views, including off-screen tabs', async ({ actor }) => {
    const page = await actor(ACCOUNTS.seller);
    await openDashboard(page, '/sell');
    const bar = page.locator('#mtabs');
    await expect(bar).toBeVisible();
    await expect(page.locator('.side')).toBeHidden();
    const tabs = bar.locator('.mitem');
    expect(await tabs.count()).toBeGreaterThanOrEqual(8);
    await tabs.filter({ hasText: 'Products' }).click();
    await expect(page.locator('#view-products')).toBeVisible();
    await expect(tabs.filter({ hasText: 'Products' })).toHaveClass(/\bon\b/);
    await tabs.filter({ hasText: 'Storefront' }).click();                   // starts off-screen to the right
    await expect(page.locator('#view-storefront')).toBeVisible();
    await tabs.filter({ hasText: 'Services' }).click();
    await expect(page.locator('#view-services')).toBeVisible();
    await expect(page.locator('#ppBookings')).toContainText('SRV-DEMO01');
    const o = await horizontalOverflow(page);
    expect(o.over, `services tab (${o.culprit})`).toBeLessThanOrEqual(0);
  });

  test('provider dashboard: overview, services and bookings tabs', async ({ actor }) => {
    const page = await actor(NOOR);
    await openDashboard(page, '/provider');
    const tabs = page.locator('#mtabs .mitem');
    await expect(tabs).toHaveText([/Overview/, /My services/, /Bookings/]);
    await tabs.filter({ hasText: 'Bookings' }).click();
    await expect(page.locator('#view-bookings')).toBeVisible();
    await expect(page.locator('#pageTitle')).toHaveText('Bookings');
    await tabs.filter({ hasText: 'My services' }).click();
    await expect(page.locator('#view-services')).toBeVisible();
    await expect(page.locator('#ppSvList .pp-row')).toHaveCount(4);
  });

  test('admin: the tab bar reaches every section', async ({ actor }) => {
    const page = await actor(ACCOUNTS.admin);
    await openDashboard(page, '/admin');
    const tabs = page.locator('#mtabs .mitem');
    await expect(tabs.first()).toBeVisible();
    await tabs.filter({ hasText: 'Providers' }).click();
    await expect(page.locator('#view-providers')).toBeVisible();
    await tabs.filter({ hasText: 'Trove payouts' }).click();
    await expect(page.locator('#view-payouts')).toBeVisible();
    await expect(page.locator('#payoutsWrap')).toContainText('Next settlement run');
  });

  test('account: the Menu button opens the side menu and navigates', async ({ actor }) => {
    const page = await actor(ACCOUNTS.buyer);
    await openDashboard(page, '/account');
    const menu = page.locator('#sideMenu');
    await page.locator('.mh-btn').click();
    await expect(menu).toHaveClass(/\bopen\b/);
    await menu.locator('.mitem', { hasText: 'Addresses' }).click();
    await expect(menu).not.toHaveClass(/\bopen\b/);
    await expect(page.locator('#view-addresses')).toBeVisible();
    await expect(page.locator('#mhSec')).toHaveText('Addresses');
  });
});

/* Primary buttons a thumb has to hit (the storefront's PDP, basket, checkout,
 * filter and booking buttons are measured inside their own journeys above). */
const PRIMARY = [
  { name: 'login · Sign in', path: '/login', sel: '#submitBtn',
    bug: 'BUG: /login "Sign in" is ~42px tall on phones — trove-login.html @media .submit{padding:13px} shrinks it under 44px' },
  { name: 'apply · Continue', path: '/apply', sel: '#step1 .next' },
  { name: 'services · Become a provider', path: '/services', sel: '.ctaband .btn',
    bug: 'BUG: /services "Become a provider →" CTA is ~39px tall — trove-services.html .ctaband .btn{padding:12px 22px}' },
  { name: 'sell page · Start your application', path: '/?view=sell', sel: '#view-sell [data-cms="sell.hero.ctaApply"]' },
  { name: 'account · Menu', path: '/account', sel: '.mh-btn', account: ACCOUNTS.buyer,
    bug: 'BUG: /account "Menu" (the only way round the account area on a phone) is ~39px tall — trove-account.html .mh-btn{padding:10px 16px}' },
];
for (const b of PRIMARY) {
  test(`primary button is at least 44px tall: ${b.name}`, async ({ page }) => {
    if (b.bug) test.fail(true, b.bug);
    if (b.account) await page.request.post('/api/auth/login', { data: b.account });
    await page.goto(b.path);
    const el = page.locator(b.sel).first();
    await expect(el).toBeVisible();
    expect(await height(el), b.name).toBeGreaterThanOrEqual(MIN_TAP);
  });
}

test('secondary tap targets (header icons, dashboard tab pills): sizes recorded for the report', async ({ page, actor }, testInfo) => {
  await page.goto('/');
  const sizes = {};
  for (const el of await page.locator('header.top .icon-btn:visible').all()) {
    sizes['header · ' + ((await el.getAttribute('title')) || (await el.getAttribute('aria-label')))] = await height(el);
  }
  for (const [path, account] of [['/sell', ACCOUNTS.seller], ['/provider', NOOR], ['/admin', ACCOUNTS.admin]]) {
    const p = await actor(account);
    await openDashboard(p, path);
    sizes[`${path} · tab pill`] = await height(p.locator('#mtabs .mitem').first());
  }
  testInfo.annotations.push({ type: 'secondary tap sizes (px)', description: JSON.stringify(sizes) });
  expect(Object.keys(sizes).length).toBeGreaterThanOrEqual(7);
});
