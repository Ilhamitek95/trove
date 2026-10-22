'use strict';
/**
 * 04 · Services Marketplace — enrolment, admin approval, the provider
 * dashboard, public browsing, bookings end to end, and one account running a
 * shop and a services practice side by side.
 */
const { test, expect, j, makeProvider, makeSeller, makeBuyer, openDashboard, randomMobile, canonicalMobile, EMAIL_RE, UAE_PHONE_RE } = require('./helpers-services');
const { ACCOUNTS, uid } = require('./fixtures');

const toast = (page) => page.locator('#toast');

/* ------------------------------------------------------------------ *
 * Enrolment → approval → dashboard, as the people involved would do it
 * ------------------------------------------------------------------ */
test.describe.serial('provider enrolment, approval and listings', () => {
  const id = uid();
  const solo = { name: `Maha Qasim ${id}`, email: `maha-${id}@e2e.test`, password: 'maha-pass-123', practice: `Maha Murals ${id}` };
  const both = { name: `Omar Saeed ${id}`, email: `omar-${id}@e2e.test`, password: 'omar-pass-123', practice: `Omar Clayworks ${id}` };

  test('Services door: a new provider applies — validation, taxonomy, agreement', async ({ page }) => {
    await page.goto('/apply?for=services');
    await expect(page.locator('.role[data-role=provider]')).toHaveClass(/\bon\b/);
    await expect(page.locator('#bTitle')).toContainText('Tell us what you do');

    // Step 1 — who you are.
    const cont1 = page.locator('#step1 .next');
    await cont1.click();
    await expect(page.locator('#err')).toHaveText('Please tell us your name.');
    await page.locator('#fName').fill(solo.name);
    await page.locator('#fEmail').fill('maha-at-nowhere');
    await cont1.click();
    await expect(page.locator('#err')).toContainText('That email doesn');
    await page.locator('#fEmail').fill(solo.email);
    await page.locator('#fPass').fill('short');
    await cont1.click();
    await expect(page.locator('#err')).toHaveText('Your password needs at least 8 characters.');
    await page.locator('#fPass').fill(solo.password);
    await cont1.click();

    // Step 2 — the practice. Twelve categories across two audiences, one to three picks.
    await expect(page.locator('#step2')).toBeVisible();
    await expect(page.locator('#s2Title')).toHaveText('Now, your practice.');
    await expect(page.locator('#catPicker .catopt')).toHaveCount(12);
    await expect(page.locator('#catPicker .audlbl')).toHaveText([/^At home/, /^For makers/]);
    await expect(page.locator('#fLoc option')).toHaveText(['Dubai, UAE', 'Abu Dhabi, UAE']);
    await expect(page.locator('#fCat')).toBeHidden(); // pieces-only fields stay out of the Services door
    const cont2 = page.locator('#step2 .next');
    await cont2.click();
    await expect(page.locator('#err')).toContainText('Give your practice a name');
    await page.locator('#fShop').fill(solo.practice);
    await cont2.click();
    await expect(page.locator('#err')).toHaveText('Pick at least one service category.');
    for (const c of ['Made to order & personalisation', 'Workshops at home', 'Styling & celebrations']) {
      await page.locator('#catPicker .catopt', { hasText: c }).click();
    }
    await page.locator('#catPicker .catopt', { hasText: 'Coaching' }).click();
    await expect(page.locator('#err')).toContainText('Three categories is the limit');
    await expect(page.locator('#catPicker .catopt.on')).toHaveCount(3);
    await page.locator('#catPicker .catopt', { hasText: 'Styling & celebrations' }).click(); // unpick one
    await expect(page.locator('#catPicker .catopt.on')).toHaveCount(2);
    await page.locator('#fLoc').selectOption('Abu Dhabi, UAE');
    await page.locator('#fAbout').fill('Murals.');
    await cont2.click();
    await expect(page.locator('#err')).toContainText('Tell us a little more');
    await page.locator('#fAbout').fill('Hand-painted nursery murals and lettering, sketched with you and painted on site over a day or two.');
    await cont2.click();

    // Step 3 — what you'll offer, and the subscription + Provider Agreement.
    await expect(page.locator('#step3')).toBeVisible();
    await expect(page.locator('#subFee')).toContainText('AED 30');
    await expect(page.locator('#fProducts')).toBeHidden();
    const submit = page.locator('#submitBtn');
    await submit.click();
    await expect(page.locator('#err')).toContainText('List at least one service');
    await page.locator('#fServices').fill('Nursery name mural — from AED 900');
    await submit.click();
    await expect(page.locator('#err')).toContainText('Share your Instagram or a portfolio link');
    await page.locator('#fLinks').fill('mahamurals.ae');
    await submit.click();
    await expect(page.locator('#err')).toContainText('Add your WhatsApp number');
    await page.locator('#fPhone').fill('+971 50 765 1100');
    await submit.click();
    await expect(page.locator('#err')).toContainText('Tick the services box');
    await expect(page.locator('#stepDone')).toBeHidden();
    await page.locator('#fAgreeSvc').check();
    await submit.click();

    await expect(page.locator('#stepDone')).toBeVisible();
    await expect(page.locator('#doneText')).toContainText(solo.practice);
    await expect(page.locator('#doneBtn')).toHaveText('Set up your services →');

    // Server state: one account, a pending practice with the agreement recorded, nothing public yet.
    const me = await j(page.request, 'GET', '/api/auth/me');
    expect(me.data.user.email).toBe(solo.email);
    expect(me.data.shop).toBeNull();
    expect(me.data.provider.status).toBe('pending');
    solo.slug = me.data.provider.slug;
    solo.id = me.data.provider.id;
    const prov = await j(page.request, 'GET', '/api/provider/me');
    expect(prov.data.provider.categories).toEqual(['made-to-order', 'workshops']);
    expect(prov.data.provider.agreement.version).toBe('v1');
    expect(prov.data.provider.subscription.startedAt).toBeNull();
    expect((await j(page.request, 'GET', `/api/services/providers/${solo.slug}`)).status).toBe(404);

    // The done button opens the dashboard in review.
    await page.locator('#doneBtn').click();
    await expect(page).toHaveURL(/\/provider$/);
    await expect(page.locator('#whoStatus')).toHaveText('In review');
    await expect(page.locator('#ppOverview .pp-banner.pending')).toContainText('with our curation team');
    await expect(page.locator('#ppOverview')).toContainText('Nothing to pay yet');
  });

  test('Both door: one account applies for a shop and a services practice together', async ({ page }) => {
    await page.goto('/apply?for=both');
    await expect(page.locator('.role[data-role=both]')).toHaveClass(/\bon\b/);
    await page.locator('#fName').fill(both.name);
    await page.locator('#fEmail').fill(both.email);
    await page.locator('#fPass').fill(both.password);
    await page.locator('#step1 .next').click();

    await expect(page.locator('#s2Title')).toHaveText('Now, your shop and practice.');
    await expect(page.locator('#fNameHelp')).toBeVisible();
    await page.locator('#fShop').fill(both.practice);
    await page.locator('#fCat').selectOption('Ceramics');
    await page.locator('#catPicker .catopt', { hasText: 'Workshops at home' }).click();
    await page.locator('#fAbout').fill('Stoneware thrown in Al Quoz, and hand-building afternoons for groups at home.');
    await page.locator('#step2 .next').click();

    await expect(page.locator('#s3Title')).toHaveText('What will you sell and offer?');
    await page.locator('#fProducts').fill('Speckled mugs — AED 70');
    await page.locator('#fServices').fill('Hand-building afternoon — AED 1,100');
    await page.locator('#fInsta').fill('@omarclayworks');
    await page.locator('#fPhone').fill('+971 50 765 2200');
    await page.locator('#fAgreeSvc').check();
    await page.locator('#submitBtn').click();

    await expect(page.locator('#stepDone')).toBeVisible();
    await expect(page.locator('#doneText')).toContainText('your shop and your services practice');
    await expect(page.locator('#doneWarn')).toBeHidden(); // the services half went through too
    const me = await j(page.request, 'GET', '/api/auth/me');
    expect(me.data.shop.name).toBe(both.practice);
    expect(me.data.provider.name).toBe(both.practice);
    expect(me.data.provider.status).toBe('pending');
    both.shopSlug = me.data.shop.slug;
    both.slug = me.data.provider.slug;
    await page.locator('#doneBtn').click();
    await expect(page).toHaveURL(/\/sell$/);
  });

  test('admin: Members shows one row per account with both sides; approvals from Providers and Members', async ({ actor }) => {
    const admin = await actor(ACCOUNTS.admin);
    await admin.goto('/admin');
    await expect(admin.locator('#shell')).toBeVisible();

    // Members — one row per account, both sides on it.
    await admin.locator('.side .mitem[data-v=members]').click();
    await expect(admin.locator('#pageTitle')).toHaveText('Members');
    const bothRow = admin.locator('#membersTable tbody tr', { hasText: both.email });
    await expect(bothRow).toHaveCount(1);
    await expect(bothRow).toContainText('shop + services');
    await expect(bothRow.locator('td').nth(1)).toContainText(both.practice);
    await expect(bothRow.locator('td').nth(2)).toContainText(both.practice);
    await expect(bothRow.locator('.pill.pending')).toHaveCount(2);
    const soloRow = admin.locator('#membersTable tbody tr', { hasText: solo.email });
    await expect(soloRow).toHaveCount(1);
    await expect(soloRow).toContainText('services only');
    await expect(admin.locator('#membersBadge')).not.toHaveText('0');

    // Providers — the application card, then approval (anchors the subscription).
    await admin.locator('.side .mitem[data-v=providers]').click();
    const card = admin.locator('#providersWrap > div', { hasText: solo.email });
    await expect(card).toContainText('Hand-painted nursery murals');
    await expect(card).toContainText('Nursery name mural');
    await expect(card).toContainText('v1');                 // Provider Agreement version on the card
    await expect(card).toContainText('starts at approval');
    await card.getByRole('button', { name: '✓ Approve' }).click();
    await expect(admin.locator('#toast')).toContainText('approved');
    await expect(card.locator('.pill.approved')).toBeVisible();
    await expect(card).toContainText(/since \d{1,2} \w{3,4} \d{4}/);
    await expect(card.getByRole('link', { name: /public page/ })).toHaveAttribute('href', `/services/${solo.slug}`);

    // Members — approve the Both applicant's shop and practice inline.
    await admin.locator('.side .mitem[data-v=members]').click();
    await bothRow.locator('td').nth(1).getByRole('button', { name: '✓ Approve' }).click();
    await expect(bothRow.locator('td').nth(1).locator('.pill.approved')).toBeVisible();
    await bothRow.locator('td').nth(2).getByRole('button', { name: '✓ Approve' }).click();
    await expect(bothRow.locator('td').nth(2).locator('.pill.approved')).toBeVisible();

    const provs = await j(admin.request, 'GET', '/api/admin/providers');
    const row = provs.data.providers.find((p) => p.slug === solo.slug);
    expect(row.status).toBe('approved');
    expect(row.subStartedAt).toBeTruthy();
    expect(provs.data.providers.find((p) => p.slug === both.slug).status).toBe('approved');
  });

  test('approved provider signs in to /provider and manages listings (create, edit, hide, delete)', async ({ page, actor }) => {
    await page.goto('/login');
    await page.locator('#email').fill(solo.email);
    await page.locator('#pass').fill(solo.password);
    await page.locator('#submitBtn').click();
    await expect(page).toHaveURL(/\/provider$/);
    await expect(page.locator('#whoStatus')).toHaveText('Live provider');
    const ov = page.locator('#ppOverview');
    await expect(ov.locator('.pp-banner.good')).toContainText(/You.re live/);
    await expect(ov.locator('.pp-fee')).toContainText('AED 30');
    await expect(ov).toContainText('Running since');
    await expect(ov).toContainText('Provider Agreement v1');
    await expect(ov.locator('.pp-stat').first()).toContainText('0');

    await page.locator('.side .mitem[data-v=services]').click();
    const panel = page.locator('#ppServices');
    await expect(panel.locator('.pp-empty')).toContainText('Nothing listed yet');

    // Create — with validation first.
    await panel.getByRole('button', { name: '+ Add a service' }).click();
    await expect(page.locator('#ppEditor')).toBeVisible();
    await expect(page.locator('#ppEdTitle')).toHaveText('Add a service');
    await page.locator('#ppEdSave').click();
    await expect(page.locator('#ppEdErr')).toHaveText('Give the service a name.');
    await page.locator('#ppEdName').fill('Nursery name mural');
    await page.locator('#ppEdSave').click();
    await expect(page.locator('#ppEdErr')).toHaveText('Set a price of at least AED 1.');
    await page.locator('#ppEdCat').selectOption('made-to-order');
    await page.locator('#ppEdSetting').selectOption('home');
    await page.locator('#ppEdPrice').fill('900');
    await page.locator('#ppEdPriceType').selectOption('from');
    await page.locator('#ppEdDuration').fill('One day on site');
    await page.locator('#ppEdDesc').fill('A hand-painted name and a few leaves, sketched with you first.');
    await page.locator('#ppEdSave').click();
    await expect(page.locator('#toast')).toHaveText('Service added');
    const mural = panel.locator('.pp-row', { hasText: 'Nursery name mural' });
    await expect(mural).toContainText('From AED 900');
    await expect(mural.locator('.pp-pill')).toHaveText('live');

    // Edit price and duration.
    await mural.getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#ppEdTitle')).toHaveText('Edit service');
    await expect(page.locator('#ppEdPrice')).toHaveValue('900');
    await page.locator('#ppEdPrice').fill('1450');
    await page.locator('#ppEdDuration').fill('Two days on site');
    await page.locator('#ppEdSave').click();
    await expect(page.locator('#toast')).toHaveText('Service updated');
    await expect(mural).toContainText('From AED 1,450');
    await expect(mural).toContainText('Two days on site');

    // A second listing: hide (pause), make live, then delete.
    await panel.getByRole('button', { name: '+ Add a service' }).click();
    await page.locator('#ppEdName').fill('Lettered welcome sign');
    await page.locator('#ppEdPrice').fill('300');
    await page.locator('#ppEdSave').click();
    const sign = panel.locator('.pp-row', { hasText: 'Lettered welcome sign' });
    await expect(sign.locator('.pp-pill')).toHaveText('live');
    await sign.getByRole('button', { name: 'Hide' }).click();
    await expect(sign.locator('.pp-pill')).toHaveText('hidden');
    await expect(page.locator('#ppOverview .pp-stat').first()).toContainText('of 2 listed');

    // The public page (a shopper's own browser) shows only the live listing, at the new price.
    const shopper = await actor();
    await shopper.goto(`/services/${solo.slug}`);
    await expect(shopper.locator('#pvName')).toHaveText(solo.practice);
    await expect(shopper.locator('#pvGrid .svcard')).toHaveCount(1);
    await expect(shopper.locator('#pvGrid .svcard')).toContainText('From AED 1,450');
    await expect(shopper.locator('#pvGrid')).not.toContainText('Lettered welcome sign');

    await sign.getByRole('button', { name: 'Make live' }).click();
    await expect(sign.locator('.pp-pill')).toHaveText('live');
    await sign.getByRole('button', { name: 'Delete' }).click(); // confirm() accepted
    await expect(page.locator('#toast')).toHaveText('Service deleted');
    await expect(sign).toHaveCount(0);
    const mine = await j(page.request, 'GET', '/api/provider/services');
    expect(mine.data.services.map((s) => s.title)).toEqual(['Nursery name mural']);
    expect(mine.data.services[0]).toMatchObject({ priceCents: 145000, priceType: 'from', duration: 'Two days on site', status: 'live' });
  });
});

