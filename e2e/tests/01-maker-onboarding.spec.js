'use strict';
/**
 * 01 · Maker onboarding & shop validation.
 *
 * One serial journey: a maker applies through /apply, prepares payouts while
 * pending, gets reviewed and approved in /admin, then builds a real shop in
 * /sell (storefront, licence, products with photos / variants / extras / tags,
 * drafts, edits, deletes). A second applicant (licensed) is rejected, and a
 * signed-in buyer turns their account into a seller. The admin "shop view"
 * closes the loop.
 *
 * Emirates ID photos and the Seller Agreement are NOT part of /apply — they
 * live in /sell → Payments → Payout setup, so that's where they are tested.
 */
const { test, expect, ACCOUNTS, uid, call, pngFile } = require('./fixtures');
const { newActor, api, sellerTab, adminTab, gotoSell, gotoStore, DUBAI } = require('./helpers-market');

const tag = uid();
const MARKETPLACE_CATS = ['Home & Living', 'Wall Art & Prints', 'Ceramics', 'Stationery', 'Jewellery', 'Personalised Gifts',
  "Children's", 'Pet Accessories', 'Wellness & Self-Care', 'Accessories', 'Seasonal', 'Handmade Crafts'];

// Shared journey state (serial describe → one worker, in order).
const A = { name: `Amira Test${tag}`, email: `amira-${tag}@e2e.test`, password: 'amira-pass-123', shopName: `Clay Room ${tag}` };
const B = { name: `Bilal Lic${tag}`, email: `bilal-${tag}@e2e.test`, password: 'bilal-pass-123', shopName: `Brass Works ${tag}` };
const C = { name: `Cara Buyer${tag}`, email: `cara-${tag}@e2e.test`, password: 'cara-pass-123', shopName: `Cara Prints ${tag}` };
const VASE = `Speckled Vase ${tag}`;
const JUG = `Draft Jug ${tag}`;
const FULL_IBAN = 'AE070331234567890123456';

