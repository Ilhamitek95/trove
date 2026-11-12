'use strict';
/**
 * 05 · Admin & CMS — the overview, the Site content editor (save, reset,
 * unsaved state, copy guardrails, weekly-finds picker), catalogue moderation,
 * and the orders / payouts / VAT / graduation / search-trends surfaces.
 * (Reviews, returns, settlement runs and shop approval live in specs 01–03.)
 */
const { test, expect, j, openDashboard } = require('./helpers-services');
const { ACCOUNTS, uid } = require('./fixtures');

const HERO_DEFAULT = 'Curated|for *Living*.';
const cmsCard = (page, label) => page.locator('.cmscard', { has: page.locator('h3', { hasText: label }) });
const cmsInput = (card, label) => card.locator('.cmsf', { has: card.page().locator('.flab', { hasText: label }) }).locator('input, textarea').first();

async function openAdmin(page, view) {
  await openDashboard(page, '/admin');
  await expect(page.locator('#shell')).toBeVisible();
  if (view) {
    await page.locator(`.side .mitem[data-v=${view}]`).click();
    await expect(page.locator(`#view-${view}`)).toBeVisible();
  }
}

test('admin signs in and the overview renders real numbers, the review queue and search trends', async ({ page }) => {
  const term = `e2e unicorn ${uid()}`;
  for (let i = 0; i < 6; i++) {
    const r = await page.request.post('/api/search-log', { data: { q: term, results: 0 } });
    expect(r.status()).toBe(204);
  }

  await page.goto('/login');
  await page.locator('#email').fill(ACCOUNTS.admin.email.toUpperCase());   // emails are case-insensitive
  await page.locator('#pass').fill(ACCOUNTS.admin.password);
  // The numbers the page itself received (other journeys run alongside, so a
  // second fetch could legitimately differ).
  const statsResp = page.waitForResponse((r) => r.url().endsWith('/api/admin/stats'));
  await page.locator('#submitBtn').click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator('#shell')).toBeVisible();
  await expect(page.locator('#whoName')).toHaveText('E2E Admin');

  const stats = await (await statsResp).json();
  const cards = page.locator('#statCards .stat');
  await expect(cards).toHaveCount(8);
  await expect(cards.locator('.k')).toHaveText(['Pending approval', 'Live shops', 'Orders', 'Sales', 'Buyers', 'Live products', 'Licensed sellers', 'Service providers']);
  const value = (label) => cards.filter({ has: page.locator('.k', { hasText: label }) }).locator('.v');
  await expect(value('Live shops')).toHaveText(String(stats.shops.approved));
  await expect(value('Pending approval')).toHaveText(String(stats.shops.pending));
  await expect(value('Live products')).toHaveText(String(stats.liveProducts));
  await expect(value('Service providers')).toHaveText(String(stats.providers.approved));
  await expect(value('Sales')).toContainText('AED');
  expect(stats.orders).toBeGreaterThanOrEqual(1);

  // The seeded application waits for review with its full story.
  const pending = page.locator('#pendingList');
  await expect(pending).toContainText('Sable & Stone');
  await expect(pending).toContainText('self-taught silversmith');
  await expect(page.locator('#pendBadge')).toHaveText(String(stats.shops.pending));

  // Search trends: the no-result term is flagged.
  const row = page.locator('#trendsWrap tr', { hasText: term });
  await expect(row).toBeVisible();
  await expect(row.locator('td').nth(1)).toHaveText('6');
  await expect(row.locator('.pill')).toHaveText('no results');
});

