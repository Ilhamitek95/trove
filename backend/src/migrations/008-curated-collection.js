'use strict';
/**
 * The Trove Collection is curated, not designed in-house — align the live
 * house-shop bio with the storefront copy. Matched on slug + the exact old
 * bio, so a bio the owner has edited since seeding is never overwritten.
 */
const OLD_BIO = 'Our own line — designed in-house, made with vetted partners, priced honestly. The standard we hold the marketplace to.';
const NEW_BIO = 'Our own line — curated by us, made by makers we trust, priced honestly. The standard we hold the marketplace to.';

module.exports = {
  id: '008-curated-collection',
  up(db) {
    db.prepare('UPDATE shops SET bio=? WHERE slug=? AND bio=?').run(NEW_BIO, 'trove-label', OLD_BIO);
  },
};
