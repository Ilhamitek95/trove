'use strict';
/** /returns (also /delivery-returns) — delivery and returns, with examples. Markdown (src/markdown.js). */
module.exports = (f) => `# Delivery & Returns

Trove is the seller of every product on troveathome.com, so there is one
delivery promise and one returns policy, whichever maker made your piece.

## Where we deliver {#delivery}

We deliver to addresses in **${f.areas}** only. Checkout will not accept an
address anywhere else. We need a UAE mobile number with every order so the
courier can reach you.

## What delivery costs

- Orders of **${f.freeOver} and below**: **${f.deliveryFee}** delivery.
- Orders **over ${f.freeOver}**: **free delivery**.
- There is no service fee and nothing added at the door. The delivery
  charge is shown in your basket and at checkout before you pay.

## How long it takes

**Delivery time is shown on every piece** — on its page, in your basket and
at checkout. It is the time its maker needs to make or finish and pack it,
plus **${f.transitDays}** with our courier, counted from the day your order is
confirmed. **Most pieces arrive in ${f.deliveryDays}**; made-to-order pieces
show their own time, which can be up to ${f.maxLeadWeeks} weeks. Each piece is
packed by its maker and collected from their studio by our courier, so an
order with pieces from several makers may arrive in more than one parcel, as
each is ready. You can follow every parcel from **Your account →
Orders**, and the courier will contact you on your mobile number.

## Returns: ${f.returnDays} days from delivery {#returns}

You can ask to return a piece within **${f.returnDays} days of the day it was
delivered**. You do not need to post anything: once we approve the return,
our courier collects it from you.

For a change of mind, the piece must be unused and in the condition you
received it, with its packaging where possible.

## How to return a piece

1. Go to **Your account → Orders** and open the order.
2. Choose **Request a return**, pick the pieces going back and tell us why. A
   photo helps, and we may ask for one if a piece arrived damaged.
3. We review the request and email you our decision.
4. Once approved, our courier contacts you to collect the piece.
5. **We refund you once the courier has collected the return.**

## Refunds

Refunds go back to the card you paid with. Your bank may take a few working
days to show the money. The refund covers the price you paid for the
returned pieces, including any paid extras such as gift wrap, less the
collection fee where it applies (see below). The original delivery charge is
refunded too when the **whole order** comes back because it arrived faulty or
damaged, was the wrong item or was not as described; otherwise, including on
any change-of-mind return, it is kept.

## The collection fee

- On orders of **${f.freeOver} and below**, a change-of-mind return carries
  a **${f.deliveryFee} collection fee**, taken off the refund.
- On orders **over ${f.freeOver}**, collection is **free**.
- The fee is charged **per return request**, so if you are sending back more
  than one piece, send them back together and it is charged once.
- **There is never a collection fee when a piece is faulty, damaged or not
  what you ordered**, whatever the order value.

Examples: you return a ${f.exPiece} vase from a ${f.exPiece} order because you
changed your mind: you receive ${f.exPieceLessFee}. The same vase arrives
chipped: you receive ${f.exPiece}. You return a ${f.exPiece} vase from a
${f.exBigOrder} order because you changed your mind: you receive ${f.exPiece}.

## Personalised pieces {#personalised}

Pieces made with a name, initials or a message are made just for you, so
they can be returned **only if they are faulty, damaged or not what you
ordered**, including a personalisation that does not match what you asked
for.

## Faulty, damaged or wrong pieces

If a piece arrives damaged, faulty or is not what you ordered, request a
return within ${f.returnDays} days of delivery and choose the reason that fits.
There is no collection fee, and we refund the full price of the piece once
the courier has collected it. Nothing here affects your rights as a consumer
under UAE law.

## Services bookings

Bookings on the Services Marketplace are not deliveries and are not covered
by this page. The provider, not Trove, is responsible for the service; see
the [Services Terms](/services-terms) for how payment, cancellations and
refunds work there.

## Questions

See the [Help centre](/faq) or [contact us](/contact). Please include your
order number (it starts with TRV-).
`;
