'use strict';
/**
 * 03 · Orders, fulfilment, returns, reviews, settlement, analytics.
 *
 * A dedicated maker (approved, payout setup done) and a buyer with three
 * orders placed through the API (spec 02 covers the checkout UI):
 *   O1  mug 40 + plate 50  = 90   → ≤ AED 200: AED 30 delivery, AED 30 return-collection fee
 *   O2  vase 150 + plate 50 + mug 40 = 240 → > AED 200: free delivery, free collection
 *   O3  jar 35 — never shipped (undelivered guards, full-order refund)
 * The seller, the buyer and the admin then drive everything else in the UI.
 *
 * Settlement: a credit is payable 7 days after delivery (config.js
 * RETURN_WINDOW_DAYS). The seeded Kiln & Clay credit is already past that,
 * so the admin's real "Run settlement" button is exercised on it. This
 * maker's own credit can only be settled through the API's runDate (a run
 * dated 8 days ahead) — see the last test for why that is itself a finding.
 */
const fs = require('fs');
const { test, expect, ACCOUNTS, uid, call, pngFile, mockDeliver } = require('./fixtures');
const { newActor, api, makeMaker, setShopStatus, addProduct, payoutSetup, makeBuyer, buyNow, shipmentFor,
  pngDataUrl, isoDay, sellerTab, adminTab, gotoSell, gotoAccount, gotoStore } = require('./helpers-market');

const tag = uid();
const M = {};
const B = {};
const P = {};
const O = {};
const KILN_IBAN = 'AE930330000010101010101';

const orderCard = (page, id) => page.locator('.order-card').filter({ hasText: id });

/** Buyer: open the return picker on an order, tick items, fill it in, send. */
async function requestReturn(page, orderId, itemNames, { reason = 'damaged', details = 'The glaze cracked in transit.' } = {}) {
  await orderCard(page, orderId).getByRole('button', { name: 'Request a return' }).click();
  await expect(page.locator('#retScrim')).toHaveClass(/open/);
  for (const n of itemNames) await page.locator('#rtItems .rti', { hasText: n }).locator('input').check();
  await page.selectOption('#rtReason', reason);
  await page.fill('#rtDetails', details);
  await page.setInputFiles('#rtFile', pngFile('return.png'));
  await expect(page.locator('#rtPhotos .ph')).toHaveCount(1);
  await page.locator('#rtSave').click();
  await expect(page.locator('#toast')).toHaveText('Return requested — we\'ll keep you posted by email');
  await expect(page.locator('#retScrim')).not.toHaveClass(/open/);
}

/** Admin: the return card for an order + item. */
const returnCard = (page, orderId, itemName) => page.locator('#returnsWrap > div').filter({ hasText: orderId }).filter({ hasText: itemName });

