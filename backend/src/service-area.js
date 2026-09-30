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

module.exports = { SERVICE_AREAS, isServiceable };
