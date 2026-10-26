/*
 * trove — front-end settings.
 *
 * The site talks to a real backend. In the recommended SINGLE-ORIGIN setup the
 * same server serves these pages AND the API, so you can leave API_URL = ""
 * (requests automatically go to the same address).
 *
 *   API_URL  — leave "" when the backend serves this site (recommended).
 *              Only set a full URL like "https://trove.onrender.com" if you host
 *              the storefront separately from the API (no trailing slash).
 *
 *   STRIPE_PUBLISHABLE_KEY — your Stripe publishable key (starts with "pk_").
 *              It is SAFE to be public. NEVER put the secret key (sk_...) here —
 *              that belongs only in the backend's environment.
 *              The card form shows only when the SERVER can take payments too
 *              (/api/config cardPayments: a Stripe secret key is set). A
 *              STRIPE_PUBLISHABLE_KEY set in the server's environment takes
 *              over from this one (served by /api/config); this value stays
 *              the fallback, so leave it in place.
 *
 * Data is always live. If the backend can't be reached, the storefront retries
 * and then shows an outage page with a Retry button (F477): never a stand-in
 * catalogue. The demo catalogue appears only on localhost / file:// pages.
 */
window.TROVE_CONFIG = {
  API_URL: "",
  STRIPE_PUBLISHABLE_KEY: "pk_live_51TKeTDEZ2SmPRliVa9yjX2y1JKzJYzyC8JNxJHADhIqFiWABB3s3dC4n2uZkIdhu5lM3dEPG7pQlqx0Md5MXwz1B00n7To9K4z",
};
