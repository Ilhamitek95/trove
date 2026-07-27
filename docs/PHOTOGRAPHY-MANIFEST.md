# Trove photography manifest

Every image slot on the site, what it currently shows, what to shoot/source
for it, and the exact size to deliver. Direction (from the brand review):

- **Product shots** — product centre-stage, soft natural light, neutral Cream
  (`#FDF7F5`) or Clay (`#DBC7BD`) backgrounds, honest textures, minimal styling.
- **Lifestyle** — real lived-in moments: morning rituals, shared meals, cosy
  evenings. Warm, unstaged, no showroom gloss.
- **Marketplace / maker cards** — hands at work, workshops, process shots.

**Current interim treatment:** every slot marked *awaiting final photography*
renders a deterministic brand-motif tile (organic shapes on palette tints) —
never a flat colour block, never unrelated stock. The old random picsum
photos (rainy windows, cliffs, walruses…) are gone entirely.

**How final photos go live:** product images are keyed by each product's
`image_seed`; when real photography lands we wire an upload per product
(the upload plumbing from reviews/returns is ready to reuse — flag this as
the follow-up build). Shop/maker photos already upload via the seller
dashboard (`Shop photo`) and display everywhere automatically.

| # | Slot | Where it shows | Current | Needed subject | Deliver at (px, ratio) | Status |
|---|------|----------------|---------|----------------|------------------------|--------|
| 1 | Hero visual | Homepage hero (right) | Brand illustration (organic blobs + botanical line-work, inline SVG) | Optional: hero lifestyle photo — a cosy, lived-in room with Collection pieces; illustration is brand-approved and may stay | 1000×1200 (5:6) | Brand art — photo optional |
| 2 | Product card / PDP main | Every product tile, weekly finds, PDP gallery | Brand-motif tile per product | Product centre-stage on Cream/Clay, soft natural light; 3–4 angles for the PDP thumbs | 1280×1560 (ex. 640×780 min), 4:5-ish | **Awaiting final photography** (14 demo + 24 live products) |
| 3 | PDP thumbnails | Product page gallery strip | Same motif tile repeated | Detail crops of #2 (texture, base, in-hand) | 640×780 | **Awaiting final photography** |
| 4 | Curated-by-Trove gallery (2–4 tiles) | Homepage Collection band | Motif tiles + product-name captions | Collection pieces in lived-in settings (kitchen shelf, sofa corner, bedside) | 900×900 (1:1 safe) | **Awaiting final photography** |
| 5 | Maker card cover | Homepage “Meet the makers”, shop directory | Motif tile (was a flat colour gradient) | Hands at work / workshop / process shot per maker | 1200×800 (3:2) | **Awaiting final photography** — sellers can upload today via dashboard |
| 6 | Maker avatar | Maker cards + shop page | Shop initial on brand colour, or the shop’s uploaded photo | Maker portrait or workshop close-up | 400×400 (1:1) | Seller-uploadable today |
| 7 | Shop page hero | Top of each shop page | Shop photo if uploaded, else brand-colour wash | Wide workshop / studio shot per maker | 1600×500 (16:5) | Seller-uploadable today |
| 8 | Sell-page testimonials | “In their words” band | Illustrated portraits (deliberate — quotes are demo content) | Real maker headshots ONLY once real quotes replace the demo ones | 200×200 (1:1) | Blocked on real maker quotes |
| 9 | Order thumbnails | Account + seller + admin order rows | Motif tile per product | Inherits #2 automatically once wired | 200×250 (4:5) | Follows #2 |
| 10 | Favicon / app icon | Browser tab, home-screen | Interim “t.” lettermark (non-italic) | Official icon artwork from the brand book | SVG + 180×180 PNG | **Awaiting official asset** |
| 11 | Logo wordmark | Header, footer, dashboards, sign-in, apply | Typed fallback (auto-swaps when asset dropped in `docs/img/`) | Official lowercase wordmark with swash ‘e’ — charcoal + cream colourways | SVG (see `docs/img/README.md`) | **Awaiting official asset** |

Categories with zero products (e.g. Children's, Pet Accessories) don't render
tiles yet, so they need no imagery until stocked.
