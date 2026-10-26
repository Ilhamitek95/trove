'use strict';
/**
 * Pictures in emails: the maker's photo, else a brand tile. Every image is
 * an absolute URL, because an inbox has no base URL.
 */
const { testEnv } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com' });

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('productImage: uploaded photo → nothing (no stock stand-in)', () => {
  const { productImage } = require('../src/email');
  assert.equal(productImage({ images: '["/uploads/products/p-7-a.jpg"]', name: 'Reeded Stoneware Mug' }), 'https://troveathome.com/uploads/products/p-7-a.jpg');
  assert.equal(productImage({ images: '[]', name: 'Reeded Stoneware Mug' }), '', 'a former demo name gets no stock photo');
  assert.equal(productImage({ images: null, name: 'Brand New Piece' }), '');
});

test('the receipt shows a picture per piece, or a brand tile when there is none', () => {
  const email = require('../src/email');
  const { html } = email.orderConfirmation({
    order: { public_id: 'TRV-IMG1', subtotal_cents: 17000, shipping_cents: 3000, service_fee_cents: 0, total_cents: 20000, created_at: '2026-09-21 06:00:00' },
    items: [
      { name: 'Reeded Stoneware Mug', qty: 1, price_cents: 10500, shop: 'Kiln & Clay', image: email.productImage({ images: ['/uploads/products/p-7-a.jpg'], name: 'Reeded Stoneware Mug' }) },
      { name: 'Brand New Piece', qty: 2, price_cents: 3250, shop: 'Folio Paper', image: '' },
    ],
    shops: ['Kiln & Clay', 'Folio Paper'],
    ship: { name: 'Layla Test', line: 'Villa 12', city: 'Jumeirah 1, Dubai' },
  });
  assert.match(html, /<img src="https:\/\/troveathome\.com\/uploads\/products\/p-7-a\.jpg" width="72" height="72" alt="Reeded Stoneware Mug"/);
  assert.ok(!/images\.unsplash\.com/.test(html), 'no stock photos in emails');
  assert.match(html, />B<\/td>/, 'no picture → the initial on a brand tile');
  assert.match(html, /Parcel 1 of 2 · packed by <b[^>]*>Kiln &amp; Clay<\/b>/);
  assert.match(html, /AED 32\.50 each/);
  assert.match(html, /21 September 2026/, 'order date in Dubai time');
  assert.match(html, /Track your order/);
  assert.ok(!/font-style:\s*italic|<em>|<i>/.test(html), 'no italics — brand rule');
});
