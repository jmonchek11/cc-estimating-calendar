/**
 * v2/hrCalendarFeed.js — reads the shared HR "days off" calendar via its
 * PUBLISHED .ics link (Outlook: calendar Settings → Shared Calendars →
 * Publish a Calendar → copy the ICS link), not Microsoft Graph.
 *
 * A published calendar's ICS URL is a plain, unauthenticated HTTP GET —
 * no Entra ID app permissions, no admin consent, nothing to configure in
 * Azure at all. Just needs HR_CALENDAR_ICS_URL set to that link.
 *
 * No-ops gracefully (empty result, logged warning) whenever the URL isn't
 * set or the fetch/parse fails — this feeds a "nice to have" banner on
 * the Calendar tab, never something that should break the page.
 */
function isConfigured() {
  return !!process.env.HR_CALENDAR_ICS_URL;
}

// Minimal RFC5545 reader — just enough to pull SUMMARY/DTSTART/DTEND out
// of each VEVENT block. Deliberately doesn't expand RRULE (a recurring
// "every Friday off" entry would only surface its first occurrence) —
// fine for the one-all-day-event-per-absence convention this calendar
// actually uses; revisit if that convention changes.
function parseIcs(text) {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    if (key.startsWith('SUMMARY')) cur.summary = value.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, ' ');
    else if (key.startsWith('DTSTART')) { cur.start = parseIcsDate(value); cur.isAllDay = !value.includes('T'); }
    else if (key.startsWith('DTEND')) cur.end = parseIcsDate(value);
  }
  return events;
}
function parseIcsDate(value) {
  // "20260815" (all-day) or "20260815T140000Z" / "20260815T140000" (timed)
  const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// All-day events whose range overlaps [startDate, endDate] ('YYYY-MM-DD').
async function getHrCalendarEvents(startDate, endDate) {
  const url = process.env.HR_CALENDAR_ICS_URL;
  if (!url) return [];
  try {
    const res = await fetch(url);
    if (!res.ok) { console.error('[hrCalendarFeed] fetch failed:', res.status); return []; }
    const text = await res.text();
    const events = parseIcs(text);
    return events.filter(ev => ev.isAllDay && ev.summary && ev.start && ev.start <= endDate && (ev.end || ev.start) >= startDate);
  } catch (e) { console.error('[hrCalendarFeed] fetch/parse failed:', e.message); return []; }
}

module.exports = { isConfigured, getHrCalendarEvents };
