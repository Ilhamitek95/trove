'use strict';
/**
 * 02 · Shopping & checkout.
 *
 * A dedicated approved shop (set up through the API — spec 01 covers doing
 * that in the UI) stocks six pieces that exercise every storefront rule:
 * a plain cup, a bowl at exactly AED 200, a Colour × Size throw with a
 * per-variant price, a sold-out combination and paid extras, a last-one
 * candle on sale, a sold-out vase and a dish that gets delisted mid-basket.
 */
const { test, expect, ACCOUNTS, uid, call, apiLogin } = require('./fixtures');
const { api, makeMaker, setShopStatus, addProduct, makeBuyer, buyNow, gotoStore, gotoAccount } = require('./helpers-market');

const tag = uid();
const M = {};
const P = {};

/** The cart drawer's line for a piece. */
const cartLine = (page, name) => page.locator('#cartBody .citem').filter({ has: page.locator('.n', { hasText: name }) });
const toast = (page) => page.locator('#toastMsg');

async function openCart(page) {
  await page.getByTitle('Cart').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
}
async function addFromPdp(page, product) {
  await gotoStore(page, `/?p=${product.id}`);
  await expect(page.locator('#pdpName')).toHaveText(product.name);
  await page.locator('#pdpAdd').click();
  await expect(toast(page)).toHaveText(`${product.name} added to your Trove`);
}
/** Type a guest's contact + delivery details into the checkout form. */
async function fillGuest(page, g) {
  await page.fill('#coEmail', g.email);
  await page.fill('#coPhone', g.phone);
  await page.fill('#coNewName', g.name);
  await page.fill('#coNewLine', g.line);
  await page.fill('#coNewCity', g.area);
  await page.selectOption('#coNewEmirate', g.emirate);
}