test.describe.serial('Site content CMS', () => {
  test('edit the homepage hero heading with an *accent* → unsaved badge → save → live on / → reset restores it', async ({ actor }) => {
    const admin = await actor(ACCOUNTS.admin);
    await openAdmin(admin, 'sitecontent');
    const hero = cmsCard(admin, 'Homepage — Hero');
    await expect(hero).toBeVisible();
    await expect(hero.locator('.cmsbadge', { hasText: 'customised' })).toHaveCount(0);
    const dirty = admin.locator('[id="dirty-home.hero"]');
    await expect(dirty).toBeHidden();

    const h1 = cmsInput(hero, 'Big heading');
    await expect(h1).toHaveValue(HERO_DEFAULT);
    const tag = uid();
    await h1.fill(`Gathered ${tag}|for *slow* living.`);
    await expect(dirty).toBeVisible();
    await expect(dirty).toHaveText('unsaved');
    const preview = hero.locator('.rprev').first();
    await expect(preview.locator('em')).toHaveText('slow');
    await expect(preview.locator('br')).toHaveCount(1);

    await hero.getByRole('button', { name: 'Save' }).click();
    await expect(admin.locator('#toast')).toHaveText('Saved — live on the storefront');
    await expect(dirty).toBeHidden();
    await expect(hero.locator('.cmsbadge', { hasText: 'customised' })).toBeVisible();
    await expect(hero.getByRole('link', { name: /See it on the site/ })).toHaveAttribute('href', '/');

    // A shopper (fresh browser) sees it on the homepage, accent included.
    const shopper = await actor();
    await shopper.goto('/');
    const heading = shopper.locator('h1[data-cms-rich="home.hero.h1"]');
    await expect(heading).toHaveText(new RegExp(`Gathered ${tag}\\s*for slow living\\.`));
    await expect(heading.locator('em')).toHaveText('slow');
    await expect(heading.locator('br')).toHaveCount(1);
    expect(await heading.locator('em').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(241, 154, 130)'); // the Orange accent

    // Reset → the default returns.
    await hero.getByRole('button', { name: 'Reset to original' }).click();       // confirm() accepted
    await expect(admin.locator('#toast')).toHaveText('Back to the original copy');
    await expect(hero.locator('.cmsbadge', { hasText: 'customised' })).toHaveCount(0);
    await expect(h1).toHaveValue(HERO_DEFAULT);
    const pub = await j(admin.request, 'GET', '/api/content');
    expect(pub.data.home.hero.h1).toBe(HERO_DEFAULT);
    const shopper2 = await actor();
    await shopper2.goto('/');
    await expect(shopper2.locator('h1[data-cms-rich="home.hero.h1"]')).toHaveText(/Curated\s*for Living\./);
  });

  test('copy guardrails reject banned money-handling and green-claim phrases', async ({ actor }) => {
    const admin = await actor(ACCOUNTS.admin);
    await openAdmin(admin, 'sitecontent');
    const before = (await j(admin.request, 'GET', '/api/content')).data;

    const hero = cmsCard(admin, 'Homepage — Hero');
    await cmsInput(hero, 'Intro paragraph').fill('Trove collects your sales on behalf of every maker in the Marketplace.');
    await hero.getByRole('button', { name: 'Save' }).click();
    await expect(admin.locator('#toast')).toContainText('on behalf of');
    await expect(admin.locator('#toast')).toContainText("can't be used");
    await expect(admin.locator('[id="dirty-home.hero"]')).toBeVisible();           // still unsaved

    const footer = cmsCard(admin, 'Storefront — Footer');
    await cmsInput(footer, 'About blurb').fill('Every delivery is carbon-neutral and plastic-free.');
    await footer.getByRole('button', { name: 'Save' }).click();
    await expect(admin.locator('#toast')).toContainText('carbon-neutral');
    await expect(footer.locator('.cmsbadge', { hasText: 'customised' })).toHaveCount(0);

    // An empty required field is refused too.
    const promo = cmsCard(admin, 'Storefront — Announcement bar');
    await cmsInput(promo, 'Bar text').fill('   ');
    await promo.getByRole('button', { name: 'Save' }).click();
    await expect(admin.locator('#toast')).toContainText("can't be empty");

    const after = (await j(admin.request, 'GET', '/api/content')).data;
    expect(after.home.hero.lead).toBe(before.home.hero.lead);
    expect(after.site.footer.blurb).toBe(before.site.footer.blurb);
    expect(after.site.promo.text).toBe(before.site.promo.text);
    const api = await j(admin.request, 'PUT', '/api/admin/content/site.promo', { text: 'We remit every sale weekly' });
    expect(api.status).toBe(422);
  });

  test('weekly-finds product picker: hand-pick a piece → it leads "This week\'s finds"', async ({ actor }) => {
    const admin = await actor(ACCOUNTS.admin);
    await openAdmin(admin, 'sitecontent');
    const weekly = cmsCard(admin, "Homepage — This week's finds");
    await expect(weekly).toContainText('Automatic — the 8 newest pieces');
    const select = weekly.locator('select');
    const options = await select.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(8);
    // The oldest pieces are listed last — pick one the automatic mix would not show first.
    const pickLabel = options[options.length - 1];
    const pickName = pickLabel.split(' — ')[0];
    await select.selectOption({ label: pickLabel });
    await weekly.getByRole('button', { name: 'Add' }).click();
    await expect(weekly.locator('.pk')).toHaveCount(1);
    await expect(weekly.locator('.pk')).toContainText(pickName);
    await expect(admin.locator('[id="dirty-home.weekly"]')).toBeVisible();
    await weekly.getByRole('button', { name: 'Save' }).click();
    await expect(admin.locator('#toast')).toHaveText('Saved — live on the storefront');

    const shopper = await actor();
    await shopper.goto('/');
    const grid = shopper.locator('#trendingGrid .card');
    await expect(grid).toHaveCount(1);
    await expect(grid.locator('h3')).toHaveText(pickName);

    await weekly.getByRole('button', { name: 'Reset to original' }).click();
    await expect(admin.locator('#toast')).toHaveText('Back to the original copy');
    expect((await j(admin.request, 'GET', '/api/content')).data.home.weekly.productIds).toEqual([]);
    const shopper2 = await actor();
    await shopper2.goto('/');
    await expect(shopper2.locator('#trendingGrid .card')).toHaveCount(8);
  });

  test('a saved change shows on the shopper\'s next page load (no stale copy)', async ({ playwright, actor, baseURL }) => {
    test.fail(true, 'BUG: GET /api/content is sent with Cache-Control "public, max-age=300" (app.js siteCache), so a browser that loaded the storefront in the last 5 minutes keeps showing the old copy after "Saved — live on the storefront"');
    // Playwright switches the HTTP cache off in any context that intercepts
    // requests (the harness does, for config.js), so this shopper gets a real
    // browser with its cache on — outside hosts are unresolvable instead.
    const browser = await playwright.chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost'] });
    const admin = await actor(ACCOUNTS.admin);
    // (The homepage "Browse by" heading — nothing else on the site reads it.)
    const text = `Where shall we start, ${uid()}?`;
    try {
      const shopper = await (await browser.newContext({ baseURL })).newPage();
      await shopper.goto('/');
      const heading = shopper.locator('[data-cms="home.browse.heading"]');
      await expect(heading).toHaveText('Where would you like to begin?');
      const r = await j(admin.request, 'PUT', '/api/admin/content/home.browse', { eyebrow: 'Browse by', heading: text });
      expect(r.status).toBe(200);
      await shopper.goto('/');
      await expect(heading).toHaveText(text, { timeout: 5000 });
    } finally {
      await j(admin.request, 'DELETE', '/api/admin/content/home.browse');
      await browser.close();
    }
  });
});

test.describe('catalogue moderation', () => {
  test('hide a product → it leaves the storefront; put it live → it returns', async ({ actor }) => {
    const admin = await actor(ACCOUNTS.admin);
    await openAdmin(admin, 'products');
    const name = 'Weighted Brass Clip';
    await admin.locator('#prodFilter').fill('brass clip');
    const rows = admin.locator('#productsTable tbody tr');
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row).toContainText(name);
    await expect(row).toContainText('Folio Paper Co.');
    await expect(row.locator('.pill')).toHaveText('live');
    const pid = (await j(admin.request, 'GET', '/api/admin/products')).data.products.find((p) => p.name === name).id;

    await row.getByRole('button', { name: 'Hide' }).click();            // confirm() accepted
    await expect(admin.locator('#toast')).toHaveText('Product hidden');
    await expect(row.locator('.pill')).toHaveText('hidden');
    await expect(row.getByRole('button', { name: 'Put live' })).toBeVisible();

    const shopper = await actor();
    await shopper.goto('/?view=shop');
    await expect(shopper.locator('#view-shop')).toBeVisible();
    await expect(shopper.locator('#shopGrid .card').first()).toBeVisible();
    await expect(shopper.locator('#shopGrid')).not.toContainText(name);
    expect((await j(shopper.request, 'GET', `/api/products/${pid}`)).status).toBe(404);

    await row.getByRole('button', { name: 'Put live' }).click();
    await expect(admin.locator('#toast')).toHaveText('Product is live');
    await expect(row.locator('.pill')).toHaveText('live');
    const shopper2 = await actor();
    await shopper2.goto('/?view=shop');
    await expect(shopper2.locator('#shopGrid')).toContainText(name);
    await shopper2.goto(`/?p=${pid}`);
    await expect(shopper2.locator('#pdpName')).toHaveText(name);
  });

  test('without an AI key the tag-suggest buttons stay hidden and the endpoint answers 503', async ({ actor }) => {
    const admin = await actor(ACCOUNTS.admin);
    const cfg = await j(admin.request, 'GET', '/api/config');
    expect(cfg.data.aiTagsEnabled).toBe(false);
    await openAdmin(admin, 'products');
    await expect(admin.locator('#productsTable tbody tr').first()).toBeVisible();
    await expect(admin.getByRole('button', { name: '✨ AI' })).toHaveCount(0);
    await admin.locator('#prodFilter').fill('candle');
    const row = admin.locator('#productsTable tbody tr').first();
    await row.getByRole('button', { name: 'Tags' }).click();
    await expect(admin.locator('#tagScrim')).toHaveClass(/open/);
    await expect(admin.locator('#tmName')).toContainText('Candle');
    await expect(admin.locator('#tmAI')).toBeHidden();
    await admin.locator('#tagScrim').getByRole('button', { name: 'Cancel' }).click();
    await expect(admin.locator('#tagScrim')).not.toHaveClass(/open/);
    const pid = (await j(admin.request, 'GET', '/api/admin/products')).data.products[0].id;
    expect((await j(admin.request, 'POST', `/api/admin/products/${pid}/suggest-tags`)).status).toBe(503);
  });
});

