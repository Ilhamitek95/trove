'use strict';

// Trove currently operates in Dubai and Abu Dhabi only. Buyer delivery
// addresses, saved account addresses and seller locations are all
// constrained to these two emirates — widen this list to expand.
const SERVICE_AREAS = ['Dubai', 'Abu Dhabi'];

// A city/emirate string qualifies when it names one of the service areas
// anywhere in it ("Dubai Marina, Dubai", "Abu Dhabi, UAE", "dubai").
const isServiceable = (v) => {
  const s = String(v || '').toLowerCase();
  return SERVICE_AREAS.some((a) => s.includes(a.toLowerCase()));
};

module.exports = { SERVICE_AREAS, isServiceable };
