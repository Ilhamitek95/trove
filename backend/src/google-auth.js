'use strict';
/**
 * "Sign in with Google" via Google Identity Services ID tokens.
 *
 * The browser obtains a signed ID token from Google and posts it to
 * /api/auth/google; we hand the token to Google's own tokeninfo endpoint,
 * which validates the signature for us, then we check it was minted for OUR
 * client id, for a verified email, and hasn't expired. At this traffic level
 * that's the simplest correct setup — swap in google-auth-library's
 * verifyIdToken (offline JWKS verification) if logins ever get hot.
 *
 * Needs GOOGLE_CLIENT_ID in the environment; without it enabled() is false,
 * /api/config reports googleClientId:null and the login page hides the button.
 */
const clientId = () => (process.env.GOOGLE_CLIENT_ID || '').trim() || null;
const enabled = () => !!clientId();

async function verifyIdToken(credential) {
  if (!credential) return null;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(credential)));
  if (!r.ok) return null;
  const t = await r.json();
  const issOk = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
  if (!issOk || t.aud !== clientId() || t.email_verified !== 'true') return null;
  if (!t.exp || Number(t.exp) * 1000 < Date.now()) return null;
  const email = String(t.email || '').trim().toLowerCase();
  if (!email) return null;
  return { email, name: t.name || t.given_name || email.split('@')[0] };
}

module.exports = { enabled, clientId, verifyIdToken };
