'use strict';
/**
 * The same facts as facts.js, worded for the Arabic help pages (about-ar,
 * delivery-returns-ar, faq-ar). Amounts stay 'AED 120' (the page wraps them
 * in a left-to-right isolate); numbers stay Western digits.
 */
const fees = require('../fees');
const { facts } = require('./facts');

/** Arabic counted noun for days: 1 يوم واحد, 2 يومان, 3–10 أيام, 11+ يوماً. */
const days = (n) => (n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n >= 3 && n <= 10 ? `${n} أيام` : `${n} يوماً`);
const range = (a, b) => `${a}–${b} ${b >= 3 && b <= 10 ? 'أيام' : 'يوماً'}`;
const weeks = (n) => (n === 1 ? 'أسبوع واحد' : n === 2 ? 'أسبوعين' : n >= 3 && n <= 10 ? `${n} أسابيع` : `${n} أسبوعاً`);

function factsAr() {
  const f = facts();
  const every = fees.SETTLEMENT_INTERVAL_DAYS;
  return {
    ...f,
    returnDaysText: days(f.returnDays),
    providerGraceText: days(f.providerGraceDays),
    payoutRhythm: every === 14 ? 'مرة كل أسبوعين، يوم الثلاثاء'
      : every === 7 ? 'أسبوعياً، كل يوم ثلاثاء'
        : `كل ${days(every)}، يوم الثلاثاء`,
    deliveryDays: range(fees.LEAD_DAYS_DEFAULT + fees.COURIER_TRANSIT_MIN_DAYS, fees.LEAD_DAYS_DEFAULT + fees.COURIER_TRANSIT_MAX_DAYS),
    transitDays: range(fees.COURIER_TRANSIT_MIN_DAYS, fees.COURIER_TRANSIT_MAX_DAYS),
    maxLeadText: weeks(f.maxLeadWeeks),
    areas: 'دبي وأبوظبي',
  };
}

module.exports = { factsAr, days, range };
