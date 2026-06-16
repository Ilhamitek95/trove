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
 *              This switches on the real card form at checkout. It is SAFE to be
 *              public. NEVER put the secret key (sk_...) here — that belongs only
 *              in the backend's .env file.
 *
 * Data is live whenever the backend is reachable. If it isn't, the storefront
 * gracefully falls back to a demo catalogue so the page still renders.
 */
window.TROVE_CONFIG = {
  API_URL: "",
  STRIPE_PUBLISHABLE_KEY: "",
};