test.describe.serial('orders, returns, reviews, settlement', () => {
  test.beforeAll(async ({}, testInfo) => {
    Object.assign(M, await makeMaker(testInfo, { shopName: `Return Studio ${tag}` }));
    await setShopStatus(testInfo, M.shop.id, 'approved');
    await payoutSetup(M);
    const pick = await M.session.call('PATCH', '/api/seller/me', { pickupAddress: 'Studio 4, Street 18, Al Quoz 3, Dubai', pickupPhone: '052 765 4321' });
    expect(pick.status).toBe(200);
    P.mug = await addProduct(M, { name: `Return Mug ${tag}`, price: 40, stock: 20 });
    P.plate = await addProduct(M, { name: `Return Plate ${tag}`, price: 50, stock: 20 });
    P.vase = await addProduct(M, { name: `Return Vase ${tag}`, price: 150, stock: 20 });
    P.jar = await addProduct(M, { name: `Unshipped Jar ${tag}`, price: 35, stock: 20 });
    P.lamp = await addProduct(M, { name: `Analytics Lamp ${tag}`, price: 90, stock: 5 });

    Object.assign(B, await makeBuyer(testInfo, { name: `Nour Buyer${tag}` }));
    const addr = { name: B.name, line: 'Apt 801, Marina Heights', city: 'Dubai Marina, Dubai', emirate: 'Dubai', country: 'United Arab Emirates' };
    O.o1 = await buyNow(B.session, [{ productId: P.mug.id, qty: 1 }, { productId: P.plate.id, qty: 1 }], { address: addr, phone: '050 123 4567' });
    O.o2 = await buyNow(B.session, [{ productId: P.vase.id, qty: 1 }, { productId: P.plate.id, qty: 1 }, { productId: P.mug.id, qty: 1 }], { address: addr, phone: '050 123 4567' });
    O.o3 = await buyNow(B.session, [{ productId: P.jar.id, qty: 1 }], { address: addr, phone: '050 123 4567' });
  });
  test.afterAll(async () => {
    if (M.session) await M.session.dispose();
    if (B.session) await B.session.dispose();
  });

  test('seller works the order: no buyer email or phone anywhere, filters, courier hand-over and label, then delivery reaches the buyer', async ({ browser }, testInfo) => {
    const seller = await newActor(browser, testInfo, { account: M });
    const pg = seller.page;
    await gotoSell(pg);
    await expect(pg.locator('#orderPill')).toHaveText('3');
    await sellerTab(pg, 'orders', 'Orders');
    await expect(pg.locator('#orderList .ochip')).toHaveText(['All3', 'Needs action3', 'In transit0', 'Delivered0']);

    const card = pg.locator('.ship-card').filter({ hasText: O.o1 });
    await expect(card.locator('.sc-info').first()).toContainText(B.name);
    await expect(card.locator('.sc-info').first()).toContainText('Trove handles customer contact');
    await expect(card.locator('.sc-info').nth(1)).toContainText('Apt 801, Marina Heights');
    await expect(card.locator('.sc-li .nm')).toHaveText([P.mug.name, P.plate.name]);
    await expect(card.locator('.sc-earn .e')).toHaveText(['List price totalAED 90', 'Trove margin (40%)−AED 36', 'Your purchase priceAED 54']);

    // Privacy: the shop never gets the buyer's email or phone, on the page or in the API.
    const body = await pg.locator('body').innerText();
    expect(body).not.toContain(B.email);
    expect(body).not.toMatch(/50\s?123\s?4567|501234567/);
    const raw = JSON.stringify((await call(pg, 'GET', '/api/seller/orders')).data);
    expect(raw).not.toContain(B.email);
    expect(raw).not.toContain('501234567');
    expect(raw).not.toContain('"phone"');

    // Courier booking + label link (the mock courier has no label yet → a friendly page).
    const sh = await shipmentFor(M, O.o1);
    await expect(card).toContainText(`Courier booking ${sh.deliveryRef}`);
    await expect(card).toContainText('collected once you mark it packed');
    const label = card.getByRole('link', { name: 'Print label' });
    await expect(label).toHaveAttribute('href', `/api/seller/shipments/${sh.id}/label`);
    const [labelTab] = await Promise.all([seller.context.waitForEvent('page'), label.click()]);
    await expect(labelTab.getByRole('heading', { name: 'Your label is on its way' })).toBeVisible();
    await labelTab.close();

    await card.getByRole('button', { name: 'Packed · ready for collection' }).click();
    await expect(pg.locator('#toast')).toHaveText('Order updated');
    await expect(card.locator('.order-pill')).toHaveText('Shipped');
    await expect.poll(async () => (await shipmentFor(M, O.o1)).readyAt).toBeTruthy();
    await expect(pg.locator('#orderList .ochip')).toHaveText(['All3', 'Needs action2', 'In transit1', 'Delivered0']);
    await pg.locator('#orderList .ochip', { hasText: 'Needs action' }).click();
    await expect(pg.locator('#orderList')).not.toContainText(O.o1);
    await expect(pg.locator('#orderList')).toContainText(O.o3);
    await pg.locator('#orderList .ochip', { hasText: 'In transit' }).click();
    await expect(pg.locator('#orderList .ship-card, #orderList .ship-row')).toHaveCount(1);
    await expect(pg.locator('#orderList')).toContainText(O.o1);

    // The courier confirms delivery (mock hand-crank).
    const d = await mockDeliver(pg, { shipmentId: sh.id });
    expect(d.status).toBe(200);
    await gotoSell(pg);
    await sellerTab(pg, 'orders', 'Orders');
    await pg.locator('#orderList .ochip', { hasText: 'Delivered' }).click();
    await pg.locator('.ship-row').filter({ hasText: O.o1 }).click();   // delivered parcels load collapsed
    const done = pg.locator('.ship-card').filter({ hasText: O.o1 });
    await expect(done.locator('.sc-done')).toContainText('✓ Delivered');
    await expect(done.locator('.sc-step.done')).toHaveCount(4);
    await expect(done.locator('.sc-tl li')).toHaveCount(4);
    await expect(done.locator('.sc-tl li').first()).toContainText('Delivered (confirmed by courier)');
    await expect(done.locator('.sc-tl')).toContainText(`Ready for collection · Quiqup ${sh.deliveryRef}`);
    await expect(done.locator('.sc-tl')).toContainText('Order received — preparing your items');
    await seller.close();

    const buyer = await newActor(browser, testInfo, { account: B });
    await gotoAccount(buyer.page, 'orders', B.email);
    const o1 = orderCard(buyer.page, O.o1);
    await expect(o1.locator('.oc-head .opill')).toHaveText('Delivered');
    await expect(o1.locator('.pstep.done')).toHaveCount(4);
    await expect(o1.locator('.ship-note').first()).toContainText('Delivered (confirmed by courier)');
    await expect(o1.locator('.oc-foot')).toContainText(/Returns open until \d{1,2} \w{3,4} \d{4}/);
    await expect(orderCard(buyer.page, O.o3).locator('.oc-head .opill')).toHaveText('Processing');
    await expect(orderCard(buyer.page, O.o3).getByRole('button', { name: 'Request a return' })).toHaveCount(0);
    await buyer.close();
  });

  test('buyer asks to return single items with a photo; undelivered orders and double requests are refused; a pending request can be withdrawn', async ({ browser }, testInfo) => {
    // Not before delivery.
    let r = await B.session.call('POST', `/api/account/orders/${O.o3}/return-request`, { itemIds: [1], reason: 'damaged', details: 'Never arrived at all', images: [pngDataUrl()] });
    expect([r.status, r.data.error]).toEqual([409, 'Returns open once the order has been delivered']);

    const buyer = await newActor(browser, testInfo, { account: B });
    const pg = buyer.page;
    const t = pg.locator('#toast');
    await gotoAccount(pg, 'orders', B.email);
    await orderCard(pg, O.o1).getByRole('button', { name: 'Request a return' }).click();
    await expect(pg.locator('#rtSub')).toHaveText(`Order ${O.o1} — only what you tick goes back`);
    await expect(pg.locator('#rtItems .rti input:checked')).toHaveCount(0);      // two candidates → nothing pre-ticked
    await expect(pg.locator('#rtMoney')).toHaveText('Tick at least one item above — your refund figure appears here.');
    await pg.locator('#rtItems .rti', { hasText: P.mug.name }).locator('input').check();
    await expect(pg.locator('#rtMoney')).toContainText('You\'ll get AED 10 back to your card.');
    await expect(pg.locator('#rtMoney')).toContainText('Collection costs AED 30 on orders of AED 200 and below');
    await pg.locator('#rtSave').click();
    await expect(t).toHaveText('Pick a reason for the return');
    await pg.selectOption('#rtReason', 'damaged');
    await pg.fill('#rtDetails', 'bad');
    await pg.locator('#rtSave').click();
    await expect(t).toHaveText('Tell us a little about what went wrong');
    await pg.fill('#rtDetails', 'The glaze cracked in transit.');
    await pg.locator('#rtSave').click();
    await expect(t).toHaveText('Add at least one photo of the item');
    await pg.setInputFiles('#rtFile', pngFile('crack.png'));
    await expect(pg.locator('#rtPhotos .ph')).toHaveCount(1);
    await pg.locator('#rtSave').click();
    await expect(t).toHaveText('Return requested — we\'ll keep you posted by email');
    const foot = orderCard(pg, O.o1).locator('.oc-foot');
    await expect(foot).toContainText(`Return requested for ${P.mug.name} on`);

    // The same item can't go into a second request.
    const itemIds = (await call(pg, 'GET', '/api/account/orders')).data.orders.find((o) => o.id === O.o1).returns.items;
    const mugItem = itemIds.find((i) => i.name === P.mug.name);
    expect(mugItem.locked).toBe('requested');
    r = await B.session.call('POST', `/api/account/orders/${O.o1}/return-request`, { itemIds: [mugItem.id], reason: 'damaged', details: 'Asking again for it', images: [pngDataUrl()] });
    expect([r.status, r.data.error]).toEqual([409, 'One of those items is already part of another return request']);
    await orderCard(pg, O.o1).getByRole('button', { name: 'Request a return' }).click();
    await expect(pg.locator('#rtItems .rti.off', { hasText: P.mug.name })).toContainText('already requested');
    await expect(pg.locator('#rtItems .rti', { hasText: P.plate.name }).locator('input')).toBeChecked();   // the only one left
    await pg.locator('#retScrim').getByRole('button', { name: 'Cancel' }).click();

    // Withdraw it while it's undecided.
    await foot.getByRole('button', { name: 'Withdraw' }).click();
    await expect(t).toHaveText('Request withdrawn');
    await expect(foot).not.toContainText('Return requested');
    expect((await call(pg, 'GET', '/api/account/orders')).data.orders.find((o) => o.id === O.o1).returns.requests).toEqual([]);

    // The two requests the rest of the journey decides on.
    await requestReturn(pg, O.o1, [P.mug.name], { reason: 'damaged', details: 'The glaze cracked in transit.' });
    await requestReturn(pg, O.o1, [P.plate.name], { reason: 'changed-mind', details: 'It is smaller than I pictured.' });
    await expect(foot).toContainText(`Return requested for ${P.mug.name}`);
    await expect(foot).toContainText(`Return requested for ${P.plate.name}`);
    await buyer.close();
  });

  test('seller follows both requests in the Returns tab, read-only, with what each would do to the payout', async ({ browser }, testInfo) => {
    const seller = await newActor(browser, testInfo, { account: M });
    const pg = seller.page;
    await gotoSell(pg);
    await expect(pg.locator('#returnPill')).toHaveText('2');
    await sellerTab(pg, 'returns', 'Returns');
    const cards = pg.locator('#returnList > .card');
    await expect(cards).toHaveCount(2);
    const mug = cards.filter({ hasText: P.mug.name });
    await expect(mug.locator('.order-pill')).toHaveText('awaiting Trove');
    await expect(mug).toContainText(O.o1);
    await expect(mug).toContainText('Qty 1 · AED 40 each');
    await expect(mug).toContainText('Arrived damaged — The glaze cracked in transit.');
    await expect(mug.locator('.rr-ph img')).toHaveCount(1);
    await expect(mug.locator('.rr-note')).toContainText('If it\'s approved, AED 24 of the sale\'s credit reverses');
    await expect(cards.filter({ hasText: P.plate.name }).locator('.rr-note')).toContainText('AED 30 of the sale\'s credit reverses');
    await expect(pg.locator('#returnList button')).toHaveCount(0);   // buyers request, Trove decides

    await sellerTab(pg, 'orders', 'Orders');
    await pg.locator('#orderList .ochip', { hasText: 'Delivered' }).click();
    await pg.locator('.ship-row').filter({ hasText: O.o1 }).click();
    await expect(pg.locator('.ship-row').filter({ hasText: O.o1 })).toHaveCount(0);
    await expect(pg.locator('.ship-card').filter({ hasText: O.o1 }).locator('.sc-return')).toContainText('Return requested by the buyer');
    await seller.close();
  });

  test('admin approves one request and declines the other; at or below AED 200 the refund is items − AED 30', async ({ browser }, testInfo) => {
    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    const pg = admin.page;
    await pg.goto('/admin');
    await adminTab(pg, 'returns', 'Returns');
    const mug = returnCard(pg, O.o1, P.mug.name);
    await expect(mug).toContainText(`${B.name} · ${B.email}`);     // Trove (not the shop) sees the buyer
    await expect(mug).toContainText('Arrived damaged — The glaze cracked in transit.');
    await expect(mug).toContainText('(1 of 2 items on the order)');
    await expect(mug).toContainText('Returning AED 40 of the order\'s AED 90 · would refund AED 10 (AED 30 collection fee deducted)');
    await mug.getByRole('button', { name: 'Approve · refund AED 10' }).click();
    await expect(pg.locator('#toast')).toHaveText('Return approved — refund issued');
    await expect(mug.locator('.pill')).toHaveText('approved');
    await expect(mug).toContainText('refunded AED 10 (AED 30 collection fee deducted)');

    const plate = returnCard(pg, O.o1, P.plate.name);
    admin.promptAnswer = 'Photos show normal wear, not damage';
    await plate.getByRole('button', { name: 'Decline…' }).click();
    await expect(pg.locator('#toast')).toHaveText('Return declined');
    await expect(plate.locator('.pill')).toHaveText('declined');
    await expect(plate).toContainText('declined: “Photos show normal wear, not damage”');

    const rets = (await call(pg, 'GET', '/api/admin/returns')).data.returns.filter((x) => x.order.publicId === O.o1);
    expect(rets.find((x) => x.items[0].name === P.mug.name)).toMatchObject({ status: 'approved', refund: 10, fee: 30 });
    expect(rets.find((x) => x.items[0].name === P.plate.name)).toMatchObject({ status: 'declined', declineReason: 'Photos show normal wear, not damage' });
    expect((await call(pg, 'GET', '/api/admin/orders')).data.orders.find((o) => o.publicId === O.o1).refundedAt).toBeNull();
    await admin.close();

    const buyer = await newActor(browser, testInfo, { account: B });
    await gotoAccount(buyer.page, 'orders', B.email);
    const foot = orderCard(buyer.page, O.o1).locator('.oc-foot');
    await expect(foot).toContainText(`Return approved for ${P.mug.name} — AED 10 is on its way back to your card (AED 30 collection fee deducted).`);
    await expect(foot).toContainText(`Return declined for ${P.plate.name} — Photos show normal wear, not damage`);
    await expect(orderCard(buyer.page, O.o1).locator('.oc-head .opill')).toHaveText('Delivered');   // not every item came back
    await buyer.close();

    const seller = await newActor(browser, testInfo, { account: M });
    await gotoSell(seller.page);
    await sellerTab(seller.page, 'returns', 'Returns');
    const cards = seller.page.locator('#returnList > .card');
    await expect(cards.filter({ hasText: P.mug.name }).locator('.rr-note')).toContainText('AED 24 of this sale no longer counts toward your payouts');
    await expect(cards.filter({ hasText: P.plate.name }).locator('.rr-note')).toContainText('Reason given to the buyer: “Photos show normal wear, not damage”');
    // The unswept O1 credit shrank from AED 54 to AED 30: 30 (O1) + 144 (O2) + 21 (O3) still in the window.
    await sellerTab(seller.page, 'payments', 'Payments');
    await expect(seller.page.locator('#view-payments .fee-row', { hasText: 'In the 7-day return window' })).toContainText('AED 195');
    expect((await call(seller.page, 'GET', '/api/seller/settlements')).data.pendingCents).toBe(19500);
    await seller.close();
  });

  test('above AED 200 the full item amount comes back; the order is refunded only once every item is back', async ({ browser }, testInfo) => {
    const sh = await shipmentFor(M, O.o2);
    expect((await M.session.call('POST', '/api/delivery/mock/deliver', { shipmentId: sh.id })).status).toBe(200);

    const buyer = await newActor(browser, testInfo, { account: B });
    const bp = buyer.page;
    await gotoAccount(bp, 'orders', B.email);
    await orderCard(bp, O.o2).getByRole('button', { name: 'Request a return' }).click();
    await bp.locator('#rtItems .rti', { hasText: P.vase.name }).locator('input').check();
    await expect(bp.locator('#rtMoney')).toHaveText('You\'ll get AED 150 back to your card. Collection is free for this order. The original delivery fee isn\'t refundable.');
    await bp.locator('#retScrim').getByRole('button', { name: 'Cancel' }).click();
    await requestReturn(bp, O.o2, [P.vase.name], { reason: 'not-as-described', details: 'Colour is much darker than the photos.' });

    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    const ap = admin.page;
    await ap.goto('/admin');
    await adminTab(ap, 'returns', 'Returns');
    await returnCard(ap, O.o2, P.vase.name).getByRole('button', { name: 'Approve · refund AED 150' }).click();
    await expect(ap.locator('#toast')).toHaveText('Return approved — refund issued');
    expect((await call(ap, 'GET', '/api/admin/orders')).data.orders.find((o) => o.publicId === O.o2).refundedAt).toBeNull();

    // The rest of the order, together: one collection.
    await gotoAccount(bp, 'orders', B.email);
    await requestReturn(bp, O.o2, [P.plate.name, P.mug.name], { reason: 'changed-mind', details: 'Sending the rest back too.' });
    await ap.reload();
    await adminTab(ap, 'returns', 'Returns');
    const rest = returnCard(ap, O.o2, P.plate.name);
    await expect(rest).toContainText('(2 of 3 items on the order)');
    await rest.getByRole('button', { name: 'Approve · refund AED 90' }).click();
    await expect(ap.locator('#toast')).toHaveText('Return approved — refund issued');
    const o2 = (await call(ap, 'GET', '/api/admin/orders')).data.orders.find((o) => o.publicId === O.o2);
    expect(o2.refundedAt).not.toBeNull();
    const rets = (await call(ap, 'GET', '/api/admin/returns')).data.returns.filter((x) => x.order.publicId === O.o2);
    expect(rets.map((x) => [x.status, x.refund, x.fee]).sort()).toEqual([['approved', 150, 0], ['approved', 90, 0]].sort());
    await adminTab(ap, 'orders', 'Orders');
    const row = ap.locator('#ordersTable tbody tr').filter({ hasText: O.o2 });
    await expect(row.locator('.pill')).toHaveText('refunded');
    await expect(row.getByRole('button', { name: 'Refund' })).toHaveCount(0);
    await admin.close();

    await gotoAccount(bp, 'orders', B.email);
    const card = orderCard(bp, O.o2);
    await expect(card.locator('.oc-head .opill')).toHaveText('Refunded');
    await expect(card.locator('.oc-foot')).toContainText(`Return approved for ${P.vase.name} — AED 150 is on its way back to your card. Our courier`);
    await expect(card.locator('.oc-foot')).toContainText('AED 90 is on its way back to your card. Our courier');
    await expect(card.getByRole('button', { name: 'Request a return' })).toHaveCount(0);
    await buyer.close();

    // O2's whole credit reversed: 30 (O1) + 21 (O3) left in the window.
    expect((await M.session.call('GET', '/api/seller/settlements')).data.pendingCents).toBe(5100);
  });

  test('admin full-order refund: offered in Orders, refused in demo-payments mode with a reason', async ({ browser }, testInfo) => {
    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    const pg = admin.page;
    await pg.goto('/admin');
    await adminTab(pg, 'orders', 'Orders');
    const row = pg.locator('#ordersTable tbody tr').filter({ hasText: O.o3 });
    await expect(row).toContainText(B.email);
    await expect(row).toContainText('+971501234567');     // Trove sees the phone the shop never does
    await expect(row).toContainText('AED 65');
    await row.getByRole('button', { name: 'Refund' }).click();
    await expect(pg.locator('#toast')).toHaveText('No card payment to refund');
    await expect(row.locator('.pill')).toHaveText('paid');
    expect((await call(pg, 'GET', '/api/admin/orders')).data.orders.find((o) => o.publicId === O.o3).refundedAt).toBeNull();
    await admin.close();
  });

  test('reviews: a delivered piece gets stars + words + a photo; undelivered can\'t be reviewed; admin filters and hides it', async ({ browser }, testInfo) => {
    let r = await B.session.call('POST', '/api/account/reviews', { productId: P.jar.id, rating: 5, body: 'Lovely' });
    expect(r.status).toBe(403);
    expect(r.data.error).toContain('Reviews are for delivered purchases');

    const buyer = await newActor(browser, testInfo, { account: B });
    const pg = buyer.page;
    await gotoAccount(pg, 'orders', B.email);
    const nudge = pg.locator('#reviewNudge');
    await expect(nudge).toContainText('Share what you thought');
    await expect(nudge.locator('.rev-row .nm', { hasText: P.mug.name })).toHaveCount(1);
    await expect(nudge.locator('.rev-row .nm', { hasText: P.plate.name })).toHaveCount(1);
    await expect(nudge).not.toContainText(P.jar.name);     // O3 never arrived
    await expect(nudge).not.toContainText(P.vase.name);    // O2 was refunded
    await nudge.locator('.rev-row', { hasText: P.plate.name }).getByRole('button', { name: /Rate & review/ }).click();
    await expect(pg.locator('#revScrim')).toHaveClass(/open/);
    await expect(pg.locator('#rvSub')).toHaveText(`${P.plate.name} · ${M.shop.name}`);
    await pg.locator('#rvSave').click();
    await expect(pg.locator('#toast')).toHaveText('Tap a star rating first');
    await pg.locator('#rvStars button[title="4 stars"]').click();
    await expect(pg.locator('#rvStars button.on')).toHaveCount(4);
    await pg.fill('#rvBody', `Heavy, even glaze, ${tag} — exactly as pictured.`);
    await pg.setInputFiles('#rvFile', pngFile('plate.png'));
    await expect(pg.locator('#rvPhotos .ph')).toHaveCount(1);
    await pg.locator('#rvSave').click();
    await expect(pg.locator('#toast')).toHaveText('Thank you — your review is live');
    const mine = pg.locator('#myReviews .r').filter({ hasText: P.plate.name });
    await expect(mine.locator('.rstars')).toHaveText('★★★★☆');
    await expect(mine).toContainText('exactly as pictured');
    await expect(mine.locator('.rimgs img')).toHaveCount(1);
    await expect(nudge.locator('.rev-row', { hasText: P.plate.name })).toHaveCount(0);

    const shopper = await newActor(browser, testInfo);
    const sp = shopper.page;
    await gotoStore(sp, `/?p=${P.plate.id}`);
    await expect(sp.locator('#pdpReviews')).toBeVisible();
    await expect(sp.locator('#pdpRevHead')).toContainText('4');
    await expect(sp.locator('#pdpRevHead')).toContainText('1 review');
    const rev = sp.locator('#pdpRevList .rev');
    await expect(rev).toHaveCount(1);
    await expect(rev.locator('.rwho')).toHaveText('Nour B.');          // first name + initial, never the full name
    await expect(rev).toContainText('exactly as pictured');
    await expect(rev.locator('.rimgs img')).toHaveCount(1);
    await expect(sp.locator('#pdpStars')).toContainText('4 · 1 review');
    await gotoStore(sp, `/?shop=${M.shop.slug}`);
    await expect(sp.locator('#vendorReviews')).toBeVisible();
    await expect(sp.locator('#vRevHead')).toContainText('4★ from 1 review');
    await expect(sp.locator('#vRevList .rev .rprod')).toHaveText([P.plate.name]);

    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    const ap = admin.page;
    await ap.goto('/admin');
    await adminTab(ap, 'reviews', 'Reviews');
    await ap.fill('#revSearch', B.email);
    const rows = ap.locator('#reviewsTable tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(P.plate.name);
    await ap.locator('#revStarChips .rchip', { hasText: '5★' }).click();
    await expect(rows).toHaveText(['No reviews match these filters.']);
    await ap.locator('#revStarChips .rchip', { hasText: '5★' }).click();       // tap again to clear
    await ap.locator('#revStarChips .rchip', { hasText: '4★' }).click();
    await expect(rows).toHaveCount(1);
    await ap.selectOption('#revShopSel', M.shop.name);
    await expect(rows).toHaveCount(1);
    await rows.getByRole('button', { name: 'Hide' }).click();
    await expect(ap.locator('#toast')).toHaveText('Review hidden');
    await expect(rows.locator('.pill')).toHaveText('hidden');
    await ap.locator('#revStatusChips .rchip', { hasText: 'Published' }).click();
    await expect(rows).toHaveText(['No reviews match these filters.']);
    await ap.locator('#revStatusChips .rchip', { hasText: 'Hidden' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.getByRole('button', { name: 'Publish' })).toBeVisible();
    await admin.close();

    await gotoStore(sp, `/?p=${P.plate.id}`);
    await expect(sp.locator('#pdpName')).toHaveText(P.plate.name);
    await expect(sp.locator('#pdpReviews')).toBeHidden();
    await expect(sp.locator('#pdpStars')).toBeEmpty();
    await shopper.close();
    await gotoAccount(pg, 'orders', B.email);
    await expect(pg.locator('#myReviews .r').filter({ hasText: P.plate.name })).toContainText('hidden by Trove');
    await buyer.close();
  });

  test('settlement: admin previews, runs, downloads the bank CSV (the only place a full IBAN appears) and marks paid; sellers see it with a purchase note', async ({ browser }, testInfo) => {
    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    const pg = admin.page;
    await pg.goto('/admin');
    await adminTab(pg, 'payouts', 'Trove payouts');
    const wrap = pg.locator('#payoutsWrap');
    // Seeded: Kiln & Clay's mug (AED 64) was delivered 9 days ago → AED 38.40 payable today.
    await expect(wrap.locator('.card').first()).toContainText('1 supplier payable · AED 38.40 total');
    const kiln = wrap.locator('tr').filter({ hasText: 'Kiln & Clay' });
    await expect(kiln.locator('td')).toHaveText(['Kiln & Clay', 'Mashreq Bank · AE·· ···· 0101', 'AED 38.40', '—', 'AED 38.40']);
    await expect(wrap).not.toContainText(M.shop.name);   // this maker's credits are still inside their window
    await expect(pg.locator('body')).not.toContainText(KILN_IBAN);

    await wrap.getByRole('button', { name: 'Run settlement' }).click();
    await expect(pg.locator('#toast')).toHaveText('Settlement drafted — 1 supplier, AED 38.40');
    const run = wrap.locator('div[style*="border-bottom"]').filter({ has: pg.locator('strong', { hasText: `Run ${isoDay(0)}` }) });
    await expect(run.locator('.pill')).toHaveText('draft');
    await expect(run.locator('tbody tr')).toContainText(['Kiln & Clay']);
    await expect(run).toContainText(/Purchase of handmade goods — PO #\d+/);
    await expect(wrap.getByRole('button', { name: 'Run settlement' })).toBeDisabled();

    const [csv] = await Promise.all([pg.waitForEvent('download'), run.getByRole('link', { name: 'Download bank CSV' }).click()]);
    expect(csv.suggestedFilename()).toMatch(/^trove-settlement-\d+\.csv$/);
    const lines = fs.readFileSync(await csv.path(), 'utf8').trim().split(/\r\n/);
    expect(lines[0]).toBe('supplier,account_name,bank,iban,amount_aed,reference');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^"Kiln & Clay","Mara Ceramics Studio","Mashreq Bank","${KILN_IBAN}",38\\.40,"Purchase of handmade goods — PO #\\d+"$`));
    await expect(run.locator('.pill')).toHaveText('exported');
    for (const url of ['/api/admin/settlements', '/api/admin/settlements/preview', '/api/admin/shops']) {
      expect(JSON.stringify((await call(pg, 'GET', url)).data), url).not.toContain(KILN_IBAN);
    }

    await run.getByRole('button', { name: 'Mark paid' }).click();
    await expect(pg.locator('#toast')).toHaveText('Settlement marked paid');
    await expect(run.locator('.pill')).toHaveText('paid');
    const noteLink = run.getByRole('link', { name: 'Purchase note' });
    const note = await pg.request.get(await noteLink.getAttribute('href'));
    expect(note.status()).toBe(200);
    const noteHtml = await note.text();
    expect(noteHtml).toContain('self-billed purchase note');
    expect(noteHtml).toContain('TRV-SEED01');
    expect(noteHtml).toContain('AED 38.40');

    // Kiln & Clay's maker sees the run, paid, with their note.
    const mara = await newActor(browser, testInfo, { account: ACCOUNTS.seller });
    await gotoSell(mara.page);
    await sellerTab(mara.page, 'payments', 'Payments');
    const hist = mara.page.locator('#view-payments .card').filter({ hasText: 'Settlement history' }).locator('tbody tr');
    await expect(hist).toHaveCount(1);
    const today = await mara.page.evaluate((d) => fmtDate(d), isoDay(0));
    await expect(hist.locator('td')).toHaveText([today, '1 order · AED 38.40', '—', 'AED 38.40', 'paid', 'Purchase note']);
    await expect(mara.page.locator('#view-payments .fee-row', { hasText: 'Settled to date' })).toContainText('AED 38.40');
    const own = await mara.page.request.get(await hist.getByRole('link', { name: 'Purchase note' }).getAttribute('href'));
    expect(own.status()).toBe(200);
    expect(await own.text()).toContain('Supplier:</strong> Kiln & Clay');
    await mara.close();

    // This maker's O1 credit (AED 90 sold − AED 40 returned → 60% of AED 50 = AED 30) settles once
    // its window closes — reached here with a run dated 8 days ahead through the API.
    const future = await call(pg, 'POST', '/api/admin/settlements/run', { runDate: isoDay(8) });
    expect(future.status).toBe(201);
    const mine = future.data.items.find((i) => i.shopId === M.shop.id);
    expect(mine).toMatchObject({ amountCents: 3000 });
    await admin.close();

    const seller = await newActor(browser, testInfo, { account: M });
    const sp = seller.page;
    await gotoSell(sp);
    await sellerTab(sp, 'payments', 'Payments');
    const rows = sp.locator('#view-payments .card').filter({ hasText: 'Settlement history' }).locator('tbody tr');
    const runDay = await sp.evaluate((d) => fmtDate(d), isoDay(8));
    await expect(rows.locator('td')).toHaveText([runDay, '1 order · AED 30', '—', 'AED 30', 'processing', '']);
    await expect(sp.locator('#view-payments .fee-row', { hasText: 'In the 7-day return window' })).toContainText('AED 21');  // O3 (never delivered)

    const adm = await api(testInfo, ACCOUNTS.admin);
    expect((await adm.call('POST', `/api/admin/settlements/${future.data.settlementId}/paid`)).status).toBe(200);
    await adm.dispose();
    await gotoSell(sp);
    await sellerTab(sp, 'payments', 'Payments');
    await expect(rows.locator('td').nth(4)).toHaveText('paid');
    await expect(sp.locator('#view-payments .fee-row', { hasText: 'Settled to date' })).toContainText('AED 30');
    const mineNote = await sp.request.get(await rows.getByRole('link', { name: 'Purchase note' }).getAttribute('href'));
    expect(mineNote.status()).toBe(200);
    const html = await mineNote.text();
    expect(html).toContain(O.o1);
    expect(html).toContain('AED 30.00');
    expect(html).toContain('····4821');
    expect(html).not.toContain(O.o2);
    await seller.close();
  });

  test('shop analytics count shopper views and baskets, never the owner\'s own visits', async ({ browser }, testInfo) => {
    const lampRow = async () => (await M.session.call('GET', '/api/seller/analytics?days=30')).data.products.find((p) => p.name === P.lamp.name);
    expect(await lampRow()).toMatchObject({ views: 0, adds: 0 });

    const shopper = await newActor(browser, testInfo);
    const sp = shopper.page;
    const beacon = (kind) => sp.waitForResponse((r) => r.url().endsWith('/api/track') && r.request().postDataJSON().kind === kind);
    let shopView = beacon('shop_view');
    await gotoStore(sp, `/?shop=${M.shop.slug}`);
    await shopView;
    const view = beacon('product_view');
    await sp.locator('#vendorProducts .card h3', { hasText: P.lamp.name }).click();
    await view;
    const add = beacon('add_to_cart');
    await sp.locator('#pdpAdd').click();
    await add;
    await shopper.close();

    const seller = await newActor(browser, testInfo, { account: M });
    const pg = seller.page;
    // The owner opening their own piece and basketing it is not demand.
    const own = pg.waitForResponse((r) => r.url().endsWith('/api/track') && r.request().postDataJSON().kind === 'add_to_cart');
    await gotoStore(pg, `/?p=${P.lamp.id}`);
    await pg.locator('#pdpAdd').click();
    await own;
    expect(await lampRow()).toMatchObject({ views: 1, adds: 1, units: 0 });

    await gotoSell(pg);
    await sellerTab(pg, 'analytics', 'Shop Analytics');
    const row = pg.locator('#view-analytics tbody tr').filter({ hasText: P.lamp.name });
    await expect(row.locator('td')).toHaveText([P.lamp.name, '1', '1', '0', 'AED 0', '5 in stock']);
    const cards = pg.locator('#view-analytics .grid-4 .stat');
    const summary = (await M.session.call('GET', '/api/seller/analytics?days=30')).data.summary;
    await expect(cards.filter({ hasText: 'Piece views' }).locator('.big')).toHaveText(String(summary.productViews));
    await expect(cards.filter({ hasText: 'Added to basket' }).locator('.big')).toHaveText(String(summary.addToCart));
    expect(summary.productViews).toBeGreaterThanOrEqual(1);
    await expect(pg.locator('#view-analytics .an-foot')).toContainText('Your own visits aren\'t counted');
    await seller.close();
  });

  test('shop analytics earnings leave out refunded orders and returned items', async ({}, testInfo) => {
    test.fail(true, 'BUG: analytics.js summary()/productRows() count every paid/fulfilled order — refunds and approved returns still show as sold and earned');
    // Sold and kept: O1 plate (AED 50) + O3 jar (AED 35) → 60% = AED 51. O1 mug came back; all of O2 was refunded.
    const a = (await M.session.call('GET', '/api/seller/analytics?days=30')).data;
    expect(a.summary.earnings).toBe(51);
    expect(a.products.find((p) => p.name === P.vase.name)).toMatchObject({ units: 0, earnings: 0 });
  });

  test('admin return card names the real free-collection threshold (AED 200)', async ({ browser }, testInfo) => {
    test.fail(true, 'BUG: trove-admin.html renderReturns says "free collection, AED 500+ order"; the threshold is AED 200');
    const o4 = await buyNow(B.session, [{ productId: P.vase.id, qty: 1 }, { productId: P.plate.id, qty: 1 }, { productId: P.mug.id, qty: 1 }]);   // AED 240
    await M.session.call('POST', '/api/delivery/mock/deliver', { shipmentId: (await shipmentFor(M, o4)).id });
    const item = (await B.session.call('GET', '/api/account/orders')).data.orders.find((o) => o.id === o4).returns.items[0];
    const r = await B.session.call('POST', `/api/account/orders/${o4}/return-request`, { itemIds: [item.id], reason: 'other', details: 'Checking the copy', images: [pngDataUrl()] });
    expect(r.status).toBe(201);
    const admin = await newActor(browser, testInfo, { account: ACCOUNTS.admin });
    await admin.page.goto('/admin');
    await adminTab(admin.page, 'returns', 'Returns');
    const card = admin.page.locator('#returnsWrap > div').filter({ hasText: o4 });
    await expect(card).toContainText('would refund AED');
    await expect(card).not.toContainText('AED 500');
    await admin.close();
  });

  test('a settlement run cannot be dated into the future (credits would be paid inside their return window)', async ({}, testInfo) => {
    test.fail(true, 'BUG: POST /api/admin/settlements/run accepts any runDate — a future date sweeps credits whose 7-day window is still open (settlement.js run())');
    const admin = await api(testInfo, ACCOUNTS.admin);
    const r = await admin.call('POST', '/api/admin/settlements/run', { runDate: isoDay(30) });
    await admin.dispose();
    expect(r.status).toBe(400);
  });
});
