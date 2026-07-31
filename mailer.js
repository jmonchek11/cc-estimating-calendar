const nodemailer = require('nodemailer');

const APP_URL = 'https://lis-estimating-calendar.onrender.com';

let _transporter = null;
function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
  }
  return _transporter;
}

// Every email this app sends was HTML-only — no text/plain part. A manually
// typed email always has both (Gmail generates the plain-text part for
// you); an HTML-only message is a well-known spam/phishing signal to most
// mail security gateways (GoDaddy/Microsoft included), and several can
// silently discard it AFTER accepting it during the SMTP handshake — no
// bounce, no visible quarantine entry, exactly the symptom that sent us
// looking here. Deriving a plain-text alternative from the HTML fixes this
// for every email template at once, in the one shared place they all funnel
// through, rather than touching each individual template.
function htmlToPlainText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '  ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Every category a person can individually opt out of, and the label shown
// for it in Settings — the one place this list needs to stay in sync with
// the toggles rendered there (public/v2.html renderSettings). Idea/issue
// submission-to-admin is deliberately NOT here: it always goes to one fixed
// admin inbox, not a roster of people who might want to turn it off.
const NOTIFICATION_CATEGORIES = {
  assigned: 'Bid/CO assignment',
  followup: 'Follow-up logged',
  awarded: 'Bid awarded (team-wide)',
  reminder: 'Reminders due',
  walkthrough: 'Jobsite walk-throughs',
  digest: 'Weekly digest',
  ideas: 'Idea/issue status updates',
};

// Missing member, missing prefs object, or missing key all mean "send it" —
// opt-OUT, not opt-in, so accounts that predate this feature (or a lookup
// that failed) keep getting what they already got rather than silently
// going dark. Only an explicit `false` suppresses a category.
function wantsNotification(member, category) {
  return member?.notification_prefs?.[category] !== false;
}

async function sendMail({ to, subject, html }) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('[email] skipped — no credentials configured');
    return;
  }
  const toArr = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!toArr.length) return;
  try {
    await getTransporter().sendMail({
      from: `"LIS Estimating Calendar" <${process.env.EMAIL_USER}>`,
      to: toArr.join(', '),
      subject,
      html,
      text: htmlToPlainText(html),
    });
    console.log('[email] sent:', subject, '->', toArr.join(', '));
  } catch (e) {
    console.error('[email] FAILED:', subject, e.message);
  }
}

