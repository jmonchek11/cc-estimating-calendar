// ── Config ────────────────────────────────────────────────────────────────────
const REFRESH_INTERVAL   = 60 * 1000;  // re-fetch every 60 s
const WIN_CYCLE_INTERVAL =  7 * 1000;  // cycle wins every 7 s
const PAGE_INTERVAL      =  8 * 1000;  // scroll to next page every 8 s
const ROW_HEIGHT         = 128;        // px — must match .tv-row height in CSS
const LOOKAHEAD_DAYS     = 14;         // show bids due within this many days

const PALETTE = ['#2563eb','#16a34a','#dc2626','#d97706','#7c3aed','#0891b2','#be185d','#ea580c'];
function estimatorColor(id) {
  if (!id) return '#475569';
  return PALETTE[Number(id) % PALETTE.length];
}

// ── Token ─────────────────────────────────────────────────────────────────────
// Accepts token from either:
//   /tv/MY-TOKEN       ← path style (preferred for Fully Kiosk)
//   /tv?token=MY-TOKEN ← query string style
(function () {
  const parts = window.location.pathname.split('/').filter(Boolean);
  // parts[0] = 'tv', parts[1] = token (if path style)
  window._TV_TOKEN = parts[1] || new URLSearchParams(window.location.search).get('token') || '';
})();
const TV_TOKEN = window._TV_TOKEN;

// ── Clock ─────────────────────────────────────────────────────────────────────
function tickClock() {
  const now = new Date();
  document.getElementById('tv-time').textContent =
    now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  document.getElementById('tv-date').textContent =
    now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtCurrency(n) {
  if (!n) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return '$' + n;
}

function duePill(dateStr) {
  if (!dateStr) return { html: '<span class="tv-due-pill none">No Date</span>', overdue: false };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due   = new Date(dateStr + 'T00:00:00');
  const days  = Math.round((due - today) / 86400000);

  if (days < 0)  return { html: `<span class="tv-due-pill red">OVERDUE ${Math.abs(days)}d</span>`, overdue: true };
  if (days === 0) return { html: `<span class="tv-due-pill red">DUE TODAY</span>`, overdue: true };
  if (days <= 3)  return { html: `<span class="tv-due-pill red">${days}d</span>`, overdue: false };
  if (days <= 7)  return { html: `<span class="tv-due-pill amber">${days}d</span>`, overdue: false };
  return            { html: `<span class="tv-due-pill green">${days}d</span>`, overdue: false };
}

function fmtAwardDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US',
    { month: 'short', day: 'numeric', year: 'numeric' });
}

// "10:00" (24h, as stored) -> "10:00 AM" for display.
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// A walk-through date is informational, not a deadline — no red/amber
// urgency coloring or overdue pulsing the way a bid's due date gets (see
// duePill below); just a neutral "when" that reads clearly from across
// the room.
function walkPill(dateStr, timeStr, small) {
  if (!dateStr) return small ? '' : '<span class="tv-due-pill none">No Date</span>';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  const days = Math.round((d - today) / 86400000);
  const label = days === 0 ? 'TODAY' : days === 1 ? 'TOMORROW'
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  // Date + time stacked on two lines, not side by side — "Wed, Oct 1 ·
  // 10:00 AM" as one line was wide enough to overflow the fixed due-date
  // column on the actual board (confirmed in preview).
  const cls = small ? 'tv-walk-pill-sm' : 'tv-due-pill tv-walk-pill';
  return `<span class="${cls}">${label}${timeStr ? `<span class="tv-walk-pill-time">${fmtTime(timeStr)}</span>` : ''}</span>`;
}

// ── Pager / Auto-scroll ───────────────────────────────────────────────────────
let _pageInterval = null;
let _currentPage  = 0;
let _totalPages   = 1;

function calcRowsPerPage() {
  const wrap = document.getElementById('tv-rows-wrap');
  if (!wrap) return 6;
  return Math.max(1, Math.floor(wrap.clientHeight / ROW_HEIGHT));
}

function goToPage(page) {
  _currentPage = page;
  const rowsEl = document.getElementById('tv-rows');
  const rpp    = calcRowsPerPage();
  rowsEl.style.transform = `translateY(-${page * rpp * ROW_HEIGHT}px)`;
  document.querySelectorAll('.tv-pager-dot').forEach((dot, i) =>
    dot.classList.toggle('active', i === page));
}

