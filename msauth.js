/**
 * msauth.js — Microsoft Entra ID (OIDC) sign-in, via MSAL Node's
 * ConfidentialClientApplication (server-side auth-code flow).
 *
 * Everything here must no-op gracefully when AZURE_* env vars aren't set —
 * the app deploys before Joe sets them in Render, and it must not crash.
 */
const { ConfidentialClientApplication } = require('@azure/msal-node');

function isConfigured() {
  return !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET);
}

let _cca = null;
function getClient() {
  if (!isConfigured()) return null;
  if (_cca) return _cca;
  _cca = new ConfidentialClientApplication({
    auth: {
      clientId: process.env.AZURE_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
  });
  return _cca;
}

// The app is reachable at more than one domain (the onrender.com URL and
// estimating.libertyintegrated.com), and the SSO round-trip must return to
// whichever one the user actually started from — the login session cookie
// that stores the CSRF state is host-scoped, so a mismatch here reads as
// "Invalid state" even though the code and Azure app registration are both
// fine. Compute it per-request from the incoming host by default; only fall
// back to a fixed value if MS_REDIRECT_URI is explicitly set (e.g. behind a
// proxy setup where the request host isn't trustworthy) or there's no
// request to read (there never is for this app, but keeps the function safe
// to call without one).
function getRedirectUri(req) {
  if (process.env.MS_REDIRECT_URI) return process.env.MS_REDIRECT_URI;
  if (req) return `${req.protocol}://${req.get('host')}/auth/callback`;
  return process.env.NODE_ENV === 'production'
    ? 'https://lis-estimating-calendar.onrender.com/auth/callback'
    : 'http://localhost:3000/auth/callback';
}

async function getAuthCodeUrl(state, req) {
  const cca = getClient();
  if (!cca) throw new Error('Microsoft sign-in is not configured');
  return cca.getAuthCodeUrl({
    scopes: ['user.read'],
    redirectUri: getRedirectUri(req),
    state,
  });
}

async function acquireTokenByCode(code, req) {
  const cca = getClient();
  if (!cca) throw new Error('Microsoft sign-in is not configured');
  return cca.acquireTokenByCode({
    code,
    scopes: ['user.read'],
    redirectUri: getRedirectUri(req),
  });
}

module.exports = { isConfigured, getAuthCodeUrl, acquireTokenByCode, getRedirectUri };
