'use strict';

// Trove currently operates in Dubai and Abu Dhabi only. Buyer delivery
// addresses, saved account addresses and seller locations are all
// constrained to these two emirates — widen this list to expand.
const SERVICE_AREAS = ['Dubai', 'Abu Dhabi'];

// A city/emirate string qualifies when it names one of the service areas
// anywhere in it ("Dubai Marina, Dubai", "Abu Dhabi, UAE", "dubai"). A
// value carrying markup never qualifies, however it is spelt — the substring
// test alone would let "Dubai<img …>" through to every page that shows it.
const isServiceable = (v) => {
  const s = String(v || '').toLowerCase();
  if (/[<>]/.test(s)) return false;
  return SERVICE_AREAS.some((a) => s.includes(a.toLowerCase()));
};

// The other five emirates, in English spellings people type and in Arabic.
// An address whose area or street line names one of them is outside the
// service area even when the Emirate box says Dubai (F192: 'Al Nahda,
// Sharjah' with the box left on its old default was accepted, charged and
// booked with the courier as Dubai). Whole words only, so 'Ras Al Khor'
// (Dubai) never reads as Ras Al Khaimah.
const OTHER_EMIRATES = /(^|[^a-z])(sharjah|shj|ajman|umm\s*al[\s-]*quwain|uaq|ras\s*al[\s-]*khaimah|fujairah|fujeirah)([^a-z]|$)|الشارقة|عجمان|أم\s*القيوين|ام\s*القيوين|رأس\s*الخيمة|راس\s*الخيمة|الفجيرة/i;
const namesOtherEmirate = (...parts) => OTHER_EMIRATES.test(parts.map((p) => String(p || '')).join(' '));

/**
 * A delivery address Trove can deliver to: its emirate (or city) names Dubai
 * or Abu Dhabi, and nothing in it names another emirate.
 */
const isDeliverable = (a) => !!a && isServiceable(a.emirate || a.city) && !namesOtherEmirate(a.line, a.city, a.emirate);

module.exports = { SERVICE_AREAS, isServiceable, namesOtherEmirate, isDeliverable };