function startPager(totalRows) {
  if (_pageInterval) { clearInterval(_pageInterval); _pageInterval = null; }
  const rpp = calcRowsPerPage();
  _totalPages  = Math.max(1, Math.ceil(totalRows / rpp));
  _currentPage = 0;

  const pagerEl = document.getElementById('tv-pager');
  pagerEl.innerHTML = Array.from({ length: _totalPages }, (_, i) =>
    `<div class="tv-pager-dot${i === 0 ? ' active' : ''}"></div>`
  ).join('');

  goToPage(0);

  if (_totalPages > 1) {
    _pageInterval = setInterval(() => goToPage((_currentPage + 1) % _totalPages), PAGE_INTERVAL);
  }
}

// ── Render Rows ───────────────────────────────────────────────────────────────
function renderRows(bids) {
  const rowsEl = document.getElementById('tv-rows');

  // Build date window: today → today + LOOKAHEAD_DAYS
  const today  = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + LOOKAHEAD_DAYS);
  const todayStr  = today.toISOString().split('T')[0];
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // Filter to only bids with a due date inside the window (no overdue, no far-future)
  const filtered = (bids || []).filter(b =>
    b.estimate_due_date && b.estimate_due_date >= todayStr && b.estimate_due_date <= cutoffStr
  );

  // Update the window label in the table header
  const rangeEl = document.getElementById('tv-date-range');
  if (rangeEl) {
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    rangeEl.textContent = `${fmt(today)} – ${fmt(cutoff)}`;
  }

  if (!filtered.length) {
    rowsEl.innerHTML = '<div class="tv-empty">Nothing due in the next ' + LOOKAHEAD_DAYS + ' days 🎉</div>';
    startPager(0);
    return;
  }

  // Sort by due date ascending
  const sorted = [...filtered].sort((a, b) =>
    a.estimate_due_date < b.estimate_due_date ? -1 : a.estimate_due_date > b.estimate_due_date ? 1 : 0
  );

  rowsEl.innerHTML = sorted.map(b => {
    const isWalk = b.stage === 'walkthrough';
    const typeBadge = isWalk ? '<span class="tv-type walk">WALK</span>'
      : b.stage === 'active_co' ? '<span class="tv-type co">CO</span>'
      : '<span class="tv-type bid">BID</span>';

    // Walk-throughs can have several assignees — stack up to 3 avatars,
    // "+N" beyond that. A bid/CO row shows the lead estimator at full size
    // plus each sub-estimator's own avatar at ~3/4 size next to it, per Joe
    // — not just a note at the bottom of the project.
    let avatarsHtml;
    if (isWalk && (b.assignees || []).length) {
      const shown = b.assignees.slice(0, 3);
      const extra = b.assignees.length - shown.length;
      avatarsHtml = `<div class="tv-avatars">${shown.map(a =>
        `<div class="tv-avatar-sm" style="background:${estimatorColor(a.id)}">${esc(a.initials || '?')}</div>`).join('')}${
        extra > 0 ? `<div class="tv-avatar-more">+${extra}</div>` : ''}</div>`;
    } else {
      const subAvatars = (b.sub_estimators || []).slice(0, 1).map(s =>
        `<div class="tv-avatar-sub" style="background:${estimatorColor(s.id)}">${esc(s.initials || '?')}</div>`).join('');
      avatarsHtml = `<div class="tv-avatars-lead">
        <div class="tv-avatar" style="background:${estimatorColor(b.estimator_id)}">${esc(b.estimator_initials || '?')}</div>
        ${subAvatars}
      </div>`;
    }

    // Sub-estimators — a real avatar + name + scope-below-name block, per
    // Joe, rather than a small note-like chip at the bottom of the card.
    // Capped to the first one (row height is fixed for the pager's transform
    // math, so a second/third full name+scope block doesn't fit) — the rest
    // fold into a "+N more" note rather than overflowing into the next row
    // (a real collision hit in preview before this cap was added).
    const subEsts = b.sub_estimators || [];
    const subEstHtml = subEsts.length
      ? `<div class="tv-subest">${subEsts.slice(0, 1).map(s => `
          <div class="tv-subest-row">
            <div class="tv-subest-avatar" style="background:${estimatorColor(s.id)}">${esc(s.initials || '?')}</div>
            <div class="tv-subest-text">
              <div class="tv-subest-name">${esc(s.name || '')}</div>
              ${s.scope ? `<div class="tv-subest-scope">${esc(s.scope)}${subEsts.length > 1 ? ` · +${subEsts.length - 1} more` : ''}</div>` : ''}
            </div>
          </div>`).join('')}</div>` : '';

    const { html: pillHtml, overdue } = isWalk ? { html: walkPill(b.estimate_due_date, b.due_time), overdue: false } : duePill(b.estimate_due_date);

    // RFI Due and Walkthrough are their own dedicated columns now — not
    // folded into one catch-all Details cell, per Joe. Details itself goes
    // back to showing only what's genuinely detail: CO # + description for
    // a change order, and site company for a walk-through row; a plain bid
    // row has nothing left to show there.
    const rfiCell = (!isWalk && b.stage !== 'active_co' && b.rfi_due_date)
      ? `<div class="tv-rfi-cell">${new Date(b.rfi_due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>`
      : `<div class="tv-rfi-cell empty">—</div>`;
    const walkCell = (!isWalk && b.stage !== 'active_co' && b.next_walkthrough_date)
      ? `<div class="tv-walk-cell">${walkPill(b.next_walkthrough_date, b.next_walkthrough_time, true)}</div>`
      : `<div class="tv-walk-cell"></div>`;

    let detailCell;
    if (isWalk) {
      detailCell = `<div class="tv-amount" style="color:var(--sub);font-size:15px">${b.customer ? esc(b.customer) : '—'}</div>`;
    } else if (b.stage === 'active_co') {
      detailCell = `<div class="tv-amount" style="color:var(--sub);font-size:14px;font-weight:600">${esc(b.bid_number || '')}${b.description ? ` · ${esc(b.description)}` : ''}</div>`;
    } else {
      detailCell = `<div class="tv-amount"></div>`;
    }

    return `
      <div class="tv-row${overdue ? ' overdue' : ''}" style="border-left-color:${isWalk ? '#22d3ee' : estimatorColor(b.estimator_id)}">
        ${avatarsHtml}
        <div class="tv-proj">
          <div class="tv-proj-name">${esc(b.project_name)}</div>
          ${!isWalk && b.customer ? `<div class="tv-proj-cust">${esc(b.customer)}</div>` : ''}
          ${!isWalk && b.project_type ? `<div class="tv-proj-type">${esc(b.project_type)}</div>` : ''}
          ${!isWalk ? subEstHtml : ''}
        </div>
        <div style="display:flex;align-items:center;justify-content:center">${typeBadge}</div>
        ${rfiCell}
        ${walkCell}
        ${detailCell}
        <div class="tv-due">${pillHtml}</div>
      </div>`;
  }).join('');

  startPager(sorted.length);
}

