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
function base(content) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f1f5f9;margin:0;padding:24px 16px}
  .wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .hdr{background:#1e293b;padding:20px 28px}
  .hdr h1{color:#fff;margin:0;font-size:17px;font-weight:700;letter-spacing:-.3px}
  .hdr p{color:#94a3b8;margin:4px 0 0;font-size:12px}
  .bdy{padding:24px 28px;color:#1e293b}
  h2{font-size:18px;margin:0 0 14px;color:#0f172a}
  p{margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569}
  table{width:100%;border-collapse:collapse;margin:14px 0}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;padding:7px 0;border-bottom:2px solid #e2e8f0}
  td{padding:8px 0;font-size:14px;color:#334155;border-bottom:1px solid #f1f5f9;vertical-align:top}
  td.lbl{font-size:12px;color:#64748b;width:110px;padding-right:12px}
  .btn{display:inline-block;background:#2563eb;color:#fff!important;padding:11px 22px;border-radius:7px;text-decoration:none;font-size:14px;font-weight:600;margin-top:18px}
  .pill{display:inline-block;padding:2px 9px;border-radius:12px;font-size:12px;font-weight:600}
  .pill-green{background:#dcfce7;color:#166534}
  .pill-red{background:#fee2e2;color:#991b1b}
  .pill-blue{background:#dbeafe;color:#1e40af}
  .pill-amber{background:#fef3c7;color:#92400e}
  .pill-gray{background:#f1f5f9;color:#475569}
  .ftr{background:#f8fafc;padding:14px 28px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center}
  .ftr a{color:#2563eb;text-decoration:none}
  .section{margin-bottom:24px}
  .section-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#64748b;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0}
  .bid-row{padding:10px 0;border-bottom:1px solid #f1f5f9}
  .bid-name{font-weight:600;font-size:14px;color:#0f172a}
  .bid-meta{font-size:12px;color:#64748b;margin-top:2px}
  .amount{font-weight:700;color:#166534}
  .overdue{color:#dc2626}
  @media(max-width:480px){.bdy{padding:18px 16px}.hdr{padding:16px 18px}}
</style></head><body>
<div class="wrap">
  <div class="hdr">
    <h1>🏗️ LIS Estimating Calendar</h1>
    <p>Liberty Integrated Solutions</p>
  </div>
  <div class="bdy">${content}</div>
  <div class="ftr">
    <a href="${APP_URL}">Open App</a> &nbsp;·&nbsp; LIS Estimating Calendar &nbsp;·&nbsp; libertyintegrated.com
  </div>
</div>
</body></html>`;
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

function emailAssigned(bid, recipientName, actorName, role) {
  const roleLabel = role === 'salesperson' ? 'salesperson' : 'estimator';
  // Deep-links straight to the bid's flyout when the caller's shape includes
  // ids (v2's bidEmailShape does); older/v1-shaped bid objects just don't
  // have these fields and fall back to the bare app URL.
  const hasDeepLink = bid.project_id && bid.bid_id;
  const link = hasDeepLink ? `${APP_URL}/#project/${bid.project_id}/bid/${bid.bid_id}` : APP_URL;
  return {
    subject: `You've been added to a bid — ${bid.project_name || bid.bid_number || 'Unnamed'}`,
    html: base(`
      <h2>📋 New Bid Assignment</h2>
      <p>Hi <strong>${recipientName}</strong>, <strong>${actorName}</strong> has added you as ${roleLabel === 'salesperson' ? 'the salesperson' : 'an estimator'} on a bid.</p>
      ${bidTable(bid)}
      <a href="${link}" class="btn">${hasDeepLink ? 'Open Bid' : 'Open App'}</a>
    `),
  };
}

function emailFollowup(bid, note, nextDate, loggedByName) {
  return {
    subject: `Follow-up logged — ${bid.project_name || bid.bid_number || 'Unnamed'}`,
    html: base(`
      <h2>📝 Follow-up Logged</h2>
      <p><strong>${loggedByName}</strong> logged a follow-up on a bid you're involved with.</p>
      ${bidTable(bid)}
      ${note ? `<div style="margin:14px 0;padding:12px 16px;background:#f8fafc;border-left:3px solid #cbd5e1;border-radius:4px;font-size:14px;color:#475569;font-style:italic">"${note}"</div>` : ''}
      ${nextDate ? `<p style="margin-top:12px">Next follow-up scheduled: <strong>${fmtDate(nextDate)}</strong></p>` : ''}
      <a href="${APP_URL}" class="btn">Open App</a>
    `),
  };
}

function emailAwarded(bid, actorName) {
  const amtStr = fmtCurrency(bid.estimate_amount);
  return {
    subject: `🎉 Bid Awarded — ${bid.project_name || bid.bid_number || 'Unnamed'}`,
    html: base(`
      <h2>🎉 Bid Awarded!</h2>
      <p><strong>${actorName}</strong> marked a bid as awarded${amtStr ? ` for <strong>${amtStr}</strong>` : ''}.</p>
      ${bidTable(bid)}
      <a href="${APP_URL}" class="btn">Open App</a>
    `),
  };
}

function emailReminder(bid, reminder, recipientName) {
  return {
    subject: `⏰ Reminder — ${bid.project_name || bid.bid_number || 'Unnamed'}`,
    html: base(`
      <h2>⏰ Bid Reminder</h2>
      <p>Hi <strong>${recipientName}</strong>, you have a reminder due today.</p>
      ${bidTable(bid)}
      ${reminder.note ? `<div style="margin:14px 0;padding:12px 16px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px;font-size:14px;color:#78350f">${reminder.note}</div>` : ''}
      <a href="${APP_URL}" class="btn">Open App</a>
    `),
  };
}

function emailDigest(digest) {
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

  return {
    subject: `📊 Weekly Estimating Digest — ${today}`,
    html: base(`
      <h2>📊 Weekly Digest</h2>
      <p style="color:#64748b">${today}</p>

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

      <a href="${APP_URL}" class="btn">Open App</a>
    `),
  };
}

const IDEA_STATUS_LABEL = { new: 'New', reviewed: 'Reviewed', done: 'Done', wontfix: "Won't Fix" };
const IDEA_TYPE_ICON = t => t === 'issue' ? '🐛 Bug/Issue' : '💡 Idea/Enhancement';

function emailIdeaSubmitted(idea, submitterName) {
  return {
    subject: `${idea.type === 'issue' ? '🐛' : '💡'} New ${idea.type === 'issue' ? 'bug report' : 'idea'} — ${idea.title}`,
    html: base(`
      <h2>${IDEA_TYPE_ICON(idea.type)}</h2>
      <p><strong>${submitterName || 'Someone'}</strong> just submitted a new ${idea.type === 'issue' ? 'bug report' : 'idea'}.</p>
      <table>
        <tr><td class="lbl">Title</td><td><strong>${idea.title}</strong></td></tr>
        ${idea.body ? `<tr><td class="lbl">Details</td><td>${idea.body}</td></tr>` : ''}
        ${idea.page ? `<tr><td class="lbl">Page</td><td>${idea.page}</td></tr>` : ''}
      </table>
      <a href="${APP_URL}" class="btn">Open App</a>
    `),
  };
}

function emailIdeaStatusChanged(idea, newStatus) {
  const label = IDEA_STATUS_LABEL[newStatus] || newStatus;
  const pillClass = newStatus === 'done' ? 'pill-green' : newStatus === 'wontfix' ? 'pill-gray' : 'pill-blue';
  return {
    subject: `${IDEA_TYPE_ICON(idea.type).split(' ')[0]} Your ${idea.type === 'issue' ? 'bug report' : 'idea'} was marked "${label}" — ${idea.title}`,
    html: base(`
      <h2>Update on your ${idea.type === 'issue' ? 'bug report' : 'idea'}</h2>
      <p><strong>${idea.title}</strong> is now <span class="pill ${pillClass}">${label}</span>.</p>
      <a href="${APP_URL}" class="btn">Open App</a>
    `),
  };
}

module.exports = { sendMail, emailAssigned, emailFollowup, emailAwarded, emailReminder, emailDigest, emailIdeaSubmitted, emailIdeaStatusChanged };
