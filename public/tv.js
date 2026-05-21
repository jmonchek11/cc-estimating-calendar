// ── Config ────────────────────────────────────────────────────────────────────
const REFRESH_INTERVAL = 60 * 1000;   // re-fetch every 60 seconds
const WIN_CYCLE_INTERVAL = 7 * 1000;  // cycle wins every 7 seconds
const MAX_CARDS_PER_LANE = 4;         // bid cards shown before "+ N more"

const PALETTE = ['#2563eb','#16a34a','#dc2626','#d97706','#7c3aed','#0891b2','#be185d','#ea580c'];
function estimatorColor(id) {
  if (!id) return '#475569';
  return PALETTE[Number(id) % PALETTE.length];
}

// ── Token ─────────────────────────────────────────────────────────────────────
// Accepts token from either:
//   /tv/MY-TOKEN          ← path style (preferred for Fully Kiosk)
//   /tv?token=MY-TOKEN    ← query string style
(function() {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  // pathParts[0] = 'tv', pathParts[1] = token (if path style)
  window._TV_TOKEN = pathParts[1] || new URLSearchParams(window.location.search).get('token') || '';
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

function dueBadge(dateStr) {
  if (!dateStr) return { html: '<span class="tv-due-badge none">No Due Date</span>', overdue: false };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due   = new Date(dateStr + 'T00:00:00');
  const days  = Math.round((due - today) / 86400000);

  if (days < 0)  return { html: `<span class="tv-due-badge red">🔴 ${Math.abs(days)}d Overdue</span>`, overdue: true };
  if (days === 0) return { html: `<span class="tv-due-badge red">🔴 Due Today</span>`, overdue: true };
  if (days <= 3)  return { html: `<span class="tv-due-badge red">⚠️ ${days}d</span>`, overdue: false };
  if (days <= 7)  return { html: `<span class="tv-due-badge amber">🟡 ${days}d</span>`, overdue: false };
  return { html: `<span class="tv-due-badge green">🟢 ${days}d</span>`, overdue: false };
}

function fmtAwardDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Render Lanes ──────────────────────────────────────────────────────────────
function renderLanes(bids, team) {
  const lanesEl = document.getElementById('tv-lanes');

  // Build estimator → bids map; include an "Unassigned" bucket
  const laneMap = {};

  // Prime with all active estimators who appear in current bids
  bids.forEach(b => {
    const key = b.estimator_id || 0;
    if (!laneMap[key]) {
      laneMap[key] = {
        id:       key,
        initials: b.estimator_initials || '?',
        name:     b.estimator_name     || 'Unassigned',
        bids:     [],
      };
    }
    laneMap[key].bids.push(b);
  });

  // If no bids at all
  if (!Object.keys(laneMap).length) {
    lanesEl.innerHTML = '<div class="tv-loading">No active bids or change orders 🎉</div>';
    return;
  }

  // Sort lanes: assigned estimators alphabetically, unassigned last
  const lanes = Object.values(laneMap).sort((a, b) => {
    if (a.id === 0) return 1;
    if (b.id === 0) return -1;
    return a.name.localeCompare(b.name);
  });

  lanesEl.innerHTML = lanes.map(lane => {
    const color   = estimatorColor(lane.id);
    const shown   = lane.bids.slice(0, MAX_CARDS_PER_LANE);
    const extra   = lane.bids.length - shown.length;
    const totalAmt = lane.bids.reduce((s, b) => s + (b.estimate_amount || 0), 0);

    const cards = shown.map(b => {
      const { html: dueHtml, overdue } = dueBadge(b.estimate_due_date);
      const pct = Math.round((b.estimate_pct_complete || 0) * 100);
      const typeBadge = b.stage === 'active_co'
        ? '<span class="tv-bid-type co">CO</span>'
        : '<span class="tv-bid-type bid">BID</span>';

      return `
        <div class="tv-bid-card${overdue ? ' overdue' : ''}">
          <div class="tv-bid-top">
            <span class="tv-bid-name">${esc(b.project_name)}</span>
            ${typeBadge}
          </div>
          <div class="tv-bid-meta">
            ${dueHtml}
            <span class="tv-bid-customer">${esc(b.customer || '')}</span>
          </div>
          <div class="tv-progress-row">
            <div class="tv-progress-track">
              <div class="tv-progress-fill" style="width:${pct}%;background:${color}"></div>
            </div>
            <span class="tv-progress-pct">${pct}%</span>
          </div>
        </div>`;
    }).join('');

    const subLine = totalAmt > 0
      ? `${lane.bids.length} bid${lane.bids.length !== 1 ? 's' : ''} · ${fmtCurrency(totalAmt)}`
      : `${lane.bids.length} bid${lane.bids.length !== 1 ? 's' : ''}`;

    return `
      <div class="tv-lane">
        <div class="tv-lane-header">
          <div class="tv-lane-avatar" style="background:${color}">${esc(lane.initials)}</div>
          <div class="tv-lane-info">
            <div class="tv-lane-name">${esc(lane.name)}</div>
            <div class="tv-lane-sub">${esc(subLine)}</div>
          </div>
          <div class="tv-lane-count">${lane.bids.length}</div>
        </div>
        <div class="tv-lane-body">
          ${cards}
          ${extra > 0 ? `<div class="tv-lane-more">+ ${extra} more</div>` : ''}
          ${shown.length === 0 ? '<div class="tv-lane-empty">No active bids</div>' : ''}
        </div>
      </div>`;
  }).join('');
}

// ── Render Stats Bar ──────────────────────────────────────────────────────────
function renderStats(stats, timestamp) {
  document.getElementById('stat-bids').textContent   = stats.activeBids;
  document.getElementById('stat-cos').textContent    = stats.activeCOs;
  document.getElementById('stat-value').textContent  = fmtCurrency(stats.pipelineValue);
  document.getElementById('stat-week').textContent   = stats.dueThisWeek;

  if (timestamp) {
    const d = new Date(timestamp);
    document.getElementById('stat-refresh').textContent =
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // Color the "Due This Week" value based on urgency
  const weekEl = document.getElementById('stat-week');
  weekEl.style.color = stats.dueThisWeek > 0 ? '#fcd34d' : '#2563eb';
}

// ── Wins Carousel ─────────────────────────────────────────────────────────────
let _winsInterval = null;
let _winsIndex    = 0;

function renderWins(wins) {
  const section  = document.getElementById('tv-wins-section');
  const noWins   = document.getElementById('tv-no-wins-bar');
  const display  = document.getElementById('tv-wins-display');
  const dotsEl   = document.getElementById('tv-wins-dots');

  if (!wins || !wins.length) {
    section.style.display = 'none';
    noWins.style.display  = 'flex';
    return;
  }

  section.style.display = '';
  noWins.style.display  = 'none';

  // Build win items
  display.innerHTML = wins.map((w, i) => {
    const people = [w.estimator_initials, w.salesperson_initials].filter(Boolean).join(' · ');
    const dateStr = fmtAwardDate(w.award_date);
    return `
      <div class="tv-win-item${i === 0 ? ' active' : ''}" data-idx="${i}">
        <div class="tv-win-trophy">🏆</div>
        <div class="tv-win-info">
          <div class="tv-win-name">${esc(w.project_name)}</div>
          <div class="tv-win-meta">${esc(w.customer || '')}${people ? ' · ' + esc(people) : ''}${dateStr ? ' · Awarded ' + dateStr : ''}</div>
        </div>
        <div class="tv-win-amount">${fmtCurrency(w.estimate_amount)}</div>
      </div>`;
  }).join('');

  // Build dots
  dotsEl.innerHTML = wins.map((_, i) =>
    `<div class="tv-wins-dot${i === 0 ? ' active' : ''}" data-idx="${i}"></div>`
  ).join('');

  // Start cycling
  if (_winsInterval) clearInterval(_winsInterval);
  _winsIndex = 0;

  if (wins.length > 1) {
    _winsInterval = setInterval(() => {
      _winsIndex = (_winsIndex + 1) % wins.length;
      showWin(_winsIndex);
    }, WIN_CYCLE_INTERVAL);
  }
}

function showWin(idx) {
  document.querySelectorAll('.tv-win-item').forEach((el, i) =>
    el.classList.toggle('active', i === idx));
  document.querySelectorAll('.tv-wins-dot').forEach((el, i) =>
    el.classList.toggle('active', i === idx));
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
    renderLanes(data.bids, data.team);
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
