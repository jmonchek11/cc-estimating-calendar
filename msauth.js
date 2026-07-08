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

function getRedirectUri() {
  return process.env.MS_REDIRECT_URI ||
    (process.env.NODE_ENV === 'production'
      ? 'https://lis-estimating-calendar.onrender.com/auth/callback'
      : 'http://localhost:3000/auth/callback');
}

async function getAuthCodeUrl(state) {
  const cca = getClient();
  if (!cca) throw new Error('Microsoft sign-in is not configured');
  return cca.getAuthCodeUrl({
    scopes: ['user.read'],
    redirectUri: getRedirectUri(),
    state,
  });
}

async function acquireTokenByCode(code) {
  const cca = getClient();
  if (!cca) throw new Error('Microsoft sign-in is not configured');
  return cca.acquireTokenByCode({
    code,
    scopes: ['user.read'],
    redirectUri: getRedirectUri(),
  });
}

module.exports = { isConfigured, getAuthCodeUrl, acquireTokenByCode, getRedirectUri };
