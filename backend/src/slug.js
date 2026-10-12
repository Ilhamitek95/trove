'use strict';
/**
 * The one slug rule (F375): URL addresses (seo.js) and the slugs stored for
 * new shops and providers (auth, services and seller routes) use the same
 * function, so 'Café & Co' becomes cafe-and-co and "Mara's Kiln" becomes
 * maras-kiln everywhere. The storefront and Services page scripts carry a
 * copy that test/seo.test.js pins equal to this one. Existing stored slugs
 * are never changed.
 */
function slugify(s) {
  return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}

module.exports = { slugify };
