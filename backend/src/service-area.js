// Where Trove works (owner): Dubai, Abu Dhabi and Sharjah, on both sides.
//
//  - SERVICE_AREAS: the DEMAND side. Buyer delivery addresses, saved account
//    addresses, order address edits and service bookings (a customer's home).
//    Sharjah joined on 2026-10-27 ("oto does deliver to sharjah"), at the same
//    delivery price as the other two.
//  - MAKER_AREAS: the SUPPLY side. Where a maker or a service provider is
//    based, the shop's location, the courier pickup address and the maker's
//    home address for the identity check. Sharjah since 2026-10-26.
//
// The two lists are the same today but stay separate names, so one side can
// change without the other. Ajman, Umm Al Quwain, Ras Al Khaimah and Fujairah
// (and anything that names no accepted emirate, e.g. a bare 'Al Ain') are
// refused on both sides.
const SERVICE_AREAS = ['Dubai', 'Abu Dhabi', 'Sharjah'];
const MAKER_AREAS = ['Dubai', 'Abu Dhabi', 'Sharjah'];
// 'Dubai, Abu Dhabi and Sharjah', for error messages (errors.json keys).
const listAreas = (areas) => (areas.length < 2 ? areas.join('') : `${areas.slice(0, -1).join(', ')} and ${areas[areas.length - 1]}`);
const AREA_LIST = listAreas(SERVICE_AREAS);

// A city/emirate string qualifies when it names one of the service areas
// anywhere in it ("Dubai Marina, Dubai", "Abu Dhabi, UAE", "dubai"). A
// value carrying markup never qualifies, however it is spelt — the substring
// test alone would let "Dubai<img …>" through to every page that shows it.
const isServiceable = (v) => {
  const s = String(v || '').toLowerCase();
  if (/[<>]/.test(s)) return false;
  return SERVICE_AREAS.some((a) => s.includes(a.toLowerCase()));
};

// The four emirates Trove does not serve, in English spellings people type
// and in Arabic. An address whose area or street line names one of them is
// outside the service area even when the Emirate box says Dubai (F192: an
// address in another emirate with the box left on its old default was
// accepted, charged and booked with the courier as Dubai). Whole words only,
// so 'Ras Al Khor' (Dubai) never reads as Ras Al Khaimah. Sharjah left this
// list on 2026-10-27.
const OTHER_EMIRATES = /(^|[^a-z])(ajman|umm\s*al[\s-]*quwain|uaq|ras\s*al[\s-]*khaimah|fujairah|fujeirah)([^a-z]|$)|عجمان|أم\s*القيوين|ام\s*القيوين|رأس\s*الخيمة|راس\s*الخيمة|الفجيرة/i;
const namesOtherEmirate = (...parts) => OTHER_EMIRATES.test(parts.map((p) => String(p || '')).join(' '));

// The emirates no maker or provider may be based in (the same four).
const NON_MAKER_EMIRATES = OTHER_EMIRATES;
// An accepted supply-side emirate, in English or as typed on the Arabic pages.
const MAKER_AREA_WORDS = /dubai|abu\s*dhabi|(^|[^a-z])(sharjah|shj)([^a-z]|$)|دبي|أبو\s*ظبي|ابو\s*ظبي|الشارقة/i;

/**
 * Where a maker or provider is based, or where the courier collects from a
 * maker: names Dubai, Abu Dhabi or Sharjah, names none of the other four
 * emirates, and carries no markup. Never use this for a buyer's address.
 */
const isMakerArea = (...parts) => {
  const s = parts.map((p) => String(p || '')).join(' ');
  if (/[<>]/.test(s)) return false;
  return MAKER_AREA_WORDS.test(s) && !NON_MAKER_EMIRATES.test(s);
};

/**
 * A delivery address Trove can deliver to: its emirate (or city) names Dubai,
 * Abu Dhabi or Sharjah, and nothing in it names one of the other four.
 */
const isDeliverable = (a) => !!a && isServiceable(a.emirate || a.city) && !namesOtherEmirate(a.line, a.city, a.emirate);

/**
 * The courier emirate of an address: 'Dubai', 'Abu Dhabi' or 'Sharjah' (the
 * last of them named, since addresses end with the emirate; English or
 * Arabic), 'Dubai' when none is named. Used for maker pickups and, with the
 * address's Emirate box, for buyer deliveries.
 */
const EMIRATE_WORDS = [['Abu Dhabi', /abu\s*dhabi|أبو\s*ظبي|ابو\s*ظبي/gi], ['Sharjah', /sharjah|الشارقة/gi], ['Dubai', /dubai|دبي/gi]];
const emirateOf = (s) => {
  const v = String(s || '');
  let best = 'Dubai', at = -1;
  for (const [name, re] of EMIRATE_WORDS) {
    for (const m of v.matchAll(re)) if (m.index > at) { at = m.index; best = name; }
  }
  return best;
};

module.exports = { SERVICE_AREAS, MAKER_AREAS, AREA_LIST, listAreas, isServiceable, namesOtherEmirate, isDeliverable, isMakerArea, emirateOf };
