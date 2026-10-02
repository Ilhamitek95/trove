'use strict';
/**
 * /faq — the Help centre. Every "## Section {#id}" holds "### Question"
 * blocks whose following paragraphs are the answer; site-pages.js reads the
 * same source for the page, the FAQPage structured data and llms-full.txt.
 */
module.exports = (f) => `# Help centre

Answers for shoppers, makers and service providers. If yours is not here,
[contact us](/contact).

## Buying on Trove {#buying}

### Who am I buying from?

Trove. Trove is the seller of every product on troveathome.com: when your
order is confirmed, Trove buys the piece from its maker and sells it to you.
You pay Trove, and Trove is responsible to you for the order, including
returns and refunds. See the [Terms of Sale](/terms).

### How do I pay?

By card at checkout. Payments are processed securely by Stripe; Trove never
sees or stores your full card number. There is no service fee.

### Do I need an account to order?

No. You can check out as a guest with your email and UAE mobile number. An
account keeps your orders in one place, and it is where you follow
deliveries and request returns.

### Are the pieces really handmade?

Pieces in the Trove Marketplace are made by the makers themselves, in small
batches. Every maker is reviewed by a real person before their shop goes
live. See [how curation works](/about#curation). Handmade pieces vary a
little from one to the next, and that is part of their character.

### Can I order a personalised piece?

Yes, where a piece shows a personalisation option. Personalised pieces are
made for you, so they can be returned only if they are faulty, damaged or not
what you ordered.

## Delivery and returns {#delivery}

### Where do you deliver?

To addresses in ${f.areas} only.

### How much is delivery and how long does it take?

${f.deliveryFee} on orders of ${f.freeOver} and below, free on orders over
${f.freeOver}. Delivery time is shown on every piece: its maker's time to make
or finish and pack it, plus ${f.transitDays} with our courier. Most pieces
arrive in ${f.deliveryDays}; made-to-order pieces show their own time. An order
with pieces from several makers may arrive in more than one parcel.

### Can I return something?

Yes. You can ask to return a piece within **${f.returnDays} days of
delivery** from Your account → Orders. Once we approve it, our courier
collects it from you, and we refund you once the courier has collected the
return. See [Delivery & Returns](/returns).

### Is there a charge to return a piece?

Only for a change of mind on orders of ${f.freeOver} and below: a
${f.deliveryFee} collection fee is taken off the refund. There is no
collection fee when a piece is faulty, damaged or not what you ordered, and
none on orders over ${f.freeOver}.

### When will I get my refund?

We refund you once the courier has collected the return. The money goes back
to the card you paid with; your bank may take a few working days to show it.

## Selling on Trove: the maker handbook {#makers}

### Who can sell on Trove?

Makers in ${f.areas} who make their pieces themselves, at home or in a small
studio. Apply at [Sell on Trove](/apply); a real person reviews every
application.

### What does it cost to sell?

Nothing to join and no listing or monthly fee. You set each piece's price.
When a piece sells, Trove buys it from you at **${f.makerShare}% of your
price** and keeps ${f.commission}%, which pays for photography, marketing,
the storefront, checkout, delivery and customer care. See the
[Seller Agreement](/seller-agreement).

### How and when am I paid?

By bank transfer to an account in your own name, **${f.payoutRhythm}**. A
sale becomes payable once the piece has been delivered and the settlement
hold has passed; your Payments page shows exactly what is coming and when.

### Who delivers my pieces?

Trove books and pays for the courier. When a piece sells, you pack it in your
own packaging, mark it as packed in your dashboard, and the courier collects
it from your door.

### What happens when a buyer returns a piece?

Trove handles the buyer and the refund. The piece comes back to you by
courier and the purchase is reversed on a following payout, as the
[Seller Agreement](/seller-agreement) explains.

### What can I not sell?

Anything you did not make, anything counterfeit or unsafe, and anything
ingestible or applied to the skin: no food, drinks, cosmetics, skincare,
soap, perfume or supplements.

### Do I need a trade licence?

Trove buys your pieces and resells them, so many home makers can start
without one. If you do not have a licence, Trove will ask for your Emirates
ID and home address before your first payout, to verify who you are. As your
sales grow, you may be asked to get a UAE e-Trader or trade licence. Check
your own situation with the relevant authority if you are unsure.

## Services Marketplace {#services}

### Who provides the services?

Independent providers: makers, creatives and professionals running their own
businesses. Trove reviews every provider before listing them, but **the
provider, not Trove, is responsible for the service**. See the
[Services Terms](/services-terms).

### How do I pay for a service?

You choose when you send the booking request. **Settle directly** with the
provider (bank transfer, cash or as you agree): that payment is between you
and the provider, and Trove cannot refund it. Or **pay through Trove** by
card once the provider confirms, where available: Trove is then your
contracting party for that booking and refunds you in full if the service is
not delivered.

### How do I offer my services on Trove?

Apply at [Offer your services](/apply?for=services). Listing is free during
launch: the ${f.providerSub} monthly platform subscription starts later, with
30 days' notice. On bookings paid through Trove, Trove keeps
${f.serviceCommission}% of the price. See the
[Provider Agreement](/provider-agreement).

### How do providers get paid for bookings paid through Trove?

By bank transfer from **${f.providerPayer} on Trove's behalf**, so look for
that name on your statement. Your fee (the price less Trove's
${f.serviceCommission}% platform fee) is provisional until the service date has
passed and a ${f.providerGraceDays}-day window for any complaint or cancellation
has closed. It is then paid on the next payout day, every other Tuesday, the
same days Trove pays its makers. Add your bank
details under Payouts in your provider dashboard; each fee there shows when it
becomes payable and, once sent, the date and the transfer reference. Direct
bookings are settled between you and the customer, so Trove pays nothing on
them.

## Your account and your data {#account}

### I forgot my password. What do I do?

[Contact us](/contact) with the email address on your account and we will
help you back in.

### How do I see or delete my personal data?

Write to us through the [Contact page](/contact) and choose Privacy and my
data. The [Privacy Policy](/privacy) explains what we keep and your rights.
`;
