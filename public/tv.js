// ── Config ────────────────────────────────────────────────────────────────────
const REFRESH_INTERVAL  = 60 * 1000;  // re-fetch every 60 s
const WIN_CYCLE_INTERVAL = 7 * 1000;  // cycle wins every 7 s
const PAGE_INTERVAL      = 8 * 1000;  // scroll to next page every 8 s
const ROW_HEIGHT         = 72;        // px — must match .tv-row height in CSS

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

  if (!bids || !bids.length) {
    rowsEl.innerHTML = '<div class="tv-empty">No active bids or change orders 🎉</div>';
    startPager(0);
    return;
  }

  // Sort: earliest due date first; null dates last
  const sorted = [...bids].sort((a, b) => {
    const da = a.estimate_due_date || '9999-99-99';
    const db = b.estimate_due_date || '9999-99-99';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  rowsEl.innerHTML = sorted.map(b => {
    const color   = estimatorColor(b.estimator_id);
    const initials = esc(b.estimator_initials || '?');
    const { html: pillHtml, overdue } = duePill(b.estimate_due_date);
    const typeBadge = b.stage === 'active_co'
      ? '<span class="tv-type co">CO</span>'
      : '<span class="tv-type bid">BID</span>';

    return `
      <div class="tv-row${overdue ? ' overdue' : ''}" style="border-left-color:${color}">
        <div class="tv-avatar" style="background:${color}">${initials}</div>
        <div class="tv-proj">
          <div class="tv-proj-name">${esc(b.project_name)}</div>
          ${b.customer ? `<div class="tv-proj-cust">${esc(b.customer)}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;justify-content:center">${typeBadge}</div>
        <div class="tv-amount">${fmtCurrency(b.estimate_amount)}</div>
        <div class="tv-due">${pillHtml}</div>
      </div>`;
  }).join('');

  startPager(sorted.length);
}

// ── Render Stats ──────────────────────────────────────────────────────────────
function renderStats(stats, timestamp) {
  document.getElementById('stat-bids').textContent  = stats.activeBids;
  document.getElementById('stat-cos').textContent   = stats.activeCOs;
  document.getElementById('stat-value').textContent = fmtCurrency(stats.pipelineValue);

  const weekEl = document.getElementById('stat-week');
  weekEl.textContent = stats.dueThisWeek;
  weekEl.className   = 'tv-stat-val' + (stats.dueThisWeek > 0 ? ' warn' : '');

  const odEl = document.getElementById('stat-overdue');
  odEl.textContent = stats.overdueCount || 0;
  odEl.className   = 'tv-stat-val' + (stats.overdueCount > 0 ? ' warn' : '');

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
    renderRows(data.bids);
    renderWins(data.wins);
  } catch (e) {
    console.error('TV fetch error:', e);
    // Keep showing last data on network blip
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
if (!TV_TOKEN) {
  document.getElementById('tv-error').style.display = 'flex';
} else {
  fetchData();
  setInterval(fetchData, REFRESH_INTERVAL);
}
