'use strict';
/**
 * 2026 brand review: move every product and shop onto the two-pillar category
 * taxonomy, retire off-taxonomy apparel basics, restore the "designed by
 * Trove" Collection story, and clear site_content overrides that are
 * byte-identical to the OLD defaults (they carry no owner intent and would
 * silently mask the reviewed copy).
 *
 * Everything is keyed on exact current values, so anything the owner has
 * edited since is never overwritten — only logged for follow-up.
 */

// Maker (marketplace) categories.
const MAKER_MAP = {
  Home: 'Home & Living',
  Art: 'Wall Art & Prints',
  Woodwork: 'Handmade Crafts',
  Jewelry: 'Jewellery',
  Textiles: 'Home & Living',
  Apparel: 'Handmade Crafts', // remaining maker apparel is hand-knit
};

// House (Trove Collection) categories.
const HOUSE_MAP = {
  Ceramics: 'Kitchen & Dining',
  Home: 'Decorative Accessories',
  Accessories: 'Storage & Organisation',
  Stationery: 'Decorative Accessories',
  Textiles: 'Textiles',
};

// The house apparel basics have no home in the new taxonomy — retire them.
const RETIRE_HOUSE_APPAREL = true;

const OLD_HOUSE_BIO = 'Our own line — curated by us, made by makers we trust, priced honestly. The standard we hold the marketplace to.';
const NEW_HOUSE_BIO = 'Our own line — designed by Trove, made with quality materials and considered details. The standard we hold the marketplace to.';

// DEFAULTS as they stood before the brand review, for the sections whose copy
// changed. An override equal to one of these is a stale snapshot, not an edit.
const OLD_DEFAULTS = {
  'site.footer': {
    blurb: 'Thoughtfully chosen homeware from the Trove Collection, alongside handcrafted finds from independent makers in the Trove Marketplace. Objects worth keeping.',
    legal: '© 2026 trove · Dubai, UAE',
  },
  'home.hero': {
    eyebrow: 'Thoughtfully gathered',
    h1: 'Curated|for *Living*',
    lead: 'Discover thoughtfully chosen homeware from the Trove Collection alongside handcrafted finds from independent makers in the Trove Marketplace.',
    ctaShop: 'Explore the trove',
    ctaSell: 'Open a shop →',
    tagLine: 'Our own line',
    tagName: 'Trove Collection →',
  },
  'home.collection': {
    eyebrow: 'Curated by trove',
    h2: 'Trove Collection.|*Our own, made well.*',
    intro: 'Timeless pieces chosen to become part of your everyday home. Curated by us, made by makers we trust, priced honestly.',
    points: [
      { title: 'Authentic', text: "Every piece is chosen by hand and made in small batches by real makers — each one comes out a little different, and that's the point." },
      { title: 'Homely', text: 'Warm, everyday pieces made to be lived with — poured, thrown and stitched to make a house feel like home, not kept behind glass.' },
      { title: 'Made yours', text: 'Spot a personalisation box on a piece? That maker will add your name or a few words of your choosing — made just for you.' },
    ],
    cta: 'Shop the Collection',
  },
};

module.exports = {
  id: '010-brand-taxonomy',
  up(db) {
    // 1) Retire the house apparel basics (status flip — fully reversible in admin).
    if (RETIRE_HOUSE_APPAREL) {
      const n = db.prepare(`UPDATE products SET status='hidden'
        WHERE category='Apparel' AND status!='hidden'
          AND shop_id IN (SELECT id FROM shops WHERE is_house=1)`).run().changes;
      if (n) console.log(`010: retired ${n} house apparel product(s) (status=hidden)`);
    }

    // Any lingering banned-class Beauty products get pulled off the storefront too.
    const beauty = db.prepare(`UPDATE products SET status='hidden' WHERE category='Beauty' AND status!='hidden'`).run().changes;
    if (beauty) console.log(`010: hid ${beauty} Beauty product(s) — banned class`);

    // 2) Remap product categories, house-aware.
    const remap = db.prepare(`UPDATE products SET category=?
      WHERE category=? AND shop_id IN (SELECT id FROM shops WHERE is_house=?)`);
    let moved = 0;
    for (const [from, to] of Object.entries(HOUSE_MAP)) moved += remap.run(to, from, 1).changes;
    for (const [from, to] of Object.entries(MAKER_MAP)) moved += remap.run(to, from, 0).changes;
    console.log(`010: recategorised ${moved} product(s) onto the brand taxonomy`);

    // 3) Shop craft categories (shown in admin/applications) follow the maker map + UK spelling.
    const shopMap = { ...MAKER_MAP, Jewelry: 'Jewellery' };
    const shopRemap = db.prepare('UPDATE shops SET category=? WHERE category=? AND is_house=0');
    for (const [from, to] of Object.entries(shopMap)) shopRemap.run(to, from);

    // 4) Collection story: designed by Trove (exact-match keyed, owner edits survive).
    db.prepare('UPDATE shops SET bio=? WHERE slug=? AND bio=?').run(NEW_HOUSE_BIO, 'trove-label', OLD_HOUSE_BIO);

    // 5) Drop site_content overrides identical to the OLD defaults.
    let hasTable = true;
    try { db.prepare('SELECT 1 FROM site_content LIMIT 1').get(); } catch (_) { hasTable = false; }
    if (hasTable) {
      for (const [section, oldDef] of Object.entries(OLD_DEFAULTS)) {
        const row = db.prepare('SELECT value FROM site_content WHERE section=?').get(section);
        if (!row) continue;
        let same = false;
        try { same = JSON.stringify(JSON.parse(row.value)) === JSON.stringify(oldDef); } catch (_) {}
        if (same) {
          db.prepare('DELETE FROM site_content WHERE section=?').run(section);
          console.log(`010: cleared stale "${section}" override (was identical to the old default)`);
        }
      }
      // Surgical fix inside genuinely-edited overrides: the Collection is designed, not chosen.
      for (const r of db.prepare('SELECT section, value FROM site_content').all()) {
        if (!/houghtfully chosen homeware/.test(r.value)) continue;
        const fixed = r.value
          .replace(/Thoughtfully chosen homeware/g, 'Thoughtfully designed homeware')
          .replace(/thoughtfully chosen homeware/g, 'thoughtfully designed homeware');
        db.prepare('UPDATE site_content SET value=? WHERE section=?').run(fixed, r.section);
        console.log(`010: reworded "chosen homeware" inside the edited "${r.section}" override`);
      }
      for (const r of db.prepare('SELECT section FROM site_content').all()) {
        const v = db.prepare('SELECT value FROM site_content WHERE section=?').get(r.section).value;
        if (/urated by (us|trove)/i.test(v)) console.log(`010: NOTE — override "${r.section}" still says "curated by"; review it in /admin → Site content`);
      }
    }
  },
};