test.describe.serial('maker onboarding', () => {
  test('applicant walks /apply: every step validates, then the application lands as pending', async ({ page }) => {
    await page.goto('/apply');
    await expect(page.locator('.role[data-role="maker"]')).toHaveClass(/\bon\b/);
    const err = page.locator('#err');
    const next1 = page.locator('#step1 .next');

    await next1.click();
    await expect(err).toHaveText('Please tell us your name.');
    await page.fill('#fName', A.name);
    await page.fill('#fEmail', 'not-an-email');
    await next1.click();
    await expect(err).toContainText('That email doesn’t look right');
    await page.fill('#fEmail', A.email);
    await page.fill('#fPass', 'short');
    await next1.click();
    await expect(err).toHaveText('Your password needs at least 8 characters.');
    await page.fill('#fPass', A.password);
    await next1.click();

    await expect(page.getByRole('heading', { name: 'Now, your shop.' })).toBeVisible();
    await expect(page.locator('#fLoc option')).toHaveText(['Dubai, UAE', 'Abu Dhabi, UAE']);
    const next2 = page.locator('#step2 .next');
    await next2.click();
    await expect(err).toHaveText('Give your shop a name — you can change it later.');
    await page.fill('#fShop', A.shopName);
    await page.fill('#fAbout', 'Too short');
    await next2.click();
    await expect(err).toContainText('Tell us a little more about you');
    await page.fill('#fAbout', 'I throw speckled stoneware in a small Al Quoz studio and glaze every piece by hand.');
    await page.selectOption('#fCat', 'Ceramics');
    await page.selectOption('#fExp', '3+ years');
    await page.selectOption('#fLic', 'yes');
    await expect(page.locator('#fLicNo')).toBeVisible();
    await next2.click();
    await expect(err).toContainText('Add your license number');
    await page.selectOption('#fLic', 'no');
    await next2.click();

    await expect(page.getByRole('heading', { name: 'What will you sell?' })).toBeVisible();
    const submit = page.locator('#submitBtn');
    await submit.click();
    await expect(err).toHaveText('List at least one thing you’re planning to sell.');
    await page.fill('#fProducts', 'Speckled vases — AED 150\nPour-over cups');
    await submit.click();
    await expect(err).toContainText('Share your Instagram');
    await page.fill('#fInsta', `@clayroom${tag}`);
    await submit.click();
    await expect(err).toContainText('Add your WhatsApp number');
    await page.fill('#fPhone', '+971 50 765 4321');
    await page.selectOption('#fCap', '10–30');
    await submit.click();

    await expect(page.getByRole('heading', { name: 'Application received.' })).toBeVisible();
    await expect(page.locator('#doneText')).toContainText(`Thanks ${A.name.split(' ')[0]}`);
    await expect(page.locator('#doneText')).toContainText(A.shopName);
    await expect(page.locator('#doneBtn')).toHaveText('Set up your shop →');

    const me = await call(page, 'GET', '/api/seller/me');
    expect(me.data.shop.status).toBe('pending');
    expect(me.data.shop.name).toBe(A.shopName);
    expect(me.data.shop.pitch_instagram).toBe(`instagram.com/clayroom${tag}`);
    expect(me.data.shop.pitch_phone).toBe('+971 50 765 4321');
    expect(me.data.shop.pitch_capacity).toBe('10–30');
    A.shop = me.data.shop;

    // The same rules hold when the form is bypassed.
    const raw = await api(test.info());
    const base = { role: 'seller', name: 'Raw Applicant', password: 'raw-pass-123', shopName: 'Raw', location: 'Dubai, UAE', instagram: '@raw', phone: '0501234567' };
    let r = await raw.call('POST', '/api/auth/register', { ...base, email: `raw1-${tag}@e2e.test`, instagram: '' });
    expect([r.status, r.data.error]).toEqual([400, 'Instagram is required for a shop application']);
    r = await raw.call('POST', '/api/auth/register', { ...base, email: `raw2-${tag}@e2e.test`, phone: '' });
    expect([r.status, r.data.error]).toEqual([400, 'A WhatsApp number is required for a shop application']);
    r = await raw.call('POST', '/api/auth/register', { ...base, email: `raw3-${tag}@e2e.test`, location: 'Sharjah, UAE' });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('Dubai and Abu Dhabi only');
    await raw.dispose();
  });

  test('a pending shop stays off the storefront and its pieces cannot be bought', async ({ browser }, testInfo) => {
    const maker = await newActor(browser, testInfo, { account: A });
    await gotoSell(maker.page);
    await expect(maker.page.locator('#ovBanner')).toContainText('Your shop is being reviewed');
    // Preparing a piece while the review is pending is allowed (setup shortcut).
    const p = await call(maker.page, 'POST', '/api/seller/products', { name: `Waiting Bowl ${tag}`, price: 90, stock: 5, status: 'live', category: 'Ceramics' });
    expect(p.status).toBe(201);
    const pid = p.data.product.id;
    await maker.close();

    const shopper = await newActor(browser, testInfo);
    const pg = shopper.page;
    expect((await call(pg, 'GET', '/api/shops')).data.shops.map((s) => s.slug)).not.toContain(A.shop.slug);
    expect((await call(pg, 'GET', `/api/shops/${A.shop.slug}`)).status).toBe(404);
    expect((await call(pg, 'GET', `/api/products/${pid}`)).status).toBe(404);
    expect((await call(pg, 'GET', `/api/products?shop=${A.shop.slug}`)).data.products).toEqual([]);

    // Deep links land on the home page instead of the shop / piece.
    await gotoStore(pg, `/?shop=${A.shop.slug}`);
    await expect(pg).toHaveURL(/\/$/);
    await expect(pg.locator('#view-vendor')).not.toHaveClass(/active/);
    await gotoStore(pg, `/?p=${pid}`);
    await expect(pg).toHaveURL(/\/$/);
    await expect(pg.locator('#view-pdp')).not.toHaveClass(/active/);
    // Search can't find it either.
    await pg.fill('#searchInput', `Waiting Bowl ${tag}`);
    await pg.press('#searchInput', 'Enter');
    await expect(pg.locator('#shopGrid .noresult')).toBeVisible();

    // And the checkout refuses it outright.
    const co = await call(pg, 'POST', '/api/checkout', { items: [{ productId: pid, qty: 1 }], email: `peek-${tag}@e2e.test`, phone: '0501234567', address: DUBAI });
    expect(co.status).toBe(400);
    expect(co.data.error).toContain('unavailable');
    await shopper.close();
  });

  test('payout setup while pending: Emirates ID photos, home address, agreement; bad IBAN refused, good IBAN stored masked', async ({ browser }, testInfo) => {
    const maker = await newActor(browser, testInfo, { account: A });
    const pg = maker.page;
    const toast = pg.locator('#toast');
    await gotoSell(pg);
    await expect(pg.locator('#ovBanner')).toContainText('Finish your payout setup');
    await sellerTab(pg, 'payments', 'Payments');
    const save = pg.getByRole('button', { name: 'Save payout details' });

    await pg.fill('#psEid', '4821');
    await pg.fill('#psExp', '2031-06-30');
    await pg.fill('#bkName', A.name);
    await pg.fill('#bkBank', 'Emirates NBD');
    await pg.fill('#bkIban', 'AE12 3456');
    await save.click();
    await expect(toast).toHaveText('Add a photo of the front of your Emirates ID');

    await pg.setInputFiles('#psEidFrontFile', pngFile('eid-front.png'));
    await expect(pg.locator('#psEidFrontBtn')).toHaveText('Photo added ✓ — change');
    await save.click();
    await expect(toast).toHaveText('Add a photo of the back of your Emirates ID');
    await pg.setInputFiles('#psEidBackFile', pngFile('eid-back.png'));
    await expect(pg.locator('#psEidBackBtn')).toHaveText('Photo added ✓ — change');

    await save.click();
    await expect(toast).toHaveText('Enter your home address');
    await pg.fill('#psAddrLine', 'Villa 7, Street 12');
    await pg.fill('#psAddrArea', 'Al Barsha');
    await pg.selectOption('#psAddrEmirate', 'Dubai');
    await save.click();
    await expect(toast).toHaveText('Tick the Seller Agreement box to continue');

    await pg.check('#psAgree');
    await save.click();
    await expect(toast).toHaveText('Enter a valid UAE IBAN (AE followed by 21 digits)');

    await pg.fill('#bkIban', 'AE07 0331 2345 6789 0123 456');
    await save.click();
    await expect(toast).toContainText('Payout setup complete');

    const card = pg.locator('#view-payments .card').filter({ hasText: 'Payout details' });
    await expect(card).toContainText('Emirates NBD');
    await expect(card).toContainText(A.name);
    await expect(card).toContainText('AE·· ···· 3456');
    await expect(card).toContainText('On file ✓');
    await expect(card).toContainText('Villa 7, Street 12, Al Barsha, Dubai');
    await expect(card).toContainText('Accepted · v3');
    await expect(pg.locator('body')).not.toContainText(FULL_IBAN);
    await expect(pg.locator('#view-payments')).not.toContainText('Add your bank details');

    const me = await call(pg, 'GET', '/api/seller/me');
    expect(JSON.stringify(me.data)).not.toContain(FULL_IBAN);
    expect(me.data.shop.iban_masked).toBe('AE·· ···· 3456');
    expect(me.data.shop.eidFrontProvided && me.data.shop.eidBackProvided).toBe(true);
    expect(me.data.shop.agreement_version).toBe('v3');
    await maker.close();
  });

  test('a signed-in buyer turns their account into a seller from /apply', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Create an account' }).click();
    await page.fill('#name', C.name);
    await page.fill('#email', C.email);
    await page.fill('#pass', C.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/account/);
    expect((await call(page, 'GET', '/api/auth/me')).data.user.role).toBe('buyer');

    await page.goto('/apply');
    await expect(page.locator('#signedNote')).toBeVisible();
    await expect(page.locator('#signedWho')).toHaveText(C.email);
    await expect(page.locator('#fEmail')).toHaveValue(C.email);
    await expect(page.locator('#fEmail')).toHaveAttribute('readonly', '');
    await expect(page.locator('#passField')).toBeHidden();
    await expect(page.locator('#fName')).toHaveValue(C.name);
    await page.locator('#step1 .next').click();
    await page.fill('#fShop', C.shopName);
    await page.fill('#fAbout', 'Risograph prints of old Dubai shopfronts, printed in two colours in my spare room.');
    await page.selectOption('#fCat', 'Wall Art & Prints');
    await page.selectOption('#fLoc', 'Abu Dhabi, UAE');
    await page.locator('#step2 .next').click();
    await page.fill('#fProducts', 'A3 risograph prints');
    await page.fill('#fInsta', 'instagram.com/caraprints');
    await page.fill('#fPhone', '055 444 3322');
    await page.locator('#submitBtn').click();
    await expect(page.getByRole('heading', { name: 'Application received.' })).toBeVisible();

    const me = (await call(page, 'GET', '/api/auth/me')).data;
    expect(me.user.email).toBe(C.email);
    expect(me.user.role).toBe('seller');
    expect(me.shop.name).toBe(C.shopName);
    // Same account, now with a dashboard — and /apply sends it there.
    await page.goto('/apply');
    await expect(page).toHaveURL(/\/sell/);
    await expect(page.locator('#sideShop')).toHaveText(C.shopName);
  });

  test('a signed-out buyer applies with their existing email: the wrong password is refused, the right one adds the shop', async ({ page }, testInfo) => {
    const D = { name: `Dana Existing${tag}`, email: `dana-${tag}@e2e.test`, password: 'dana-pass-123' };
    const s0 = await api(testInfo);
    expect((await s0.call('POST', '/api/auth/register', { role: 'buyer', ...D })).status).toBe(201);
    await s0.dispose();

    await page.goto('/apply');
    await page.fill('#fName', D.name);
    await page.fill('#fEmail', D.email);
    await page.fill('#fPass', 'wrong-pass-999');
    await page.locator('#step1 .next').click();
    await page.fill('#fShop', `Dana Weaves ${tag}`);
    await page.fill('#fAbout', 'Hand-woven palm-leaf baskets, dyed with pomegranate and indigo at home.');
    await page.locator('#step2 .next').click();
    await page.fill('#fProducts', 'Palm baskets');
    await page.fill('#fInsta', '@danaweaves');
    await page.fill('#fPhone', '050 777 8899');
    await page.locator('#submitBtn').click();
    await expect(page.locator('#step1')).toBeVisible();
    await expect(page.locator('#err')).toHaveText('An account with this email already exists. To add this to it, use that account’s password here — or apply with a different email.');
    expect((await call(page, 'GET', '/api/auth/me')).status).toBe(401);

    await page.fill('#fPass', D.password);
    await page.locator('#step1 .next').click();
    await page.locator('#step2 .next').click();
    await page.locator('#submitBtn').click();
    await expect(page.getByRole('heading', { name: 'Application received.' })).toBeVisible();
    const me = (await call(page, 'GET', '/api/auth/me')).data;
    expect([me.user.email, me.user.role, me.shop.name]).toEqual([D.email, 'seller', `Dana Weaves ${tag}`]);
  });

  test('a licensed applicant uploads a licence photo with the application', async ({ page }) => {
    await page.goto('/apply');
    await page.fill('#fName', B.name);
    await page.fill('#fEmail', B.email);
    await page.fill('#fPass', B.password);
    await page.locator('#step1 .next').click();
    await page.fill('#fShop', B.shopName);
    await page.fill('#fAbout', 'Hand-spun brass bowls and trays from our licensed Deira workshop, since 2011.');
    await page.selectOption('#fCat', 'Home & Living');
    await page.selectOption('#fLic', 'yes');
    await page.fill('#fLicNo', 'CN-1234567');
    await page.setInputFiles('#fLicImg', pngFile('licence.png'));
    await page.locator('#step2 .next').click();
    await page.fill('#fProducts', 'Brass trays');
    await page.fill('#fInsta', '@brassworks');
    await page.fill('#fPhone', '+971 52 000 1122');
    await page.locator('#submitBtn').click();
    await expect(page.getByRole('heading', { name: 'Application received.' })).toBeVisible();

    const me = (await call(page, 'GET', '/api/seller/me')).data.shop;
    expect(me.license_number).toBe('CN-1234567');
    expect(me.connect_queue).toBe(1);
    expect(me.needsIdVerification).toBe(false);   // licensed → no Emirates ID photos needed
    B.shop = me;
  });

  test('the seller API does not hand the private licence-image path back to the shop', async ({ page }) => {
    test.fail(true, 'BUG: /api/seller/me publicShop() strips EID paths but leaks license_image (server filesystem path)');
    await page.request.post('/api/auth/login', { data: { email: B.email, password: B.password } });
    const me = (await call(page, 'GET', '/api/seller/me')).data.shop;
    expect(me).not.toHaveProperty('license_image');
  });

  test('admin reads the application, opens the Emirates ID photos and approves the shop', async ({ browser }, testInfo) => {
    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    const pg = admin.page;
    await pg.goto('/admin');
    const card = pg.locator('#pendingList > div').filter({ hasText: A.shopName });
    await expect(card).toContainText(`${A.name} · ${A.email}`);
    await expect(card).toContainText('I throw speckled stoneware in a small Al Quoz studio');
    await expect(card).toContainText('Speckled vases — AED 150');
    await expect(card).toContainText('+971 50 765 4321');
    await expect(card).toContainText('3+ years');
    await expect(card).toContainText('10–30');
    await expect(card.getByRole('link', { name: new RegExp(`instagram.com/clayroom${tag}`) })).toBeVisible();

    // Identity: the Emirates ID photos, admin-only.
    await adminTab(pg, 'shops', 'Shops');
    const row = pg.locator('#shopsTable tbody tr').filter({ hasText: A.shopName });
    await expect(row.locator('.pill', { hasText: 'EID ✓' })).toBeVisible();
    await expect(row).toContainText('Villa 7, Street 12, Al Barsha, Dubai');
    await expect(row.locator('.pill.pending', { hasText: 'pending' })).toBeVisible();
    for (const side of ['front', 'back']) {
      const [photo] = await Promise.all([admin.context.waitForEvent('page'), row.getByRole('link', { name: side }).click()]);
      const res = await photo.waitForLoadState().then(() => photo.request.get(photo.url()));
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('image/jpeg');
      expect(res.headers()['cache-control']).toContain('no-store');
      expect((await res.body()).subarray(0, 2).toString('hex')).toBe('ffd8');
      await photo.close();
    }
    // …and the shop owner can't open them through the admin route.
    const own = await api(testInfo, A);
    expect((await own.call('GET', `/api/admin/shops/${A.shop.id}/eid/front`)).status).toBe(403);
    await own.dispose();

    await adminTab(pg, 'overview', 'Overview');
    await card.getByRole('button', { name: '✓ Approve' }).click();
    await expect(pg.locator('#toast')).toHaveText(`${A.shopName} → approved`);
    await expect(card).toHaveCount(0);
    const shops = (await call(pg, 'GET', '/api/shops')).data.shops;
    expect(shops.map((s) => s.slug)).toContain(A.shop.slug);
    await admin.close();
  });

  test('admin rejects the licensed application; the applicant sees the outcome', async ({ browser }, testInfo) => {
    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    const pg = admin.page;
    await pg.goto('/admin');
    const statsBefore = (await call(pg, 'GET', '/api/admin/stats')).data;
    const licCard = pg.locator('#statCards .stat').filter({ hasText: 'Licensed sellers' });
    await expect(licCard.locator('.v')).toHaveText(String(statsBefore.licensed.total));
    await expect(licCard).toContainText(`${statsBefore.licensed.awaiting} awaiting check`);

    // The licence photo sits in the graduation (licensed sellers) queue.
    await adminTab(pg, 'payouts', 'Trove payouts');
    const gRow = pg.locator('#payoutsWrap tr').filter({ hasText: B.shopName });
    await expect(gRow).toContainText('CN-1234567');
    await expect(gRow).toContainText('applied with license');
    await expect(gRow.locator('.pill', { hasText: 'awaiting check' })).toBeVisible();
    const [lic] = await Promise.all([admin.context.waitForEvent('page'), gRow.getByRole('link', { name: 'image' }).click()]);
    await lic.waitForLoadState();
    const licRes = await lic.request.get(lic.url());
    expect(licRes.status()).toBe(200);
    expect(licRes.headers()['content-type']).toContain('image/jpeg');
    await lic.close();
    await adminTab(pg, 'shops', 'Shops');
    await expect(pg.locator('#shopsTable tbody tr').filter({ hasText: B.shopName }).locator('.pill', { hasText: /^license$/ })).toBeVisible();

    await adminTab(pg, 'overview', 'Overview');
    const card = pg.locator('#pendingList > div').filter({ hasText: B.shopName });
    await card.getByRole('button', { name: 'Reject' }).click();
    await expect(pg.locator('#toast')).toHaveText(`${B.shopName} → rejected`);
    await expect(card).toHaveCount(0);
    const statsAfter = (await call(pg, 'GET', '/api/admin/stats')).data;
    expect(statsAfter.licensed.total).toBe(statsBefore.licensed.total - 1);
    await admin.close();

    const maker = await newActor(browser, testInfo, { account: B });
    await gotoSell(maker.page);
    await expect(maker.page.locator('#ovBanner')).toContainText('Your shop wasn\'t approved');
    await expect(maker.page.locator('#ovBanner')).toContainText('isn\'t visible to shoppers');
    expect((await call(maker.page, 'GET', '/api/shops')).data.shops.map((s) => s.slug)).not.toContain(B.shop.slug);
    await maker.close();
  });

  test('a shop that is not live is not labelled "Live shop" in its dashboard', async ({ browser }, testInfo) => {
    test.fail(true, 'BUG: trove-seller.html applyShop()/boot() always print "Live shop" under the shop name, even while pending or after rejection');
    const maker = await newActor(browser, testInfo, { account: B });   // rejected above
    try {
      await gotoSell(maker.page);
      await expect(maker.page.locator('#ovBanner')).toContainText('Your shop wasn\'t approved');
      await expect(maker.page.locator('#sideStatus')).not.toHaveText('Live shop', { timeout: 2000 });
    } finally { await maker.context.close(); }
  });

  test('approved maker edits the storefront: photo through the cropper, details, courier pickup', async ({ browser }, testInfo) => {
    const maker = await newActor(browser, testInfo, { account: A });
    const pg = maker.page;
    const toast = pg.locator('#toast');
    await gotoSell(pg);
    await expect(pg.locator('#ovBanner')).not.toContainText('being reviewed');
    await sellerTab(pg, 'storefront', 'Storefront');

    await pg.setInputFiles('#sfPhotoFile', pngFile('shop.png'));
    await expect(pg.locator('#cropModal')).toHaveClass(/open/);
    await pg.locator('#cmZoom').focus();
    for (let i = 0; i < 5; i++) await pg.keyboard.press('ArrowRight');   // zoom in a touch
    await pg.locator('#cmApply').click();
    await expect(toast).toHaveText('Shop photo updated');
    await expect(pg.locator('#cropModal')).not.toHaveClass(/open/);
    await expect(pg.locator('#sfPhotoRemove')).toBeVisible();
    await expect(pg.locator('#sfPhotoCrop')).toBeVisible();

    const newName = `Clay Room Studio ${tag}`;
    const v = pg.locator('#view-storefront');
    await pg.fill('#sfName', newName);
    await pg.fill('#sfLoc', 'Khalifa City');
    await pg.selectOption('#sfEmirate', 'Abu Dhabi');
    await pg.fill('#sfBio', 'Speckled stoneware, thrown and glazed by hand in Abu Dhabi.');
    await expect(pg.locator('#pvName')).toHaveText(newName);
    await expect(pg.locator('#pvLoc')).toHaveText('Khalifa City, Abu Dhabi');
    await pg.fill('#sfPickup', 'Unit 3');
    await v.getByRole('button', { name: 'Save changes' }).click();
    await expect(toast).toHaveText('Enter the full pickup address — building, street and area');
    await pg.fill('#sfPickup', 'Warehouse 7, Street 21, Mussafah Industrial');
    await pg.fill('#sfPickupTel', '12345');
    await v.getByRole('button', { name: 'Save changes' }).click();
    await expect(toast).toHaveText('Enter a UAE mobile number the courier can call');
    await pg.fill('#sfPickupTel', '050 222 3344');
    await v.getByRole('button', { name: 'Save changes' }).click();
    await expect(toast).toHaveText('Storefront saved');
    await expect(pg.locator('#sideShop')).toHaveText(newName);

    const me = (await call(pg, 'GET', '/api/seller/me')).data.shop;
    expect(me.name).toBe(newName);
    expect(me.location).toBe('Khalifa City, Abu Dhabi');
    expect(me.pickup_address).toBe('Warehouse 7, Street 21, Mussafah Industrial');
    expect(me.pickup_phone).toBe('+971502223344');
    expect(me.image).toMatch(/^\/uploads\/shops\//);
    expect((await pg.request.get(me.image)).status()).toBe(200);
    A.shopName = newName;

    // Reloaded, the form reads back what was saved.
    await gotoSell(pg);
    await sellerTab(pg, 'storefront', 'Storefront');
    await expect(pg.locator('#sfLoc')).toHaveValue('Khalifa City');
    await expect(pg.locator('#sfEmirate')).toHaveValue('Abu Dhabi');
    await expect(pg.locator('#sfPickupTel')).toHaveValue('+971502223344');

    // The public shop shows the new face, never the courier-only fields.
    const pub = await api(testInfo);
    const shop = await pub.call('GET', `/api/shops/${A.shop.slug}`);
    expect(shop.data.shop.name).toBe(newName);
    expect(shop.data.shop.location).toBe('Khalifa City, Abu Dhabi');
    expect(shop.data.shop.image).toBe(me.image);
    expect(JSON.stringify(shop.data)).not.toContain('Mussafah');
    expect(JSON.stringify(shop.data)).not.toContain('502223344');
    await pub.dispose();
    await maker.close();
  });

  test('maker records an e-Trader licence; admin verifies it from the licensed-sellers queue', async ({ browser }, testInfo) => {
    const maker = await newActor(browser, testInfo, { account: A });
    const pg = maker.page;
    await gotoSell(pg);
    await sellerTab(pg, 'payments', 'Payments');
    const lic = pg.locator('#view-payments .card').filter({ hasText: 'Trade licence' });
    await expect(lic).toContainText('optional');
    await pg.fill('#licNoInput', '12');
    await lic.getByRole('button', { name: 'Save licence' }).click();
    await expect(pg.locator('#licErr')).toHaveText('Enter your license number as it appears on the document');
    await pg.fill('#licNoInput', 'ET-2026-4410');
    await lic.getByRole('button', { name: 'Save licence' }).click();
    await expect(pg.locator('#toast')).toHaveText('Licence saved — Trove will check it shortly');
    await expect(lic).toContainText('ET-2026-4410');
    await expect(lic).toContainText('Awaiting Trove’s check');

    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    const apg = admin.page;
    await apg.goto('/admin');
    await adminTab(apg, 'payouts', 'Trove payouts');
    const gRow = apg.locator('#payoutsWrap tr').filter({ hasText: A.shopName });
    await expect(gRow).toContainText('ET-2026-4410');
    await gRow.getByRole('button', { name: 'Verify license' }).click();
    await expect(apg.locator('#toast')).toHaveText('License verified');
    await expect(gRow.locator('.pill', { hasText: 'license verified' })).toBeVisible();
    await admin.close();

    await gotoSell(pg);
    await sellerTab(pg, 'payments', 'Payments');
    await expect(pg.locator('#view-payments .card').filter({ hasText: 'Trade licence' })).toContainText('Verified by Trove ✓');
    await maker.close();
  });

  test('marketplace makers only get marketplace categories, and the drawer validates name, price and was-price', async ({ browser }, testInfo) => {
    const maker = await newActor(browser, testInfo, { account: A });
    const pg = maker.page;
    await gotoSell(pg);
    await sellerTab(pg, 'products', 'Products');
    await pg.locator('#topActions').getByRole('button', { name: 'Add product' }).click();
    await expect(pg.locator('#drawer')).toHaveClass(/open/);
    await expect(pg.locator('#dCat option')).toHaveText(MARKETPLACE_CATS);
    await expect(pg.locator('#dTagAI')).toBeHidden();   // no AI key in the e2e server → the tag writer hides

    const r = await call(pg, 'POST', '/api/seller/products', { name: 'Sneaky Plate', price: 50, category: 'Kitchen & Dining' });
    expect(r.status).toBe(422);
    expect(r.data.error).toContain('the Trove Marketplace');

    await pg.locator('#drawerSave').click();
    await expect(pg.locator('#dName').locator('xpath=ancestor::div[contains(@class,"field")]')).toHaveClass(/bad/);
    await expect(pg.locator('.field.bad .ferr').first()).toHaveText('Every piece needs a name.');
    await expect(pg.locator('.field.bad .ferr').nth(1)).toHaveText('Set a price above 0.');
    await pg.fill('#dName', 'Validation Cup');
    await pg.fill('#dPrice', '100');
    await pg.fill('#dCompare', '80');
    await pg.locator('#drawerSave').click();
    await expect(pg.locator('.field.bad .ferr')).toHaveText(['A was-price only works above your price — or leave it empty.']);

    // Closing with typed work asks first.
    await pg.locator('#drawer .dmain').getByRole('button', { name: 'Cancel' }).click();
    await expect(pg.locator('#dFoot')).toHaveClass(/confirming/);
    await pg.locator('#dFoot .dconfirm').getByRole('button', { name: 'Discard' }).click();
    await expect(pg.locator('#drawer')).not.toHaveClass(/open/);
    expect((await call(pg, 'GET', '/api/seller/products')).data.products.map((p) => p.name)).not.toContain('Validation Cup');
    await maker.close();
  });

  test('maker lists a live piece: 4 photos, Colour × Size grid with its own stock and price, a paid extra, tags, a was-price', async ({ browser }, testInfo) => {
    const maker = await newActor(browser, testInfo, { account: A });
    const pg = maker.page;
    await gotoSell(pg);
    await sellerTab(pg, 'products', 'Products');
    await pg.locator('#topActions').getByRole('button', { name: 'Add product' }).click();

    await pg.fill('#dName', VASE);
    await pg.fill('#dDesc', 'Wheel-thrown speckled stoneware, satin glaze inside, 22 cm tall.');
    await pg.selectOption('#dCat', 'Ceramics');

    // Photos: three in, one out, topped up to the limit of four.
    const thumbs = pg.locator('#dPhotos .ph');
    await pg.setInputFiles('#dPhotoFile', [pngFile('v1.png'), pngFile('v2.png'), pngFile('v3.png')]);
    await expect(thumbs).toHaveCount(3);
    await expect(thumbs.first().locator('.cover')).toHaveText('COVER');
    await thumbs.nth(1).getByRole('button', { name: '×' }).click();
    await expect(thumbs).toHaveCount(2);
    await pg.setInputFiles('#dPhotoFile', [pngFile('v4.png'), pngFile('v5.png'), pngFile('v6.png')]);
    await expect(thumbs).toHaveCount(4);
    await expect(pg.locator('#dPhotos .addph')).toHaveCount(0);

    // Tags: typed and entered; one removed again.
    const tagIn = pg.locator('#dTagIn');
    for (const t of ['stoneware', 'vase', 'gift idea']) { await tagIn.fill(t); await tagIn.press('Enter'); }
    await expect(pg.locator('#dTagBox .tg')).toHaveCount(3);
    await pg.locator('#dTagBox .tg', { hasText: 'gift idea' }).getByRole('button').click();
    await expect(pg.locator('#dTagBox .tg')).toHaveCount(2);

    // Price + was-price; the live preview and the purchase-price line follow.
    await pg.fill('#dPrice', '150');
    await pg.fill('#dCompare', '180');
    await expect(pg.locator('#dpvSale')).toHaveClass(/show/);
    await expect(pg.locator('#dFeePct')).toHaveText('40');
    await expect(pg.locator('#dFeeKeep')).toHaveText('90');

    // Buyer choices: Colour × Size → four combinations, each with its own stock.
    const groups = pg.locator('#dOptions .optg');
    const addValues = async (gi, values) => {
      for (const v of values) {
        const inp = groups.nth(gi).locator('.tagbox input');
        await inp.fill(v);
        await inp.press('Enter');
      }
    };
    await pg.locator('#dOptAdd').click();
    await groups.nth(0).locator('.optg-top input').fill('Colour');
    await addValues(0, ['Sand', 'Ink']);
    await expect(pg.locator('#dOptAdd')).toHaveText('+ Add another choice');
    await pg.locator('#dOptAdd').click();
    await groups.nth(1).locator('.optg-top input').fill('Size');
    await addValues(1, ['Small', 'Large']);
    const rows = pg.locator('#dVariants tbody tr');
    await expect(rows.locator('td.vc')).toHaveText(['Sand · SmallSOLD OUT', 'Sand · LargeSOLD OUT', 'Ink · SmallSOLD OUT', 'Ink · LargeSOLD OUT']);
    await expect(pg.locator('#dStockField')).toBeHidden();
    const row = (label) => rows.filter({ has: pg.locator('td.vc', { hasText: label }) });
    const setCell = async (label, col, value) => {
      const inp = row(label).locator('input').nth(col);
      await inp.fill(String(value));
      await inp.press('Tab');
    };
    await setCell('Sand · Small', 0, 3);
    await setCell('Sand · Large', 0, 2);
    await setCell('Sand · Large', 1, 190);
    await setCell('Ink · Small', 0, 1);
    await expect(row('Ink · Large')).toHaveClass(/out/);
    await expect(row('Sand · Small')).not.toHaveClass(/out/);
    await expect(pg.locator('#dVariants .vtot')).toHaveText('Total stock6');

    // A paid extra.
    await pg.locator('#dExtraAdd').click();
    const ex = pg.locator('#dExtras .exrow').first();
    await ex.locator('.exname').fill('Gift wrap');
    await ex.locator('.exname').press('Tab');
    await ex.locator('input[type="number"]').fill('15');
    await ex.locator('input[type="number"]').press('Tab');

    await expect(pg.locator('#dStatusSeg button.on')).toHaveText('Live');
    await pg.locator('#drawerSave').click();
    await expect(pg.locator('#toast')).toHaveText('Added — it\'s live in your shop');
    await expect(pg.locator('#drawer')).not.toHaveClass(/open/);

    const tr = pg.locator('#prodTable tbody tr').filter({ hasText: VASE });
    await expect(tr).toContainText('6 across 4 choices');
    await expect(tr.locator('.price-edit s')).toHaveText('AED 180');
    await expect(tr.locator('.price-edit')).toContainText('AED 150');
    await expect(tr.locator('.pill-st')).toHaveText('live');

    const saved = (await call(pg, 'GET', '/api/seller/products')).data.products.find((p) => p.name === VASE);
    expect(saved.status).toBe('live');
    expect(saved.category).toBe('Ceramics');
    expect([saved.price_cents, saved.compare_at_cents, saved.stock]).toEqual([15000, 18000, 6]);
    expect(JSON.parse(saved.images)).toHaveLength(4);
    JSON.parse(saved.images).forEach((u) => expect(u).toMatch(/^\/uploads\/products\//));
    expect(JSON.parse(saved.tags)).toEqual(['stoneware', 'vase']);
    expect(JSON.parse(saved.options)).toEqual([{ name: 'Colour', values: ['Sand', 'Ink'] }, { name: 'Size', values: ['Small', 'Large'] }]);
    expect(JSON.parse(saved.variants).map((v) => [v.key, v.stock, v.priceCents])).toEqual([
      ['Colour:Sand|Size:Small', 3, null], ['Colour:Sand|Size:Large', 2, 19000],
      ['Colour:Ink|Size:Small', 1, null], ['Colour:Ink|Size:Large', 0, null]]);
    expect(JSON.parse(saved.extras)).toEqual([{ name: 'Gift wrap', priceCents: 1500 }]);
    A.vaseId = saved.id;
    await maker.close();
  });

  test('a draft stays private; the live piece shows on the shop page, in search and under its category', async ({ browser }, testInfo) => {
    const maker = await newActor(browser, testInfo, { account: A });
    const pg = maker.page;
    await gotoSell(pg);
    await sellerTab(pg, 'products', 'Products');
    await pg.locator('#topActions').getByRole('button', { name: 'Add product' }).click();
    await pg.fill('#dName', JUG);
    await pg.fill('#dPrice', '70');
    await pg.fill('#dStock', '3');
    await pg.selectOption('#dCat', 'Ceramics');
    await pg.locator('#dStatusSeg').getByRole('button', { name: 'Draft' }).click();
    await expect(pg.locator('#dStatusHint')).toHaveText('Only you can see it — finish it and go live whenever you like.');
    await pg.locator('#drawerSave').click();
    await expect(pg.locator('#toast')).toHaveText('Saved as a draft — go live whenever you like');
    await expect(pg.locator('#prodTable tbody tr').filter({ hasText: JUG }).locator('.pill-st')).toHaveText('draft');
    await maker.close();

    const shopper = await newActor(browser, testInfo);
    const sp = shopper.page;
    // Shop page
    await gotoStore(sp, `/?shop=${A.shop.slug}`);
    await expect(sp.locator('#view-vendor')).toHaveClass(/active/);
    await expect(sp.locator('#vName')).toHaveText(A.shopName);
    await expect(sp.locator('#vLoc')).toHaveText('Khalifa City, Abu Dhabi');
    await expect(sp.locator('#vendorProducts .card h3')).toHaveText([VASE, `Waiting Bowl ${tag}`]);
    await expect(sp.locator('#vendorProducts .card', { hasText: VASE }).locator('.sale')).toHaveText('Sale');
    // Search (the maker's unique tag is in the name and the shop name)
    await sp.fill('#searchInput', `vase ${tag}`);
    await sp.press('#searchInput', 'Enter');
    await expect(sp.locator('#browseTitle')).toHaveText(`“vase ${tag}”`);
    await expect(sp.locator('#shopGrid .card h3')).toHaveText([VASE]);
    // Category filter
    await sp.locator('header nav.links').getByRole('link', { name: 'Shop all' }).click();
    await sp.locator('#catFilters label', { hasText: /^\s*Ceramics/ }).click();
    await expect(sp.locator('#browseTitle')).toHaveText('Ceramics');
    await expect(sp.locator('#shopGrid .card h3', { hasText: VASE })).toHaveCount(1);
    await expect(sp.locator('#shopGrid .card h3', { hasText: JUG })).toHaveCount(0);
    // The piece page
    await sp.locator('#shopGrid .card', { hasText: VASE }).click();
    await expect(sp.locator('#pdpName')).toHaveText(VASE);
    await expect(sp.locator('#pdpPrice')).toHaveText('AED 180AED 150');
    await expect(sp.locator('#pdpOptions .optgroup .lbl')).toHaveText(['Colour', 'Size']);
    await expect(sp.locator('#pdpThumbs .t')).toHaveCount(4);
    await expect(sp.locator('#pdpSoldName')).toHaveText(A.shopName);

    const pub = (await call(sp, 'GET', `/api/products?shop=${A.shop.slug}`)).data.products.map((p) => p.name);
    expect(pub).toContain(VASE);
    expect(pub).not.toContain(JUG);
    await shopper.close();
  });

  test('maker edits a piece and deletes the draft', async ({ browser }, testInfo) => {
    const maker = await newActor(browser, testInfo, { account: A });
    const pg = maker.page;
    await gotoSell(pg);
    await sellerTab(pg, 'products', 'Products');
    const vaseRow = pg.locator('#prodTable tbody tr').filter({ hasText: VASE });
    await vaseRow.getByRole('button', { name: 'Edit' }).click();
    await expect(pg.locator('#drawerTitle')).toHaveText('Edit product');
    await expect(pg.locator('#dName')).toHaveValue(VASE);
    await expect(pg.locator('#dPhotos .ph')).toHaveCount(4);
    await expect(pg.locator('#dVariants tbody tr')).toHaveCount(4);
    await pg.fill('#dPrice', '140');
    await pg.locator('#drawerSave').click();
    await expect(pg.locator('#toast')).toHaveText('Changes saved');
    await expect(vaseRow.locator('.price-edit')).toContainText('AED 140');
    const after = (await call(pg, 'GET', '/api/seller/products')).data.products.find((p) => p.name === VASE);
    expect(after.price_cents).toBe(14000);
    expect(JSON.parse(after.images)).toHaveLength(4);             // kept photos survive the edit
    expect(JSON.parse(after.variants).find((v) => v.key === 'Colour:Sand|Size:Large').priceCents).toBe(19000);

    const jugRow = pg.locator('#prodTable tbody tr').filter({ hasText: JUG });
    await jugRow.getByRole('button', { name: 'Delete' }).click();
    await expect(pg.locator('#toast')).toHaveText('Product deleted');
    await expect(jugRow).toHaveCount(0);
    expect((await call(pg, 'GET', '/api/seller/products')).data.products.map((p) => p.name)).not.toContain(JUG);
    await maker.close();
  });

  test('admin "shop view" opens the maker\'s dashboard, locks admin APIs, and returns to admin', async ({ browser }, testInfo) => {
    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    const pg = admin.page;
    await pg.goto('/admin');
    await adminTab(pg, 'shops', 'Shops');
    await pg.locator('#shopsTable tbody tr').filter({ hasText: A.shopName }).getByRole('button', { name: /Shop view/ }).click();
    await expect(pg).toHaveURL(/\/sell$/);
    await expect(pg.locator('#impBar')).toHaveClass(/\bon\b/);
    await expect(pg.locator('#impShopName')).toHaveText(A.shopName);
    await expect(pg.locator('#sideShop')).toHaveText(A.shopName);
    expect((await call(pg, 'GET', '/api/admin/stats')).status).toBe(403);
    await expect(pg.locator('#pageSub')).not.toHaveText('Welcome back');
    await sellerTab(pg, 'products', 'Products');
    await expect(pg.locator('#prodTable')).toContainText(VASE);

    await pg.locator('#impBar').getByRole('button', { name: 'Return to admin' }).click();
    await expect(pg).toHaveURL(/\/admin$/);
    await expect(pg.locator('#whoName')).toHaveText('E2E Admin');
    expect((await call(pg, 'GET', '/api/admin/stats')).status).toBe(200);
    await admin.close();
  });

  test('a piece the admin hid stays hidden when its maker edits it', async ({ browser }, testInfo) => {
    test.fail(true, 'BUG: editing a hidden piece republishes it — openEdit() maps hidden→Live and PATCH /api/seller/products accepts any status, undoing admin moderation');
    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    const maker = await newActor(browser, testInfo, { account: A });
    try {
      await admin.page.goto('/admin');
      await adminTab(admin.page, 'products', 'Products');
      await admin.page.fill('#prodFilter', VASE);
      const row = admin.page.locator('#productsTable tbody tr').filter({ hasText: VASE });
      await row.getByRole('button', { name: 'Hide' }).click();
      await expect(admin.page.locator('#toast')).toHaveText('Product hidden');
      await expect(row.locator('.pill')).toHaveText('hidden');
      expect((await call(maker.page, 'GET', `/api/products/${A.vaseId}`)).status).toBe(404);

      await gotoSell(maker.page);
      await sellerTab(maker.page, 'products', 'Products');
      const tr = maker.page.locator('#prodTable tbody tr').filter({ hasText: VASE });
      await expect(tr.locator('.pill-st')).toHaveText('hidden');
      await tr.getByRole('button', { name: 'Edit' }).click();
      await maker.page.fill('#dPrice', '145');
      await maker.page.locator('#drawerSave').click();
      await expect(maker.page.locator('#toast')).toHaveText('Changes saved');
      await expect(tr.locator('.pill-st')).toHaveText('hidden', { timeout: 3000 });
      expect((await call(maker.page, 'GET', `/api/products/${A.vaseId}`)).status).toBe(404);
    } finally { await admin.context.close(); await maker.context.close(); }
  });
});