/* ------------------------------------------------------------------ *
 * Public browsing
 * ------------------------------------------------------------------ */
test.describe('public Services Marketplace', () => {
  test('/services directory: audiences, category cards, filters and the provider grid', async ({ page }) => {
    await page.goto('/services');
    const aud = page.locator('#audSwitch .audbtn');
    await expect(aud).toHaveCount(2);
    await expect(aud.nth(0)).toHaveClass(/\bon\b/);
    await expect(aud.nth(0)).toContainText('At home');
    await expect(page.locator('#dir .dcard')).toHaveCount(6);
    await expect(page.locator('#dir .dcard h3')).toContainText(['Made to order', 'Care & repair', 'Styling', 'Workshops at home', 'Portraits', 'Live creative']);

    const homeCount = (await j(page.request, 'GET', '/api/services?audience=home')).data.services.length;
    await expect(page.locator('#resultsSec h2')).toHaveText('All services');
    await expect(page.locator('#resultsSec .rhead span')).toHaveText(`${homeCount} services`);
    if (homeCount > 8) {
      await expect(page.locator('#resultsSec .svcard')).toHaveCount(8);
      await page.getByRole('button', { name: `Show all ${homeCount} services` }).click();
    }
    await expect(page.locator('#resultsSec .svcard')).toHaveCount(homeCount);

    // A category card filters the results below it.
    const careN = (await j(page.request, 'GET', '/api/services?category=care-repair')).data.services.length;
    const care = page.locator('#dir .dcard', { hasText: 'Care & repair' });
    await expect(care.locator('.cnt')).toHaveText(`${careN} services`);
    await care.click();
    await expect(care).toHaveClass(/\bon\b/);
    await expect(page.locator('#resultsSec h2')).toHaveText('Care & repair');
    await expect(page.locator('#resultsSec .svcard')).toHaveCount(careN);
    await expect(page.locator('#resultsSec')).toContainText('Ceramic repair & kintsugi');
    await expect(page.locator('#resultsSec')).not.toContainText('Family shoot at home');
    await page.getByRole('button', { name: 'Show everything' }).click();
    await expect(page.locator('#resultsSec h2')).toHaveText('All services');

    // The other audience swaps the six cards.
    await aud.nth(1).click();
    await expect(aud.nth(1)).toHaveClass(/\bon\b/);
    await expect(page.locator('#dir .dcard h3')).toContainText(['Content & visuals', 'Brand & design', 'Words, both languages', 'Social & growth', 'Shop & selling support', 'Coaching']);
    await page.locator('#dir .dcard', { hasText: 'Coaching' }).click();
    await expect(page.locator('#resultsSec .svcard')).toHaveCount(1);
    await expect(page.locator('#resultsSec')).toContainText('First 100 sales');

    // Empty categories invite providers instead of showing nothing.
    await aud.nth(0).click();
    const livePros = page.locator('#provGrid .pcard');
    await expect(livePros.first()).toBeVisible();
    expect(await livePros.count()).toBeGreaterThanOrEqual(6);
    await expect(page.locator('#provGrid')).toContainText('Noor Letters');
    await expect(page.locator('#provGrid')).not.toContainText('Oud by Khalid');
    await expect(page.locator('.ctaband a')).toHaveAttribute('href', '/apply?for=services');
  });

  test('a provider page never shows contact details — neither on the page nor in the API', async ({ page }) => {
    await page.goto('/services');
    await page.locator('#provGrid .pcard', { hasText: 'Noor Letters' }).click();
    await expect(page).toHaveURL(/\/services\/noor-letters$/);
    await expect(page.locator('#pvName')).toHaveText('Noor Letters');
    await expect(page.locator('#pvGrid .svcard')).toHaveCount(4);
    await expect(page.locator('#pvCount')).toHaveText('4 services');
    await expect(page.locator('#pvStats')).toContainText('Dubai');
    const text = await page.locator('body').innerText();
    expect(text, 'no email address on the provider page').not.toMatch(EMAIL_RE);
    expect(text, 'no UAE phone number on the provider page').not.toMatch(UAE_PHONE_RE);
    // A service detail (the booking modal) shows none either.
    await page.locator('#pvGrid .svcard', { hasText: 'Nursery name mural' }).click();
    await expect(page.locator('#svModal h3')).toHaveText('Nursery name mural');
    const modal = await page.locator('#svModal').innerText();
    expect(modal).not.toMatch(EMAIL_RE);
    expect(modal).not.toMatch(UAE_PHONE_RE);
    await page.locator('#svModal .x').click();

    for (const url of ['/api/services/providers/noor-letters', '/api/services/providers', '/api/services']) {
      const r = await j(page.request, 'GET', url);
      expect(r.status).toBe(200);
      expect(r.text, `${url} carries no email`).not.toMatch(EMAIL_RE);
      expect(r.text, `${url} carries no phone`).not.toContain('+971');
      expect(r.text).not.toMatch(/"(pitch_?[Pp]hone|phone|email|userId|user_id)"/);
    }
    // Browser back returns to the directory.
    await page.goBack();
    await expect(page).toHaveURL(/\/services$/);
    await expect(page.locator('#pview')).toBeHidden();
  });

  test('shop ↔ provider cross-links: a maker\'s shop and their services page link to each other', async ({ page }) => {
    await page.goto('/?shop=kiln-and-clay');
    await expect(page.locator('#view-vendor')).toBeVisible();
    await expect(page.locator('#vName')).toContainText('Kiln & Clay');
    await expect(page.locator('#vendorServices')).toBeVisible();
    await expect(page.locator('#vSvcHead')).toHaveText('Services by Kiln & Clay Workshops');
    await expect(page.locator('#vSvcList .svc-card')).toHaveCount(3);
    await page.locator('#vSvcLink').click();

    await expect(page).toHaveURL(/\/services\/kiln-and-clay-workshops$/);
    await expect(page.locator('#pvName')).toHaveText('Kiln & Clay Workshops');
    await expect(page.locator('#pvShop')).toBeVisible();
    await expect(page.locator('#pvShopCount')).toContainText('Kiln & Clay');
    const piece = page.locator('#pvPieces .pc').first();
    const pieceName = (await piece.locator('.pct').innerText()).trim();
    await expect(piece).toHaveAttribute('href', /^\/\?p=\d+$/);
    await page.locator('#pvShopLink').click();

    await expect(page.locator('#view-vendor')).toBeVisible();
    await expect(page.locator('#vName')).toContainText('Kiln & Clay');
    await page.goBack();
    await expect(page.locator('#pvName')).toHaveText('Kiln & Clay Workshops');
    await page.locator('#pvPieces .pc').first().click();
    await expect(page.locator('#view-pdp')).toBeVisible();
    await expect(page.locator('#pdpName')).toHaveText(pieceName);
  });

  test('a pending provider (Oud by Khalid) is not listed publicly, but can prepare in their dashboard', async ({ page, actor }) => {
    const pub = await j(page.request, 'GET', '/api/services');
    expect(pub.data.services.some((s) => s.provider.slug === 'oud-by-khalid')).toBe(false);
    expect((await j(page.request, 'GET', '/api/services/providers')).data.providers.some((p) => p.slug === 'oud-by-khalid')).toBe(false);
    expect((await j(page.request, 'GET', '/api/services/providers/oud-by-khalid')).status).toBe(404);

    await page.goto('/services/oud-by-khalid');
    await expect(page.locator('#toast')).toContainText(/That provider isn.t listed/);
    await expect(page.locator('#pview')).toBeHidden();
    await expect(page.locator('body')).not.toContainText('Oud & acoustic evening set');
    const search = await j(page.request, 'GET', '/api/services?q=oud');
    expect(search.data.services).toEqual([]);

    const khalid = await actor({ email: 'khalid@oudbykhalid.ae', password: 'demo1234' });
    await khalid.goto('/provider');
    await expect(khalid.locator('#whoStatus')).toHaveText('In review');
    await expect(khalid.locator('#ppOverview .pp-banner.pending')).toBeVisible();
    await khalid.locator('.side .mitem[data-v=services]').click();
    await expect(khalid.locator('#ppSvList .pp-row', { hasText: 'Oud & acoustic evening set' })).toBeVisible();
  });
});

