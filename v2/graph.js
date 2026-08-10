/**
 * v2/graph.js — Microsoft Graph client-credentials access, for reading the
 * shared HR calendar (hr@libertyintegrated.com) to detect estimator
 * out-of-office days on the Calendar tab.
 *
 * Separate from msauth.js's auth-code (interactive user sign-in) flow —
 * this is an app-only background read with no user context, using the
 * SAME Entra ID app registration/env vars as SSO
 * (AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET). Just needs the
 * Calendars.Read Application permission added + admin consent granted on
 * that registration — no new app registration needed.
 *
 * No-ops gracefully (empty result, logged warning) if that permission
 * isn't set up yet or the calendar can't be reached, so an unconfigured/
 * broken Graph connection never breaks the Calendar tab itself — the
 * out-of-office banner just silently doesn't appear.
 */
const { ConfidentialClientApplication } = require('@azure/msal-node');

const HR_CALENDAR_MAILBOX = 'hr@libertyintegrated.com';

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

async function getAppToken() {
  const cca = getClient();
  if (!cca) return null;
  try {
    const result = await cca.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
    return result?.accessToken || null;
  } catch (e) { console.error('[graph] token acquisition failed:', e.message); return null; }
}

// Raw all-day-flagged events between startDate/endDate ('YYYY-MM-DD',
// inclusive) — the caller (v2/db.js) does the "which estimator does this
// belong to" name-matching, this stays a thin Graph client. `end.dateTime`
// on an all-day event is exclusive (the day AFTER the last day covered),
// same convention as iCalendar — left as-is here, expanded by the caller.
async function getHrCalendarEvents(startDate, endDate) {
  const token = await getAppToken();
  if (!token) return [];
  try {
    const params = new URLSearchParams({
      startDateTime: `${startDate}T00:00:00`,
      endDateTime: `${endDate}T23:59:59`,
      $top: '250',
    });
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(HR_CALENDAR_MAILBOX)}/calendarView?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Eastern Standard Time"' },
    });
    if (!res.ok) {
      console.error('[graph] HR calendar read failed:', res.status, (await res.text().catch(() => '')).slice(0, 300));
      return [];
    }
    const data = await res.json();
    return (data.value || [])
      .filter(ev => ev.isAllDay)
      .map(ev => ({ subject: ev.subject || '', start: (ev.start?.dateTime || '').slice(0, 10), end: (ev.end?.dateTime || '').slice(0, 10) }))
      .filter(ev => ev.start);
  } catch (e) { console.error('[graph] HR calendar read failed:', e.message); return []; }
}

module.exports = { isConfigured, getHrCalendarEvents, HR_CALENDAR_MAILBOX };
