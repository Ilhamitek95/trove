'use strict';
/**
 * 06 · Accounts & security — registration and sign-in (email and UAE mobile),
 * the account area (empty states, address book), role gating in the browser
 * and on the API, cross-account isolation, and site integrity (one header,
 * no broken internal links, robots/sitemap, 404s, legacy redirects).
 */
const { test, expect, j, makeBuyer, openDashboard, randomMobile, EMAIL_RE } = require('./helpers-services');
const { ACCOUNTS, uid } = require('./fixtures');

const NOOR = { email: 'noor@noorletters.ae', password: 'demo1234' };

async function openRegister(page) {
  await page.goto('/login');
  await page.locator('#swapLink').click();
  await expect(page.locator('#aTitle')).toHaveText('Create your account');
  await expect(page.locator('#nameField')).toBeVisible();
  await expect(page.locator('#submitBtn')).toHaveText('Create account');
}
async function signInForm(page, email, password) {
  await page.locator('#email').fill(email);
  await page.locator('#pass').fill(password);
  await page.locator('#submitBtn').click();
}

/* ------------------------------------------------------------------ *
 * Registration & sign-in
 * ------------------------------------------------------------------ */
test.describe('registration', () => {
  test('register a buyer: required fields, then straight into the account (email stored lowercase)', async ({ page }) => {
    const id = uid();
    await openRegister(page);
    await page.locator('#submitBtn').click();
    await expect(page.locator('#authErr')).toHaveText('Enter your email and password.');
    await page.locator('#pass').fill('buyer-pass-123');
    await page.locator('#submitBtn').click();
    await expect(page.locator('#authErr')).toHaveText('Enter your email and password.');
    await page.locator('#email').fill(`  Mixed.Case.${id}@Example.COM `);
    await page.locator('#submitBtn').click();
    await expect(page.locator('#authErr')).toHaveText('Enter your name.');
    await page.locator('#name').fill(`Yasmin Farouk ${id}`);
    await page.locator('#submitBtn').click();

    await expect(page).toHaveURL(/\/account$/);
    await expect(page.locator('#uEmail')).toHaveText(`mixed.case.${id}@example.com`);
    await expect(page.locator('#view-overview .hello')).toHaveText('Hello, Yasmin.');
    const me = await j(page.request, 'GET', '/api/auth/me');
    expect(me.data.user).toMatchObject({ email: `mixed.case.${id}@example.com`, role: 'buyer' });
  });

  test('an email that already has an account is refused, whatever the casing', async ({ page, apiAs }) => {
    const existing = await makeBuyer(apiAs);
    await openRegister(page);
    await page.locator('#name').fill('Second Try');
    await page.locator('#email').fill(existing.email.toUpperCase());
    await page.locator('#pass').fill('another-pass-99');
    await page.locator('#submitBtn').click();
    await expect(page.locator('#authErr')).toHaveText('An account with this email already exists');
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('#email').fill(ACCOUNTS.buyer.email);
    await page.locator('#submitBtn').click();
    await expect(page.locator('#authErr')).toHaveText('An account with this email already exists');
    // The original password still works — the attempt changed nothing.
    const login = await j(page.request, 'POST', '/api/auth/login', { email: existing.email, password: existing.password });
    expect(login.status).toBe(200);
  });

  test('a malformed email address is refused at sign-up', async ({ page }) => {
    test.fail(true, 'BUG: POST /api/auth/register never validates the email format (auth.routes.js) and /login only checks it is non-empty — "not-an-email" becomes an account');
    await openRegister(page);
    await page.locator('#name').fill('No Email');
    await page.locator('#email').fill(`not-an-email-${uid()}`);
    await page.locator('#pass').fill('buyer-pass-123');
    await page.locator('#submitBtn').click();
    await expect(page.locator('#authErr')).toBeVisible({ timeout: 4000 });
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a password shorter than 8 characters is refused at sign-up', async ({ page }) => {
    test.fail(true, 'BUG: POST /api/auth/register accepts any non-empty password (auth.routes.js) — a 3-character buyer password is accepted, while /apply, checkout and /api/services/apply all require 8+');
    await openRegister(page);
    await page.locator('#name').fill('Short Password');
    await page.locator('#email').fill(`shortpw-${uid()}@e2e.test`);
    await page.locator('#pass').fill('abc');
    await page.locator('#submitBtn').click();
    await expect(page.locator('#authErr')).toContainText('8 characters', { timeout: 4000 });
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('sign-in', () => {
  test('email sign-in: wrong password, show-password toggle, then sign out', async ({ page }) => {
    await page.goto('/login');
    await signInForm(page, ACCOUNTS.buyer.email, 'not-the-password');
    await expect(page.locator('#authErr')).toHaveText('Wrong email or password');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#submitBtn')).toBeEnabled();

    const eye = page.locator('.pweye');
    await expect(page.locator('#pass')).toHaveAttribute('type', 'password');
    await eye.click();
    await expect(page.locator('#pass')).toHaveAttribute('type', 'text');
    await expect(eye).toHaveAttribute('aria-label', 'Hide password');
    await expect(page.locator('#pass')).toHaveValue('not-the-password');
    await eye.click();
    await expect(page.locator('#pass')).toHaveAttribute('type', 'password');
    await expect(eye).toHaveAttribute('aria-label', 'Show password');

    await page.locator('#pass').fill(ACCOUNTS.buyer.password);
    await page.locator('#submitBtn').click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.locator('#view-overview .hello')).toHaveText('Hello, Layla.');
    await expect(page.locator('#uEmail')).toHaveText(ACCOUNTS.buyer.email);

    await page.locator('#signOutLink').click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await j(page.request, 'GET', '/api/auth/me')).status).toBe(401);
    await page.goto('/account');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('UAE-mobile sign-in accepts any spelling of the number; bad numbers and passwords are explained', async ({ page, apiAs }) => {
    const mobile = randomMobile();                    // "05X XXX XXXX"
    const buyer = await makeBuyer(apiAs, { mobile });
    await page.goto('/login');
    await page.locator('#phoneBtn').click();
    await expect(page.locator('#mobileField')).toBeVisible();
    await expect(page.locator('#emailField')).toBeHidden();
    await expect(page.locator('#phoneBtnLabel')).toHaveText('Use email instead');

    await page.locator('#mobile').fill('12345');
    await page.locator('#pass').fill(buyer.password);
    await page.locator('#submitBtn').click();
    await expect(page.locator('#authErr')).toHaveText('Enter a UAE mobile number, like 050 123 4567.');

    const intl = '+971 ' + mobile.replace(/\D/g, '').slice(1);  // +971 5X…
    await page.locator('#mobile').fill(intl);
    await page.locator('#pass').fill('wrong-password');
    await page.locator('#submitBtn').click();
    await expect(page.locator('#authErr')).toHaveText('Wrong mobile number or password');

    await page.locator('#pass').fill(buyer.password);
    await page.locator('#submitBtn').click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.locator('#uEmail')).toHaveText(buyer.email);

    // Back to email mode restores the email field.
    await page.goto('/login');
    await page.locator('#phoneBtn').click();
    await page.locator('#phoneBtn').click();
    await expect(page.locator('#emailField')).toBeVisible();
    await expect(page.locator('#mobileField')).toBeHidden();
  });
});

/* ------------------------------------------------------------------ *
 * The account area
 * ------------------------------------------------------------------ */
test.describe('account area', () => {
  test('a brand-new account shows honest empty states (orders, reviews, saved, cards, bookings)', async ({ page, apiAs }) => {
    const buyer = await makeBuyer(apiAs);
    await page.request.post('/api/auth/login', { data: { email: buyer.email, password: buyer.password } });
    await openDashboard(page, '/account');
    await expect(page.locator('#uEmail')).toHaveText(buyer.email);
    await expect(page.locator('#oActive')).toHaveText('0');
    await expect(page.locator('#oActiveSub')).toHaveText('nothing on the way');
    await expect(page.locator('#view-overview .track')).toBeHidden();       // no fake "latest order"
    await expect(page.locator('#oSaved')).toHaveText('0');
    await expect(page.locator('#ordPill')).toHaveText('0');

    await page.locator('.menu .mitem[data-v=orders]').click();
    await expect(page.locator('#pageTitle')).toHaveText('Your orders');
    const empty = page.locator('#ordersList .empty-state');
    await expect(empty).toContainText('No orders yet');
    await expect(empty.getByRole('link', { name: 'Start shopping' })).toHaveAttribute('href', '/');
    await expect(page.locator('#reviewNudge')).toBeEmpty();
    await expect(page.locator('#myReviews')).toBeEmpty();

    await page.locator('.menu .mitem[data-v=wishlist]').click();
    await expect(page.locator('#wishWrap .empty-state')).toContainText('Nothing saved yet');
    await page.locator('.menu .mitem[data-v=payments]').click();
    await expect(page.locator('#cardList .empty-state')).toContainText('No saved cards');
    await page.locator('.menu .mitem[data-v=details]').click();
    await expect(page.locator('#dFirst')).toHaveValue('Huda');
    await expect(page.locator('#dLast')).toHaveValue(buyer.name.split(' ').slice(1).join(' '));
    await expect(page.locator('#dEmail')).toHaveValue(buyer.email);

    for (const url of ['/api/account/orders', '/api/account/reviews', '/api/services/my-bookings']) {
      const r = await j(page.request, 'GET', url);
      expect(r.status).toBe(200);
      expect(Object.values(r.data)[0]).toEqual([]);
    }
    expect((await j(page.request, 'GET', '/api/account/reviewables')).data).toEqual({ products: [], shops: [] });
    // Service bookings are tracked on the Services Marketplace — nothing there yet either.
    await page.goto('/services');
    await expect(page.locator('#dir .dcard').first()).toBeVisible();
    await expect(page.locator('#myBookings')).toBeEmpty();
  });

  test('the Following tab lists only real Trove shops (Dubai & Abu Dhabi), none followed yet', async ({ page, apiAs }) => {
    test.fail(true, 'BUG: /account → Following renders a hard-coded prototype list (trove-account.html VENDORS: "Lisbon, Portugal", "Portland, USA", "Reykjavík, Iceland"…) instead of the real shops');
    const buyer = await makeBuyer(apiAs);
    await page.request.post('/api/auth/login', { data: { email: buyer.email, password: buyer.password } });
    await openDashboard(page, '/account');
    await page.locator('.menu .mitem[data-v=following]').click();
    const rows = page.locator('#followList .follow-row');
    await expect(rows.first()).toBeVisible();
    for (const loc of await rows.locator('.fl').allInnerTexts()) expect(loc).toMatch(/Dubai|Abu Dhabi/);
  });

  test('address book: add, validate, set default, edit, delete — Dubai and Abu Dhabi only', async ({ page, apiAs }) => {
    const buyer = await makeBuyer(apiAs);
    await page.request.post('/api/auth/login', { data: { email: buyer.email, password: buyer.password } });
    await openDashboard(page, '/account');
    await page.locator('.menu .mitem[data-v=addresses]').click();
    const cards = page.locator('#addrList .addr-card');
    await expect(cards).toHaveCount(0);
    await expect(page.locator('#addrList .add-tile')).toBeVisible();

    const drawer = page.locator('#drawer');
    await page.locator('#view-addresses').getByRole('button', { name: 'Add address' }).click();
    await expect(drawer).toHaveClass(/open/);
    await expect(page.locator('#drawerTitle')).toHaveText('Add address');
    await expect(page.locator('#aEmirate option')).toHaveText(['Dubai', 'Abu Dhabi']);
    await expect(page.locator('#aName')).toHaveValue(buyer.name);
    await page.locator('#aName').fill('');
    await page.locator('#drawerSave').click();
    await expect(page.locator('#toast')).toHaveText('Add a name');
    await page.locator('#aName').fill(buyer.name);
    await page.locator('#drawerSave').click();
    await expect(page.locator('#toast')).toHaveText('Add a street address');
    await page.locator('#aLabel').fill('Home');
    await page.locator('#aLine').fill('Apt 1204, Marina Gate 2');
    await page.locator('#aCity').fill('Dubai Marina');
    await page.locator('#aEmirate').selectOption('Dubai');
    await page.locator('#aPhone').fill('050 123 4567');
    await page.locator('#drawerSave').click();
    await expect(page.locator('#toast')).toHaveText('Address added');
    await expect(drawer).not.toHaveClass(/open/);
    const home = cards.filter({ has: page.locator('h4', { hasText: 'Home' }) });
    await expect(home).toContainText('Dubai Marina, Dubai');
    await expect(home.locator('.badge')).toHaveText('Default');          // the first address is the default

    await page.locator('#addrList .add-tile').click();
    await page.locator('#aLabel').fill('Studio');
    await page.locator('#aLine').fill('Villa 7, Street 12');
    await page.locator('#aCity').fill('Khalifa City');
    await page.locator('#aEmirate').selectOption('Abu Dhabi');
    await page.locator('#drawerSave').click();
    await expect(page.locator('#toast')).toHaveText('Address added');
    await expect(cards).toHaveCount(2);
    const studio = cards.filter({ has: page.locator('h4', { hasText: 'Studio' }) });
    await expect(studio).toContainText('Khalifa City, Abu Dhabi');
    await expect(studio.locator('.badge')).toHaveCount(0);

    await studio.locator('a', { hasText: 'Set default' }).click();
    await expect(page.locator('#toast')).toHaveText('Default address updated');
    await expect(studio.locator('.badge')).toHaveText('Default');
    await expect(home.locator('.badge')).toHaveCount(0);

    await home.locator('a', { hasText: 'Edit' }).click();
    await expect(page.locator('#drawerTitle')).toHaveText('Edit address');
    await expect(page.locator('#aCity')).toHaveValue('Dubai Marina');
    await expect(page.locator('#aEmirate')).toHaveValue('Dubai');
    await page.locator('#aLine').fill('Apt 3301, Marina Gate 1');
    await page.locator('#drawerSave').click();
    await expect(page.locator('#toast')).toHaveText('Address updated');
    await expect(home).toContainText('Apt 3301, Marina Gate 1');

    await home.locator('a', { hasText: 'Delete' }).click();           // confirm() accepted
    await expect(page.locator('#toast')).toHaveText('Address deleted');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Studio');

    // The server holds the line on the service area, whatever the client sends.
    const bad = await j(page.request, 'POST', '/api/account/addresses', { name: 'X', line: '1 Corniche', city: 'Sharjah' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('Dubai and Abu Dhabi only');
    const list = (await j(page.request, 'GET', '/api/account/addresses')).data.addresses;
    expect(list).toHaveLength(1);
    const patch = await j(page.request, 'PATCH', `/api/account/addresses/${list[0].id}`, { city: 'Al Ain' });
    expect(patch.status).toBe(400);
  });

  test('"Update password" really changes the password', async ({ page, apiAs }) => {
    test.fail(true, 'BUG: /account → My details → "Update password" only calls toast("Password updated") (trove-account.html:425) — nothing is sent, the old password keeps working');
    const buyer = await makeBuyer(apiAs);
    await page.request.post('/api/auth/login', { data: { email: buyer.email, password: buyer.password } });
    await openDashboard(page, '/account');
    await page.locator('.menu .mitem[data-v=details]').click();
    const card = page.locator('#view-details .form-card', { hasText: 'Password' });
    await card.locator('input[type=password]').fill('brand-new-pass-456');
    await card.getByRole('button', { name: 'Update password' }).click();
    await expect(page.locator('#toast')).toHaveText('Password updated');
    const fresh = await apiAs();
    const r = await j(fresh, 'POST', '/api/auth/login', { email: buyer.email, password: 'brand-new-pass-456' });
    expect(r.status, 'the new password must work after "Password updated"').toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * Role gating
 * ------------------------------------------------------------------ */
test.describe('role gating', () => {
  test('signed-out visits to private pages go to sign-in, and signing in lands on that dashboard', async ({ page }) => {
    const cases = [
      ['/account', ACCOUNTS.buyer, /\/account$/],
      ['/sell', ACCOUNTS.seller, /\/sell$/],
      ['/provider', NOOR, /\/provider$/],
      ['/admin', ACCOUNTS.admin, /\/admin$/],
    ];
    for (const [path, account, landing] of cases) {
      await page.context().clearCookies();
      await page.goto(path);
      await expect(page, `${path} bounces a signed-out visitor`).toHaveURL(/\/login$/);
      await signInForm(page, account.email, account.password);
      await expect(page, `${account.email} lands back on ${path}`).toHaveURL(landing);
    }
    // A buyer who opens a dashboard that isn't theirs is sent somewhere sensible, never shown it.
    await page.context().clearCookies();
    await page.request.post('/api/auth/login', { data: ACCOUNTS.buyer });
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/provider');
    await expect(page).toHaveURL(/\/apply\?for=services$/);
    await page.goto('/sell');
    await expect(page).toHaveURL(/\/apply$/);
  });

  test('API: each role is kept to its own lane (401 signed out, 403 for the wrong role)', async ({ apiAs }) => {
    const anon = await apiAs();
    const buyer = await apiAs(ACCOUNTS.buyer);
    const seller = await apiAs(ACCOUNTS.seller);
    const provider = await apiAs(NOOR);
    const shopId = (await j(seller, 'GET', '/api/seller/me')).data.shop.id;

    const anonOnly = [
      ['GET', '/api/auth/me'], ['GET', '/api/account/orders'], ['GET', '/api/account/addresses'],
      ['POST', '/api/account/addresses'], ['GET', '/api/services/my-bookings'],
    ];
    const sellerLane = [['GET', '/api/seller/me'], ['GET', '/api/seller/products'], ['POST', '/api/seller/products'],
      ['GET', '/api/seller/orders'], ['POST', '/api/seller/enable-services'], ['GET', '/api/seller/settlements']];
    const providerLane = [['GET', '/api/provider/me'], ['GET', '/api/provider/bookings'], ['POST', '/api/provider/services']];
    const adminLane = [['GET', '/api/admin/stats'], ['GET', '/api/admin/orders'], ['GET', '/api/admin/providers'],
      ['PATCH', `/api/admin/shops/${shopId}`], ['PATCH', '/api/admin/products/1'], ['PUT', '/api/admin/content/site.promo'],
      ['POST', `/api/admin/impersonate/${shopId}`], ['POST', '/api/admin/settlements/run'], ['GET', '/api/admin/vat-report'],
      ['GET', '/api/admin/reviews'], ['GET', '/api/admin/returns']];

    const expectStatus = async (ctx, who, list, status) => {
      for (const [m, url] of list) {
        const r = await j(ctx, m, url, m === 'GET' ? undefined : { status: 'approved', name: 'x', text: 'x' });
        expect(r.status, `${who} ${m} ${url}`).toBe(status);
      }
    };
    await expectStatus(anon, 'signed out', [...anonOnly, ...sellerLane, ...providerLane, ...adminLane], 401);
    await expectStatus(buyer, 'buyer', [...sellerLane, ...providerLane, ...adminLane], 403);
    await expectStatus(seller, 'seller', adminLane, 403);
    await expectStatus(provider, 'provider without a shop', [...sellerLane, ...adminLane], 403);
    // Nothing above changed the shop.
    expect((await j(seller, 'GET', '/api/seller/me')).data.shop.status).toBe('approved');
  });

  test('a seller cannot see, edit or delete another shop\'s products', async ({ apiAs }) => {
    const mara = await apiAs(ACCOUNTS.seller);
    const all = (await j(mara, 'GET', '/api/products')).data.products;
    const ember = all.find((p) => p.shop.slug === 'ember-goods');
    expect(ember, 'Ember Goods has a live piece').toBeTruthy();
    const mine = (await j(mara, 'GET', '/api/seller/products')).data.products;
    expect(mine.some((p) => p.id === ember.id)).toBe(false);
    expect((await j(mara, 'PATCH', `/api/seller/products/${ember.id}`, { price: 1, name: 'Hijacked', status: 'hidden' })).status).toBe(404);
    expect((await j(mara, 'DELETE', `/api/seller/products/${ember.id}`)).status).toBe(404);
    const after = (await j(mara, 'GET', `/api/products/${ember.id}`)).data.product;
    expect(after).toMatchObject({ name: ember.name, price: ember.price });
  });

  test('a buyer cannot read or change another buyer\'s orders, bookings or addresses', async ({ apiAs }) => {
    const layla = await apiAs(ACCOUNTS.buyer);
    const addr = await j(layla, 'POST', '/api/account/addresses', { label: 'Office', name: 'Layla Hassan', line: 'Office 12, Bay Square', city: 'Business Bay, Dubai' });
    expect(addr.status).toBe(201);
    const svc = (await j(layla, 'GET', '/api/services/providers/the-hang-studio')).data.services[0];
    const bk = await j(layla, 'POST', `/api/services/${svc.id}/book`, { name: 'Layla Hassan', email: ACCOUNTS.buyer.email, phone: '050 123 4567', area: 'Dubai', agreeTerms: true });
    expect(bk.status).toBe(201);
    const laylaOrders = (await j(layla, 'GET', '/api/account/orders')).data.orders.map((o) => o.id);
    expect(laylaOrders).toContain('TRV-SEED01');

    const other = await makeBuyer(apiAs);
    const eve = await apiAs(other);
    expect((await j(eve, 'GET', '/api/account/orders')).data.orders).toEqual([]);
    expect((await j(eve, 'GET', '/api/account/addresses')).data.addresses).toEqual([]);
    expect((await j(eve, 'GET', '/api/services/my-bookings')).data.bookings).toEqual([]);
    expect((await j(eve, 'PATCH', `/api/account/addresses/${addr.data.address.id}`, { line: 'Hijacked' })).status).toBe(404);
    expect((await j(eve, 'DELETE', `/api/account/addresses/${addr.data.address.id}`)).status).toBe(404);
    expect((await j(eve, 'POST', `/api/services/bookings/${bk.data.booking.id}/cancel`)).status).toBe(404);
    expect((await j(eve, 'POST', '/api/account/orders/TRV-SEED01/return-request', { items: [], reason: 'other' })).status).toBe(404);
    expect((await j(eve, 'POST', '/api/checkout/claim', { orderId: 'TRV-SEED01' })).status).toBe(404);

    const still = (await j(layla, 'GET', '/api/account/addresses')).data.addresses.find((a) => a.id === addr.data.address.id);
    expect(still.line).toBe('Office 12, Bay Square');
    expect((await j(layla, 'GET', '/api/services/my-bookings')).data.bookings.find((b) => b.id === bk.data.booking.id).status).toBe('requested');
    await j(layla, 'DELETE', `/api/account/addresses/${addr.data.address.id}`);
  });

  test('a provider never sees the customer\'s email, and cannot act on another provider\'s bookings or listings', async ({ apiAs }) => {
    const layla = await apiAs(ACCOUNTS.buyer);
    const svc = (await j(layla, 'GET', '/api/services/providers/noor-letters')).data.services[0];
    const bk = await j(layla, 'POST', `/api/services/${svc.id}/book`, { name: 'Layla Hassan', email: ACCOUNTS.buyer.email, phone: '050 123 4567', area: 'Abu Dhabi', notes: 'Forty envelopes', agreeTerms: true });
    expect(bk.status).toBe(201);

    const noor = await apiAs(NOOR);
    const inbox = await j(noor, 'GET', '/api/provider/bookings');
    expect(inbox.status).toBe(200);
    const row = inbox.data.bookings.find((b) => b.code === bk.data.booking.code);
    expect(row).toMatchObject({ customerName: 'Layla Hassan', area: 'Abu Dhabi', phone: null });
    expect(inbox.text).not.toContain(ACCOUNTS.buyer.email);
    expect(inbox.text).not.toMatch(EMAIL_RE);
    expect(Object.keys(row)).not.toContain('email');

    const mara = await apiAs(ACCOUNTS.seller);
    const maraBooking = (await j(mara, 'GET', '/api/provider/bookings')).data.bookings.find((b) => b.code === 'SRV-DEMO01');
    const maraService = (await j(mara, 'GET', '/api/provider/services')).data.services[0];
    expect((await j(noor, 'PATCH', `/api/provider/bookings/${maraBooking.id}`, { action: 'confirm' })).status).toBe(404);
    expect((await j(noor, 'PATCH', `/api/provider/services/${maraService.id}`, { priceCents: 100 })).status).toBe(404);
    expect((await j(noor, 'DELETE', `/api/provider/services/${maraService.id}`)).status).toBe(404);
    const again = (await j(mara, 'GET', '/api/provider/bookings')).data.bookings.find((b) => b.code === 'SRV-DEMO01');
    expect(again.status).toBe('requested');
    expect(again.phone).toBeNull();
  });

  test('a maker\'s product name is shown as text on the storefront, never run as code', async ({ page, apiAs }) => {
    test.fail(true, 'BUG (stored XSS): trove.html productCard() interpolates p.name (and the shop name V.name) into innerHTML unescaped — a seller-chosen name runs script in every shopper\'s browser');
    const tag = uid();
    const name = `<img src="/e2e-xss-${tag}" onerror="window.__troveXss='${tag}'">Probe ${tag}`;
    const mara = await apiAs(ACCOUNTS.seller);
    const made = await j(mara, 'POST', '/api/seller/products', { name, price: 45, stock: 3, status: 'live', category: 'Ceramics', description: 'Probe' });
    expect(made.status, made.text).toBe(201);
    try {
      await page.goto('/?view=shop');
      await expect(page.locator('#shopGrid')).toContainText(`Probe ${tag}`);
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => window.__troveXss || null), 'the onerror handler must never run').toBeNull();
      await expect(page.locator('#shopGrid h3', { hasText: `Probe ${tag}` })).toContainText('<img');
    } finally {
      await j(mara, 'DELETE', `/api/seller/products/${made.data.product.id}`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Site integrity
 * ------------------------------------------------------------------ */
test.describe('site integrity', () => {
  test('one header everywhere: / and /services carry the same promo bar, links, icons and menu', async ({ page }) => {
    const read = async () => ({
      promo: (await page.locator('.promo .wrap').innerText()).trim(),
      links: (await page.locator('header.top nav.links a').allInnerTexts()).map((s) => s.trim()),
      icons: await page.locator('header.top .right .icon-btn').evaluateAll((els) => els.map((e) => e.getAttribute('title'))),
      account: (await page.locator('#acctMenu a').allTextContents()).map((s) => s.trim()),
      menu: (await page.locator('#mnav .mn-link').allTextContents()).map((s) => s.replace('→', '').trim()),
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const home = await read();
    await page.goto('/services');
    await page.waitForLoadState('networkidle');
    const services = await read();
    expect(home.links).toEqual(['Shop all', 'Trove Collection', 'Marketplace', 'Services Marketplace', 'Sell on Trove']);
    expect(services).toEqual(home);
    await expect(page.locator('header.top nav.links a.on')).toHaveText('Services Marketplace');
  });

  test('every internal link on /, /services, /apply and /?view=sell (footer included) resolves', async ({ page, baseURL }, testInfo) => {
    const found = new Map();   // url → first page it was seen on
    const dead = new Set();
    for (const path of ['/', '/services', '/apply', '/?view=sell']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const links = await page.locator('a[href]').evaluateAll((els) => els.map((a) => ({
        href: a.getAttribute('href'), abs: a.href, text: (a.textContent || '').trim().slice(0, 40), onclick: !!a.getAttribute('onclick'),
      })));
      for (const l of links) {
        if (l.href === '#' || l.href === '') { if (!l.onclick) dead.add(`${path} → "${l.text}"`); continue; }
        if (!l.abs.startsWith(baseURL)) continue;
        const url = l.abs.split('#')[0];
        if (!found.has(url)) found.set(url, path);
      }
    }
    expect(found.size).toBeGreaterThan(10);
    const broken = [];
    for (const [url, from] of found) {
      const r = await page.request.get(url);
      if (r.status() >= 400) broken.push(`${url} (on ${from}) → ${r.status()}`);
    }
    if (dead.size) testInfo.annotations.push({ type: 'dead "#" links', description: [...dead].join(' | ') });
    expect(broken).toEqual([]);
  });

  test('robots.txt keeps private surfaces out; sitemap.xml lists only live, public pages', async ({ page, baseURL }) => {
    const robots = await page.request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(robots.headers()['content-type']).toContain('text/plain');
    const rt = await robots.text();
    for (const p of ['/api/', '/admin', '/account', '/sell', '/provider', '/login']) expect(rt).toContain(`Disallow: ${p}`);
    expect(rt).toContain(`Sitemap: ${baseURL}/sitemap.xml`);

    const sm = await page.request.get('/sitemap.xml');
    expect(sm.status()).toBe(200);
    expect(sm.headers()['content-type']).toContain('xml');
    const xml = await sm.text();
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    expect(locs).toContain(`${baseURL}/services/noor-letters`);
    expect(locs).toContain(`${baseURL}/?shop=kiln-and-clay`);
    expect(locs.some((l) => l.includes('oud-by-khalid'))).toBe(false);          // pending provider
    expect(locs.some((l) => l.includes('sable-and-stone'))).toBe(false);        // pending shop
    expect(locs.filter((l) => /^\/(admin|account|sell|login|provider)(?:$|[/?#])/.test(l.replace(baseURL, '')))).toEqual([]);
    for (const loc of locs) {
      expect(loc.startsWith(baseURL), loc).toBe(true);
      const r = await page.request.get(loc.replace(baseURL, ''));
      expect(r.status(), loc).toBe(200);
    }
  });

  test('unknown pages get the branded 404; unknown API paths answer JSON', async ({ page }) => {
    const res = await page.goto('/no-such-page-' + uid());
    expect(res.status()).toBe(404);
    await expect(page).toHaveTitle('Page not found — Trove');
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex');
    await expect(page.locator('body')).toContainText(/Trove/);
    const home = page.locator('a[href="/"]').first();
    await expect(home).toBeVisible();
    await home.click();
    await expect(page).toHaveURL(/\/$/);

    for (const url of ['/services/Not_A_Slug', '/services/config.js', '/admin/secret']) {
      const r = await page.request.get(url, { headers: { accept: 'text/html' } });
      expect(r.status(), url).toBe(404);
      expect(await r.text()).toContain('Page not found');
    }
    const api = await page.request.get('/api/no-such-endpoint');
    expect(api.status()).toBe(404);
    expect(api.headers()['content-type']).toContain('application/json');
    expect(await api.json()).toEqual({ error: 'Not found' });
    const apiPost = await page.request.post('/api/services/999999/book', { data: {} });
    expect(apiPost.status()).toBe(404);
    expect((await apiPost.json()).error).toBeTruthy();
  });

  test('legacy addresses redirect permanently to their clean homes', async ({ page }) => {
    const cases = [
      ['/trove.html', '/'], ['/index.html', '/'], ['/trove', '/'],
      ['/become-a-provider', '/apply?for=services'], ['/trove-provider-apply.html', '/apply?for=services'],
      ['/trove-login.html', '/login'], ['/trove-account.html?x=1', '/account?x=1'], ['/trove-services', '/services'],
    ];
    for (const [from, to] of cases) {
      const r = await page.request.get(from, { maxRedirects: 0 });
      expect(r.status(), from).toBe(301);
      expect(r.headers().location, from).toBe(to);
    }
    // And a person following the old provider link lands on the Services door of the one form.
    await page.goto('/become-a-provider');
    await expect(page).toHaveURL(/\/apply\?for=services$/);
    await expect(page.locator('.role[data-role=provider]')).toHaveClass(/\bon\b/);
  });
});
