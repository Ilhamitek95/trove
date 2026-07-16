'use strict';
/**
 * Brand refresh (2026 brand book): the house label now sells as the
 * "Trove Collection", and seeded shop accent colours move to the refreshed
 * palette. Rows are matched on slug + the exact old value, so anything an
 * owner has edited since seeding is never overwritten. Slugs are unchanged —
 * no URL breaks.
 */
const RENAMES = [
  { slug: 'trove-label', from: 'trove label', to: 'Trove Collection' },
];
const RECOLORS = [
  { slug: 'trove-label',     from: '#262321', to: '#292727' },
  { slug: 'kiln-and-clay',   from: '#A98B7D', to: '#BD9C8C' },
  { slug: 'northbound-loom', from: '#B9D0E0', to: '#BED3DF' },
  { slug: 'ember-goods',     from: '#F5C68A', to: '#FCC998' },
  { slug: 'fern-apothecary', from: '#C7D9AC', to: '#CFDBBE' },
  { slug: 'folio-paper',     from: '#F4CFE0', to: '#F8D7E4' },
];

module.exports = {
  id: '004-brand-refresh',
  up(db) {
    const rename = db.prepare('UPDATE shops SET name=? WHERE slug=? AND name=?');
    for (const r of RENAMES) rename.run(r.to, r.slug, r.from);
    const recolor = db.prepare('UPDATE shops SET color=? WHERE slug=? AND color=?');
    for (const r of RECOLORS) recolor.run(r.to, r.slug, r.from);
  },
};
