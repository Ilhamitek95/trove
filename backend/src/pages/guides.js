'use strict';
/**
 * /guides — Trove's own guides: real, UAE-specific pages that can rank on
 * their own and send a reader to the shop, the Services Marketplace or the
 * application form. Written 4 Nov 2026 as the first content of the SEO plan
 * (the catalogue was empty, so these were the only pages with something to
 * say about handmade pieces and creative services in the UAE).
 *
 * Each guide is Markdown (src/markdown.js) built from the facts module, so
 * prices, areas and the maker's share never drift from the rest of the site.
 * English only: /guides is not in i18n.js LOCALIZED_RE, so no Arabic twin and
 * no hreflang. Add a guide = add an entry here; the sitemap, llms.txt and the
 * index page read this list.
 */

const GUIDES = [
  {
    slug: 'handmade-gifts-dubai',
    title: 'Handmade gifts in Dubai',
    h1: 'Handmade gifts in Dubai: a guide to pieces made in the UAE',
    description: 'Where to find handmade gifts in Dubai, Abu Dhabi and Sharjah, what they cost, how long they take, and how to get one delivered without the airport-gift feel.',
    intro: 'A gift made by someone who lives here says more than anything from a mall. This is how to find one, what to expect on price and timing, and how to have it delivered.',
    updated: '2026-11-04',
    md: (f) => `# Handmade gifts in Dubai

## Why a handmade gift, and why from here

Most gifts in Dubai come from the same few malls and the same few brands. A handmade piece is different in a way the person can feel: it was made in small numbers, often to order, by someone with a studio in Al Quoz, a kiln in Khalifa City or a workbench in a Sharjah flat. It carries a story you can tell when you hand it over.

The UAE has far more makers than most people realise. Ceramicists, candle makers, woodworkers, textile artists, printmakers and jewellers sell at weekend markets, through Instagram and, increasingly, through curated shops like Trove that bring them together in one place.

## What handmade gifts cost in the UAE

Prices are set by the maker and reflect materials and hours, not a brand mark-up. As a rough guide for pieces made here:

- **Small pieces** such as a mug, a candle, a print or a keyring: roughly AED 60 to AED 180.
- **Mid-size pieces** such as a bowl set, a cushion, a serving board or a small framed work: roughly AED 180 to AED 500.
- **Statement pieces** such as a large vase, a lamp, a rug or a commissioned work: AED 500 upwards, often made to order.

On Trove, delivery across ${f.areas} is ${f.deliveryFee} on orders of ${f.freeOver} and below, and free above that. Every piece shows its own delivery time on the page, because a made-to-order bowl takes longer than a print that is already on the shelf.

## How long a handmade gift takes

This is where handmade differs from a mall. Many pieces are made or finished after you order them. Most pieces on Trove arrive within ${f.deliveryDays}; made-to-order work can take a few weeks. If the gift is for a date, order early and read the delivery line on the piece.

A tip from our makers: if you are late, ask for a **gift note** and a photo of the finished piece to show on the day. The real thing follows.

## Gifts by occasion

- **Housewarming**: ceramics for the table, a wooden serving board, a scented candle poured locally, a cushion in a fabric you will not find in a chain store.
- **Weddings and engagements**: a pair of hand-thrown cups, a commissioned portrait of the couple, a calligraphy piece.
- **New baby**: a hand-stitched blanket, a wooden name sign, a small illustrated print for the nursery.
- **Eid and the festive season**: a dates platter, a set of glazed bowls, a hand-painted ornament.
- **Corporate gifts**: makers often take batch orders of 20 to 100 pieces with a longer lead time. Write to the maker through Trove before you order.

## Where to look

- **Weekend markets** in Dubai and Abu Dhabi are good for meeting makers in person, but the stock is whatever is on the table that day.
- **Instagram** is where most UAE makers started. It is wonderful for discovery and tedious for buying: messages, bank transfers, and delivery arranged by hand.
- **Trove** is a curated shop of pieces by independent makers in ${f.makerAreas}, with one checkout, card payment, delivery to your door and a ${f.returnDays}-day returns policy. Every maker is reviewed by a real person before their pieces go live. See [the shop](/shop) and [how curation works](/about#curation).

## Make it personal

Many makers take personalisation: a name on a mug, initials on a board, a colour you choose. On Trove, pieces that offer it show the options on the page. If you want something that does not exist yet, the [Services Marketplace](/services) lists makers who work to order, from custom portraits to pieces made for a particular room.

## Returns on handmade pieces

A handmade piece is not a lesser product because it is handmade. On Trove you have ${f.returnDays} days from delivery to ask for a return, and the [Delivery & Returns](/returns) page explains what happens with personalised pieces, which are made for you and cannot usually be resold.

## Are you a maker?

If you make things in ${f.makerAreas} and people keep asking where to buy them, Trove is built for you. There is nothing to pay up front, you set the price, and you keep ${f.makerShare}% of it. Read [how selling on Trove works](/sell-on-trove) or [apply](/apply).
`,
  },
  {
    slug: 'sell-handmade-uae',
    title: 'How to sell handmade products in the UAE',
    h1: 'How to sell handmade products in the UAE',
    description: 'The practical routes to selling handmade work in Dubai, Abu Dhabi and Sharjah: markets, Instagram, your own shop and curated marketplaces, plus what a licence means and when you need one.',
    intro: 'You make something people want. Here is how makers in the UAE actually sell it, what each route costs in time and money, and the licence question answered plainly.',
    updated: '2026-11-04',
    md: (f) => `# How to sell handmade products in the UAE

## The four ways makers sell here

Almost every maker in the UAE sells through some mix of these four routes. None of them is wrong; they suit different stages.

1. **Weekend markets and pop-ups.** You pay for a table, you stand behind it, you meet buyers face to face. Good for feedback and for your first hundred customers. Hard to scale: your income is capped by the hours you can stand there.
2. **Instagram and WhatsApp.** Free, and where most UAE makers started. Every sale is a conversation: a message, a bank transfer or a payment link, then a courier you book yourself. It works until it takes over your evenings.
3. **Your own online shop.** Full control, full responsibility: the website, payments, delivery, returns, photography and the traffic to make any of it worthwhile. Most makers find the traffic is the hard part.
4. **A curated marketplace.** Your pieces sit beside other makers' work in a shop that already has buyers, photography, delivery and customer service. You give up a share of the price in return. This is what Trove is.

## What Trove does for a maker

Trove is a curated marketplace for handmade pieces and creative services, open to makers in ${f.makerAreas}. It works like a shop, not a listing site:

- **Nothing up front.** No listing fee, no subscription, no photography bill.
- **You set the price and keep ${f.makerShare}% of it.** Trove buys each piece from you and resells it to the customer, so the customer deals with Trove for payment, delivery and returns, and you deal with Trove alone.
- **Photography and collection.** Trove photographs your pieces and collects them when they sell.
- **Payouts ${f.payoutRhythm}.**
- **A real person reviews every application**, and every shop is approved before it goes live. Read [how curation works](/about#curation).

The full terms are in the [Seller Agreement](/seller-agreement), written in plain English. If you also offer services, such as workshops, commissions or repairs, one account covers both: see the [Services Marketplace](/services).

## Do I need a licence to sell handmade work in the UAE?

This is the question every maker asks, so here is the honest answer: it depends on where you live, how much you sell and how you sell it. The rules are set by each emirate and they change, so treat this as a map, not legal advice.

- **Dubai** offers the e-Trader licence through the Department of Economy and Tourism for people selling online and through social media from home.
- **Abu Dhabi** has the Tajer Abu Dhabi licence for home-based businesses through its Department of Economic Development.
- **Sharjah** runs a home-business licence through its Economic Development Department.
- **Free zones** such as Shams, RAKEZ and twofour54 issue freelance permits that suit creative work.

Two numbers worth knowing for later: VAT registration becomes mandatory at AED 375,000 of taxable turnover in a year, and corporate tax has its own rules. When you get anywhere near those, speak to an accountant.

**On Trove**, the Seller Agreement explains when a licence becomes a condition of selling. In short, makers can start without one and Trove points to the licence step once a shop's paid sales pass ${f.licenceThreshold} in a trailing 30 days. Makers who already hold a licence can add it at application. Trove also runs an identity check on every maker, which protects buyers and makers alike.

## Pricing handmade work

The commonest mistake is pricing by what feels affordable. Price by what it costs you:

1. **Materials**, including the ones you waste.
2. **Your hours**, at a rate you would accept from an employer.
3. **Overheads**: kiln electricity, studio rent, packaging, tools divided across pieces.
4. **The channel's share.** On a marketplace that keeps ${100 - f.makerShare}%, set your list price so that ${f.makerShare}% of it still pays you properly.

If the number feels high, the answer is rarely to lower it. It is to make the piece more desirable, explain the work in the description, or make a smaller version for the lower price point.

## Photography sells the piece

Online, the photo is the piece. Natural light, a plain background, one shot that shows scale (a hand, a table) and one that shows the detail. On Trove, photography is part of what Trove does for you, so an honest phone photo is enough for the application.

## Delivery and returns in the UAE

Buyers here expect card payment, delivery to the door and a clear returns policy. If you sell on your own, you book the courier, chase the driver and refund by bank transfer. On Trove, delivery across ${f.areas} is handled by Trove (${f.deliveryFee} to the buyer on orders up to ${f.freeOver}, free above), and buyers have ${f.returnDays} days to ask for a return under the [Delivery & Returns](/returns) policy, which also explains how returns work for the maker.

## A sensible plan for your first year

- **Months 1 to 3**: sell through a curated marketplace and your own Instagram. Learn which pieces sell and at what price.
- **Months 3 to 6**: do one or two markets to meet buyers and hear what they say about your work.
- **Months 6 to 12**: if sales are steady, sort the licence that fits your emirate, and decide whether your own shop is worth the extra work.

Ready? [Apply to sell on Trove](/apply). Applications are reviewed by a real person, usually within a day or two.
`,
  },
  {
    slug: 'custom-portrait-dubai',
    title: 'Commissioning a custom portrait in Dubai',
    h1: 'Commissioning a custom portrait in Dubai: cost, timing and how it works',
    description: 'What a hand-painted portrait costs in Dubai and the UAE, how long it takes, what to send the artist, and how to book one from a local painter.',
    intro: 'A painted portrait is the gift people keep on the wall for decades. This is what it costs here, how the process works with a local artist, and how to avoid the two common disappointments.',
    updated: '2026-11-04',
    md: (f) => `# Commissioning a custom portrait in Dubai

## What a custom portrait costs in the UAE

Portrait prices depend on three things: the medium, the size and the number of people in the picture. As a guide from painters working in ${f.areas}:

- **Digital portrait**, sent as a file to print: roughly AED 150 to AED 400.
- **Pencil or charcoal on paper**: roughly AED 250 to AED 700.
- **Watercolour or gouache**: roughly AED 350 to AED 900.
- **Acrylic or oil on canvas**: AED 600 upwards, and AED 1,500 or more for larger canvases or several people.

Each additional person or pet usually adds 30 to 50 percent. Framing is separate. On Trove's Services Marketplace, [portrait painting](/services/timo/27-portrait-painting) starts from AED 350, with the final price confirmed by the artist once they have seen your photos and agreed the size.

## How long it takes

Allow two to four weeks for a painted portrait, and more in December. A digital portrait can be a few days. If the portrait is for a date, say so when you book: artists can often fit a smaller piece in sooner.

## What to send the artist

The quality of the portrait follows the quality of the reference photo. Send:

- **A sharp photo in natural light**, with the face filling a good part of the frame. Window light is better than a flash.
- **The expression you want.** A candid photo often paints better than a posed one.
- **Two or three alternatives** so the artist can combine the best angle with the best expression.
- **The setting and the size** of the wall it is for, so the artist can advise on canvas size.

Avoid heavily filtered photos, group shots where the face is tiny, and screenshots.

## How booking works on Trove

1. Choose a service on the [Services Marketplace](/services) and send a booking request with your photos and the date you have in mind.
2. The artist confirms the date and the final price.
3. Pay by card through Trove, or settle directly with the artist if they offer it. Your phone number is shared with the artist only once the booking is secured.
4. Agree a sketch or a progress photo before the artist commits to the final layer.
5. Collect, or have it delivered.

The artist, not Trove, is responsible for the work itself, and the [Services Terms](/services-terms) explain the rest in plain English.

## The two common disappointments, and how to avoid them

**It does not look like them.** This almost always comes from the reference photo. Spend time choosing it, and ask for a sketch stage.

**It arrived too late.** Agree the delivery date in writing when you book, and order before the rush.

## Portraits as gifts

A portrait of a couple for an anniversary, a grandparent for a milestone birthday, a child for the family home, or a pet for someone who loves them: see our guide to [pet portraits in the UAE](/guides/pet-portraits-uae). If you need the gift before the painting is ready, most artists will send a photo of the work in progress or a card to open on the day.

## Are you a portrait artist?

Trove lists artists and providers in ${f.makerAreas}. Listing is free during launch, Trove keeps ${f.serviceCommission}% of bookings paid through Trove and nothing of bookings settled directly, and a real person reviews every application. [Apply to offer services](/apply?for=services).
`,
  },
  {
    slug: 'pet-portraits-uae',
    title: 'Pet portraits in the UAE',
    h1: 'Pet portraits in the UAE: how to commission one',
    description: 'How to commission a hand-painted pet portrait in Dubai, Abu Dhabi or Sharjah: prices, timing, the photo to send, and local artists who take bookings.',
    intro: 'The UAE is full of rescued cats, salukis and dogs who flew here with their families. A painted portrait of one is the gift that gets the strongest reaction. Here is how to commission one well.',
    updated: '2026-11-04',
    md: (f) => `# Pet portraits in the UAE

## What a pet portrait costs

Pet portraits are priced like any portrait, by medium and size, but a single animal is often simpler than a person, so prices start a little lower:

- **Digital** pet portrait: roughly AED 120 to AED 350.
- **Watercolour or pencil**: roughly AED 250 to AED 600.
- **Acrylic or oil on canvas**: AED 450 upwards; more for two animals or a large canvas.

On Trove's Services Marketplace, [pet portraits](/services/timo/28-pet-portraits) start from AED 300, with the final price confirmed by the artist once the size is agreed.

## The photo makes the painting

With animals this matters even more than with people. The best reference photos:

- **Are taken at the animal's eye level**, not from above.
- **Use daylight**, ideally near a window or outside in the shade, never a flash (it flattens fur and gives the eyes a glow).
- **Are sharp on the eyes.** If the eyes are in focus, the artist can work with the rest.
- **Show the animal's own expression**: the head tilt, the half-open mouth, the ears.

Send three or four, and tell the artist which one is most like them. Old photos of pets who have passed are welcome; artists work from them often, and will tell you honestly if a photo is too small to paint from.

## Timing

Allow two to four weeks for a painted portrait and a week or less for digital. December fills up early with gifts, so book in November if it is for the festive season.

## How booking works

Send a booking request from the service page with your photos, the size you have in mind and any date. The artist confirms the date and final price, you pay by card through Trove or directly with the artist, and your phone number is shared only once the booking is secured. The [Services Terms](/services-terms) set out the rest.

## Memorial portraits

Many requests are for animals who have died. Artists treat these with care. If you have only one usable photo, say so; a good artist can still work from it, and will tell you what they can and cannot promise.

## Pet portraits as gifts

If the portrait is a surprise, send the photos yourself and ask the artist to keep the owner out of the loop. For the day itself, most artists will send a photo of the painting in progress or a small card to open while the canvas dries.

Looking for something else handmade? See our guide to [handmade gifts in Dubai](/guides/handmade-gifts-dubai), or browse [the Services Marketplace](/services) for commissions, workshops and more in ${f.areas}.
`,
  },
  {
    slug: 'handmade-ceramics-dubai',
    title: 'Handmade ceramics in Dubai',
    h1: 'Handmade ceramics in Dubai: how to buy, use and care for them',
    description: 'A buyer\'s guide to handmade ceramics in Dubai and the UAE: what makes a piece food-safe, why prices vary, how to care for glazed stoneware, and where local potters sell.',
    intro: 'Ceramics are the heart of handmade homeware in the UAE: hand-thrown mugs, glazed bowls, platters for the table. This guide covers what to look for, what things cost and how to keep them for years.',
    updated: '2026-11-04',
    md: (f) => `# Handmade ceramics in Dubai

## Why handmade ceramics look and feel different

A factory mug is identical to a million others. A hand-thrown mug carries the potter's hands: a slight unevenness in the rim, a glaze that pooled a little thicker on one side, a weight that feels right. Those are not flaws; they are the point. A good potter is consistent in the things that matter (food safety, stability, how the handle sits in your hand) and relaxed about the rest.

The UAE has a growing community of potters, many of them trained at studios in Dubai and Abu Dhabi, firing stoneware in electric kilns at home or in shared spaces.

## What to look for

- **Food-safe glaze.** For anything you eat or drink from, ask whether the glaze is food-safe and fired to stoneware temperature. Reputable makers say so in the listing.
- **A flat, finished foot.** Turn the piece over: the unglazed base should be smooth, so it does not scratch the table.
- **A handle that fits.** On a mug, two fingers should fit comfortably and the mug should balance when full.
- **Honest descriptions.** Dimensions, capacity, whether it is dishwasher and microwave safe, and whether each piece varies.

## What handmade ceramics cost in the UAE

Prices reflect clay, glaze, two kiln firings, and hours at the wheel:

- **Mugs and cups**: roughly AED 90 to AED 180.
- **Bowls and plates**: roughly AED 120 to AED 300 each; sets priced accordingly.
- **Vases, platters and lamps**: AED 300 upwards, and well above for large or sculptural pieces.

On Trove, ceramics from independent makers in ${f.makerAreas} are delivered across ${f.areas}; delivery is ${f.deliveryFee} on orders of ${f.freeOver} and below, and free above. Every piece shows its own delivery time, and you have ${f.returnDays} days from delivery to ask for a return.

## Caring for glazed stoneware

- **Dishwasher**: most stoneware with a fully glazed surface is dishwasher safe, but hand-washing keeps a glaze bright for longer. Follow what the maker says.
- **Microwave**: fine for most glazed stoneware without metallic lustres. Not for pieces with gold or platinum detail.
- **Thermal shock**: do not take a piece from the fridge to the oven. Let it come to room temperature first.
- **Crazing**: fine lines in a glaze are a feature of some finishes and a fault in others. Ask the maker; on a piece you eat from, a glaze that crazes can hold stains.
- **Chips**: a chipped rim on a mug is a reason to retire it from drinking; as a pen pot it will live for years.

## Commissioning ceramics

Potters often take commissions for a dinner set, a particular glaze or a colour to match a room, with a lead time of a few weeks to a couple of months. Trove's [Services Marketplace](/services) lists makers who work to order, and the service page explains how a booking works and when the final price is confirmed.

## Where to buy

Weekend markets, studio open days and Instagram are all good for meeting potters. For buying with card payment, delivery and returns in one place, see the ceramics on [Trove's shop](/shop). Every maker is reviewed by a real person before their pieces go live; read [how curation works](/about#curation).

## Are you a potter?

Trove is open to makers in ${f.makerAreas}, with nothing to pay up front, photography and collection by Trove, and ${f.makerShare}% of the list price to you. See [Sell on Trove](/sell-on-trove), or go straight to the [application](/apply).
`,
  },
  {
    slug: 'handmade-homeware-abu-dhabi-sharjah',
    title: 'Handmade homeware in Abu Dhabi and Sharjah',
    h1: 'Handmade homeware delivered in Abu Dhabi and Sharjah',
    description: 'Buying handmade homeware from UAE makers if you live in Abu Dhabi or Sharjah: delivery, timing, returns, and the makers and services available outside Dubai.',
    intro: 'Most handmade shops in the UAE quietly mean Dubai. Trove delivers and books services across Abu Dhabi and Sharjah too. Here is what that means in practice.',
    updated: '2026-11-04',
    md: (f) => `# Handmade homeware delivered in Abu Dhabi and Sharjah

## Delivery outside Dubai

Trove delivers handmade pieces across ${f.areas}. The delivery fee is ${f.deliveryFee} on orders of ${f.freeOver} and below, and free above. Every piece shows its own delivery time on its page: most arrive within ${f.deliveryDays}, with transit itself taking ${f.transitDays} once the maker has packed the piece. Made-to-order work takes longer and says so.

The returns policy is the same wherever you live: ${f.returnDays} days from delivery to ask for a return, with collection arranged by Trove. The [Delivery & Returns](/returns) page has worked examples.

## Makers in Abu Dhabi and Sharjah

Trove is open to makers based in ${f.makerAreas}, so the shop is not a Dubai shop with a long courier list. Potters in Khalifa City, textile makers in Al Ain Road studios, woodworkers in Sharjah's industrial areas and printmakers in Al Reem sell on the same terms as anyone in Al Quoz. Every maker is reviewed by a real person; see [how curation works](/about#curation).

## Services at your place

The [Services Marketplace](/services) covers in-person creative services, from commissioned portraits and made-to-order pieces to styling, repairs and workshops, booked from customers in ${f.areas}. Providers set their own service area, so a booking request from Abu Dhabi or Sharjah goes to providers who travel there or work remotely (a digital portrait does not care where you live).

## Timing tips for Abu Dhabi and Sharjah

- **Order early for dates.** Delivery from a Dubai studio to Abu Dhabi usually adds a day compared with a Dubai address.
- **Check the piece's own delivery line**, not the general policy. A print on the shelf and a bowl made to order are different promises.
- **Workshops and in-home services**: say which emirate you are in when you book, so the provider can confirm travel.

## What to buy first

If you are new to handmade, start with pieces you use every day and will notice: a set of hand-thrown mugs, a serving board, a cushion in a fabric nobody else has. Our guide to [handmade ceramics](/guides/handmade-ceramics-dubai) covers what to look for, and [handmade gifts in Dubai](/guides/handmade-gifts-dubai) is as true in Abu Dhabi and Sharjah.

## Are you a maker in Abu Dhabi or Sharjah?

Trove takes makers from all three emirates on the same terms: nothing to pay up front, photography and collection by Trove, and ${f.makerShare}% of the list price to you. [Apply to sell on Trove](/apply).
`,
  },
];

module.exports = { GUIDES };