test.describe.serial('shopping & checkout', () => {
  test.beforeAll(async ({}, testInfo) => {
    Object.assign(M, await makeMaker(testInfo, { shopName: `Shelf Studio ${tag}` }));
    await setShopStatus(testInfo, M.shop.id, 'approved');
    P.cup = await addProduct(M, { name: `Plain Cup ${tag}`, price: 50, stock: 20, category: 'Ceramics', tags: ['cup', 'everyday'] });
    P.bowl = await addProduct(M, { name: `Big Bowl ${tag}`, price: 200, stock: 10, category: 'Home & Living' });
    P.throw = await addProduct(M, {
      name: `Grid Throw ${tag}`, price: 120, category: 'Home & Living',
      options: [{ name: 'Colour', values: ['Sand', 'Ink'] }, { name: 'Size', values: ['S', 'L'] }],
      variants: [
        { key: 'Colour:Sand|Size:S', stock: 2 }, { key: 'Colour:Sand|Size:L', stock: 1, priceCents: 26000 },
        { key: 'Colour:Ink|Size:S', stock: 0 }, { key: 'Colour:Ink|Size:L', stock: 3 }],
      extras: [{ name: 'Gift wrap', priceCents: 1500 }, { name: 'Note card', priceCents: 0 }],
    });
    P.candle = await addProduct(M, { name: `Last Candle ${tag}`, price: 40, compareAt: 60, stock: 1, category: 'Home & Living' });
    P.gone = await addProduct(M, { name: `Gone Vase ${tag}`, price: 80, stock: 0, category: 'Ceramics' });
    P.dish = await addProduct(M, { name: `Fleeting Dish ${tag}`, price: 30, stock: 5, category: 'Ceramics' });
  });
  test.afterAll(async () => { if (M.session) await M.session.dispose(); });

  test('home renders the hero shelf, the category mosaic, this week\'s finds and the makers', async ({ page }) => {
    await gotoStore(page, '/');
    await expect(page.locator('.promo')).toContainText('Free delivery on orders over AED 200');
    const hero = page.locator('#heroDeck .hc');
    await expect(hero.first()).toBeAttached();
    expect(await hero.count()).toBeGreaterThan(1);
    await expect(page.locator('#hsCount')).toHaveText(/^01 \/ \d\d$/);
    await page.getByRole('button', { name: 'Next piece' }).click();
    await expect(page.locator('#hsCount')).toHaveText(/^02 \/ \d\d$/);

    const tiles = page.locator('#catRail .cat');
    await expect(tiles.first()).toBeVisible();
    await expect(tiles.filter({ hasText: 'Ceramics' }).locator('.ct')).toHaveText(/^\d+ pieces?$/);
    await page.locator('#catTabs').getByRole('tab', { name: 'Trove Collection' }).click();
    await expect(page.locator('#catRail .cat .pillar').first()).toHaveText('Trove Collection');
    await expect(page.locator('#catRail .cat .pillar', { hasText: 'Trove Marketplace' })).toHaveCount(0);

    const finds = page.locator('#trendingGrid .card');
    expect(await finds.count()).toBeGreaterThan(0);
    expect(await finds.count()).toBeLessThanOrEqual(8);
    await expect(page.locator('#vendorGrid .vcard h3', { hasText: M.shop.name }).first()).toBeAttached();

    const first = (await finds.first().locator('h3').textContent()).trim();
    await finds.first().locator('h3').click();
    await expect(page.locator('#view-pdp')).toHaveClass(/active/);
    await expect(page.locator('#pdpName')).toHaveText(first);
  });

  test('browse: maker, category, on-sale and price filters, and sorting', async ({ page }) => {
    await gotoStore(page, '/?view=shop');
    await expect(page.locator('#view-shop')).toHaveClass(/active/);
    await expect(page.locator('#browseTitle')).toHaveText('Shop all');
    const names = () => page.locator('#shopGrid .card h3').allTextContents();
    const mine = [P.cup, P.bowl, P.throw, P.candle, P.gone, P.dish].map((p) => p.name);

    await expect(page.locator(`#fltShop option[value="${M.shop.slug}"]`)).toHaveText(`${M.shop.name} (6)`);
    await page.selectOption('#fltShop', M.shop.slug);
    await expect(page.locator('#resCount')).toHaveText('6');
    await expect(page.locator('#shopCount')).toHaveText('1');
    expect((await names()).sort()).toEqual([...mine].sort());

    await page.locator('#catFilters label', { hasText: /^\s*Ceramics/ }).click();
    await expect(page.locator('#browseTitle')).toHaveText('Ceramics');
    expect((await names()).sort()).toEqual([P.cup.name, P.gone.name, P.dish.name].sort());

    await page.check('#fltSale');
    await expect(page.locator('#shopGrid .noresult .big')).toHaveText('Nothing in Ceramics matches these filters');
    await page.locator('#shopGrid .noresult').getByRole('button', { name: 'Reset filters' }).click();
    await expect(page.locator('#fltSale')).not.toBeChecked();
    await expect(page.locator('#fltShop')).toHaveValue('all');

    await page.locator('#catFilters label', { hasText: 'All categories' }).click();
    await page.selectOption('#fltShop', M.shop.slug);
    await page.check('#fltSale');
    await expect(page.locator('#shopGrid .card h3')).toHaveText([P.candle.name]);
    await expect(page.locator('#shopGrid .card .sale')).toHaveText(['Sale']);
    await expect(page.locator('#shopGrid .card .price')).toHaveText(['AED 60AED 40']);
    await page.uncheck('#fltSale');

    await page.locator('label.fitem', { hasText: 'AED 200+' }).click();
    await expect(page.locator('#shopGrid .card h3')).toHaveText([P.bowl.name]);
    await page.locator('label.fitem', { hasText: 'Any price' }).click();

    await page.selectOption('#sortSel', 'low');
    await expect(page.locator('#shopGrid .card h3')).toHaveText([P.dish, P.candle, P.cup, P.gone, P.throw, P.bowl].map((p) => p.name));
    await page.selectOption('#sortSel', 'high');
    await expect(page.locator('#shopGrid .card h3')).toHaveText([P.bowl, P.throw, P.gone, P.cup, P.candle, P.dish].map((p) => p.name));

    // The house toggle and the maker dropdown are mutually exclusive.
    await page.check('#fltHouse');
    await expect(page.locator('#fltShop')).toHaveValue('all');
    await expect(page.locator('#shopGrid .card .vrow.is-house').first()).toBeVisible();
    await expect(page.locator('#shopGrid .card .vrow:not(.is-house)')).toHaveCount(0);
  });

  test('search: results for a term, then a no-result search offers popular searches', async ({ page }) => {
    await gotoStore(page, '/');
    const term = `plain cup ${tag}`;
    for (let i = 0; i < 2; i++) {   // searched twice so it ranks as "popular"
      const logged = page.waitForResponse((r) => r.url().endsWith('/api/search-log') && r.status() === 204);
      await page.fill('#searchInput', term);
      await page.press('#searchInput', 'Enter');
      await logged;
    }
    await expect(page.locator('#browseTitle')).toHaveText(`“${term}”`);
    await expect(page.locator('#searchChip')).toContainText(`Searching for “${term}”`);
    await expect(page.locator('#shopGrid .card h3')).toHaveText([P.cup.name]);

    await page.fill('#searchInput', 'zzqx nothing here');
    await page.press('#searchInput', 'Enter');
    await expect(page.locator('#shopGrid .noresult .big')).toHaveText('Nothing turned up for “zzqx nothing here”');
    await expect(page.locator('#popSearch .eyebrow')).toHaveText('Popular right now');
    const chip = page.locator('#popSearch .ptag', { hasText: term });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.locator('#browseTitle')).toHaveText(`“${term}”`);
    await expect(page.locator('#shopGrid .card h3')).toHaveText([P.cup.name]);
    await page.locator('#searchChip').getByRole('button', { name: 'Clear search' }).click();
    await expect(page.locator('#browseTitle')).toHaveText('Shop all');
  });

  test('PDP: nothing preselected, sold-out combinations struck through, price follows the variant and the extras', async ({ page }) => {
    await gotoStore(page, `/?p=${P.throw.id}`);
    await expect(page.locator('#pdpName')).toHaveText(P.throw.name);
    const chip = (g, v) => page.locator('#pdpOptions .optgroup').nth(g).locator('.optchip', { hasText: new RegExp(`^${v}$`) });
    await expect(page.locator('#pdpOptions .optgroup .lbl')).toHaveText(['Colour', 'Size']);
    await expect(page.locator('#pdpOptions .optchip.on')).toHaveCount(0);
    await expect(page.locator('#pdpOptions .optchip.gone')).toHaveCount(0);   // every value is still makeable somewhere
    await expect(page.locator('#pdpPrice')).toHaveText('AED 120');
    await expect(page.locator('#pdpExtras .optchip.on')).toHaveCount(0);

    await page.locator('#pdpAdd').click();
    await expect(toast(page)).toHaveText('Choose a colour before adding this to your Trove');

    await chip(0, 'Ink').click();
    await expect(chip(0, 'Ink')).toHaveClass(/\bon\b/);
    await expect(chip(1, 'S')).toHaveClass(/\bgone\b/);          // Ink · S has none left
    await expect(chip(1, 'L')).not.toHaveClass(/\bgone\b/);
    await expect(chip(1, 'S')).toHaveAttribute('aria-disabled', 'true');
    await chip(1, 'S').click({ force: true });   // aria-disabled, but still tappable
    await expect(toast(page)).toHaveText('S is sold out just now');
    await expect(chip(1, 'S')).not.toHaveClass(/\bon\b/);
    await page.locator('#pdpAdd').click();
    await expect(toast(page)).toHaveText('Choose a size before adding this to your Trove');

    await chip(0, 'Sand').click();
    await expect(chip(1, 'S')).not.toHaveClass(/\bgone\b/);
    await chip(1, 'L').click();
    await expect(page.locator('#pdpPrice')).toHaveText('AED 260');       // Sand · L carries its own price
    await expect(page.locator('#pdpStockNote')).toHaveText('Only 1 left of this one.');

    const extras = page.locator('#pdpExtras .optchip');
    await expect(extras).toHaveText(['Gift wrap +AED 15', 'Note card']);
    await extras.filter({ hasText: 'Gift wrap' }).click();
    await expect(extras.filter({ hasText: 'Gift wrap' })).toHaveText('✓ Gift wrap +AED 15');
    await expect(page.locator('#pdpPrice')).toHaveText('AED 275');
    await extras.filter({ hasText: 'Note card' }).click();                 // a free extra doesn't move the price
    await expect(page.locator('#pdpPrice')).toHaveText('AED 275');
    await extras.filter({ hasText: 'Note card' }).click();
    await extras.filter({ hasText: 'Gift wrap' }).click();
    await expect(page.locator('#pdpPrice')).toHaveText('AED 260');
    await extras.filter({ hasText: 'Gift wrap' }).click();

    await page.locator('#pdpAdd').click();
    await expect(toast(page)).toHaveText(`${P.throw.name} added to your Trove`);
    await expect(page.locator('#cartCount')).toHaveText('1');
    await openCart(page);
    const line = cartLine(page, P.throw.name);
    await expect(line).toContainText('Colour: Sand · Size: L');
    await expect(line).toContainText('Gift wrap +AED 15');
    await expect(line.locator('.cp')).toHaveText('AED 275');

    // A plain piece with no stock can't be added at all.
    await gotoStore(page, `/?p=${P.gone.id}`);
    await expect(page.locator('#pdpAdd')).toBeDisabled();
    await expect(page.locator('#pdpAdd')).toHaveText('Sold out');
    await expect(page.locator('#pdpStockNote')).toHaveText('This piece is sold out — the shop may make more.');
  });

  test('basket: quantity changes, removal, persistence across reload, a delisted piece is dropped with a toast', async ({ page }, testInfo) => {
    await gotoStore(page, '/');
    // Quick add straight from a product card.
    await page.fill('#searchInput', P.cup.name);
    await page.press('#searchInput', 'Enter');
    await page.locator('#shopGrid .card', { hasText: P.cup.name }).getByRole('button', { name: 'Add to cart' }).click();
    await expect(toast(page)).toHaveText(`${P.cup.name} added to your Trove`);
    await addFromPdp(page, P.dish);
    await addFromPdp(page, P.candle);
    await expect(page.locator('#cartCount')).toHaveText('3');

    await openCart(page);
    await expect(page.locator('#cartBody .citem')).toHaveCount(3);
    await expect(page.locator('#cartBody .vg-head')).toContainText(M.shop.name);
    const cup = cartLine(page, P.cup.name);
    await cup.getByRole('button', { name: '+' }).click();
    await expect(cup.locator('.qv')).toHaveText('2');
    await expect(cup.locator('.cp')).toHaveText('AED 100');
    await cup.getByRole('button', { name: '−' }).click();
    await expect(cup.locator('.qv')).toHaveText('1');
    await cartLine(page, P.candle.name).locator('.rm').click();
    await expect(page.locator('#cartBody .citem')).toHaveCount(2);
    await expect(page.locator('#cartCount')).toHaveText('2');

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('trove.cart.v1')));
    expect(saved.map((l) => [l.pid, l.qty]).sort()).toEqual([[P.cup.id, 1], [P.dish.id, 1]].sort());

    await page.reload();
    await expect(page.locator('#cartCount')).toHaveText('2');
    await openCart(page);
    await expect(page.locator('#cartBody .citem')).toHaveCount(2);

    // The maker takes the dish off sale; the basket drops it on the next visit.
    const r = await M.session.call('PATCH', `/api/seller/products/${P.dish.id}`, { status: 'draft' });
    expect(r.status).toBe(200);
    await page.reload();
    await expect(toast(page)).toHaveText('One piece from your basket is no longer available');
    await expect(page.locator('#cartCount')).toHaveText('1');
    await openCart(page);
    await expect(page.locator('#cartBody .citem')).toHaveCount(1);
    await expect(cartLine(page, P.cup.name)).toHaveCount(1);
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('trove.cart.v1')))).map((l) => l.pid)).toEqual([P.cup.id]);
  });

  test('money: AED 30 delivery at or below AED 200 (exactly 200 pays), free above, never a service fee', async ({ page }) => {
    await addFromPdp(page, P.bowl);
    await openCart(page);
    await expect(page.locator('#cartSubtotal')).toHaveText('AED 200');
    await expect(page.locator('#cartShip')).toHaveText('AED 30');
    await expect(page.locator('#cartTotal')).toHaveText('AED 230');
    await expect(page.locator('#cartFreeNote')).toHaveText('Free delivery kicks in on orders over AED 200.');

    await page.locator('#drawer').getByRole('button', { name: 'Checkout' }).click();
    await expect(page.locator('#view-checkout')).toHaveClass(/active/);
    await expect(page.locator('#coTotals .row')).toHaveText(['SubtotalAED 200', 'DeliveryAED 30', 'TotalAED 230']);
    await expect(page.locator('#coPlaceTot')).toHaveText('AED 230');
    await expect(page.locator('#coTotals')).not.toContainText('Service fee');

    await addFromPdp(page, P.cup);
    await openCart(page);
    await expect(page.locator('#cartSubtotal')).toHaveText('AED 250');
    await expect(page.locator('#cartShip')).toHaveText('Free');
    await expect(page.locator('#cartTotal')).toHaveText('AED 250');
    await expect(page.locator('#cartFreeNote')).toHaveText('You’ve unlocked free delivery.');
    await page.locator('#drawer').getByRole('button', { name: 'Checkout' }).click();
    await expect(page.locator('#coTotals .row')).toHaveText(['SubtotalAED 250', 'DeliveryFree', 'TotalAED 250']);

    await page.locator('.co-back').click();
    await cartLine(page, P.bowl.name).locator('.rm').click();
    await expect(page.locator('#cartSubtotal')).toHaveText('AED 50');
    await expect(page.locator('#cartShip')).toHaveText('AED 30');
    await expect(page.locator('#cartFreeNote')).toHaveText('Add AED 150 more for free delivery.');

    // The server's own rule, straight from /api/config.
    const cfg = (await call(page, 'GET', '/api/config')).data;
    expect([cfg.serviceFeeCents, cfg.deliveryFeeCents, cfg.freeDeliveryThresholdCents]).toEqual([0, 3000, 20000]);
  });

  test('guest checkout: contact, UAE mobile and Dubai/Abu Dhabi checks, demo payment, confirmation, then the account offer', async ({ page }, testInfo) => {
    const guest = { email: `gina-${tag}@e2e.test`, phone: '050 987 6543', name: 'Gina Guest', line: 'Villa 3, Street 9', area: 'Khalifa City', emirate: 'Abu Dhabi' };
    await addFromPdp(page, P.bowl);
    await openCart(page);
    await page.locator('#drawer').getByRole('button', { name: 'Checkout' }).click();
    await expect(page.locator('#coAcctBox')).toBeVisible();
    await expect(page.locator('#coAcctChk')).toBeChecked();
    await expect(page.locator('#coNewEmirate option')).toHaveText(['Dubai', 'Abu Dhabi']);
    await expect(page.locator('#payNote')).toContainText('Demo mode');
    const place = page.locator('.co-place');
    await expect(place).toHaveText('Place order · AED 230');

    await place.click();
    await expect(toast(page)).toHaveText('Enter your email so we can send your receipt');
    await page.fill('#coEmail', guest.email);
    await page.fill('#coPhone', '12345');
    await place.click();
    await expect(toast(page)).toHaveText('Add a UAE mobile so the driver can reach you');
    await page.fill('#coPhone', guest.phone);
    await place.click();
    await expect(toast(page)).toHaveText('Add your delivery name and address');
    await fillGuest(page, guest);
    await place.click();
    await expect(page.locator('#coAcctErr')).toHaveText('Choose a password to create your account — or pick “check out as a guest” below.');
    await page.locator('#coAcctGuestLink').getByText('check out as a guest').click();
    await expect(toast(page)).toHaveText('No problem — checking out as a guest');
    await expect(page.locator('#coAcctPassWrap')).toBeHidden();
    await place.click();

    await expect(page.locator('#view-confirm')).toHaveClass(/active/);
    await expect(page.locator('#confHead')).toHaveText('Thank you, Gina.');
    const orderId = (await page.locator('#confOrdId').textContent()).replace('Order ', '');
    expect(orderId).toMatch(/^TRV-[0-9A-F]{4}\d{2}$/);
    await expect(page.locator('#confShip')).toContainText('1 shipment · tracked together');
    await expect(page.locator('#confShip')).toContainText(M.shop.name);
    await expect(page.locator('#confShip')).toContainText('1 item · arrives 3–6 days');
    await expect(page.locator('#confTrack')).toBeHidden();
    await expect(page.locator('#confAcct')).toBeVisible();
    await expect(page.locator('#confAcctEmail')).toHaveValue(guest.email);
    await expect(page.locator('#cartCount')).toHaveClass(/hide/);

    // What the server charged is what the page showed.
    const admin = await api(testInfo, ACCOUNTS.admin);
    const order = (await admin.call('GET', '/api/admin/orders')).data.orders.find((o) => o.publicId === orderId);
    expect(order).toMatchObject({ email: guest.email, phone: '+971509876543', totalCents: 23000, status: 'paid', itemCount: 1 });

    // Outside the service area, or without a real UAE mobile, the server refuses.
    const bad = await api(testInfo);
    const base = { items: [{ productId: P.cup.id, qty: 1 }], email: `sharjah-${tag}@e2e.test`, phone: '0501112233' };
    let r = await bad.call('POST', '/api/checkout', { ...base, address: { name: 'S', line: 'Al Nahda 2', city: 'Al Nahda, Sharjah', emirate: 'Sharjah' } });
    expect([r.status, r.data.error]).toEqual([400, 'We currently deliver in Dubai and Abu Dhabi only']);
    r = await bad.call('POST', '/api/checkout', { ...base, phone: '12345', address: { name: 'S', line: 'Marina', city: 'Dubai' } });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('UAE mobile');
    await bad.dispose();

    // The post-purchase offer: an account that keeps this order.
    await page.fill('#confAcctPw', 'short');
    await page.getByRole('button', { name: 'Create my account' }).click();
    await expect(page.locator('#confAcctErr')).toHaveText('Your password needs at least 8 characters.');
    await page.fill('#confAcctPw', 'gina-pass-123');
    await page.getByRole('button', { name: 'Create my account' }).click();
    await expect(toast(page)).toHaveText('Account created — this order is attached to it');
    await expect(page.locator('#confAcct')).toBeHidden();
    await page.locator('#confTrack').click();
    await expect(page).toHaveURL(/\/account#orders$/);
    const card = page.locator('.order-card').filter({ hasText: orderId });
    await expect(card.locator('.v.tot')).toHaveText('AED 230');
    await expect(card).toContainText(P.bowl.name);
    const addr = (await call(page, 'GET', '/api/account/addresses')).data.addresses;
    expect(addr).toMatchObject([{ label: 'Home', name: 'Gina Guest', line: 'Villa 3, Street 9', city: 'Khalifa City, Abu Dhabi', is_default: 1 }]);
    await admin.dispose();
  });

  test('signed-in checkout with a saved address: /account shows items, options, extras and totals; variant stock drops', async ({ page }, testInfo) => {
    const buyer = await makeBuyer(testInfo, { name: `Omar Saved${tag}` });
    await apiLogin(page, buyer);
    await gotoAccount(page, 'addresses', buyer.email);
    await page.getByRole('button', { name: 'Add address' }).click();
    await page.fill('#aLabel', 'Home');
    await page.fill('#aLine', 'Apt 1502, Bloom Towers');
    await page.fill('#aCity', 'Jumeirah Village Circle');
    await page.selectOption('#aEmirate', 'Dubai');
    await page.fill('#aPhone', '055 123 4567');
    await page.locator('#drawerSave').click();
    await expect(page.locator('#toast')).toHaveText('Address added');
    await expect(page.locator('#addrList .addr-card')).toHaveCount(1);
    await expect(page.locator('#addrList .addr-card .badge')).toHaveText('Default');

    const before = {
      throw: (await call(page, 'GET', `/api/products/${P.throw.id}`)).data.product,
      cup: (await call(page, 'GET', `/api/products/${P.cup.id}`)).data.product,
    };
    const sandL = (p) => p.variants.find((v) => v.key === 'Colour:Sand|Size:L').stock;
    expect(sandL(before.throw)).toBe(1);

    await gotoStore(page, `/?p=${P.throw.id}`);
    await page.locator('#pdpOptions .optgroup').nth(0).locator('.optchip', { hasText: 'Sand' }).click();
    await page.locator('#pdpOptions .optgroup').nth(1).locator('.optchip', { hasText: /^L$/ }).click();
    await page.locator('#pdpExtras .optchip', { hasText: 'Gift wrap' }).click();
    await page.locator('#pdpAdd').click();
    await addFromPdp(page, P.cup);
    await openCart(page);
    await cartLine(page, P.cup.name).getByRole('button', { name: '+' }).click();
    await expect(page.locator('#cartTotal')).toHaveText('AED 375');
    await page.locator('#drawer').getByRole('button', { name: 'Checkout' }).click();

    await expect(page.locator('#coAcctBox')).toBeHidden();
    await expect(page.locator('#coEmail')).toHaveValue(buyer.email);
    await expect(page.locator('#coPhone')).toHaveValue('055 123 4567');
    await expect(page.locator('#coAddrSaved .saved-opt.on')).toContainText('Home');
    await expect(page.locator('#coAddrSaved .saved-opt.on')).toContainText('Apt 1502, Bloom Towers, Jumeirah Village Circle, Dubai');
    await expect(page.locator('#coTotals .row')).toHaveText(['SubtotalAED 375', 'DeliveryFree', 'TotalAED 375']);
    await expect(page.locator('#coSummary')).toContainText('Qty 1 · Colour: Sand · Size: L · Gift wrap +AED 15');
    await page.locator('.co-place').click();

    await expect(page.locator('#view-confirm')).toHaveClass(/active/);
    await expect(page.locator('#confHead')).toHaveText(`Thank you, ${buyer.name.split(' ')[0]}.`);
    await expect(page.locator('#confAcct')).toBeHidden();
    const orderId = (await page.locator('#confOrdId').textContent()).replace('Order ', '');
    await page.locator('#confTrack').click();
    await expect(page.locator('#pageTitle')).toHaveText('Your orders');
    const card = page.locator('.order-card').filter({ hasText: orderId });
    await expect(card.locator('.v.tot')).toHaveText('AED 375');
    await expect(card.locator('.opill').first()).toHaveText('Processing');
    const throwLine = card.locator('.oline').filter({ hasText: P.throw.name });
    await expect(throwLine).toContainText('Qty 1');
    await expect(throwLine).toContainText('Colour: Sand · Size: L');
    await expect(throwLine).toContainText('+ Gift wrap (+AED 15)');
    await expect(throwLine.locator('.pr')).toHaveText('AED 275');
    const cupLine = card.locator('.oline').filter({ hasText: P.cup.name });
    await expect(cupLine).toContainText('Qty 2');
    await expect(cupLine.locator('.pr')).toHaveText('AED 100');

    const o = (await call(page, 'GET', '/api/account/orders')).data.orders.find((x) => x.id === orderId);
    expect(o.total).toBe(375);
    const ti = o.items.find((i) => i.name === P.throw.name);
    expect([ti.price, ti.qty, ti.options, ti.extras]).toEqual([275, 1, [{ name: 'Colour', value: 'Sand' }, { name: 'Size', value: 'L' }], [{ name: 'Gift wrap', price: 15 }]]);

    const after = {
      throw: (await call(page, 'GET', `/api/products/${P.throw.id}`)).data.product,
      cup: (await call(page, 'GET', `/api/products/${P.cup.id}`)).data.product,
    };
    expect(sandL(after.throw)).toBe(0);
    expect(after.throw.stock).toBe(before.throw.stock - 1);
    expect(after.throw.variants.find((v) => v.key === 'Colour:Ink|Size:L').stock).toBe(3);   // other combinations untouched
    expect(after.cup.stock).toBe(before.cup.stock - 2);
    await buyer.session.dispose();
  });

  test('sold-out combinations and quantities above stock are refused, in the basket and at the till', async ({ page }, testInfo) => {
    // Sand · L sold its last one in the previous test.
    await gotoStore(page, `/?p=${P.throw.id}`);
    await page.locator('#pdpOptions .optgroup').nth(0).locator('.optchip', { hasText: 'Sand' }).click();
    const L = page.locator('#pdpOptions .optgroup').nth(1).locator('.optchip', { hasText: /^L$/ });
    await expect(L).toHaveClass(/\bgone\b/);
    await L.click({ force: true });
    await expect(toast(page)).toHaveText('L is sold out just now');

    // One candle left: the basket won't go to two, and nor will the server.
    await addFromPdp(page, P.candle);
    await openCart(page);
    const line = cartLine(page, P.candle.name);
    await line.getByRole('button', { name: '+' }).click();
    await expect(toast(page)).toHaveText('Only 1 left of this one');
    await expect(line.locator('.qv')).toHaveText('1');
    const over = await call(page, 'POST', '/api/checkout', { items: [{ productId: P.candle.id, qty: 2 }], email: `over-${tag}@e2e.test`, phone: '0501234567', address: { name: 'O', line: 'Marina Walk', city: 'Dubai' } });
    expect([over.status, over.data.error]).toEqual([409, `Only 1 left of ${P.candle.name}`]);

    // Someone else buys the last candle while it sits in this basket.
    const rival = await makeBuyer(testInfo);
    await buyNow(rival.session, [{ productId: P.candle.id, qty: 1 }]);
    await rival.session.dispose();
    await page.locator('#drawer').getByRole('button', { name: 'Checkout' }).click();
    await fillGuest(page, { email: `late-${tag}@e2e.test`, phone: '0521112233', name: 'Lara Late', line: 'Villa 1, Al Wasl Road', area: 'Jumeirah', emirate: 'Dubai' });
    await page.locator('#coAcctChk').uncheck();
    await page.locator('.co-place').click();
    await expect(toast(page)).toHaveText(`${P.candle.name} is out of stock`);
    await expect(page.locator('#view-checkout')).toHaveClass(/active/);

    // Back in the basket, the line now says why.
    await page.reload();
    await openCart(page);
    await expect(cartLine(page, P.candle.name)).toContainText('Sold out — remove to check out');
  });

  test('"Update password" in /account really changes the password', async ({ page }, testInfo) => {
    test.fail(true, 'BUG: /account → My details → Update password only shows a "Password updated" toast; nothing reaches the server');
    const buyer = await makeBuyer(testInfo);
    await apiLogin(page, buyer);
    await page.goto('/account?v=1#details');
    await expect(page.locator('#pageTitle')).toHaveText('My details');
    const card = page.locator('.form-card').filter({ hasText: 'Password' });
    await card.locator('input[type="password"]').fill('brand-new-pass-456');
    await card.getByRole('button', { name: 'Update password' }).click();
    await expect(page.locator('#toast')).toHaveText('Password updated');     // the page says it worked…
    const fresh = await api(testInfo);
    const r = await fresh.call('POST', '/api/auth/login', { email: buyer.email, password: 'brand-new-pass-456' });
    await fresh.dispose();
    await buyer.session.dispose();
    expect(r.status).toBe(200);                                             // …but the new password is refused
  });
});
