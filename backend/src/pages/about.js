'use strict';
/** /about — what Trove is, how curation works, who it is for. Markdown (src/markdown.js). */
module.exports = (f) => `# About Trove

Trove (also known as Trove at Home) is a curated online marketplace for
homeware and handmade pieces, based in Dubai and delivering across
**${f.areas}**. It brings together work by independent makers in the UAE,
chosen piece by piece, in one shop with one checkout, one delivery promise
and one returns policy.

## What you will find on Trove

- **The Trove Marketplace**: ceramics, textiles, prints, candles, wood,
  lighting and more, made in small batches by independent makers.
- **The Trove Collection**: Trove's own line of homeware, added as it
  arrives.
- **The Services Marketplace**: creative services at your place, from
  made-to-order pieces and repairs to styling, workshops and photography,
  offered by independent providers. See [Services](/services).

## How curation works {#curation}

Nothing appears on Trove by default. Every shop is chosen.

1. **Every maker applies.** They tell us who they are, what they make, how
   it is made and how many orders a month they can handle.
2. **A real person reviews every application.** We look at the quality of
   the work, the materials, whether it is genuinely made by the maker, and
   whether it would sit well beside the rest of Trove.
3. **Every shop is approved before it goes live**, and we keep an eye on the
   pieces listed after that. Anything that is not handmade by the maker, is
   unsafe, is counterfeit or is in a category we do not sell (nothing
   ingestible and nothing applied to the skin) comes down.
4. **We photograph and present the pieces** so they are shown honestly and
   well, and we write to makers when something needs changing.

Service providers go through the same kind of review before they are
listed. That review looks at the quality of their work as shown to us; it is
not an inspection, certification or background check, and the provider, not
Trove, is responsible for the service they deliver.

## Who Trove is for

- **People making a home in Dubai and Abu Dhabi** who would rather buy fewer,
  better things, made by someone they can name.
- **Gift buyers** looking for something personal, including pieces that can
  be made with a name or a message.
- **Makers** who make lovely things at home but do not want to run a shop:
  Trove takes care of the storefront, photography, marketing, checkout,
  delivery and customer care. See [Sell on Trove](/?view=sell).

## How buying on Trove works

- **Trove is the seller of every product you buy.** You pay Trove by card
  through Stripe, and Trove is responsible to you for the order, including
  returns and refunds. See the [Terms of Sale](/terms).
- Delivery takes **${f.deliveryDays}** to addresses in ${f.areas}. It costs
  **${f.deliveryFee} on orders of ${f.freeOver} and below** and is **free on
  orders over ${f.freeOver}**. There is no service fee.
- You can ask to return a piece within **${f.returnDays} days of delivery**;
  our courier collects it from you. See [Delivery & Returns](/returns).

## Where we work

Trove delivers to, and works with makers in, **${f.areas}**. We do not
deliver elsewhere in the UAE or abroad yet.
`;