test.describe('orders, payouts, VAT and graduation', () => {
  test('the orders list shows every order with the buyer contact for the courier desk', async ({ actor }) => {
    const admin = await actor(ACCOUNTS.admin);
    const ordersResp = admin.waitForResponse((r) => r.url().endsWith('/api/admin/orders'));
    await openAdmin(admin, 'orders');
    const api = (await (await ordersResp).json()).orders;
    await expect(admin.locator('#ordersTable thead th')).toHaveText(['Order', 'Buyer', 'Shops', 'Items', 'Total', 'Status', 'Placed', '']);
    const seed = admin.locator('#ordersTable tbody tr', { hasText: 'TRV-SEED01' });
    await expect(seed).toContainText('layla@email.com');
    await expect(seed).toContainText('+971501234567');
    await expect(seed).toContainText('Kiln & Clay');
    await expect(seed).toContainText('Ember Goods');
    await expect(seed.locator('.pill')).toHaveText('paid');
    await expect(seed.getByRole('button', { name: 'Refund' })).toBeVisible();
    await expect(admin.locator('#ordersTable tbody tr')).toHaveCount(api.length);
    await expect(admin.locator('#ordersTable tbody tr').first()).toContainText(api[0].publicId);   // newest first
  });

  test('payouts: settlement run, history, VAT (off) and graduation (Rail B off) render', async ({ actor }) => {
    const admin = await actor(ACCOUNTS.admin);
    const gradResp = admin.waitForResponse((r) => r.url().endsWith('/api/admin/graduation'));
    await openAdmin(admin, 'payouts');
    const grad = await (await gradResp).json();
    const wrap = admin.locator('#payoutsWrap');
    await expect(wrap.locator('h3')).toContainText(['Next settlement run', 'Settlement history', 'VAT by quarter', 'Graduation queue']);
    await expect(wrap.getByRole('button', { name: 'Run settlement' })).toBeVisible();
    await expect(wrap).toContainText(/\d+ suppliers? payable · AED/);
    const vatCard = wrap.locator('.card', { has: admin.locator('h3', { hasText: 'VAT by quarter' }) });
    await expect(vatCard).toContainText('VAT capture is off');
    await expect(vatCard).toContainText('No VAT captured yet.');
    const gradCard = wrap.locator('.card', { has: admin.locator('h3', { hasText: 'Graduation queue' }) });
    await expect(gradCard).toContainText('Rail B is OFF');
    expect(grad.railBEnabled).toBe(false);
    if (grad.queue.length) {
      await expect(gradCard.locator('tbody tr')).toHaveCount(grad.queue.length);
      for (const b of await gradCard.getByRole('button', { name: /Approve → Stripe|Re-send onboarding/ }).all()) await expect(b).toBeDisabled();
    } else {
      await expect(gradCard).toContainText('Nobody is waiting to graduate.');
    }
    const vat = (await j(admin.request, 'GET', '/api/admin/vat-report')).data;
    expect(vat).toEqual({ vatRegistered: false, rows: [] });
  });
});