// ── Base template ─────────────────────────────────────────────────────────────
// The logo (same file as the login screen) is white-on-transparent, so it
// only reads against a dark ground — hence the navy header rather than a
// plain white one. accent-bar echoes the red/blue/star rule under the
// wordmark in that same logo, the one visual through-line tying the email
// back to the app itself.
function base(content) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#e8ecf3;margin:0;padding:32px 16px}
  .wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.04),0 12px 32px rgba(15,23,42,.10)}
  .hdr{background:#0f172a;padding:28px 28px 24px;text-align:center}
  .hdr img{width:180px;max-width:60%;height:auto;display:inline-block}
  .accent-bar{height:4px;line-height:4px;font-size:0;background:linear-gradient(90deg,#5b8bb0 0%,#5b8bb0 33%,#dc2626 33%,#dc2626 50%,#2c4a6e 50%,#2c4a6e 67%,#dc2626 67%,#dc2626 84%,#5b8bb0 84%,#5b8bb0 100%)}
  .bdy{padding:32px 28px 8px;color:#1e293b}
  .icon-row td{border:none;padding:0;vertical-align:middle}
  .icon-badge{width:38px;height:38px;border-radius:10px;display:block}
  h2{font-size:19px;margin:0;color:#0f172a;font-weight:800;letter-spacing:-.2px}
  p{margin:0 0 14px;font-size:14px;line-height:1.65;color:#475569}
  table{width:100%;border-collapse:collapse;margin:16px 0}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;padding:7px 0;border-bottom:2px solid #eef1f6}
  td{padding:9px 0;font-size:14px;color:#1e293b;border-bottom:1px solid #eef1f6;vertical-align:top}
  td.lbl{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#94a3b8;width:112px;padding-right:12px}
  .btn-row-wrap{text-align:center;margin:22px 0 8px}
  .btn-row td{padding:0;border:none}
  .btn-row td.gap{width:10px}
  .btn{display:inline-block;background:#2563eb;color:#fff!important;padding:12px 22px;border-radius:9px;text-decoration:none;font-size:14px;font-weight:700;box-shadow:0 4px 10px rgba(37,99,235,.28)}
  .btn-outline{display:inline-block;background:#fff;color:#1e293b!important;padding:11px 20px;border-radius:9px;text-decoration:none;font-size:14px;font-weight:700;border:1.5px solid #dbe1ea}
  .pill{display:inline-block;padding:3px 10px;border-radius:99px;font-size:11.5px;font-weight:700}
  .pill-green{background:#dcfce7;color:#166534}
  .pill-red{background:#fee2e2;color:#991b1b}
  .pill-blue{background:#dbeafe;color:#1e40af}
  .pill-amber{background:#fef3c7;color:#92400e}
  .pill-gray{background:#f1f5f9;color:#475569}
  .ftr{background:#f8fafc;padding:18px 28px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;text-align:center}
  .ftr a{color:#2563eb;text-decoration:none;font-weight:600}
  .section{margin-bottom:26px}
  .section-title{font-size:12.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#64748b;margin-bottom:10px;padding-bottom:7px;border-bottom:1px solid #eef1f6}
  .bid-row{padding:11px 0;border-bottom:1px solid #f4f6f9}
  .bid-name{font-weight:700;font-size:14px;color:#0f172a}
  .bid-meta{font-size:12px;color:#64748b;margin-top:2px}
  .amount{font-weight:700;color:#166534}
  .overdue{color:#dc2626}
  @media(max-width:480px){.bdy{padding:24px 18px 4px}.hdr{padding:22px 18px 18px}}
</style></head><body>
<div class="wrap">
  <div class="hdr"><img src="${APP_URL}/logo.png" alt="Liberty Integrated Solutions — Estimating Calendar"></div>
  <div class="accent-bar">&nbsp;</div>
  <div class="bdy">${content}</div>
  <div class="ftr">
    <a href="${APP_URL}">Open App</a> &nbsp;·&nbsp; Estimating Calendar &nbsp;·&nbsp; libertyintegrated.com
  </div>
</div>
</body></html>`;
}

// Icon + heading, laid out as a table so Outlook's Word rendering engine
// (no flexbox support) still lines them up instead of stacking.
function iconHeading(iconUrl, text) {
  return `<table class="icon-row" role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:16px"><tr>
    <td style="width:38px"><img class="icon-badge" src="${iconUrl}" alt=""></td>
    <td style="padding-left:12px"><h2>${text}</h2></td>
  </tr></table>`;
}

// Two-up button row (primary action + an optional secondary one) — a
// centered table, so Outlook's Word rendering engine (no flexbox, and
// unreliable margin:auto on tables) still centers it; align="center" is
// the belt-and-suspenders attribute form Word actually honors.
function buttonRow(primary, secondary) {
  return `<div class="btn-row-wrap"><table class="btn-row" role="presentation" align="center" cellpadding="0" cellspacing="0"><tr>
    <td><a href="${primary.href}" class="btn">${primary.label}</a></td>
    ${secondary ? `<td class="gap">&nbsp;</td><td><a href="${secondary.href}" class="btn-outline">${secondary.label}</a></td>` : ''}
  </tr></table></div>`;
}

// Pure string/integer arithmetic on a "YYYY-MM-DD" + "HH:MM" pair — deliberately
// avoids the real Date object for this, since Date always resolves through
// SOME timezone (the server's, usually UTC on Render) and these values are
// meant to be taken as-is, wall-clock, in whatever timezone the recipient's
// own calendar is in. Only used to add a duration for the calendar link's
// end time, never to reinterpret the value in a different zone.
function addMinutesToDateTime(dateStr, timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMin = h * 60 + m + minutes;
  const dayOffset = Math.floor(totalMin / 1440);
  const remMin = ((totalMin % 1440) + 1440) % 1440;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return { date: d.toISOString().slice(0, 10), time: `${String(Math.floor(remMin / 60)).padStart(2, '0')}:${String(remMin % 60).padStart(2, '0')}` };
}

// "Add to Outlook" — Outlook Web's own compose-event deep link (no .ics
// attachment involved, which matters here: an attachment is one more thing
// a mail security gateway could flag, and we've already been burned once by
// this exact recipient's filtering). All-day when there's no specific time
// (a due date is just a date); a real 1-hour timed event when there is
// (a walk-through has an actual time on the clock).
function outlookCalendarLink({ subject, dateStr, timeStr, durationMinutes = 60, body }) {
  if (!dateStr) return null;
  const params = { path: '/calendar/action/compose', rru: 'addevent', subject: subject || 'Estimating Calendar', body: body || '' };
  if (timeStr) {
    const end = addMinutesToDateTime(dateStr, timeStr, durationMinutes);
    Object.assign(params, { startdt: `${dateStr}T${timeStr}:00`, enddt: `${end.date}T${end.time}:00` });
  } else {
    Object.assign(params, { allday: 'true', startdt: dateStr, enddt: addMinutesToDateTime(dateStr, '00:00', 24 * 60).date });
  }
  return `https://outlook.office.com/calendar/0/deeplink/compose?${new URLSearchParams(params).toString()}`;
}

// Every template that shows a single bid/CO ends with this — the primary
// "open it" action, plus an "Add to Outlook" button whenever there's a due
// date to attach (per-template callers no longer need to build the
// calendar link by hand).
function actionButtons(bid, primary) {
  const calLink = bid?.estimate_due_date ? outlookCalendarLink({
    subject: `Due: ${bid.project_name || bid.bid_number || 'Estimating Calendar'}`,
    dateStr: bid.estimate_due_date,
    body: [bid.bid_number ? `Bid #${bid.bid_number}` : null, bid.customer ? `Customer: ${bid.customer}` : null, primary.href].filter(Boolean).join('\n'),
  }) : null;
  return buttonRow(primary, calLink ? { href: calLink, label: '📅 Add Due Date to Outlook' } : null);
}

function fmtCurrency(n) {
  if (!n) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function fmtDate(d) {
  if (!d) return null;
  const [y, m, day] = d.split('-');
  return new Date(Number(y), Number(m) - 1, Number(day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function stageName(s) {
  return { opportunity: 'Opportunity', active_bid: 'Active Bid', active_co: 'Change Order', follow_up: 'Follow-up', awarded: 'Awarded', not_awarded: 'Not Awarded', closed: 'Closed' }[s] || s;
}

function bidTable(bid) {
  const rows = [
    ['Bid Name',  bid.project_name],
    ['Bid #',     bid.bid_number],
    ['Project',   bid.project_entity_name || bid.project_name],
    ['Customer',  bid.customer],
    ['Stage',     bid.stage ? stageName(bid.stage) : null],
    ['Due Date',  bid.estimate_due_date ? fmtDate(bid.estimate_due_date) : null],
    ['Value',     bid.estimate_amount ? fmtCurrency(bid.estimate_amount) : null],
  ].filter(([, v]) => v);

  return `<table>${rows.map(([l, v]) => `<tr><td class="lbl">${l}</td><td>${v}</td></tr>`).join('')}</table>`;
}

// ── Email builders ─────────────────────────────────────────────────────────────

function emailAssigned(bid, recipientName, actorName, role, scope) {
  const roleText = role === 'salesperson' ? 'the salesperson' : role === 'sub_estimator' ? 'a sub-estimator' : 'an estimator';
  // Deep-links straight to the bid's flyout when the caller's shape includes
  // ids (v2's bidEmailShape does); older/v1-shaped bid objects just don't
  // have these fields and fall back to the bare app URL.
  const hasDeepLink = bid.project_id && bid.bid_id;
  const link = hasDeepLink ? `${APP_URL}/#project/${bid.project_id}/bid/${bid.bid_id}` : APP_URL;
  const label = bid.project_name || bid.bid_number || 'Unnamed';
  return {
    subject: `You've been added to a bid — ${label}`,
    html: base(`
      ${iconHeading(`${APP_URL}/icon-active-bids.png`, 'New Bid Assignment')}
      <p>Hi <strong>${recipientName}</strong>, <strong>${actorName}</strong> has added you as ${roleText} on a bid${role === 'sub_estimator' && scope ? ` — scope: <strong>${scope}</strong>` : ''}.</p>
      ${bidTable(bid)}
      ${actionButtons(bid, { href: link, label: hasDeepLink ? 'Open Bid' : 'Open App' })}
    `),
  };
}

function emailFollowup(bid, note, nextDate, loggedByName) {
  return {
    subject: `Follow-up logged — ${bid.project_name || bid.bid_number || 'Unnamed'}`,
    html: base(`
      ${iconHeading(`${APP_URL}/icon-followup.png`, 'Follow-up Logged')}
      <p><strong>${loggedByName}</strong> logged a follow-up on a bid you're involved with.</p>
      ${bidTable(bid)}
      ${note ? `<div style="margin:14px 0;padding:12px 16px;background:#f8fafc;border-left:3px solid #cbd5e1;border-radius:4px;font-size:14px;color:#475569;font-style:italic">"${note}"</div>` : ''}
      ${nextDate ? `<p style="margin-top:12px">Next follow-up scheduled: <strong>${fmtDate(nextDate)}</strong></p>` : ''}
      ${actionButtons(bid, { href: APP_URL, label: 'Open App' })}
    `),
  };
}

function emailAwarded(bid, actorName) {
  const amtStr = fmtCurrency(bid.estimate_amount);
  return {
    subject: `🎉 Bid Awarded — ${bid.project_name || bid.bid_number || 'Unnamed'}`,
    html: base(`
      ${iconHeading(`${APP_URL}/icon-awarded.png`, 'Bid Awarded!')}
      <p><strong>${actorName}</strong> marked a bid as awarded${amtStr ? ` for <strong>${amtStr}</strong>` : ''}.</p>
      ${bidTable(bid)}
      ${buttonRow({ href: APP_URL, label: 'Open App' })}
    `),
  };
}

function emailReminder(bid, reminder, recipientName) {
  return {
    subject: `⏰ Reminder — ${bid.project_name || bid.bid_number || 'Unnamed'}`,
    html: base(`
      ${iconHeading(`${APP_URL}/icon-reminder.png`, 'Bid Reminder')}
      <p>Hi <strong>${recipientName}</strong>, you have a reminder due today.</p>
      ${bidTable(bid)}
      ${reminder.note ? `<div style="margin:14px 0;padding:12px 16px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px;font-size:14px;color:#78350f">${reminder.note}</div>` : ''}
      ${actionButtons(bid, { href: APP_URL, label: 'Open App' })}
    `),
  };
}

function walkthroughContactLine(contact) {
  if (!contact?.name && !contact?.phone) return '';
  return `<div style="margin:14px 0;padding:12px 16px;background:#ecfeff;border-left:3px solid #0891b2;border-radius:4px;font-size:14px;color:#0e7490">
    <strong>Site contact:</strong> ${contact.name || '—'}${contact.phone ? ` · ${contact.phone}` : ''}
  </div>`;
}

// Fires once, right when a walk-through date/time is set or rescheduled.
function emailWalkthroughSet(bid, walkthroughDate, walkthroughTime, recipientName, actorName, contact) {
  const hasDeepLink = bid.project_id && bid.bid_id;
  const link = hasDeepLink ? `${APP_URL}/#project/${bid.project_id}/bid/${bid.bid_id}` : APP_URL;
  const label = bid.project_name || bid.bid_number || 'Unnamed';
  const whenStr = fmtDate(walkthroughDate) + (walkthroughTime ? ` at ${fmtTime(walkthroughTime)}` : '');
  const calLink = outlookCalendarLink({
    subject: `Jobsite Walk-through: ${label}`,
    dateStr: walkthroughDate, timeStr: walkthroughTime,
    body: [bid.bid_number ? `Bid #${bid.bid_number}` : null, bid.customer ? `Customer: ${bid.customer}` : null, contact?.name ? `Site contact: ${contact.name}${contact.phone ? ' (' + contact.phone + ')' : ''}` : null, link].filter(Boolean).join('\n'),
  });
  return {
    subject: `🚶 Jobsite Walk-through Scheduled — ${label}`,
    html: base(`
      ${iconHeading(`${APP_URL}/icon-walkthrough.png`, 'Jobsite Walk-through Scheduled')}
      <p>Hi <strong>${recipientName}</strong>, <strong>${actorName}</strong> scheduled a jobsite walk-through for this bid — <strong>${whenStr}</strong>.</p>
      ${bidTable(bid)}
      ${walkthroughContactLine(contact)}
      ${buttonRow({ href: link, label: hasDeepLink ? 'Open Bid' : 'Open App' }, calLink ? { href: calLink, label: '📅 Add Walk-through to Outlook' } : null)}
    `),
  };
}

// Fires ~24 hours before, via the hourly cron in server.js.
function emailWalkthroughReminder(bid, walkthroughDate, walkthroughTime, recipientName, contact) {
  const hasDeepLink = bid.project_id && bid.bid_id;
  const link = hasDeepLink ? `${APP_URL}/#project/${bid.project_id}/bid/${bid.bid_id}` : APP_URL;
  const label = bid.project_name || bid.bid_number || 'Unnamed';
  const whenStr = walkthroughTime ? `tomorrow at ${fmtTime(walkthroughTime)}` : 'tomorrow';
  return {
    subject: `🚶 Walk-through Tomorrow — ${label}`,
    html: base(`
      ${iconHeading(`${APP_URL}/icon-walkthrough.png`, 'Walk-through Tomorrow')}
      <p>Hi <strong>${recipientName}</strong>, reminder — the jobsite walk-through for this bid is <strong>${whenStr}</strong>.</p>
      ${bidTable(bid)}
      ${walkthroughContactLine(contact)}
      ${buttonRow({ href: link, label: hasDeepLink ? 'Open Bid' : 'Open App' })}
    `),
  };
}

function emailDigest(digest, personal, recipientName) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Pipeline snapshot — counts only for opportunities/active bids/active COs
  // (nothing's been priced/committed yet); $ values only make sense once
  // something's actually been submitted, shown as both a 30-day window and
  // year-to-date.
  const ps = digest.pipelineSnapshot || {};
  const pipelineRows = `
    <tr><td>Opportunities</td><td style="text-align:center;font-weight:700">${ps.opportunities || 0}</td><td></td></tr>
    <tr><td>Active Bids</td><td style="text-align:center;font-weight:700">${ps.activeBids || 0}</td><td></td></tr>
    <tr><td>Active Change Orders</td><td style="text-align:center;font-weight:700">${ps.activeCos || 0}</td><td></td></tr>
    <tr><td>Submitted Bids — 30d</td><td style="text-align:center;font-weight:700">${ps.submittedBids?.last30?.count || 0}</td><td style="text-align:right;color:#166534">${fmtCurrency(ps.submittedBids?.last30?.value) || '—'}</td></tr>
    <tr><td>Submitted Bids — YTD</td><td style="text-align:center;font-weight:700">${ps.submittedBids?.ytd?.count || 0}</td><td style="text-align:right;color:#166534">${fmtCurrency(ps.submittedBids?.ytd?.value) || '—'}</td></tr>
    <tr><td>Submitted COs — 30d</td><td style="text-align:center;font-weight:700">${ps.submittedCos?.last30?.count || 0}</td><td style="text-align:right;color:#166534">${fmtCurrency(ps.submittedCos?.last30?.value) || '—'}</td></tr>
    <tr><td>Submitted COs — YTD</td><td style="text-align:center;font-weight:700">${ps.submittedCos?.ytd?.count || 0}</td><td style="text-align:right;color:#166534">${fmtCurrency(ps.submittedCos?.ytd?.value) || '—'}</td></tr>`;

  function bidListRows(bids, showAmt = false) {
    if (!bids || !bids.length) return `<p style="color:#94a3b8;font-size:13px;margin:6px 0">None this week</p>`;
    return bids.slice(0, 10).map(b => `
      <div class="bid-row">
        <div class="bid-name">${b.project_name || '—'}${b.bid_number ? ` <span style="color:#94a3b8;font-weight:400">#${b.bid_number}</span>` : ''}</div>
        <div class="bid-meta">
          ${b.customer || ''}${b.customer && (b.estimator_initials || b.salesperson_initials) ? ' · ' : ''}
          ${b.estimator_initials ? `Est: ${b.estimator_initials}` : ''}
          ${b.salesperson_initials ? ` Sales: ${b.salesperson_initials}` : ''}
          ${showAmt && b.estimate_amount ? ` · <span class="amount">${fmtCurrency(b.estimate_amount)}</span>` : ''}
        </div>
      </div>`).join('');
  }

  function dueDateRows(bids) {
    if (!bids || !bids.length) return `<p style="color:#94a3b8;font-size:13px;margin:6px 0">None upcoming</p>`;
    return bids.slice(0, 10).map(b => `
      <div class="bid-row">
        <div class="bid-name">${b.project_name || '—'}${b.bid_number ? ` <span style="color:#94a3b8;font-weight:400">#${b.bid_number}</span>` : ''}</div>
        <div class="bid-meta">
          Due <strong>${fmtDate(b.estimate_due_date)}</strong>
          ${b.estimator_initials ? ` · Est: ${b.estimator_initials}` : ''}
        </div>
      </div>`).join('');
  }

  function overdueRows(bids) {
    if (!bids || !bids.length) return `<p style="color:#166534;font-size:13px;font-weight:600;margin:6px 0">✅ No overdue follow-ups — great work!</p>`;
    return bids.slice(0, 10).map(b => `
      <div class="bid-row">
        <div class="bid-name">${b.project_name || '—'}${b.bid_number ? ` <span style="color:#94a3b8;font-weight:400">#${b.bid_number}</span>` : ''}</div>
        <div class="bid-meta">
          <span class="overdue">Follow-up due ${fmtDate(b.next_followup_date)}</span>
          ${b.salesperson_initials ? ` · Sales: ${b.salesperson_initials}` : ''}
          ${b.estimator_initials ? ` · Est: ${b.estimator_initials}` : ''}
        </div>
      </div>`).join('');
  }

  // Personal section — "what's on my plate" — goes first, above the
  // company-wide numbers, so the reader's own week is the first thing they
  // see Monday morning. Only rendered when a per-person digest was passed in
  // (the admin's on-demand "send test digest" can still call this without
  // one for a quick company-wide preview).
  const personalSection = personal ? `
      <div class="section" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 16px;margin-bottom:20px">
        <div class="section-title" style="margin-top:0">👋 Your Week${recipientName ? `, ${recipientName.split(' ')[0]}` : ''}</div>

        <div style="font-weight:700;font-size:13px;margin:10px 0 2px">Active Bids (${(personal.activeBids || []).length})</div>
        ${bidListRows(personal.activeBids, true)}

        <div style="font-weight:700;font-size:13px;margin:10px 0 2px">Your Upcoming Due Dates</div>
        ${dueDateRows(personal.upcomingDueDates)}

        <div style="font-weight:700;font-size:13px;margin:10px 0 2px">Recently Submitted (last 2 weeks)</div>
        ${bidListRows(personal.recentlySubmitted, true)}

        ${(personal.awardedThisWeek || []).length ? `
        <div style="font-weight:700;font-size:13px;margin:10px 0 2px">🎉 You Won This Week</div>
        ${bidListRows(personal.awardedThisWeek, true)}` : ''}

        <div style="font-weight:700;font-size:13px;margin:10px 0 2px">Your Overdue Follow-ups</div>
        ${overdueRows(personal.overdueFollowups)}
      </div>` : '';

  return {
    subject: `📊 Weekly Estimating Digest — ${today}`,
    html: base(`
      ${iconHeading(`${APP_URL}/icon-digest.png`, 'Weekly Digest')}
      <p style="color:#64748b">${today}</p>

      ${personalSection}

      ${personal ? '<p style="color:#64748b;font-weight:700;font-size:13px;margin:22px 0 4px">Company-Wide</p>' : ''}
      <div class="section">
        <div class="section-title">Pipeline Snapshot</div>
        <table>
          <thead><tr><th>Stage</th><th style="text-align:center">Count</th><th style="text-align:right">Value</th></tr></thead>
          <tbody>${pipelineRows}</tbody>
        </table>
      </div>

      ${(digest.awardedThisWeek || []).length ? `
      <div class="section">
        <div class="section-title">🎉 Awarded This Week</div>
        ${bidListRows(digest.awardedThisWeek, true)}
      </div>` : ''}

      <div class="section">
        <div class="section-title">📅 Upcoming Due Dates</div>
        ${dueDateRows(digest.upcomingDueDates)}
      </div>

      ${(digest.newOpportunities || []).length ? `
      <div class="section">
        <div class="section-title">🆕 New Opportunities This Week (${digest.newOpportunities.length})</div>
        ${bidListRows(digest.newOpportunities)}
      </div>` : ''}

      ${(digest.newActiveBids || []).length ? `
      <div class="section">
        <div class="section-title">🆕 New Active Bids This Week (${digest.newActiveBids.length})</div>
        ${bidListRows(digest.newActiveBids)}
      </div>` : ''}

      ${(digest.newActiveCos || []).length ? `
      <div class="section">
        <div class="section-title">🆕 New Change Orders This Week (${digest.newActiveCos.length})</div>
        ${bidListRows(digest.newActiveCos)}
      </div>` : ''}

      <div class="section">
        <div class="section-title">⚠️ Overdue Follow-ups</div>
        ${overdueRows(digest.overdueFollowups)}
      </div>

      ${buttonRow({ href: APP_URL, label: 'Open App' })}
    `),
  };
}

const IDEA_STATUS_LABEL = { new: 'New', reviewed: 'Reviewed', done: 'Done', wontfix: "Won't Fix" };
const IDEA_TYPE_ICON = t => t === 'issue' ? '🐛 Bug/Issue' : '💡 Idea/Enhancement';
const ideaIconUrl = t => `${APP_URL}/${t === 'issue' ? 'icon-issue' : 'icon-idea'}.png`;

function emailIdeaSubmitted(idea, submitterName) {
  return {
    subject: `${idea.type === 'issue' ? '🐛' : '💡'} New ${idea.type === 'issue' ? 'bug report' : 'idea'} — ${idea.title}`,
    html: base(`
      ${iconHeading(ideaIconUrl(idea.type), IDEA_TYPE_ICON(idea.type))}
      <p><strong>${submitterName || 'Someone'}</strong> just submitted a new ${idea.type === 'issue' ? 'bug report' : 'idea'}.</p>
      <table>
        <tr><td class="lbl">Title</td><td><strong>${idea.title}</strong></td></tr>
        ${idea.body ? `<tr><td class="lbl">Details</td><td>${idea.body}</td></tr>` : ''}
        ${idea.page ? `<tr><td class="lbl">Page</td><td>${idea.page}</td></tr>` : ''}
      </table>
      ${buttonRow({ href: APP_URL, label: 'Open App' })}
    `),
  };
}

function emailIdeaStatusChanged(idea, newStatus) {
  const label = IDEA_STATUS_LABEL[newStatus] || newStatus;
  const pillClass = newStatus === 'done' ? 'pill-green' : newStatus === 'wontfix' ? 'pill-gray' : 'pill-blue';
  return {
    subject: `${IDEA_TYPE_ICON(idea.type).split(' ')[0]} Your ${idea.type === 'issue' ? 'bug report' : 'idea'} was marked "${label}" — ${idea.title}`,
    html: base(`
      ${iconHeading(ideaIconUrl(idea.type), `Update on your ${idea.type === 'issue' ? 'bug report' : 'idea'}`)}
      <p><strong>${idea.title}</strong> is now <span class="pill ${pillClass}">${label}</span>.</p>
      ${buttonRow({ href: APP_URL, label: 'Open App' })}
    `),
  };
}

module.exports = { sendMail, emailAssigned, emailFollowup, emailAwarded, emailReminder, emailWalkthroughSet, emailWalkthroughReminder, emailDigest, emailIdeaSubmitted, emailIdeaStatusChanged, wantsNotification, NOTIFICATION_CATEGORIES };