/* ------------------------------------------------------------------ *
 * Bookings: customer ↔ provider, statuses on both sides
 * ------------------------------------------------------------------ */
test.describe.serial('booking a service', () => {
  let prov, buyer;
  const phone = randomMobile();
  const codes = {};

  test.beforeAll(async ({ apiAs }) => {
    prov = await makeProvider(apiAs, {
      services: [
        { title: 'Hand-building afternoon', priceCents: 120000, duration: '3 hours' },
        { title: 'Glaze clinic', priceCents: 45000, priceType: 'hourly', setting: 'studio' },
      ],
    });
    buyer = await makeBuyer(apiAs);
  });

  test('customer books with the direct method; card is unavailable; Services Terms required', async ({ page }) => {
    const login = await page.request.post('/api/auth/login', { data: { email: buyer.email, password: buyer.password } });
    expect(login.status()).toBe(200);
    await page.goto(`/services/${prov.slug}`);
    await expect(page.locator('#pvGrid .svcard')).toHaveCount(2);
    await page.locator('#pvGrid .svcard', { hasText: 'Hand-building afternoon' }).click();

    const modal = page.locator('#svModal');
    await expect(modal.locator('h3')).toHaveText('Hand-building afternoon');
    await expect(modal.locator('.price')).toHaveText('AED 1,200');
    await expect(page.locator('#bkName')).toHaveValue(buyer.name);      // signed in → prefilled
    await expect(page.locator('#bkEmail')).toHaveValue(buyer.email);
    const direct = modal.locator('input[name=bkPay][value=direct]');
    const card = modal.locator('input[name=bkPay][value=trove]');
    await expect(direct).toBeChecked();
    await expect(card).toBeDisabled();                                   // demo-payments: no card option
    await expect(modal.locator('.payopt.off')).toContainText('Coming with Trove');
    await expect(page.locator('#bkArea option')).toHaveText(['Dubai', 'Abu Dhabi']);

    const send = page.locator('#bkSubmit');
    await send.click();
    await expect(page.locator('#bkErr')).toContainText('Add a UAE mobile');
    await page.locator('#bkPhone').fill('12345');
    await send.click();
    await expect(page.locator('#bkErr')).toContainText('accept the Services Terms');
    await page.locator('#bkTerms').check();
    await send.click();
    await expect(page.locator('#bkErr')).toHaveText('Enter a UAE mobile number, like 05x xxx xxxx');   // server-side check
    await page.locator('#bkPhone').fill(phone);
    await page.locator('#bkArea').selectOption('Abu Dhabi');
    await page.locator('#bkDate').fill('A Friday afternoon');
    await page.locator('#bkNotes').fill('Six adults, garden table.');
    await send.click();

    await expect(modal.locator('.booked h4')).toHaveText('Request sent.');
    codes.a = (await modal.locator('.booked .code').innerText()).trim();
    expect(codes.a).toMatch(/^SRV-[0-9A-F]{6}$/);
    await modal.locator('.x').click();
    await expect(page.locator('#svScrim')).not.toHaveClass(/open/);

    const mine = page.locator('#myBookings .bkcard', { hasText: codes.a });
    await expect(mine).toContainText('Hand-building afternoon');
    await expect(mine).toContainText('Settling directly with the provider');
    await expect(mine.locator('.pill')).toHaveText('Waiting for the provider');

    // Two more requests (set-up shortcuts through the same endpoint the form uses).
    const [svA, svB] = prov.services;
    for (const [key, sv] of [['b', svB], ['c', svA]]) {
      const r = await j(page.request, 'POST', `/api/services/${sv.id}/book`, {
        name: buyer.name, email: buyer.email, phone, area: 'Dubai', preferredDate: 'Next week', notes: 'Booking ' + key, paymentMethod: 'direct', agreeTerms: true,
      });
      expect(r.status, r.text).toBe(201);
      codes[key] = r.data.booking.code;
    }
    const stored = await j(page.request, 'GET', '/api/services/my-bookings');
    const a = stored.data.bookings.find((b) => b.code === codes.a);
    expect(a).toMatchObject({ status: 'requested', paymentMethod: 'direct', area: 'Abu Dhabi', termsVersion: 'v1', priceCents: 120000 });
  });

  test('provider sees requests without the customer email; confirming releases the phone; declining another', async ({ page }) => {
    await page.request.post('/api/auth/login', { data: { email: prov.email, password: prov.password } });
    await page.goto('/provider');
    await expect(page.locator('#bkBadge')).toHaveText('3');
    await page.locator('.side .mitem[data-v=bookings]').click();
    const box = page.locator('#ppBookings');
    const newReq = box.locator('.pp-card', { has: page.locator('h3', { hasText: 'New requests' }) });
    await expect(newReq.locator('.pp-bk')).toHaveCount(3);
    const a = box.locator('.pp-bk', { hasText: codes.a });
    await expect(a).toContainText(buyer.name);
    await expect(a).toContainText('Abu Dhabi');
    await expect(a).toContainText('Six adults, garden table.');
    await expect(a).toContainText('Settled directly with the customer');
    await expect(a).toContainText('mobile appears once you confirm');
    const inbox = await box.innerText();
    expect(inbox, 'the customer email never reaches the provider').not.toContain(buyer.email);
    expect(inbox).not.toMatch(EMAIL_RE);
    expect(inbox, 'no phone before confirming').not.toContain(canonicalMobile(phone));
    const api = await j(page.request, 'GET', '/api/provider/bookings');
    expect(api.text).not.toContain(buyer.email);
    expect(api.data.bookings.every((b) => b.phone === null)).toBe(true);

    await a.getByRole('button', { name: '✓ Confirm' }).click();
    await expect(page.locator('#toast')).toHaveText('Booking confirmed');
    const confirmed = box.locator('.pp-card', { has: page.locator('h3', { hasText: 'Confirmed' }) });
    const aConf = confirmed.locator('.pp-bk', { hasText: codes.a });
    await expect(aConf.locator('.pp-pill')).toHaveText('confirmed');
    await expect(aConf.getByRole('link', { name: canonicalMobile(phone) })).toHaveAttribute('href', `tel:${canonicalMobile(phone)}`);
    expect(await box.innerText()).not.toContain(buyer.email);

    await box.locator('.pp-bk', { hasText: codes.b }).getByRole('button', { name: 'Decline' }).click(); // prompt → "ok"
    await expect(page.locator('#toast')).toHaveText('Request declined');
    const history = box.locator('.pp-card', { has: page.locator('h3', { hasText: 'History' }) });
    await expect(history.locator('.pp-bk', { hasText: codes.b }).locator('.pp-pill')).toHaveText('declined');
    await expect(page.locator('#bkBadge')).toHaveText('1');
    const after = await j(page.request, 'GET', '/api/provider/bookings');
    expect(after.data.bookings.find((b) => b.code === codes.b).phone).toBeNull();
  });

  test('customer sees the statuses and cancels the open request; provider sees it cancelled', async ({ page, actor }) => {
    await page.request.post('/api/auth/login', { data: { email: buyer.email, password: buyer.password } });
    await page.goto('/services');
    const card = (code) => page.locator('#myBookings .bkcard', { hasText: code });
    await expect(page.locator('#myBookings h3')).toHaveText('Your bookings');
    await expect(card(codes.a).locator('.pill')).toHaveText('Confirmed');
    await expect(card(codes.b).locator('.pill')).toHaveText('Declined');
    await expect(card(codes.b)).toContainText('“ok”');
    await expect(card(codes.b).getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await expect(card(codes.c).locator('.pill')).toHaveText('Waiting for the provider');
    await card(codes.c).getByRole('button', { name: 'Cancel' }).click();          // confirm() accepted
    await expect(page.locator('#toast')).toHaveText('Booking cancelled');
    await expect(card(codes.c).locator('.pill')).toHaveText('Cancelled');
    await expect(card(codes.c).getByRole('button', { name: 'Cancel' })).toHaveCount(0);

    const provider = await actor({ email: prov.email, password: prov.password });
    await provider.goto('/provider');
    await provider.locator('.side .mitem[data-v=bookings]').click();
    const history = provider.locator('#ppBookings .pp-card', { has: provider.locator('h3', { hasText: 'History' }) });
    await expect(history.locator('.pp-bk', { hasText: codes.c }).locator('.pp-pill')).toHaveText('cancelled');
    await expect(provider.locator('#bkBadge')).toHaveText('0');
    // Provider marks the confirmed visit done → the customer sees "Done".
    await provider.locator('#ppBookings .pp-bk', { hasText: codes.a }).getByRole('button', { name: 'Mark as done' }).click();
    await expect(provider.locator('#toast')).toHaveText('Marked as done');
    await expect(history.locator('.pp-bk', { hasText: codes.a }).locator('.pp-pill')).toHaveText('completed');
    await expect(provider.locator('#ppOverview .pp-stat', { hasText: 'Completed' })).toContainText('1');

    await page.reload();
    await expect(card(codes.a).locator('.pill')).toHaveText('Done');
    const mine = await j(page.request, 'GET', '/api/services/my-bookings');
    const status = Object.fromEntries(mine.data.bookings.map((b) => [b.code, b.status]));
    expect(status).toEqual({ [codes.a]: 'completed', [codes.b]: 'declined', [codes.c]: 'cancelled' });
  });

  test('the server refuses a "pay through Trove by card" booking while card payments are off', async ({ page }) => {
    test.fail(true, 'BUG: POST /api/services/:id/book accepts paymentMethod "trove" (and snapshots a 10% commission) with no card payments configured — services.routes.js never checks getStripe()');
    const health = await j(page.request, 'GET', '/api/health');
    expect(health.data.stripe).toBe(false);
    const r = await j(page.request, 'POST', `/api/services/${prov.services[0].id}/book`, {
      name: 'Guest Card', email: `guest-${uid()}@e2e.test`, phone: randomMobile(), area: 'Dubai', paymentMethod: 'trove', agreeTerms: true,
    });
    expect(r.status, 'card bookings must wait for card payments').toBe(400);
  });
});

/* ------------------------------------------------------------------ *
 * One account, shop + services
 * ------------------------------------------------------------------ */
test.describe('makers switch services on from the seller dashboard', () => {
  test('an approved maker switches on services and is live immediately', async ({ page, apiAs, actor }) => {
    const maker = await makeSeller(apiAs, { approve: true });
    await page.request.post('/api/auth/login', { data: { email: maker.email, password: maker.password } });
    await openDashboard(page, '/sell');
    await page.locator('.side .mitem[data-v=services]').click();
    await expect(page.locator('#svcEnable')).toBeVisible();
    await expect(page.locator('#svcEnableNote')).toContainText('Goes live straight away');
    await expect(page.locator('#svcCatPicker .svc-catopt')).toHaveCount(12);

    await page.locator('#svcEnableBtn').click();
    await expect(page.locator('#svcErr')).toHaveText('Pick at least one service category.');
    await page.locator('#svcCatPicker .svc-catopt', { hasText: 'Workshops at home' }).click();
    await page.locator('#svcCatPicker .svc-catopt', { hasText: 'Care & repair' }).click();
    await page.locator('#svcPlanned').fill('Hand-building afternoons');
    await page.locator('#svcEnableBtn').click();
    await expect(page.locator('#svcErr')).toContainText('Tick the box');
    await page.locator('#svcAgree').check();
    await page.locator('#svcEnableBtn').click();

    await expect(page.locator('#toast')).toContainText(/Services switched on/);
    await expect(page.locator('#svcPanel')).toBeVisible();
    await expect(page.locator('#svcEnable')).toBeHidden();
    await expect(page.locator('#ppOverview .pp-banner.good')).toContainText(/You.re live/);
    await expect(page.locator('#ppOverview')).toContainText('Running since');

    // List a service from the same tab — public at once, cross-linked to the shop.
    await page.locator('#ppServices').getByRole('button', { name: '+ Add a service' }).click();
    await page.locator('#ppEdName').fill('Wheel taster session');
    await page.locator('#ppEdCat').selectOption('workshops');
    await page.locator('#ppEdPrice').fill('380');
    await page.locator('#ppEdSave').click();
    await expect(page.locator('#toast')).toHaveText('Service added');

    const me = await j(page.request, 'GET', '/api/auth/me');
    expect(me.data.provider.status).toBe('approved');
    expect(me.data.shop.slug).toBe(maker.slug);
    const shopper = await actor();
    await shopper.goto(`/services/${me.data.provider.slug}`);
    await expect(shopper.locator('#pvName')).toHaveText(maker.shopName);
    await expect(shopper.locator('#pvGrid .svcard')).toContainText('Wheel taster session');
  });

  test('a pending shop gets a pending practice, reviewed together', async ({ page, apiAs }) => {
    const maker = await makeSeller(apiAs, { approve: false });
    await page.request.post('/api/auth/login', { data: { email: maker.email, password: maker.password } });
    await openDashboard(page, '/sell');
    await page.locator('.side .mitem[data-v=services]').click();
    await expect(page.locator('#svcEnableNote')).toContainText('Reviewed together with your shop application');
    await page.locator('#svcCatPicker .svc-catopt', { hasText: 'Portraits & photography' }).click();
    await page.locator('#svcAgree').check();
    await page.locator('#svcEnableBtn').click();
    await expect(page.locator('#toast')).toContainText('reviewed with your shop');
    await expect(page.locator('#ppOverview .pp-banner.pending')).toContainText('with our curation team');
    const me = await j(page.request, 'GET', '/api/auth/me');
    expect(me.data.provider.status).toBe('pending');
    expect((await j(page.request, 'GET', `/api/services/providers/${me.data.provider.slug}`)).status).toBe(404);
    // Once only.
    const again = await j(page.request, 'POST', '/api/seller/enable-services', { categories: ['workshops'], agreeSub: true, agreeTerms: true });
    expect(again.status).toBe(409);
  });
});
