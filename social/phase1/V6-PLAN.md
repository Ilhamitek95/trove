# Trove Phase 1, v6 plan (26 Oct 2026)

Everything is still a draft: nothing is queued, scheduled or posted, and the auto-poster's Trove queue stays empty.
The dates are a plan only.

Sources: `FEEDBACK-2026-10-22.md` (the feedback), owner on 26 Oct ("amend the social calendar. I would like to have
more image/videos rather than text"), `social/BRIEF.md` (v6 rules at the end). Files changed in this step:
`posts.json`, `frames.js`, `video/reels.js`, `photos/prompts.json`, `gallery.html`, `social/BRIEF.md`.

## (a) The new calendar

Every post at 18:30 Dubai time, every two or three days. Same order as v5: what Trove is, makers, providers, money,
a founding maker, the Collection; buyers in December. Post numbers are unchanged, so 12 and 13 sit between the others.

| Date | Post | Format | Headline | Lead colour |
|---|---|---|---|---|
| Sat 31 Oct | 1 | Carousel, 5 (pinned) | Handmade in Dubai, Abu Dhabi and Sharjah. | Clay |
| Mon 2 Nov | 2 | Reel, 6 shots (pinned) | We'd rather know who made it. | Cream, an accent per scene |
| Wed 4 Nov | 3 | **Reel, 5 shots (was a carousel)** (pinned) | Makers. Providers. Buyers. | Pink / Light Blue / Light Green, one per word |
| Fri 6 Nov | 4 | Carousel, 6 | Make things by hand? You're a maker. | Pink |
| Sun 8 Nov | Story only | Diwali greeting | | |
| Mon 9 Nov | 12 | Reel, 5 shots | From your hands to your own shop. | Light Blue yarn |
| Wed 11 Nov | 5 | **Reel, 5 shots (was a carousel)** | You make it. Trove sells it. | Clay |
| Sat 14 Nov | 6 | Carousel, 4 | Keep your stall. Add a Trove shop. | Tan, Pastel Orange light |
| Mon 16 Nov | 7 | Carousel, 5 | Style homes? Run workshops? You're a provider. | Pastel Orange (in the photo), Orange accents |
| Wed 18 Nov | 13 | Reel, 5 shots | Get booked for what you do best. | Light Green |
| Fri 20 Nov | 8 | **Reel, 5 shots (was a carousel)** | Run workshops? Take bookings on Trove. | Light Blue |
| Mon 23 Nov | 9 | Carousel, 7 | What Trove costs, and what you keep. | Sage, the 60% on Charcoal |
| Wed 25 Nov | 10 | Collab Reel (real maker) or 3 back-up slides | Meet [Name]. | The maker's own colours |
| Sat 28 Nov | 11 | Carousel, 3 | Something of our own. | Cream and Sage |
| Wed 2 Dec (UAE National Day) | 14 | Reel, 5 shots | Handmade, by people who live here. | Pink and Pastel Orange gift tones |

Reels: 8 of 14 (2, 3, 5, 8, 10, 12, 13, 14); 7 of 14 if post 10 runs its back-up slides. Grid rhythm: C R R C R R C C R R C R C R.

Why the dates moved the way they did:
- **Diwali (Sun 8 Nov 2026; most calendars agree, VERIFY).** The provider post can't fall on it without putting providers before
  makers (seven posts would have to fit in the eight days from 31 Oct). So Diwali is a Story greeting on 8 Nov, and post 7 is
  re-anchored to the season ahead (National Day, Christmas, New Year gatherings) with a new, non-Diwali cover. Post 13 keeps its
  diya-table clip, with the line "Set the table for every celebration?".
- **Downtown Design (4 to 8 Nov at d3, VERIFY).** Falls on posts 3 and 4. Post 6 ("Keep your stall") comes after it, so its
  Downtown Design line is gone; the fair is in Stories that week. (Alternative: swap posts 4 and 6 so the established-maker post
  runs during the fair. Not done: post 4 is the main maker post and should lead.)
- **UAE National Day (Wed 2 Dec).** Post 14, the buyers Reel, with a one-line greeting in the caption, only if the Marketplace is
  open to buyers by then (planned 1 Dec). No flag, emblem or leaders' images.

## (b) Change list, post by post

**Everywhere**
- Maker- and provider-facing copy says Dubai, Abu Dhabi and Sharjah: post 1 headline, the one-liner (now on every end card),
  captions of posts 1, 2, 4, 5, 6, 7, 8, 11 and 12, the four DMs, the nomination check, Stories, the "Who made that?" series,
  site-fix notes, `#SharjahMakers` in the hashtags. Arabic one-liner updated (native check).
- Buyer-facing copy (post 14, the buyers audience line) keeps Dubai and Abu Dhabi: `oneLinerBuyers` = "Handmade pieces and
  creative services for homes in Dubai and Abu Dhabi."
- Providers: "based in Dubai, Abu Dhabi and Sharjah", bookings in homes in Dubai and Abu Dhabi (posts 7, 8, DM 4).
- End cards: always Cream, a photo strip, the title, the one-liner, the apply pill, the sign-off (carousels: `cta` layout;
  Reels: `end` layout). The "Know a maker? Tag them." lines moved into titles or captions.
- Every inner carousel slide: one headline and one short line, about twelve words. Steps, lists and Q&A answers moved to captions.
- New in `posts.json`: `colour` on every post, `campaign.palette`, `campaign.outreach` (Sharjah colleges, creative spaces,
  markets), `campaign.areaNote`, `oneLinerBuyers`, a "Student makers" series, three new shoot shots (14 to 16), a Sharjah
  site-fix (launch blocker), updated Stories (five weeks), verify items. Not added: Ajman, Al Ain, "apply anyway".
- `gallery.html`: v6 lede, headings, posts in date order, a Format and Lead colour column, the palette table, a "Where to look
  for makers" section.

**Post 1** (carousel 5, Clay). Headline "Handmade in Dubai, Abu Dhabi and Sharjah." Bands Clay, Pink, Tan, phone, Cream.
Slide 2 = new colourful flat-lay (`v-pieces.jpg`, 4:5 crop). Shorter lines throughout.

**Post 2** (Reel, 6 shots, ~30 s). Name tags exactly per the feedback, two-line style:
1 "A pair of earrings, / made for a bride" (classic: pearl and fine gold), 2 "A blanket, / crocheted for a new baby" (playful
pastel stripes), 3 "A cushion cover, / stitched by hand" (bold terracotta and indigo geometric), 4 "A painting, / made for a
first home" (colourful abstract), 5 "An heirloom chair, / brought back to life" (carved wood re-covered in a bold print).
The "Trove: handmade pieces…" lower third is gone; the end card carries the one-liner. Caption opening and manifesto use the
five tags; the wedding-card line is gone from both.
Clips: **keep** 02-1 (bowl, the hook). **Regenerate** 02-2 cushion (was green leaves on linen) and 02-3 chair (was a plain worn
arm, no print). **New** earrings, blanket, painting. **Dropped** 02-4 (lettering, now post 8) and 02-5 (shared table, now post 3).

**Post 3** (now a Reel, 5 shots). Hook on the shared table (02-5, reused), Makers = pink linocut, "Any style. Made by hand." over
four very different pieces, Providers = stylist with light blue linen, Buyers = green vase among plants. Pink cover card.

**Post 4** (carousel 6, Pink). New cover (candle in a rose-pink vessel, pink roses), slide 2 the range ("Pearls to cobalt
glaze."), example shop page, "Never sold anything?" on Tan, the offer on Charcoal ("Free to join."), Cream end card
("Know a maker? Tag them."). The list and steps slides are gone. Caption opens "Any style. Made by hand."

**Post 12** (Reel). A crocheted light blue toy (new), the candle (12-3, kept), a bright dog collar (new), cobalt plates (new),
jewel-toned beads (new). Last line on screen "Any style. Made by hand." Light Blue cover card, new cover photo `v-toy.jpg`.

**Post 5** (now a process Reel). Make (hand-bound notebook, new), photograph (12-4, moved), the example shop page on a phone
(a rendered frame, no clip), pack (silk scarf, new), courier (12-5, moved). Clay cover card.

**Post 6** (carousel 4, Tan). New cover (colourful stall in low sun), example shop page, "Keep all of it." on Charcoal, end card
"Tag a maker with a stall." Downtown Design line removed; "What Trove handles" moved into the caption.

**Post 7** (carousel 5, Pastel Orange in the photo). Not Diwali any more. New cover (seasonal table, pastel-orange roses,
clementines, brass). Slide 2 kintsugi (`v-kintsugi.jpg`, 4:5 crop) on Tan, the services page on a phone, "Services as
gifts, from December." on Charcoal, Cream end card.

**Post 13** (Reel, Light Green). Stylist (13-1), celebration table (13-3), photographer (13-4) kept; kintsugi and a botanical
mural new. 13-2 and 13-5 moved to post 8. Overlays: "Style homes?", "Set the table for every celebration?", "Take photos at
home?", "Mend what's broken?", "You're a provider".

**Post 8** (now a Reel, Light Blue). Pottery (13-2, moved), embroidery workshop (new), calligraphy (02-4, moved), kids' craft
birthday (new, children's hands only), pots held up (13-5, moved). How a booking works is in the caption.

**Post 9** (carousel 7, was 8, Sage). One question, one short line per photo: "Need a company? / Not to start." (Cream),
"What does it cost? / Nothing to join. Nothing if nothing sells." (Light Blue), "When a piece sells? / You keep 60%, paid every
other Tuesday." (Charcoal, the key slide), "Offer a service? / Free to list during launch." (Light Green), "How much to start? /
Four lovely pieces is a shop." (Light Blue, new photo `g-09-four.jpg`), Cream end card. The company answer and the 100% / 90%
service split are in the caption. The steps slide is gone.

**Post 10** (collab Reel, unchanged until a real maker agrees). Back-up: three photo slides (Clay, Pink with `v-four.jpg`,
Cream end card with `e-05.jpg`); the steps are in `altCaption`.

**Post 11** (carousel 3, Cream and Sage). Shorter lines; Sharjah and "in any style" in the caption.

**Post 14** (Reel, Wed 2 Dec, buyer-facing). Overlays and end card keep Dubai and Abu Dhabi; caption adds a National Day
greeting. Shot 5 replaced with the colourful flat-lay (`v-pieces.jpg`). Pink cover card.

## (c) For the producer (agent 2)

### Credits

| Item | Count | Each | Credits |
|---|---|---|---|
| New stills, gpt_image_2_5, high, 2k | 25 | 2.75 | 68.75 |
| New Kling 3.0 pro clips, 5 s, silent, 9:16 | 20 | 8.75 | 175.00 |
| **Total** | | | **243.75** |

Balance 435.5, so about 192 left after this; keep about 50 for retakes (a bad hand, a garbled object). Used again at no
cost: 15 existing clips (kept in their Reel: 02-1, 12-3, 13-1, 13-3, 13-4, 14-1 to 14-4; moved to another Reel: 02-4, 02-5,
12-4, 12-5, 13-2, 13-5), one rendered still (post 5's phone frame) and every other existing photo.

### New stills (all in `photos/prompts.json`, fifth element `{"status": "to-generate"}`)

Append the entry's style suffix (`HANDS6` or `STILL6`, not the old HANDS / STILL) to each prompt. Save to `photos/` under
the file name; copy each 9:16 Reel start frame into `video/start/` too.

| File | Aspect | Style | Used in |
|---|---|---|---|
| v-earrings.jpg | 9:16 | HANDS6 | post 2 shot 2 |
| v-blanket.jpg | 9:16 | HANDS6 | post 2 shot 3 |
| v-cushion.jpg | 9:16 | HANDS6 | post 2 shot 4 (replaces the 02-2 look) |
| v-painting.jpg | 9:16 | HANDS6 | post 2 shot 5 |
| v-chair-print.jpg | 9:16 | HANDS6 | post 2 shot 6 (replaces the 02-3 look) |
| v-linocut.jpg | 9:16 | HANDS6 | post 3 shot 2 |
| v-four.jpg | 9:16 | STILL6 | post 3 shot 3; post 10 back-up slide 2 (4:5 crop) |
| v-stylist.jpg | 9:16 | HANDS6 | post 3 shot 4 |
| v-vase.jpg | 9:16 | HANDS6 | post 3 shot 5 |
| v-toy.jpg | 9:16 | HANDS6 | post 12 shot 1 and cover |
| v-collar.jpg | 9:16 | HANDS6 | post 12 shot 3 |
| v-cobalt.jpg | 9:16 | HANDS6 | post 12 shot 4 |
| v-beads.jpg | 9:16 | HANDS6 | post 12 shot 5 |
| v-notebook.jpg | 9:16 | HANDS6 | post 5 shot 1 and cover |
| v-pack.jpg | 9:16 | HANDS6 | post 5 shot 4 |
| v-embroidery.jpg | 9:16 | HANDS6 | post 8 shot 2 |
| v-kids.jpg | 9:16 | HANDS6 | post 8 shot 4 |
| v-kintsugi.jpg | 9:16 | HANDS6 | post 13 shot 4; post 7 slide 2 (4:5 crop) |
| v-mural.jpg | 9:16 | HANDS6 | post 13 shot 5 |
| v-pieces.jpg | 9:16 | STILL6 | post 14 shot 5; post 1 slide 2 (4:5 crop) |
| g-04-pink.jpg | 4:5 | HANDS6 | post 4 cover |
| g-04-range.jpg | 4:5 | STILL6 | post 4 slide 2 |
| g-06-market.jpg | 4:5 | HANDS6 | post 6 cover |
| g-07-season.jpg | 4:5 | HANDS6 | post 7 cover |
| g-09-four.jpg | 4:5 | HANDS6 | post 9 slide 6 |

Check every new still before animating it: hands only, no faces (the kids' scene above all), no text or logos, no flags, the
pieces really are colourful (if one comes back beige, regenerate it), the name-tag scenes (post 2) have a fairly plain lower
middle where the tag sits. 9:16 stills used as 4:5 slides must still read when centre-cropped.

### New clips (all in `video/reels.js` with `status: 'new'`; motion prompt there, STYLE suffix included)

| Reel | Shot | Clip file | Start frame | Overlay |
|---|---|---|---|---|
| 2 | 2 | 02-earrings.mp4 | v-earrings.jpg | name-1 |
| 2 | 3 | 02-blanket.mp4 | v-blanket.jpg | name-2 |
| 2 | 4 | 02-cushion.mp4 | v-cushion.jpg | name-3 |
| 2 | 5 | 02-painting.mp4 | v-painting.jpg | name-4 |
| 2 | 6 | 02-chair.mp4 | v-chair-print.jpg | name-5 |
| 3 | 2 | 03-linocut.mp4 | v-linocut.jpg | l-1 |
| 3 | 3 | 03-pieces.mp4 | v-four.jpg | l-2 |
| 3 | 4 | 03-stylist.mp4 | v-stylist.jpg | l-3 |
| 3 | 5 | 03-vase.mp4 | v-vase.jpg | l-4 |
| 12 | 1 | 12-toy.mp4 | v-toy.jpg | hook |
| 12 | 3 | 12-collar.mp4 | v-collar.jpg | l-2 |
| 12 | 4 | 12-cobalt.mp4 | v-cobalt.jpg | l-3 |
| 12 | 5 | 12-beads.mp4 | v-beads.jpg | l-4 |
| 5 | 1 | 05-notebook.mp4 | v-notebook.jpg | hook |
| 5 | 4 | 05-pack.mp4 | v-pack.jpg | l-2 |
| 13 | 4 | 13-kintsugi.mp4 | v-kintsugi.jpg | l-3 |
| 13 | 5 | 13-mural.mp4 | v-mural.jpg | l-4 |
| 8 | 2 | 08-embroidery.mp4 | v-embroidery.jpg | l-1 |
| 8 | 4 | 08-kids.mp4 | v-kids.jpg | l-3 |
| 14 | 5 | 14-pieces.mp4 | v-pieces.jpg | l-4 |

New clip names never overwrite the old ones (02-2 and 02-3 stay in the clips folder, unused). Reused clips, moved between
Reels at no cost: 02-5 → post 3 shot 1; 12-4 → post 5 shot 2; 12-5 → post 5 shot 5; 13-2 → post 8 shot 1; 02-4 → post 8
shot 3; 13-5 → post 8 shot 5. Dropped: 12-1, 12-2 (no longer in any Reel).

### Renderer changes (render.js and video/build.js)

1. `BG` gains the brand colours v6 uses: `pink: '#F8D7E4'`, `green: '#CFDBBE'` (Light Green), `tan: '#BD9C8C'`,
   `char: '#292727'` (`blue: '#BED3DF'` is Light Blue and already there). No Pastel Orange band, on purpose.
2. On a `char` band (photo layout): headline, line and the URL line in Cream `#FDF7F5`; any wordmark on it with a Cream dot,
   never the Orange dot (never Charcoal with Orange). On `blue` (bands and Reel cover cards) the wordmark dot is Charcoal (never
   Light Blue with Orange). Keep the counter pill as it is.
3. `photo` layout: honour `f.pos` as the image's `object-position` (post 9's 16:9 photos are centre-cropped into 4:5 slides;
   check each crop, and if one fails, generate a 4:5 version from the same prompt from the retake reserve).
4. `reel-cover-photo`: the headline card takes its colour from `f.card` (cream, clay, pink, blue, green) instead of always Cream.
5. `end` layout: when `f.lead === null`, leave out the "Apply in about ten minutes." line (v6 Reel end cards carry the one-liner
   in `body` instead). Post 14 sets `lead: 'Shop at'` and its own pill, as before.
6. `cta` layout with `img` (carousel end cards): unchanged, but the body is now the one-liner (about 18 words); make sure it fits
   above the pill at 36 px (three lines) and drop the title to 72 px if needed.
7. `video/build.js`: a shot may have `still: '<frame id>'` instead of `clip`: use `out/post-NN/<id>.png` (rendered 1080×1920),
   looped for the shot length with a slow push-in (zoompan, about 1.00 to 1.05), no overlay when `overlay` is null. Post 5
   shot 3 uses it. Post 2 has six shots (about 30 s); the others five (about 26 s).
8. `export.py` needs no change: posts 3, 5 and 8 now carry `video`, so they export as Reels (reel.mp4 + cover.jpg).

Then: `node render.js`, `node video/build.js`, check every frame and Reel, rebuild the export, and nothing is posted.

## (d) Open questions for the owner

1. **Launch blocker: the website still says Dubai and Abu Dhabi.** The apply form ("Where are you based?"), the one-liner
   (homepage, meta description, About), the Sell page and FAQ, and the server's service area all refuse Sharjah. This round
   changed the posts only. Update the site and the Seller and Provider Agreements first, or hold every post that names Sharjah.
2. **The courier and Sharjah:** does it collect from makers there at the same cost and speed? (Posts promise "a courier
   collects from your door in Dubai, Abu Dhabi or Sharjah".)
3. **Buyer deliveries to Sharjah:** not decided, so buyer posts say Dubai and Abu Dhabi. The one-liner says the marketplace is
   "in Dubai, Abu Dhabi and Sharjah", which buyers may read as delivery there. Keep it, or say "for makers in…"?
4. **Providers:** will they travel to homes in Sharjah? Until then, posts say providers can be based there and bookings are in
   Dubai and Abu Dhabi homes.
5. **Ajman, Al Ain and "apply anyway" for other emirates:** not added. Your decision.
6. **Students:** student-visa selling and the 18-or-over rule (business adviser, agreements) before any college outreach.
7. **Diwali:** a Story greeting on Sun 8 Nov instead of a grid post (the order wouldn't allow it). Happy with that?
8. **National Day:** post 14 on Wed 2 Dec only if the Marketplace is open to buyers; greeting wording "National Day" or
   "Eid Al Etihad"?
9. **Downtown Design:** is the team going (4 to 8 Nov)? It is in Stories only now.
10. **Colour type cards:** the feedback's "photo, card, photo, card" would add text-only slides, which your 21 Oct rule and
    today's ask rule out; colour sits in the band under each photo instead. Agree?
11. **Arabic:** the new one-liner with Sharjah, the buyers line and the "Student makers" series title need a native check.

All feedback colours are already brand colours (checked against `docs/trove.html` `:root`): Pink #F8D7E4 (`--blush`), Pastel
Orange #FCC998 (`--peach`), Light Blue #BED3DF (`--sky`), Light Green #CFDBBE (`--moss`), Tan #BD9C8C (`--taupe`), Orange
#F19A82 (`--coral`), plus Clay #DBC7BD, Sage #CAD5CC, Cream #FDF7F5, Charcoal #292727. None was flagged.
