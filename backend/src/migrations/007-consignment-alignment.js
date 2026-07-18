'use strict';
/**
 * Demo-catalogue alignment: Northbound Loom and Folio Paper kept a legacy
 * 'connect' tier from before the two-rail refactor, but Rail B is off and
 * neither shop has a Stripe account — so their sales credit nobody on the
 * ledger and settlement skips them entirely. Move them onto the consignment
 * rail like every other supplier. Matched on slug + tier + missing Stripe
 * account so a shop that really graduated to Connect is never pulled back.
 */
module.exports = {
  id: '007-consignment-alignment',
  up(db) {
    const flip = db.prepare(`UPDATE shops SET tier='consignment'
      WHERE slug=? AND tier='connect' AND (stripe_account_id IS NULL OR stripe_account_id='')`);
    for (const slug of ['northbound-loom', 'folio-paper']) flip.run(slug);
  },
};
