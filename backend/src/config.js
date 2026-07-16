'use strict';
/**
 * Feature flags + business rules for the two-rail payment architecture.
 * Everything env-driven is read at CALL time (not module load) so the test
 * suite can flip a flag mid-file without re-requiring the world.
 *
 *   RAIL_B_ENABLED           '1'/'true' switches on the Connect graduation rail
 *   VAT_REGISTERED           '1'/'true' once Trove is VAT-registered (5% capture)
 *   GRADUATION_THRESHOLD_AED trailing-30-day paid settlements that flag a
 *                            supplier for graduation (default 12000)
 */
const on = (v) => v === '1' || v === 'true';

const AGREEMENT_VERSION = 'v2';
const RETURN_WINDOW_DAYS = 7;

module.exports = {
  AGREEMENT_VERSION,
  RETURN_WINDOW_DAYS,
  railBEnabled: () => on(process.env.RAIL_B_ENABLED || ''),
  vatRegistered: () => on(process.env.VAT_REGISTERED || ''),
  graduationThresholdCents: () => {
    const aed = Number(process.env.GRADUATION_THRESHOLD_AED);
    return (Number.isFinite(aed) && aed > 0 ? aed : 12000) * 100;
  },
  // UAE VAT is 5%; prices are VAT-inclusive, so the tax inside a gross amount
  // is 5/105 of it.
  vatFromGross: (cents) => Math.round((cents * 5) / 105),
};