// ── Out on Walkthrough Today ────────────────────────────────────────────────
function renderOutToday(list) {
  const wrap = document.getElementById('tv-outtoday');
  const listEl = document.getElementById('tv-outtoday-list');
  if (!list || !list.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  listEl.innerHTML = list.map(w => {
    const names = (w.assignees || []).map(a => a.name).join(' & ') || 'Unassigned';
    const avatars = (w.assignees || []).map(a =>
      `<div class="tv-outtoday-avatar" style="background:${estimatorColor(a.id)}">${esc(a.initials || '?')}</div>`).join('');
    const meta = [w.project_name, w.company, w.time ? fmtTime(w.time) : null].filter(Boolean).join(' · ');
    return `
      <div class="tv-outtoday-chip">
        <div class="tv-outtoday-avatars">${avatars}</div>
        <div class="tv-outtoday-body">
          <div class="tv-outtoday-names">${esc(names)}</div>
          <div class="tv-outtoday-meta">${esc(meta)}</div>
        </div>
      </div>`;
  }).join('');
}

// ── Render Stats ──────────────────────────────────────────────────────────────
function renderStats(stats, timestamp) {
  document.getElementById('stat-bids').textContent  = stats.activeBids;
  document.getElementById('stat-cos').textContent   = stats.activeCOs;
  // RFIs Due This Week — replaced Pipeline Value, then briefly Submitted
  // This Month (a real number, but retrospective — belongs on Reports,
  // which has real drill-down, not this board). A missed RFI cutoff blocks
  // the whole bid, and this is the one real deadline that exists before a
  // bid is even submitted, unlike a dollar figure.
  const rfiEl = document.getElementById('stat-value');
  rfiEl.textContent = stats.rfisDueThisWeek || 0;
  rfiEl.className = 'tv-stat-val' + (stats.rfisDueThisWeek > 0 ? ' warn' : '');

  const weekEl = document.getElementById('stat-week');
  weekEl.textContent = stats.dueThisWeek;
  weekEl.className   = 'tv-stat-val' + (stats.dueThisWeek > 0 ? ' warn' : '');

  const odEl = document.getElementById('stat-overdue');
  odEl.textContent = stats.overdueCount || 0;
  odEl.className   = 'tv-stat-val' + (stats.overdueCount > 0 ? ' warn' : '');

  document.getElementById('stat-walkthroughs').textContent = stats.walkthroughsToday || 0;

  if (timestamp) {
    document.getElementById('stat-refresh').textContent =
      new Date(timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
}

// ── Wins Carousel ─────────────────────────────────────────────────────────────
let _winsInterval = null;
let _winsIndex    = 0;

function renderWins(wins) {
  const winsEl  = document.getElementById('tv-wins');
  const noWins  = document.getElementById('tv-no-wins');
  const stageEl = winsEl.querySelector('.tv-wins-stage');
  const dotsEl  = winsEl.querySelector('.tv-wins-dots');

  if (!wins || !wins.length) {
    winsEl.style.display = 'none';
    noWins.style.display = 'flex';
    return;
  }

  winsEl.style.display = '';
  noWins.style.display = 'none';

  stageEl.innerHTML = wins.map((w, i) => {
    const people  = [w.estimator_initials, w.salesperson_initials].filter(Boolean).join(' · ');
    const dateStr = fmtAwardDate(w.award_date);
    return `
      <div class="tv-win-item${i === 0 ? ' active' : ''}" data-idx="${i}">
        <div class="tv-win-icon">🏆</div>
        <div class="tv-win-body">
          <div class="tv-win-name">${esc(w.project_name)}</div>
          <div class="tv-win-meta">${esc(w.customer || '')}${people ? ' · ' + esc(people) : ''}${dateStr ? ' · Awarded ' + dateStr : ''}</div>
        </div>
        <div class="tv-win-amt">${fmtCurrency(w.estimate_amount)}</div>
      </div>`;
  }).join('');

  dotsEl.innerHTML = wins.map((_, i) =>
    `<div class="tv-wins-dot${i === 0 ? ' active' : ''}"></div>`
  ).join('');

  if (_winsInterval) { clearInterval(_winsInterval); _winsInterval = null; }
  _winsIndex = 0;

  if (wins.length > 1) {
    _winsInterval = setInterval(() => {
      _winsIndex = (_winsIndex + 1) % wins.length;
      document.querySelectorAll('.tv-win-item').forEach((el, i) =>
        el.classList.toggle('active', i === _winsIndex));
      document.querySelectorAll('.tv-wins-dot').forEach((el, i) =>
        el.classList.toggle('active', i === _winsIndex));
    }, WIN_CYCLE_INTERVAL);
  }
}

// ── Data Fetch ────────────────────────────────────────────────────────────────
async function fetchData() {
  try {
    const res = await fetch(`/api/tv/data?token=${encodeURIComponent(TV_TOKEN)}`);
    if (res.status === 401) {
      document.getElementById('tv-error').style.display = 'flex';
      return;
    }
    const data = await res.json();
    if (data.error) { console.error('TV data error:', data.error); return; }

    renderStats(data.stats, data.timestamp);
    renderOutToday(data.outToday);
    renderRows(data.bids);
    renderWins(data.wins);
  } catch (e) {
    console.error('TV fetch error:', e);
    // Keep showing last data on network blip
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
// No TV_TOKEN in the URL isn't necessarily an error anymore — the sidebar's
// TV Board link (added 2026-09-25) opens this with no token at all, relying
// on the viewer's own logged-in session instead (the API route accepts
// either). fetchData() itself shows tv-error if that session check fails too.
fetchData();
setInterval(fetchData, REFRESH_INTERVAL);
