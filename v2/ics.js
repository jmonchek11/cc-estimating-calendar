/**
 * v2/ics.js — minimal RFC5545 (iCalendar) serialization.
 *
 * No date-time-with-timezone support on purpose: every DTSTART here is
 * either an all-day VALUE=DATE, or a "floating" local time (no Z, no
 * TZID) — fine for a single-office team where everyone's in the same
 * timezone. Revisit if remote/multi-timezone estimators become a thing.
 */
const pad = n => String(n).padStart(2, '0');

function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// RFC5545 §3.1: lines SHOULD be folded at 75 octets, continuation lines
// start with a single space. Not every parser enforces this, but some
// (older Outlook) do, so it's worth doing right.
function foldLine(line) {
  if (line.length <= 75) return line;
  let out = line.slice(0, 75);
  let rest = line.slice(75);
  while (rest.length) {
    out += '\r\n ' + rest.slice(0, 74);
    rest = rest.slice(74);
  }
  return out;
}

function dtstampNow() {
  const d = new Date();
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const dateOnly = dateStr => dateStr.replace(/-/g, '');

function addOneDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

// { uid, summary, description?, dateStr, timeStr? } → one VEVENT block.
// timeStr present → a timed floating-local event; absent → all-day.
function buildVEvent({ uid, summary, description, dateStr, timeStr }) {
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtstampNow()}`];
  if (timeStr) {
    const [h, m] = timeStr.split(':');
    lines.push(`DTSTART:${dateOnly(dateStr)}T${pad(h)}${pad(m)}00`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(dateStr)}`);
    lines.push(`DTEND;VALUE=DATE:${addOneDay(dateStr)}`);
  }
  lines.push(`SUMMARY:${icsEscape(summary)}`);
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  lines.push('END:VEVENT');
  return lines.map(foldLine).join('\r\n');
}

// vevents: array of pre-built VEVENT block strings (from buildVEvent).
function buildCalendar(vevents, calName) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Liberty Integrated Solutions//Estimating Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldLine(`X-WR-CALNAME:${icsEscape(calName)}`),
    // Hints, not guarantees — Apple Calendar mostly respects these; Google
    // Calendar polls on its own schedule (roughly every 12-24h) regardless.
    'X-PUBLISHED-TTL:PT12H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    ...vevents,
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}

module.exports = { buildVEvent, buildCalendar };
