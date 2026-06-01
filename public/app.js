// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const State = {
  team: [],
  settings: { fu_initial_days: 3, fu_recurring_days: 7 },
  currentPage: '',
  currentUser: null,
  mineOnly: false,
  loginPendingId: null,
  currentPanelBidId: null,
  dashboardView: 'mine',
  quickLogBidId: null,
  analyticsPeriod: 'all',
  analyticsSort: 'volume',
  globalSearch: '',
  cleanupFilters: { issue: '', search: '', person: '', hiddenStages: [], sort: 'issues', mineOnly: false },
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(),
  calFilter: 'all',
};

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function fmt(val, type = 'text') {
  if (val === null || val === undefined || val === '') return '—';
  if (type === 'currency') {
    const n = parseFloat(val);
    if (isNaN(n)) return '—';
    if (n >= 1000000) return '$' + (n / 1000000).toFixed(2) + 'M';
    if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return '$' + n;
  }
  if (type === 'date') {
    if (!val) return '—';
    const d = new Date(val + 'T12:00:00');
    if (isNaN(d)) return val;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  if (type === 'pct') {
    const n = parseFloat(val);
    if (isNaN(n)) return '—';
    return Math.round(n * 100) + '%';
  }
  return val;
}

// Compact currency for stat boxes — always fits in a small tile
function fmtCompact(n) {
  if (!n) return '—';
  const v = parseFloat(n);
  if (isNaN(v)) return '—';
  if (v >= 1000000) return '$' + (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000)    return '$' + Math.round(v / 1000) + 'K';
  return '$' + v;
}

function today() { return new Date().toISOString().split('T')[0]; }

function daysDiff(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00');
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}

function followupUrgency(bid) {
  if (!bid.next_followup_date) return 'none';
  const diff = daysDiff(bid.next_followup_date);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff <= 7) return 'this-week';
  return 'upcoming';
}

// Compute an array of data-quality issues for a bid
function getBidIssues(bid) {
  const issues = [];
  const ACTIVE = ['opportunity', 'active_bid', 'active_co', 'follow_up'];
  const isActive = ACTIVE.includes(bid.stage);

  if (!bid.estimate_amount)
    issues.push({ key: 'no_price',       label: 'No Price',         color: '#dc2626' });
  if (!bid.customer)
    issues.push({ key: 'no_customer',    label: 'No Customer',      color: '#9333ea' });
  if (!bid.estimator_id)
    issues.push({ key: 'no_estimator',   label: 'No Estimator',     color: '#2563eb' });
  if (!bid.salesperson_id)
    issues.push({ key: 'no_salesperson', label: 'No Salesperson',   color: '#059669' });

  if (isActive) {
    if (!bid.estimate_due_date)
      issues.push({ key: 'no_due_date',  label: 'No Due Date',      color: '#d97706' });

    if (!bid.next_followup_date) {
      issues.push({ key: 'no_followup',  label: 'No Follow-up Set', color: '#ea580c' });
    } else {
      const overdueDays = Math.floor(-daysDiff(bid.next_followup_date)); // positive = days overdue
      if (overdueDays > 30)
        issues.push({ key: 'stale_followup', label: overdueDays + 'd Overdue', color: '#b91c1c' });
    }

    if (bid.date_received) {
      const ageDays = Math.floor(-daysDiff(bid.date_received));
      if (ageDays > 365)
        issues.push({ key: 'very_stale', label: '1yr+ Old',         color: '#78716c' });
      else if (ageDays > 180)
        issues.push({ key: 'stale',      label: '6mo+ Old',         color: '#a78bfa' });
    }
  }

  return issues;
}

function stageName(stage) {
  const map = {
    opportunity: 'Opportunity', active_bid: 'Active Bid', active_co: 'Change Order',
    follow_up: 'Follow Up', awarded: 'Awarded', not_awarded: 'Not Awarded', closed: 'Closed'
  };
  return map[stage] || stage;
}

function statusBadge(status) {
  const map = {
    'Open': 'badge-open', 'Pending Award': 'badge-pending', 'Awarded': 'badge-awarded',
    'Not Awarded': 'badge-not-awarded', 'Budget': 'badge-budget'
  };
  return `<span class="badge ${map[status] || 'badge-stage'}">${status || 'Open'}</span>`;
}

function relativeTime(dtStr) {
  if (!dtStr) return '';
  const diff = daysDiff(dtStr.split('T')[0]);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff < 0) return `${Math.abs(diff)}d ago`;
  if (diff === 1) return 'Tomorrow';
  return `In ${diff}d`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────
// API
// ─────────────────────────────────────────────
const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async post(url, data) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async put(url, data) {
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
};

// ─────────────────────────────────────────────
// NAV & ROUTING
// ─────────────────────────────────────────────
function navigate(page) {
  location.hash = page;
}

async function onHashChange() {
  const page = location.hash.slice(1) || 'dashboard';
  State.currentPage = page;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
  await renderPage(page);
  await updateBadges();
}

async function updateBadges() {
  try {
    const stats = await api.get('/api/stats');
    const stageMap = {};
    (stats.counts || []).forEach(c => stageMap[c.stage] = c.count);

    ['opportunity', 'active_bid', 'active_co'].forEach(s => {
      const el = document.getElementById(`badge-${s}`);
      if (el) {
        const n = stageMap[s] || 0;
        el.textContent = n;
        el.style.display = n > 0 ? 'inline-block' : 'none';
      }
    });

    const fuBadge = document.getElementById('badge-followup');
    if (fuBadge) {
      const n = stats.overdueCount || 0;
      fuBadge.textContent = n;
      fuBadge.style.display = n > 0 ? 'inline-block' : 'none';
    }
  } catch (e) { /* ignore badge errors */ }
}

async function renderPage(page) {
  closeJobPanel();
  const main = document.getElementById('main');
  main.innerHTML = '<div class="loading-screen"><div class="spinner"></div><p>Loading...</p></div>';
  try {
    switch (page) {
      case 'dashboard':     return await renderDashboard(main);
      case 'opportunities': return await renderBidTable(main, 'opportunity', 'Opportunities', '🔵');
      case 'active-bids':   return await renderBidTable(main, 'active_bid', 'Active Bids', '🟡');
      case 'change-orders': return await renderBidTable(main, 'active_co', 'Change Orders', '🟠');
      case 'follow-ups':    return await renderFollowUps(main);
      case 'search':        return await renderSearch(main);
      case 'digest':        return await renderDigest(main);
      case 'analytics':     return await renderAnalytics(main);
      case 'history':       return await renderHistory(main);
      case 'cleanup':       return await renderCleanup(main);
      case 'calendar':      return await renderCalendar(main);
      case 'contacts':      return await renderContacts(main);
      case 'settings':      return await renderSettings(main);
      default:              return await renderDashboard(main);
    }
  } catch (e) {
    main.innerHTML = `<div class="card"><p class="text-danger">Error: ${esc(e.message)}</p></div>`;
  }
}

// ─────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────
function setDashboardView(view) {
  State.dashboardView = view;
  renderPage('dashboard');
}

function navigateMineOnly(page) {
  State.mineOnly = true;
  navigate(page);
}

async function renderDashboard(main) {
  const [stats, myStats] = await Promise.all([
    api.get('/api/stats'),
    State.currentUser ? api.get('/api/my-stats') : Promise.resolve(null),
  ]);

  // Non-admins are always locked to "mine" view
  if (State.currentUser && !State.currentUser.is_admin) {
    State.dashboardView = 'mine';
  }

  const isMine = State.currentUser && State.dashboardView === 'mine';

  // Build data maps
  const globalMap = {};
  (stats.counts || []).forEach(c => globalMap[c.stage] = c);

  const myMap = {};
  (myStats?.myCounts || []).forEach(c => myMap[c.stage] = c);

  // Pick data source based on view
  const activeMap = isMine ? myMap : globalMap;
  const overdueList = isMine ? (myStats?.myOverdueFollowups || []) : (stats.overdueBids || []);
  const dueSoonList = isMine ? (myStats?.myDueSoon || []) : (stats.dueSoonBids || []);
  const recentList  = isMine ? (myStats?.myRecentBids || []) : (stats.recentActivity || []);

  const totalValue = Object.values(activeMap).reduce((s, c) => s + (c.total_value || 0), 0);
  const maxVal = Math.max(...Object.values(activeMap).map(c => c.total_value || 0), 1);
  const overdueCount = isMine ? overdueList.length : (stats.overdueCount || 0);
  const dueThisWeek = isMine ? dueSoonList.length : (stats.dueThisWeek || 0);

  // View toggle — only shown to admins
  const viewToggle = (State.currentUser && State.currentUser.is_admin) ? `
    <div class="dash-view-toggle">
      <button class="dash-view-btn ${isMine ? 'active' : ''}" onclick="setDashboardView('mine')">My View</button>
      <button class="dash-view-btn ${!isMine ? 'active' : ''}" onclick="setDashboardView('all')">All Bids</button>
    </div>` : '';

  // Personal greeting bar (shown in both views when logged in)
  let greetingBar = '';
  if (State.currentUser && myStats) {
    const myTotal = Object.values(myMap).reduce((s, c) => s + c.count, 0);
    const myOverdue = (myStats.myOverdueFollowups || []).length;
    const myValue = Object.values(myMap).reduce((s, c) => s + (c.total_value || 0), 0);
    greetingBar = `
      <div class="dash-greeting-bar">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <span class="dash-greeting-text">${greeting()}, ${esc(firstName(State.currentUser.name))}!</span>
            <span class="dash-greeting-sub">${myTotal} active · ${fmt(myValue,'currency')} in your pipeline${myOverdue > 0 ? ` · <strong style="color:#fca5a5">${myOverdue} overdue</strong>` : ''}</span>
          </div>
          <div style="margin-left:auto;display:flex;gap:8px;flex-shrink:0">
            <button class="btn btn-sm" style="background:rgba(255,255,255,0.15);color:white" onclick="navigate('follow-ups')">Follow-ups →</button>
            <button class="btn btn-sm" style="background:rgba(255,255,255,0.15);color:white" onclick="navigate('active-bids')">Active Bids →</button>
          </div>
        </div>
      </div>`;
  }

  const stageBars = [
    { stage: 'opportunity', label: 'Opportunities', color: '#3b82f6' },
    { stage: 'active_bid', label: 'Active Bids', color: '#f59e0b' },
    { stage: 'active_co', label: 'Change Orders', color: '#f97316' },
    { stage: 'follow_up', label: 'Follow Up', color: '#8b5cf6' },
  ].map(({ stage, label, color }) => {
    const d = activeMap[stage] || { count: 0, total_value: 0 };
    const pct = maxVal > 0 ? Math.max(5, Math.round((d.total_value || 0) / maxVal * 100)) : 5;
    return `
      <div class="pipeline-bar-row">
        <div class="pipeline-bar-label">${label}</div>
        <div class="pipeline-bar-track">
          <div class="pipeline-bar-fill" style="width:${pct}%;background:${color}">
            <span class="pipeline-bar-count">${d.count}</span>
          </div>
        </div>
        <div class="pipeline-bar-value">${fmt(d.total_value, 'currency')}</div>
      </div>`;
  }).join('');

  const attentionItems = overdueList.map(b => `
    <div class="attention-item" style="cursor:pointer" onclick="openJobPanel(${b.id})">
      <div class="attention-dot dot-red"></div>
      <div>
        <div class="attention-name">${esc(b.project_name)}</div>
        <div class="attention-meta">
          Follow-up due ${fmt(b.next_followup_date, 'date')} &nbsp;·&nbsp;
          ${b.estimator_initials ? `Est: ${esc(b.estimator_initials)}` : ''}
          ${b.salesperson_initials ? ` · Sales: ${esc(b.salesperson_initials)}` : ''}
          ${b.estimate_amount ? ` · ${fmt(b.estimate_amount, 'currency')}` : ''}
        </div>
      </div>
      <div style="margin-left:auto;flex-shrink:0">
        <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();openFollowupModal(${b.id})">Log</button>
      </div>
    </div>`).join('') || `<div class="text-muted" style="padding:8px 0;font-size:13px">${isMine ? 'No overdue follow-ups for you 🎉' : 'No overdue follow-ups 🎉'}</div>`;

  const dueSoon = dueSoonList.map(b => `
    <div class="attention-item" style="cursor:pointer" onclick="openJobPanel(${b.id})">
      <div class="attention-dot dot-yellow"></div>
      <div>
        <div class="attention-name">${esc(b.project_name)}</div>
        <div class="attention-meta">
          Due ${fmt(b.estimate_due_date, 'date')} (${relativeTime(b.estimate_due_date)})
          ${b.estimator_initials ? ` · Est: ${esc(b.estimator_initials)}` : ''}
          ${b.estimate_amount ? ` · ${fmt(b.estimate_amount, 'currency')}` : ''}
        </div>
      </div>
    </div>`).join('') || `<div class="text-muted" style="padding:8px 0;font-size:13px">${isMine ? 'No estimates due for you this week' : 'No bids due this week'}</div>`;

  const recentRows = recentList.map(b => `
    <div class="activity-item" style="cursor:pointer" onclick="openJobPanel(${b.id})">
      <span class="badge badge-stage">${stageName(b.stage)}</span>
      <span class="activity-name">${esc(b.project_name)}</span>
      <span class="activity-time">${relativeTime(b.updated_at?.substring(0, 10))}</span>
    </div>`).join('');

  const scopeLabel = isMine ? `${esc(firstName(State.currentUser.name))}'s` : 'Global';

  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Dashboard</div>
        <div class="page-subtitle">${new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        ${viewToggle}
        <button class="btn btn-secondary" onclick="navigate('digest')">📊 Digest</button>
        <button class="btn btn-primary" onclick="openBidModal()">+ New Bid</button>
      </div>
    </div>

    ${greetingBar}

    <div class="stat-grid">
      <div class="stat-card primary${isMine ? ' stat-card-link' : ''}" ${isMine ? 'onclick="navigateMineOnly(\'opportunities\')" title="View my opportunities"' : ''}>
        <div class="stat-label">${isMine ? 'My ' : ''}Opportunities</div>
        <div class="stat-value">${activeMap.opportunity?.count || 0}</div>
        <div class="stat-sub">${fmt(activeMap.opportunity?.total_value, 'currency')}</div>
      </div>
      <div class="stat-card warning${isMine ? ' stat-card-link' : ''}" ${isMine ? 'onclick="navigateMineOnly(\'active-bids\')" title="View my active bids"' : ''}>
        <div class="stat-label">${isMine ? 'My ' : ''}Active Bids</div>
        <div class="stat-value">${activeMap.active_bid?.count || 0}</div>
        <div class="stat-sub">${fmt(activeMap.active_bid?.total_value, 'currency')}</div>
      </div>
      <div class="stat-card${isMine ? ' stat-card-link' : ''}" style="border-top:3px solid #f97316" ${isMine ? 'onclick="navigateMineOnly(\'change-orders\')" title="View my change orders"' : ''}>
        <div class="stat-label">${isMine ? 'My ' : ''}Change Orders</div>
        <div class="stat-value" style="color:#ea580c">${activeMap.active_co?.count || 0}</div>
        <div class="stat-sub">${fmt(activeMap.active_co?.total_value, 'currency')}</div>
      </div>
      <div class="stat-card danger${isMine ? ' stat-card-link' : ''}" ${isMine ? 'onclick="navigateMineOnly(\'follow-ups\')" title="View my overdue follow-ups"' : ''}>
        <div class="stat-label">${isMine ? 'My ' : ''}Overdue Follow-ups</div>
        <div class="stat-value">${overdueCount}</div>
        <div class="stat-sub">${dueThisWeek} ${isMine ? 'of my bids' : 'bids'} due this week</div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="card">
        <div class="section-title">⚠️ ${scopeLabel} Overdue Follow-ups</div>
        ${attentionItems}
      </div>
      <div class="card">
        <div class="section-title">📅 ${scopeLabel} Estimates Due This Week</div>
        ${dueSoon}
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="card">
        <div class="section-title">📊 ${scopeLabel} Pipeline by Value</div>
        <div style="margin-top:8px">${stageBars}</div>
        <div style="text-align:right;font-size:12px;color:var(--text-muted);margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
          Total Active Pipeline: <strong>${fmt(totalValue, 'currency')}</strong>
        </div>
      </div>
      <div class="card">
        <div class="section-title">🕐 ${scopeLabel} Recent Activity</div>
        ${recentRows || '<div class="text-muted" style="padding:8px 0;font-size:13px">No recent activity</div>'}
      </div>
    </div>`;
}

// ─────────────────────────────────────────────
// BID TABLE (Opportunities / Active Bids / COs)
// ─────────────────────────────────────────────
async function renderBidTable(main, stage, title, icon) {
  const team = State.team;
  const estimators = team.filter(m => m.role === 'estimator' || m.role === 'estimator/pm');
  const salespeople = team.filter(m => m.role === 'salesperson' || m.role === 'estimator/pm');

  const params = new URLSearchParams({ stage });
  const searchVal = document.getElementById(`search-${stage}`)?.value || '';
  const estVal = document.getElementById(`est-${stage}`)?.value || '';
  const salVal = document.getElementById(`sal-${stage}`)?.value || '';
  if (searchVal) params.set('search', searchVal);
  if (estVal) params.set('estimator_id', estVal);
  if (salVal) params.set('salesperson_id', salVal);
  if (State.mineOnly && State.currentUser) params.set('mine_only', 'true');

  const bids = await api.get('/api/bids?' + params.toString());

  const estOptions = estimators.map(m => `<option value="${m.id}">${esc(m.initials)} – ${esc(m.name)}</option>`).join('');
  const salOptions = salespeople.map(m => `<option value="${m.id}">${esc(m.initials)} – ${esc(m.name)}</option>`).join('');

  const todayStr = today();
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  const rows = bids.map(b => {
    const isOverdue = b.estimate_due_date && b.estimate_due_date < todayStr;
    const isDueSoon = !isOverdue && b.estimate_due_date && b.estimate_due_date <= weekAhead;
    const rowClass = isOverdue ? 'row-overdue' : isDueSoon ? 'row-due-soon' : '';
    const dueDateClass = isOverdue ? 'overdue' : isDueSoon ? 'due-soon' : '';
    const pct = parseFloat(b.estimate_pct_complete || 0);
    const pctWidth = Math.min(100, Math.round(pct * 100));
    return `
      <tr class="${rowClass} clickable-row" data-id="${b.id}" onclick="openJobPanel(${b.id})">
        <td class="td-project">
          ${esc(b.project_name)}
          <small>${b.bid_number ? '#' + esc(b.bid_number) : ''} ${b.job_number ? '· ' + esc(b.job_number) : ''}</small>
        </td>
        <td class="td-customer">${esc(b.customer) || '—'}</td>
        <td class="td-date">${fmt(b.date_received, 'date')}</td>
        <td class="td-amount">${fmt(b.estimate_amount, 'currency')}</td>
        <td>
          <div class="progress-bar"><div class="progress-fill ${pctWidth >= 100 ? 'complete' : ''}" style="width:${pctWidth}%"></div></div>
          <small style="color:var(--text-muted);font-size:11px">${pctWidth}%</small>
        </td>
        <td class="td-date ${dueDateClass}">${fmt(b.estimate_due_date, 'date')}</td>
        <td>
          ${b.estimator_initials ? `<span class="initials-pill">${esc(b.estimator_initials)}</span>` : '—'}
          ${(b.sub_estimators||[]).map(se => {
            const m = State.team.find(t => t.id === se.estimator_id);
            return m ? `<span class="initials-pill initials-pill-sub" title="${esc(m.name)}${se.scope?' · '+se.scope:''}">${esc(m.initials)}</span>` : '';
          }).join('')}
        </td>
        <td>${b.salesperson_initials ? `<span class="initials-pill" style="background:#dcfce7;color:#166534">${esc(b.salesperson_initials)}</span>` : '—'}</td>
        <td>${statusBadge(b.status)}</td>
        <td>
          <div class="actions" onclick="event.stopPropagation()">
            <button class="btn btn-ghost btn-sm" onclick="openBidModal(${b.id})" title="Edit">✏️</button>
            <button class="btn btn-ghost btn-sm" onclick="openFollowupModal(${b.id})" title="Log Follow-up">🔔</button>
            <button class="btn btn-ghost btn-sm" onclick="openStageModal(${b.id}, '${esc(b.stage)}')" title="Move Stage">➡️</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${icon} ${title}</div>
        <div class="page-subtitle">${bids.length} record${bids.length !== 1 ? 's' : ''}</div>
      </div>
      <button class="btn btn-primary" onclick="openBidModal(null,'${stage}')">+ Add ${title.replace('s','')}</button>
    </div>

    <div class="filter-bar">
      <input type="text" id="search-${stage}" placeholder="Search project, bid #, customer…" value="${esc(searchVal)}" oninput="debounceRefresh('${stage}','${title}','${icon}')" />
      <select id="est-${stage}" onchange="refreshBidTable('${stage}','${title}','${icon}')">
        <option value="">All Estimators</option>
        ${estOptions}
      </select>
      <select id="sal-${stage}" onchange="refreshBidTable('${stage}','${title}','${icon}')">
        <option value="">All Salespeople</option>
        ${salOptions}
      </select>
      ${State.currentUser ? `<button class="mine-toggle ${State.mineOnly ? 'active' : ''}" id="mine-toggle-${stage}" onclick="toggleMineOnly('${stage}','${title}','${icon}')"><span class="toggle-dot"></span> Mine Only</button>` : ''}
      <button class="btn btn-secondary btn-sm" onclick="clearFilters('${stage}','${title}','${icon}')">Clear</button>
    </div>

    <div class="table-wrapper">
      ${bids.length ? `
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Customer</th>
            <th>Received</th>
            <th>Amount</th>
            <th>Progress</th>
            <th>Due Date</th>
            <th>Est.</th>
            <th>Sales</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-state-icon">${icon}</div>
        <div class="empty-state-title">No ${title} yet</div>
        <div class="empty-state-desc">Click "+ Add" above to create one.</div>
      </div>`}
    </div>`;

  // Restore filter values
  if (estVal) document.getElementById(`est-${stage}`).value = estVal;
  if (salVal) document.getElementById(`sal-${stage}`).value = salVal;
}

let debounceTimer;
function debounceRefresh(stage, title, icon) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => refreshBidTable(stage, title, icon), 300);
}

function refreshBidTable(stage, title, icon) {
  const main = document.getElementById('main');
  renderBidTableWithFilters(main, stage, title, icon);
}

async function renderBidTableWithFilters(main, stage, title, icon) {
  const searchEl = document.getElementById(`search-${stage}`);
  const estEl = document.getElementById(`est-${stage}`);
  const salEl = document.getElementById(`sal-${stage}`);
  const searchVal = searchEl?.value || '';
  const estVal = estEl?.value || '';
  const salVal = salEl?.value || '';

  const params = new URLSearchParams({ stage });
  if (searchVal) params.set('search', searchVal);
  if (estVal) params.set('estimator_id', estVal);
  if (salVal) params.set('salesperson_id', salVal);
  if (State.mineOnly && State.currentUser) params.set('mine_only', 'true');

  const bids = await api.get('/api/bids?' + params.toString());

  // Update the Mine toggle button state
  const mineBtn = document.getElementById(`mine-toggle-${stage}`);
  if (mineBtn) mineBtn.classList.toggle('active', State.mineOnly);

  const todayStr = today();
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  const rows = bids.map(b => {
    const isOverdue = b.estimate_due_date && b.estimate_due_date < todayStr;
    const isDueSoon = !isOverdue && b.estimate_due_date && b.estimate_due_date <= weekAhead;
    const rowClass = isOverdue ? 'row-overdue' : isDueSoon ? 'row-due-soon' : '';
    const dueDateClass = isOverdue ? 'overdue' : isDueSoon ? 'due-soon' : '';
    const pct = parseFloat(b.estimate_pct_complete || 0);
    const pctWidth = Math.min(100, Math.round(pct * 100));
    return `
      <tr class="${rowClass} clickable-row" data-id="${b.id}" onclick="openJobPanel(${b.id})">
        <td class="td-project">${esc(b.project_name)}<small>${b.bid_number ? '#' + esc(b.bid_number) : ''} ${b.job_number ? '· ' + esc(b.job_number) : ''}</small></td>
        <td class="td-customer">${esc(b.customer) || '—'}</td>
        <td class="td-date">${fmt(b.date_received, 'date')}</td>
        <td class="td-amount">${fmt(b.estimate_amount, 'currency')}</td>
        <td><div class="progress-bar"><div class="progress-fill ${pctWidth >= 100 ? 'complete' : ''}" style="width:${pctWidth}%"></div></div><small style="color:var(--text-muted);font-size:11px">${pctWidth}%</small></td>
        <td class="td-date ${dueDateClass}">${fmt(b.estimate_due_date, 'date')}</td>
        <td>
          ${b.estimator_initials ? `<span class="initials-pill">${esc(b.estimator_initials)}</span>` : '—'}
          ${(b.sub_estimators||[]).map(se => {
            const m = State.team.find(t => t.id === se.estimator_id);
            return m ? `<span class="initials-pill initials-pill-sub" title="${esc(m.name)}${se.scope?' · '+se.scope:''}">${esc(m.initials)}</span>` : '';
          }).join('')}
        </td>
        <td>${b.salesperson_initials ? `<span class="initials-pill" style="background:#dcfce7;color:#166534">${esc(b.salesperson_initials)}</span>` : '—'}</td>
        <td>${statusBadge(b.status)}</td>
        <td><div class="actions" onclick="event.stopPropagation()">
          <button class="btn btn-ghost btn-sm" onclick="openBidModal(${b.id})" title="Edit">✏️</button>
          <button class="btn btn-ghost btn-sm" onclick="openFollowupModal(${b.id})" title="Log Follow-up">🔔</button>
          <button class="btn btn-ghost btn-sm" onclick="openStageModal(${b.id},'${esc(b.stage)}')" title="Move Stage">➡️</button>
        </div></td>
      </tr>`;
  }).join('');

  const tbody = main.querySelector('tbody');
  const subtitle = main.querySelector('.page-subtitle');
  if (tbody) tbody.innerHTML = rows || '<tr><td colspan="9" class="no-data">No matching records</td></tr>';
  if (subtitle) subtitle.textContent = `${bids.length} record${bids.length !== 1 ? 's' : ''}`;
}

function clearFilters(stage, title, icon) {
  const searchEl = document.getElementById(`search-${stage}`);
  const estEl = document.getElementById(`est-${stage}`);
  const salEl = document.getElementById(`sal-${stage}`);
  if (searchEl) searchEl.value = '';
  if (estEl) estEl.value = '';
  if (salEl) salEl.value = '';
  State.mineOnly = false;
  renderBidTableWithFilters(document.getElementById('main'), stage, title, icon);
}

function toggleMineOnly(stage, title, icon) {
  State.mineOnly = !State.mineOnly;
  renderBidTableWithFilters(document.getElementById('main'), stage, title, icon);
}

function toggleFollowUpMine() {
  State.mineOnly = !State.mineOnly;
  refreshFollowUps();
}

let fuDebounceTimer;
function debounceFollowUps() {
  clearTimeout(fuDebounceTimer);
  fuDebounceTimer = setTimeout(refreshFollowUps, 300);
}

function refreshFollowUps() {
  renderFollowUps(document.getElementById('main'));
}

function clearFollowUpFilters() {
  ['fu-search','fu-type-filter','fu-customer-filter','fu-urgency-filter','fu-owner-filter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const sortEl = document.getElementById('fu-sort-filter');
  if (sortEl) sortEl.value = 'urgency';
  State.mineOnly = false;
  refreshFollowUps();
}

// ─────────────────────────────────────────────
// FOLLOW-UPS PAGE
// ─────────────────────────────────────────────
async function renderFollowUps(main) {
  const searchVal   = document.getElementById('fu-search')?.value    || '';
  const typeVal     = document.getElementById('fu-type-filter')?.value   || '';
  const urgencyVal  = document.getElementById('fu-urgency-filter')?.value || '';
  const ownerVal    = document.getElementById('fu-owner-filter')?.value  || '';
  const customerVal = document.getElementById('fu-customer-filter')?.value || '';
  const sortVal     = document.getElementById('fu-sort-filter')?.value   || 'urgency';

  // Follow-ups page always shows only follow_up stage
  const params = new URLSearchParams({ stage: 'follow_up' });
  if (searchVal) params.set('search', searchVal);
  if (State.mineOnly && State.currentUser) params.set('mine_only', 'true');

  let bids = await api.get('/api/bids?' + params.toString());

  // Type filter — CO = has job_number, BID = no job_number
  if (typeVal === 'bid') bids = bids.filter(b => !b.job_number);
  if (typeVal === 'co')  bids = bids.filter(b => !!b.job_number);

  // Customer filter
  if (customerVal) bids = bids.filter(b => b.customer === customerVal);

  // Owner filter: salesperson owns it if assigned, otherwise estimator
  if (ownerVal) {
    bids = bids.filter(b =>
      b.salesperson_id ? b.salesperson_id == ownerVal : b.estimator_id == ownerVal
    );
  }

  // Urgency filter
  if (urgencyVal) {
    bids = bids.filter(b => {
      if (urgencyVal === 'none') return !b.next_followup_date;
      return b.next_followup_date && followupUrgency(b) === urgencyVal;
    });
  }

  // Sort
  const urgencyOrder = { overdue: 0, today: 1, 'this-week': 2, upcoming: 3, none: 4 };
  bids.sort((a, b) => {
    if (sortVal === 'amount_desc') return (b.estimate_amount || 0) - (a.estimate_amount || 0);
    if (sortVal === 'project') return a.project_name.localeCompare(b.project_name);
    // date_asc, date_desc, urgency all need dates
    if (sortVal === 'date_desc') {
      if (!a.next_followup_date && !b.next_followup_date) return 0;
      if (!a.next_followup_date) return 1;
      if (!b.next_followup_date) return -1;
      return b.next_followup_date.localeCompare(a.next_followup_date);
    }
    if (sortVal === 'date_asc') {
      if (!a.next_followup_date && !b.next_followup_date) return 0;
      if (!a.next_followup_date) return 1;
      if (!b.next_followup_date) return -1;
      return a.next_followup_date.localeCompare(b.next_followup_date);
    }
    // default: urgency
    const ua = a.next_followup_date ? followupUrgency(a) : 'none';
    const ub = b.next_followup_date ? followupUrgency(b) : 'none';
    const diff = (urgencyOrder[ua] ?? 4) - (urgencyOrder[ub] ?? 4);
    if (diff !== 0) return diff;
    if (!a.next_followup_date && !b.next_followup_date) return a.project_name.localeCompare(b.project_name);
    if (!a.next_followup_date) return 1;
    if (!b.next_followup_date) return -1;
    return a.next_followup_date.localeCompare(b.next_followup_date);
  });

  const overdueCnt  = bids.filter(b => b.next_followup_date && followupUrgency(b) === 'overdue').length;
  const todayCnt    = bids.filter(b => b.next_followup_date && followupUrgency(b) === 'today').length;
  const weekCnt     = bids.filter(b => b.next_followup_date && followupUrgency(b) === 'this-week').length;
  const bidCnt      = bids.filter(b => !b.job_number).length;
  const coCnt       = bids.filter(b =>  b.job_number).length;

  const ownerOptions = State.team.filter(m => m.active)
    .map(m => `<option value="${m.id}">${esc(m.initials)} – ${esc(m.name)}</option>`).join('');

  // Unique customer list from loaded bids
  const customers = [...new Set(bids.map(b => b.customer).filter(Boolean))].sort();
  const customerOptions = customers.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  function ownerCell(b) {
    // Salesperson owns the follow-up if assigned; estimator otherwise
    if (b.salesperson_id && b.salesperson_initials) {
      return `<span class="initials-pill" style="background:#dcfce7;color:#166534" title="${esc(b.salesperson_initials)} (Sales)">${esc(b.salesperson_initials)}</span>`;
    }
    if (b.estimator_id && b.estimator_initials) {
      return `<span class="initials-pill" title="${esc(b.estimator_initials)} (Estimator)">${esc(b.estimator_initials)}</span>`;
    }
    return '—';
  }

  function followupDueCell(b) {
    if (!b.next_followup_date) return `<span class="fu-no-date">Not set</span>`;
    const urgency = followupUrgency(b);
    const diff = daysDiff(b.next_followup_date);
    const dateStr = fmt(b.next_followup_date, 'date');
    if (urgency === 'overdue') return `<div class="fu-date-overdue">${dateStr}</div><div class="fu-date-sub fu-sub-overdue">${Math.abs(diff)}d overdue</div>`;
    if (urgency === 'today')   return `<div class="fu-date-today">${dateStr}</div><div class="fu-date-sub fu-sub-today">Due today</div>`;
    if (urgency === 'this-week') return `<div class="fu-date-week">${dateStr}</div><div class="fu-date-sub fu-sub-week">In ${diff}d</div>`;
    return `<div>${dateStr}</div><div class="fu-date-sub">In ${diff}d</div>`;
  }

  const rows = bids.map(b => {
    const urgency  = b.next_followup_date ? followupUrgency(b) : 'none';
    const rowClass = urgency === 'overdue' ? 'row-overdue' : urgency === 'today' ? 'row-due-soon' : '';
    const isCO     = !!b.job_number;
    const refNum   = isCO ? (b.job_number || b.bid_number) : b.bid_number;
    const typeBadge = isCO
      ? `<span class="badge badge-co">CO</span>`
      : `<span class="badge badge-bid">BID</span>`;
    return `
      <tr class="${rowClass} clickable-row" onclick="openJobPanel(${b.id})">
        <td class="td-project">
          ${typeBadge}
          ${esc(b.project_name)}<small>${refNum ? ' #' + esc(refNum) : ''}</small>
        </td>
        <td class="td-customer">${esc(b.customer) || '—'}</td>
        <td class="td-date">${fmt(b.date_received, 'date')}</td>
        <td class="td-amount">${fmt(b.estimate_amount, 'currency')}</td>
        <td>${ownerCell(b)}</td>
        <td>${followupDueCell(b)}</td>
        <td><div class="actions" onclick="event.stopPropagation()">
          <button class="btn btn-ghost btn-sm" onclick="openFollowupModal(${b.id})" title="Log Follow-up">🔔</button>
          <button class="btn btn-ghost btn-sm" onclick="openBidModal(${b.id})" title="Edit">✏️</button>
          <button class="btn btn-ghost btn-sm" onclick="openStageModal(${b.id},'${esc(b.stage)}')" title="Move Stage">➡️</button>
        </div></td>
      </tr>`;
  }).join('');

  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">🔔 Follow Ups</div>
        <div class="page-subtitle">
          ${bids.length} item${bids.length !== 1 ? 's' : ''}
          · <span class="badge badge-bid" style="font-size:11px">${bidCnt} Bid${bidCnt !== 1 ? 's' : ''}</span>
          <span class="badge badge-co" style="font-size:11px">${coCnt} CO${coCnt !== 1 ? 's' : ''}</span>
          · ${overdueCnt} overdue · ${todayCnt} due today · ${weekCnt} this week
        </div>
      </div>
      <button class="btn btn-primary" onclick="openBidModal(null,'follow_up')">+ Add</button>
    </div>

    <div class="filter-bar">
      <input type="text" id="fu-search" placeholder="Search project, bid #, customer…" value="${esc(searchVal)}" oninput="debounceFollowUps()" />
      <select id="fu-type-filter" onchange="refreshFollowUps()">
        <option value="">Bids + COs</option>
        <option value="bid">Bids Only</option>
        <option value="co">Change Orders Only</option>
      </select>
      <select id="fu-customer-filter" onchange="refreshFollowUps()">
        <option value="">All Customers</option>
        ${customerOptions}
      </select>
      <select id="fu-urgency-filter" onchange="refreshFollowUps()">
        <option value="">All Urgency</option>
        <option value="overdue">🔴 Overdue</option>
        <option value="today">🟡 Due Today</option>
        <option value="this-week">🔵 This Week</option>
        <option value="upcoming">⚪ Upcoming</option>
        <option value="none">📭 No Date Set</option>
      </select>
      <select id="fu-owner-filter" onchange="refreshFollowUps()">
        <option value="">All Owners</option>
        ${ownerOptions}
      </select>
      <select id="fu-sort-filter" onchange="refreshFollowUps()">
        <option value="urgency">Sort: Urgency</option>
        <option value="date_asc">Sort: Date ↑</option>
        <option value="date_desc">Sort: Date ↓</option>
        <option value="amount_desc">Sort: Amount ↓</option>
        <option value="project">Sort: Project A–Z</option>
      </select>
      ${State.currentUser ? `<button class="mine-toggle ${State.mineOnly ? 'active' : ''}" onclick="toggleFollowUpMine()"><span class="toggle-dot"></span> Mine Only</button>` : ''}
      <button class="btn btn-secondary btn-sm" onclick="clearFollowUpFilters()">Clear</button>
    </div>

    <div class="table-wrapper">
      ${bids.length ? `
      <table>
        <thead>
          <tr>
            <th>Project</th><th>Customer</th><th>Received</th><th>Amount</th>
            <th>Owner</th><th>Follow-up Due</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-state-icon">🎉</div>
        <div class="empty-state-title">All caught up!</div>
        <div class="empty-state-desc">No follow-ups match your filters.</div>
      </div>`}
    </div>`;

  if (typeVal)     document.getElementById('fu-type-filter').value     = typeVal;
  if (customerVal) document.getElementById('fu-customer-filter').value = customerVal;
  if (urgencyVal)  document.getElementById('fu-urgency-filter').value  = urgencyVal;
  if (ownerVal)    document.getElementById('fu-owner-filter').value    = ownerVal;
  if (sortVal !== 'urgency') document.getElementById('fu-sort-filter').value = sortVal;
}

// ─────────────────────────────────────────────
// GLOBAL SEARCH
// ─────────────────────────────────────────────
let globalSearchTimer;

function debounceGlobalSearch() {
  clearTimeout(globalSearchTimer);
  const q = (document.getElementById('global-search-input')?.value || '').trim();
  State.globalSearch = q;

  // Show / hide the clear ✕ button
  const clearBtn = document.getElementById('sidebar-search-clear');
  if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';

  if (q.length < 2) {
    if (State.currentPage === 'search') renderPage('search');
    return;
  }

  globalSearchTimer = setTimeout(() => {
    if (State.currentPage !== 'search') navigate('search');
    else renderPage('search');
  }, 280);
}

function clearGlobalSearch() {
  State.globalSearch = '';
  const inp = document.getElementById('global-search-input');
  if (inp) { inp.value = ''; inp.blur(); }
  const clearBtn = document.getElementById('sidebar-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  if (State.currentPage === 'search') navigate('dashboard');
}

async function renderSearch(main) {
  // Sync query from live input (handles back-nav edge cases)
  const inp = document.getElementById('global-search-input');
  const q = (inp?.value || State.globalSearch || '').trim();
  State.globalSearch = q;
  const clearBtn = document.getElementById('sidebar-search-clear');
  if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';

  if (q.length < 2) {
    main.innerHTML = `
      <div class="page-header">
        <div><div class="page-title">🔍 Search</div></div>
      </div>
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">Search all bids</div>
        <div class="empty-state-desc">
          Type in the search bar on the left to find any bid across<br>
          <strong>all stages</strong> — opportunities, active bids, follow-ups, history, and more.<br>
          <span style="font-size:12px;color:var(--text-light);margin-top:6px;display:block">
            Tip: press <kbd style="background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:11px">Ctrl K</kbd> to focus the search bar from anywhere.
          </span>
        </div>
      </div>`;
    if (inp) setTimeout(() => inp.focus(), 50);
    return;
  }

  main.innerHTML = '<div class="loading-screen"><div class="spinner"></div><p>Searching…</p></div>';

  const bids = await api.get(`/api/bids?search=${encodeURIComponent(q)}`);

  if (!bids.length) {
    main.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">🔍 Search Results</div>
          <div class="page-subtitle">No results for "<strong>${esc(q)}</strong>"</div>
        </div>
      </div>
      <div class="empty-state">
        <div class="empty-state-icon">😶</div>
        <div class="empty-state-title">No results found</div>
        <div class="empty-state-desc">No bids matched "<strong>${esc(q)}</strong>".<br>Try a project name, bid #, customer, or job #.</div>
      </div>`;
    return;
  }

  // Group by stage in priority order (active work first, history last)
  const STAGE_ORDER = ['active_bid', 'active_co', 'follow_up', 'opportunity', 'awarded', 'not_awarded', 'closed'];
  const STAGE_COLORS = {
    opportunity: '#3b82f6', active_bid: '#f59e0b', active_co: '#f97316',
    follow_up: '#8b5cf6', awarded: '#16a34a', not_awarded: '#dc2626', closed: '#94a3b8'
  };

  const grouped = {};
  bids.forEach(b => { (grouped[b.stage] ??= []).push(b); });

  // Ordered stages that have results, then any unexpected stages
  const orderedStages = [
    ...STAGE_ORDER.filter(s => grouped[s]?.length),
    ...Object.keys(grouped).filter(s => !STAGE_ORDER.includes(s)),
  ];

  const sections = orderedStages.map(s => {
    const items = grouped[s];
    const color = STAGE_COLORS[s] || '#94a3b8';
    const rows = items.map(b => `
      <tr class="clickable-row" onclick="openJobPanel(${b.id})">
        <td class="td-project">${esc(b.project_name)}<small>${b.bid_number ? ' #' + esc(b.bid_number) : ''}</small></td>
        <td class="td-customer">${esc(b.customer) || '—'}</td>
        <td class="td-amount">${fmt(b.estimate_amount, 'currency')}</td>
        <td class="td-date">${fmt(b.date_received, 'date')}</td>
        <td>${b.estimator_initials   ? `<span class="initials-pill">${esc(b.estimator_initials)}</span>` : '—'}</td>
        <td>${b.salesperson_initials ? `<span class="initials-pill" style="background:#dcfce7;color:#166534">${esc(b.salesperson_initials)}</span>` : '—'}</td>
        <td onclick="event.stopPropagation()">
          <button class="btn btn-ghost btn-sm" onclick="openBidModal(${b.id})"      title="Edit">✏️</button>
          <button class="btn btn-ghost btn-sm" onclick="openFollowupModal(${b.id})" title="Log Follow-up">🔔</button>
          <button class="btn btn-ghost btn-sm" onclick="openStageModal(${b.id},'${esc(b.stage)}')" title="Move Stage">➡️</button>
        </td>
      </tr>`).join('');

    return `
      <div style="margin-bottom:22px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <div class="section-title" style="color:${color}">${stageName(s)}</div>
          <span style="background:${color};color:white;font-size:11px;font-weight:700;padding:1px 8px;border-radius:10px">${items.length}</span>
        </div>
        <div class="table-wrapper" style="margin:0">
          <table>
            <thead><tr>
              <th>Project</th><th>Customer</th><th>Amount</th>
              <th>Received</th><th>Est.</th><th>Sales</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">🔍 Search Results</div>
        <div class="page-subtitle">${bids.length} result${bids.length !== 1 ? 's' : ''} for "<strong>${esc(q)}</strong>"</div>
      </div>
      <button class="btn btn-secondary" onclick="clearGlobalSearch()">✕ Clear</button>
    </div>
    ${sections}`;
}

// ─────────────────────────────────────────────
// ANALYTICS DETAIL MODAL
// ─────────────────────────────────────────────
function analyticsDetailClick(el) {
  openAnalyticsDetail(el.dataset.type, el.dataset.value, el.dataset.name);
}

function closeAnalyticsModal() {
  document.getElementById('analytics-modal').style.display = 'none';
}

async function openAnalyticsDetail(type, value, displayName) {
  const modal = document.getElementById('analytics-modal');
  const body  = document.getElementById('analytics-modal-body');
  const title = document.getElementById('analytics-modal-title');

  title.textContent = displayName;
  body.innerHTML = '<div class="loading-screen" style="min-height:200px"><div class="spinner"></div><p>Loading…</p></div>';
  modal.style.display = 'flex';

  try {
    let decidedUrl, activeUrl;

    if (type === 'customer') {
      const v = encodeURIComponent(value);
      decidedUrl = `/api/bids?stage=awarded,not_awarded&customer_exact=${v}`;
      activeUrl  = `/api/bids?stage=opportunity,active_bid,active_co,follow_up&customer_exact=${v}`;
    } else if (type === 'estimator') {
      decidedUrl = `/api/bids?stage=awarded,not_awarded&estimator_id=${value}`;
      activeUrl  = `/api/bids?stage=opportunity,active_bid,active_co,follow_up&estimator_id=${value}`;
    } else { // salesperson
      decidedUrl = `/api/bids?stage=awarded,not_awarded&salesperson_id=${value}`;
      activeUrl  = `/api/bids?stage=opportunity,active_bid,active_co,follow_up&salesperson_id=${value}`;
    }

    const [decidedBids, activeBids] = await Promise.all([
      api.get(decidedUrl),
      api.get(activeUrl),
    ]);

    const won  = decidedBids.filter(b => b.stage === 'awarded');
    const lost = decidedBids.filter(b => b.stage === 'not_awarded');
    const total = decidedBids.length;
    const winRate   = total > 0 ? Math.round(won.length / total * 100) : 0;
    const wonValue  = won.reduce((s, b) => s + (b.estimate_amount || 0), 0);
    const lostValue = lost.reduce((s, b) => s + (b.estimate_amount || 0), 0);
    const activeValue = activeBids.reduce((s, b) => s + (b.estimate_amount || 0), 0);
    const winColor = winRate >= 50 ? '#16a34a' : '#dc2626';

    function detailBidRow(b) {
      const dateVal = b.award_date || b.date_estimate_sent || b.date_received;
      return `<tr class="clickable-row" onclick="closeAnalyticsModal();setTimeout(()=>openJobPanel(${b.id}),80)">
        <td class="td-project">${esc(b.project_name)}<small>${b.bid_number ? ' #' + esc(b.bid_number) : ''}</small></td>
        <td class="td-customer" style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.customer) || '—'}</td>
        <td class="td-amount">${fmt(b.estimate_amount, 'currency')}</td>
        <td>${b.estimator_initials   ? `<span class="initials-pill">${esc(b.estimator_initials)}</span>` : '—'}</td>
        <td>${b.salesperson_initials ? `<span class="initials-pill" style="background:#dcfce7;color:#166534">${esc(b.salesperson_initials)}</span>` : '—'}</td>
        <td style="color:var(--text-muted);font-size:12px">${fmt(dateVal, 'date')}</td>
      </tr>`;
    }

    function detailSection(sectionTitle, bids, color, emptyMsg) {
      const sectionTotal = bids.reduce((s, b) => s + (b.estimate_amount || 0), 0);
      return `
        <div style="margin-bottom:22px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div class="section-title" style="color:${color}">${sectionTitle} (${bids.length})</div>
            ${bids.length ? `<div style="font-size:12px;color:var(--text-muted)">${fmt(sectionTotal, 'currency')}</div>` : ''}
          </div>
          ${bids.length ? `
          <div class="table-wrapper" style="margin:0">
            <table>
              <thead><tr>
                <th>Project</th><th>Customer</th><th>Amount</th>
                <th>Est.</th><th>Sales</th><th>Date</th>
              </tr></thead>
              <tbody>${bids.map(detailBidRow).join('')}</tbody>
            </table>
          </div>` : `<div style="color:var(--text-muted);font-size:13px;padding:6px 0">${emptyMsg}</div>`}
        </div>`;
    }

    body.innerHTML = `
      <!-- KPI summary row -->
      <div style="display:flex;gap:12px;margin-bottom:22px;flex-wrap:wrap">
        <div class="stat-card" style="flex:1;min-width:110px;padding:12px 16px;border-top:3px solid ${winColor}">
          <div class="stat-label">Win Rate</div>
          <div class="stat-value" style="color:${winColor};font-size:1.6rem">${winRate}%</div>
          <div class="stat-sub">${won.length}W · ${lost.length}L</div>
        </div>
        <div class="stat-card" style="flex:1;min-width:110px;padding:12px 16px;border-top:3px solid #16a34a">
          <div class="stat-label">Won Value</div>
          <div class="stat-value" style="color:#16a34a;font-size:1.4rem">${fmt(wonValue, 'currency')}</div>
          <div class="stat-sub">${won.length} bids</div>
        </div>
        <div class="stat-card" style="flex:1;min-width:110px;padding:12px 16px;border-top:3px solid #dc2626">
          <div class="stat-label">Lost Value</div>
          <div class="stat-value" style="color:#dc2626;font-size:1.4rem">${fmt(lostValue, 'currency')}</div>
          <div class="stat-sub">${lost.length} bids</div>
        </div>
        <div class="stat-card" style="flex:1;min-width:110px;padding:12px 16px;border-top:3px solid #6366f1">
          <div class="stat-label">Active Pipeline</div>
          <div class="stat-value" style="color:#6366f1;font-size:1.4rem">${fmt(activeValue, 'currency')}</div>
          <div class="stat-sub">${activeBids.length} bid${activeBids.length !== 1 ? 's' : ''}</div>
        </div>
      </div>

      ${detailSection('✅ Won', won, '#16a34a', 'No won bids found.')}
      ${detailSection('❌ Lost', lost, '#dc2626', 'No lost bids found.')}
      ${activeBids.length ? detailSection('🔵 Active Pipeline', activeBids, '#3b82f6', '') : ''}
    `;
  } catch (e) {
    body.innerHTML = `<div class="text-danger" style="padding:16px">Error loading details: ${esc(e.message)}</div>`;
  }
}

// ─────────────────────────────────────────────
// ANALYTICS PAGE
// ─────────────────────────────────────────────
function analyticsDateRange(period) {
  // Returns { since, until } — both may be null (= no bound)
  if (period && /^Q[1-4]-\d{4}$/.test(period)) {
    const qNum  = Number(period[1]) - 1;   // 0-indexed quarter
    const year  = Number(period.slice(3));
    const start = new Date(year, qNum * 3, 1);
    const end   = new Date(year, qNum * 3 + 3, 0); // last day of quarter
    return {
      since: start.toISOString().split('T')[0],
      until: end.toISOString().split('T')[0],
    };
  }
  const d = new Date(); d.setHours(0,0,0,0);
  if (period === '3m')  { d.setMonth(d.getMonth() - 3); }
  else if (period === '6m')  { d.setMonth(d.getMonth() - 6); }
  else if (period === '1y')  { d.setFullYear(d.getFullYear() - 1); }
  else if (period === 'ytd') { d.setMonth(0); d.setDate(1); }
  else return { since: null, until: null };
  return { since: d.toISOString().split('T')[0], until: null };
}

function buildQuarterOptions(currentPeriod) {
  const now = new Date();
  const opts = [];
  for (let i = 0; i < 8; i++) {
    let month = now.getMonth() - i * 3;
    let year  = now.getFullYear();
    while (month < 0) { month += 12; year--; }
    const q = Math.floor(month / 3) + 1;
    const val = `Q${q}-${year}`;
    opts.push(`<option value="${val}" ${currentPeriod === val ? 'selected' : ''}>Q${q} ${year}</option>`);
  }
  return opts.join('');
}

async function renderAnalytics(main) {
  main.innerHTML = '<div class="loading-screen"><div class="spinner"></div><p>Loading analytics…</p></div>';

  const period  = State.analyticsPeriod || 'all';
  const sortBy  = State.analyticsSort   || 'volume';
  const { since, until } = analyticsDateRange(period);
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  const url = '/api/analytics' + (params.toString() ? '?' + params.toString() : '');

  const d = await api.get(url);
  const { overall, byCustomer, byEstimator, bySalesperson, monthlyVolume,
          topActivePipeline, quarterlyTrend, awardedBids, notAwardedBids } = d;

  const periodLabels = { all: 'All Time', '3m': 'Last 3 Months', '6m': 'Last 6 Months', '1y': 'Last 12 Months', ytd: 'Year to Date' };
  const periodLabel = periodLabels[period] || period.replace('-', ' ');

  // ── KPI values ─────────────────────────────────────────────
  const winRatePct  = Math.round((overall.win_rate || 0) * 100);
  const avgDealSize = overall.awarded > 0 ? overall.awarded_value / overall.awarded : 0;
  const winColor    = winRatePct >= 50 ? '#16a34a' : '#dc2626';

  // ── Customer win rate table ────────────────────────────────
  let customers = [...byCustomer];
  if (sortBy === 'rate')  customers.sort((a, b) => b.win_rate - a.win_rate || b.total - a.total);
  else if (sortBy === 'value') customers.sort((a, b) => b.awarded_value - a.awarded_value);
  // default 'volume' already sorted by server

  function winRateBar(rate, height = 8) {
    const color = rate >= 60 ? '#16a34a' : rate >= 40 ? '#d97706' : '#dc2626';
    return `<div style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;height:${height}px;background:#e2e8f0;border-radius:4px;overflow:hidden;min-width:50px">
        <div style="height:100%;width:${rate}%;background:${color};border-radius:4px"></div>
      </div>
      <span style="font-weight:700;color:${color};min-width:34px;text-align:right;font-size:12px">${rate}%</span>
    </div>`;
  }

  const customerRows = customers.slice(0, 30).map(c => {
    const rate = Math.round(c.win_rate * 100);
    return `<tr class="clickable-row" data-type="customer" data-value="${esc(c.customer)}" data-name="${esc(c.customer)}" onclick="analyticsDetailClick(this)" title="Click to see all bids for ${esc(c.customer)}">
      <td style="font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.customer)}</td>
      <td style="text-align:center;color:#16a34a;font-weight:700">${c.awarded}</td>
      <td style="text-align:center;color:#dc2626;font-weight:700">${c.not_awarded}</td>
      <td style="min-width:130px">${winRateBar(rate)}</td>
      <td style="text-align:right">${fmt(c.awarded_value, 'currency')}</td>
      <td style="text-align:right;color:var(--text-muted)">${fmt(c.total_value, 'currency')}</td>
      <td style="text-align:center;color:var(--text-muted)">${c.total}</td>
    </tr>`;
  }).join('');

  // ── Person win rate rows ───────────────────────────────────
  function personRows(people, type) {
    if (!people.length) return '<tr><td colspan="5" class="no-data" style="padding:10px">No data for this period</td></tr>';
    return people.map(p => {
      const rate = Math.round(p.win_rate * 100);
      return `<tr class="clickable-row" data-type="${esc(type)}" data-value="${p.id}" data-name="${esc(p.name)}" onclick="analyticsDetailClick(this)" title="Click to see all bids for ${esc(p.name)}">
        <td><span class="initials-pill" style="margin-right:4px">${esc(p.initials)}</span>${esc(p.name)}</td>
        <td style="text-align:center;color:#16a34a;font-weight:700">${p.awarded}</td>
        <td style="text-align:center;color:#dc2626;font-weight:700">${p.not_awarded}</td>
        <td style="min-width:110px">${winRateBar(rate, 6)}</td>
        <td style="text-align:right;font-size:12px">${fmt(p.awarded_value, 'currency')}</td>
      </tr>`;
    }).join('');
  }

  // ── Monthly volume bar chart ────────────────────────────────
  const maxCount = Math.max(...monthlyVolume.map(m => m.count), 1);
  const monthBars = monthlyVolume.map(m => {
    const barPct = Math.max(4, Math.round((m.count / maxCount) * 100));
    const label  = new Date(m._id + '-15T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    const hasData = m.count > 0;
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1;min-width:0">
      <div style="font-size:9px;font-weight:600;color:${hasData ? 'var(--text)' : 'transparent'}">${m.count || ''}</div>
      <div style="width:100%;height:80px;display:flex;flex-direction:column;justify-content:flex-end">
        <div style="width:100%;height:${barPct}%;background:${hasData ? '#3b82f6' : '#e2e8f0'};border-radius:3px 3px 0 0;min-height:2px" title="${m.count} bids in ${m._id}"></div>
      </div>
      <div style="font-size:8px;color:var(--text-muted);text-align:center;line-height:1.1;writing-mode:initial">${label}</div>
    </div>`;
  }).join('');

  // ── Top active pipeline customers ──────────────────────────
  const maxPipe = Math.max(...topActivePipeline.map(c => c.pipeline_value || 0), 1);
  const pipeRows = topActivePipeline.map(c => {
    const pct = Math.max(6, Math.round((c.pipeline_value / maxPipe) * 100));
    return `<div class="pipeline-bar-row" style="cursor:pointer" data-type="customer" data-value="${esc(c._id)}" data-name="${esc(c._id)}" onclick="analyticsDetailClick(this)" title="Click to see all bids for ${esc(c._id)}">
      <div class="pipeline-bar-label" style="min-width:130px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c._id)}</div>
      <div class="pipeline-bar-track">
        <div class="pipeline-bar-fill" style="width:${pct}%;background:#6366f1">
          <span class="pipeline-bar-count">${c.count}</span>
        </div>
      </div>
      <div class="pipeline-bar-value">${fmt(c.pipeline_value, 'currency')}</div>
    </div>`;
  }).join('') || '<div class="no-data" style="padding:8px 0">No active pipeline data</div>';

  // ── Period selector (shared HTML) ─────────────────────────
  const periodSelect = `
    <select onchange="State.analyticsPeriod=this.value;renderPage('analytics')"
      style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--card-bg);color:var(--text);cursor:pointer">
      <option value="all" ${period==='all'?'selected':''}>All Time</option>
      <option value="ytd" ${period==='ytd'?'selected':''}>Year to Date</option>
      <option value="1y"  ${period==='1y' ?'selected':''}>Last 12 Months</option>
      <option value="6m"  ${period==='6m' ?'selected':''}>Last 6 Months</option>
      <option value="3m"  ${period==='3m' ?'selected':''}>Last 3 Months</option>
      <optgroup label="──── By Quarter ────">${buildQuarterOptions(period)}</optgroup>
    </select>`;

  // ── Quarterly trend table ──────────────────────────────────
  const qtRows = quarterlyTrend.slice(-8).map(q => {
    const rate = q.win_rate !== null ? Math.round(q.win_rate * 100) : null;
    const rateColor = rate === null ? 'var(--text-muted)' : rate >= 50 ? '#16a34a' : rate >= 35 ? '#d97706' : '#dc2626';
    const rateBar = rate !== null ? `
      <div style="display:flex;align-items:center;gap:6px">
        <div style="flex:1;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;min-width:40px">
          <div style="height:100%;width:${rate}%;background:${rateColor};border-radius:3px"></div>
        </div>
        <span style="font-weight:700;color:${rateColor};font-size:12px;min-width:30px">${rate}%</span>
      </div>` : '<span style="color:var(--text-muted)">—</span>';
    const isCurrentPeriod = period === `Q${q.quarter}-${q.year}`;
    return `<tr class="clickable-row${isCurrentPeriod?' row-due-soon':''}"
               onclick="State.analyticsPeriod='Q${q.quarter}-${q.year}';renderPage('analytics')"
               title="Click to filter to ${q.label}">
      <td style="font-weight:${isCurrentPeriod?'700':'500'}">${q.label}</td>
      <td style="text-align:center">${q.count}</td>
      <td style="text-align:center;color:#16a34a;font-weight:700">${q.awarded}</td>
      <td style="text-align:center;color:#dc2626;font-weight:700">${q.not_awarded}</td>
      <td style="min-width:120px">${rateBar}</td>
      <td style="text-align:right">${fmtCompact(q.awarded_value)}</td>
      <td style="text-align:right;color:var(--text-muted)">${fmtCompact(q.total_value)}</td>
    </tr>`;
  }).join('');

  // ── Awarded / Not Awarded bid tables ──────────────────────
  function bidHistoryTable(bids, emptyMsg) {
    if (!bids.length) return `<div class="empty-state" style="padding:20px 0"><div class="empty-state-desc">${emptyMsg}</div></div>`;
    return `<div class="table-wrapper" style="margin:0">
      <table>
        <thead><tr>
          <th>Project</th><th>Customer</th><th>Amount</th>
          <th>Est.</th><th>Sales</th><th>Date</th>
        </tr></thead>
        <tbody>${bids.map(b => `
          <tr class="clickable-row" onclick="openJobPanel(${b.id})">
            <td class="td-project">${esc(b.project_name)}<small>${b.bid_number?'#'+esc(b.bid_number):''}</small></td>
            <td class="td-customer">${esc(b.customer)||'—'}</td>
            <td class="td-amount">${fmt(b.estimate_amount,'currency')}</td>
            <td>${b.estimator_initials?`<span class="initials-pill">${esc(b.estimator_initials)}</span>`:'—'}</td>
            <td>${b.salesperson_initials?`<span class="initials-pill" style="background:#dcfce7;color:#166534">${esc(b.salesperson_initials)}</span>`:'—'}</td>
            <td style="color:var(--text-muted);font-size:12px">${fmt(b.award_date||b.date_received,'date')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">📈 Analytics</div>
        <div class="page-subtitle">Win rates, customer trends & pipeline intelligence · ${periodLabel}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">${periodSelect}</div>
    </div>

    <!-- KPI cards -->
    <div class="stat-grid" style="margin-bottom:20px">
      <div class="stat-card" style="border-top:3px solid ${winColor}">
        <div class="stat-label">Overall Win Rate</div>
        <div class="stat-value" style="color:${winColor}">${winRatePct}%</div>
        <div class="stat-sub">${overall.awarded} won · ${overall.not_awarded} lost · ${overall.total} decided</div>
      </div>
      <div class="stat-card" style="border-top:3px solid #16a34a">
        <div class="stat-label">Total Won Value</div>
        <div class="stat-value" style="color:#16a34a">${fmt(overall.awarded_value, 'currency')}</div>
        <div class="stat-sub">${overall.awarded} awarded bids</div>
      </div>
      <div class="stat-card" style="border-top:3px solid #dc2626">
        <div class="stat-label">Total Bids Lost</div>
        <div class="stat-value" style="color:#dc2626">${overall.not_awarded}</div>
        <div class="stat-sub">${fmt(overall.total_value - overall.awarded_value, 'currency')} in lost bids</div>
      </div>
      <div class="stat-card" style="border-top:3px solid #6366f1">
        <div class="stat-label">Avg Won Deal Size</div>
        <div class="stat-value" style="color:#6366f1">${fmt(avgDealSize, 'currency')}</div>
        <div class="stat-sub">${periodLabels[period]}</div>
      </div>
    </div>

    <!-- Customer Win Rate Table -->
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div class="section-title">🏢 Win Rate by Customer / GC</div>
        <div style="display:flex;gap:8px;align-items:center">
          ${periodSelect}
          <select onchange="State.analyticsSort=this.value;renderPage('analytics')"
            style="padding:5px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:white;cursor:pointer">
            <option value="volume" ${sortBy==='volume'?'selected':''}>Sort: Most Bids</option>
            <option value="rate"   ${sortBy==='rate'  ?'selected':''}>Sort: Best Win Rate</option>
            <option value="value"  ${sortBy==='value' ?'selected':''}>Sort: Most Value Won</option>
          </select>
        </div>
      </div>
      ${customers.length ? `
      <div class="table-wrapper" style="margin:0">
        <table>
          <thead><tr>
            <th>Customer / GC</th>
            <th style="text-align:center">Won</th>
            <th style="text-align:center">Lost</th>
            <th>Win Rate</th>
            <th style="text-align:right">Value Won</th>
            <th style="text-align:right">Total Value</th>
            <th style="text-align:center">Bids</th>
          </tr></thead>
          <tbody>${customerRows}</tbody>
        </table>
      </div>` : `<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-title">No decided bids for this period</div></div>`}
    </div>

    <!-- Salesperson & Estimator Win Rates -->
    <div class="dashboard-grid" style="margin-bottom:20px">
      <div class="card">
        <div class="section-title" style="margin-bottom:12px">📞 Win Rate by Salesperson</div>
        <div class="table-wrapper" style="margin:0">
          <table>
            <thead><tr>
              <th>Salesperson</th>
              <th style="text-align:center">W</th>
              <th style="text-align:center">L</th>
              <th>Rate</th>
              <th style="text-align:right">Won $</th>
            </tr></thead>
            <tbody>${personRows(bySalesperson, 'salesperson')}</tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="section-title" style="margin-bottom:12px">👷 Win Rate by Estimator</div>
        <div class="table-wrapper" style="margin:0">
          <table>
            <thead><tr>
              <th>Estimator</th>
              <th style="text-align:center">W</th>
              <th style="text-align:center">L</th>
              <th>Rate</th>
              <th style="text-align:right">Won $</th>
            </tr></thead>
            <tbody>${personRows(byEstimator, 'estimator')}</tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Charts Row -->
    <div class="dashboard-grid" style="margin-bottom:20px">
      <div class="card">
        <div class="section-title" style="margin-bottom:4px">📅 Monthly Bid Volume (Last 24 Months)</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">Bids received per month</div>
        <div style="display:flex;align-items:flex-end;gap:2px;height:110px;padding-top:16px;overflow:hidden">
          ${monthBars}
        </div>
      </div>
      <div class="card">
        <div class="section-title" style="margin-bottom:4px">🔵 Active Pipeline by Customer (Top 10)</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Current opportunities, active bids & change orders</div>
        ${pipeRows}
      </div>
    </div>

    <!-- Quarterly trend -->
    <div class="card" style="margin-bottom:20px">
      <div class="section-title" style="margin-bottom:12px">📆 Quarterly Trend
        <span style="font-size:12px;font-weight:400;color:var(--text-muted);margin-left:8px">Click any row to filter the whole page to that quarter</span>
      </div>
      ${qtRows ? `<div class="table-wrapper" style="margin:0"><table>
        <thead><tr>
          <th>Quarter</th><th style="text-align:center">Bids</th>
          <th style="text-align:center">Won</th><th style="text-align:center">Lost</th>
          <th>Win Rate</th><th style="text-align:right">Won Value</th><th style="text-align:right">Total Value</th>
        </tr></thead>
        <tbody>${qtRows}</tbody>
      </table></div>` : '<div class="empty-state"><div class="empty-state-desc">Not enough historical data yet.</div></div>'}
    </div>

    <!-- Awarded & Not Awarded sections -->
    <div class="dashboard-grid">
      <div class="card">
        <div class="section-title" style="color:#16a34a;margin-bottom:12px">
          ✅ Awarded Projects
          <span style="font-size:12px;font-weight:400;color:var(--text-muted);margin-left:6px">${awardedBids.length} · ${fmtCompact(awardedBids.reduce((s,b)=>s+(b.estimate_amount||0),0))} · ${periodLabel}</span>
        </div>
        ${bidHistoryTable(awardedBids, 'No awarded bids in this period')}
      </div>
      <div class="card">
        <div class="section-title" style="color:#dc2626;margin-bottom:12px">
          ❌ Not Awarded
          <span style="font-size:12px;font-weight:400;color:var(--text-muted);margin-left:6px">${notAwardedBids.length} · ${fmtCompact(notAwardedBids.reduce((s,b)=>s+(b.estimate_amount||0),0))} · ${periodLabel}</span>
        </div>
        ${bidHistoryTable(notAwardedBids, 'No lost bids in this period')}
      </div>
    </div>`;
}

// ─────────────────────────────────────────────
// HISTORY PAGE
// ─────────────────────────────────────────────
async function renderHistory(main) {
  const bids = await api.get('/api/bids?stage=awarded,not_awarded,closed');

  const awarded = bids.filter(b => b.stage === 'awarded');
  const notAwarded = bids.filter(b => b.stage === 'not_awarded');
  const closed = bids.filter(b => b.stage === 'closed');

  function histTable(items, emptyMsg) {
    if (!items.length) return `<div class="no-data">${emptyMsg}</div>`;
    return `<div class="table-wrapper"><table>
      <thead><tr><th>Project</th><th>Customer</th><th>Amount</th><th>Est.</th><th>Sales</th><th>Result</th><th>Actions</th></tr></thead>
      <tbody>${items.map(b => `
        <tr class="clickable-row" onclick="openJobPanel(${b.id})">
          <td class="td-project">${esc(b.project_name)}<small>${b.bid_number ? '#' + esc(b.bid_number) : ''}</small></td>
          <td class="td-customer">${esc(b.customer) || '—'}</td>
          <td class="td-amount">${fmt(b.estimate_amount, 'currency')}</td>
          <td>${b.estimator_initials ? `<span class="initials-pill">${esc(b.estimator_initials)}</span>` : '—'}</td>
          <td>${b.salesperson_initials ? `<span class="initials-pill" style="background:#dcfce7;color:#166534">${esc(b.salesperson_initials)}</span>` : '—'}</td>
          <td>${statusBadge(b.status)}</td>
          <td onclick="event.stopPropagation()"><button class="btn btn-ghost btn-sm" onclick="openBidModal(${b.id})">✏️</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  const awardedVal = awarded.reduce((s, b) => s + (b.estimate_amount || 0), 0);

  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">📁 History</div>
        <div class="page-subtitle">${bids.length} total · ${fmt(awardedVal, 'currency')} awarded</div>
      </div>
    </div>

    <div style="margin-bottom:24px">
      <div class="section-title" style="margin-bottom:10px">✅ Awarded (${awarded.length})</div>
      ${histTable(awarded, 'No awarded bids yet.')}
    </div>
    <div style="margin-bottom:24px">
      <div class="section-title" style="margin-bottom:10px">❌ Not Awarded (${notAwarded.length})</div>
      ${histTable(notAwarded, 'No lost bids.')}
    </div>
    <div>
      <div class="section-title" style="margin-bottom:10px">📦 Closed (${closed.length})</div>
      ${histTable(closed, 'No closed bids.')}
    </div>`;
}

// ─────────────────────────────────────────────
// WEEKLY DIGEST
// ─────────────────────────────────────────────
async function renderDigest(main) {
  main.innerHTML = '<div class="loading-screen"><div class="spinner"></div></div>';
  const d = await api.get('/api/digest');

  const stageOrder = ['opportunity', 'active_bid', 'active_co', 'follow_up'];
  const stageLabels = { opportunity: 'Opportunities', active_bid: 'Active Bids', active_co: 'Change Orders', follow_up: 'Follow Up' };
  const pipelineRows = stageOrder.map(s => {
    const row = (d.pipelineSummary || []).find(r => r.stage === s) || { count: 0, total_value: 0 };
    return `<tr><td>${stageLabels[s]}</td><td style="text-align:center;font-weight:700">${row.count}</td><td style="text-align:right">${fmt(row.total_value, 'currency')}</td></tr>`;
  });
  const totalActive = (d.pipelineSummary || []).reduce((s, r) => s + r.count, 0);
  const totalVal = (d.pipelineSummary || []).reduce((s, r) => s + (r.total_value || 0), 0);

  function bidList(items, showStage = false) {
    if (!items?.length) return '<div class="digest-empty">None this week</div>';
    return items.map(b => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
        <strong>${esc(b.project_name)}</strong>
        ${b.bid_number ? `<span style="color:var(--text-muted)"> #${esc(b.bid_number)}</span>` : ''}
        ${showStage ? `<span class="badge badge-stage" style="margin-left:6px">${stageName(b.stage)}</span>` : ''}
        <div style="color:var(--text-muted);margin-top:2px">
          ${b.customer ? esc(b.customer) + ' · ' : ''}${fmt(b.estimate_amount, 'currency')}
          ${b.estimator_initials ? ` · Est: <strong>${esc(b.estimator_initials)}</strong>` : ''}
          ${b.salesperson_initials ? ` · Sales: <strong>${esc(b.salesperson_initials)}</strong>` : ''}
        </div>
      </div>`).join('');
  }

  const estimatorRows = (d.byEstimator || []).filter(e => e.bid_count > 0).map(e =>
    `<tr><td>${esc(e.name)} <span style="color:var(--text-muted)">(${esc(e.initials)})</span></td><td style="text-align:center">${e.bid_count}</td><td style="text-align:right">${fmt(e.total_value,'currency')}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="no-data">No active bids assigned</td></tr>';

  const salespersonRows = (d.bySalesperson || []).filter(s => s.bid_count > 0).map(s =>
    `<tr><td>${esc(s.name)} <span style="color:var(--text-muted)">(${esc(s.initials)})</span></td><td style="text-align:center">${s.bid_count}</td><td style="text-align:center${s.overdue_followups > 0 ? ';color:var(--danger);font-weight:700' : ''}">${s.overdue_followups || 0}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="no-data">—</td></tr>';

  const weekRange = d.weekRange ? `${fmt(d.weekRange.from, 'date')} – ${fmt(d.weekRange.to, 'date')}` : '';

  const reminderRows = (d.upcomingReminders || []).map(r => {
    const daysAway = Math.round((new Date(r.remind_on + 'T00:00:00') - new Date()) / 86400000);
    const label    = daysAway === 0 ? 'Today' : daysAway === 1 ? 'Tomorrow' : `in ${daysAway}d`;
    const color    = daysAway <= 1 ? '#dc2626' : daysAway <= 7 ? '#d97706' : '#16a34a';
    return `
      <div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-weight:700;color:${color};white-space:nowrap">${fmt(r.remind_on,'date')} <em style="font-weight:400">(${label})</em></span>
          <strong>${esc(r.project_name)}</strong>
          ${r.bid_number ? `<span style="color:var(--text-muted)">#${esc(r.bid_number)}</span>` : ''}
        </div>
        <div style="color:var(--text-muted);margin-top:2px">📌 ${esc(r.note)}</div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">📊 Weekly Digest</div>
        <div class="page-subtitle">Replaces your Monday morning meeting</div>
      </div>
      <button class="btn btn-secondary" onclick="window.print()">🖨️ Print</button>
    </div>

    <div class="card" style="max-width:860px">
      <div class="digest-header">
        <h1 style="font-size:20px;font-weight:700">Liberty Estimating — Weekly Digest</h1>
        <div class="digest-date">Week of ${weekRange} &nbsp;·&nbsp; Generated ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</div>
      </div>

      <div class="digest-section">
        <div class="digest-section-title">📊 Pipeline Overview</div>
        <table class="digest-table">
          <thead><tr><th>Stage</th><th style="text-align:center">Count</th><th style="text-align:right">Total Value</th></tr></thead>
          <tbody>
            ${pipelineRows.join('')}
            <tr style="font-weight:700;background:#f8fafc"><td>TOTAL ACTIVE</td><td style="text-align:center">${totalActive}</td><td style="text-align:right">${fmt(totalVal,'currency')}</td></tr>
          </tbody>
        </table>
      </div>

      ${(d.upcomingReminders||[]).length ? `
      <div class="digest-section">
        <div class="digest-section-title" style="color:#d97706">📌 Upcoming Reminders (${d.upcomingReminders.length}) — Next 14 Days</div>
        ${reminderRows}
      </div>` : ''}

      <div class="digest-section">
        <div class="digest-section-title">⚠️ Overdue Follow-ups (${(d.overdueFollowups || []).length})</div>
        ${bidList(d.overdueFollowups)}
      </div>

      <div class="digest-section">
        <div class="digest-section-title">📅 Upcoming Due Dates — Next 7 Days</div>
        ${bidList(d.upcomingDueDates, true)}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px">
        <div class="digest-section">
          <div class="digest-section-title">🆕 New This Week</div>
          ${bidList(d.newThisWeek, true)}
        </div>
        <div class="digest-section">
          <div class="digest-section-title">📤 Bids Submitted — Last 2 Weeks</div>
          ${bidList(d.submittedThisWeek)}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px">
        <div class="digest-section">
          <div class="digest-section-title" style="color:var(--success)">✅ Awarded This Week</div>
          ${bidList(d.awardedThisWeek)}
        </div>
        <div class="digest-section">
          <div class="digest-section-title" style="color:var(--danger)">❌ Not Awarded This Week</div>
          ${bidList(d.notAwardedThisWeek)}
        </div>
      </div>

      <div class="digest-section">
        <div class="digest-section-title">📞 By Salesperson</div>
        <table class="digest-table">
          <thead><tr><th>Salesperson</th><th style="text-align:center">Active</th><th style="text-align:center">Overdue F/U</th></tr></thead>
          <tbody>${salespersonRows}</tbody>
        </table>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────
// DATA CLEANUP PAGE
// ─────────────────────────────────────────────
let cleanupSearchTimer;

function setCleanupFilter(key, value) {
  State.cleanupFilters[key] = value;
  renderPage('cleanup');
}

function refreshCleanup() {
  State.cleanupFilters.person = document.getElementById('cu-person-filter')?.value || '';
  State.cleanupFilters.sort   = document.getElementById('cu-sort-filter')?.value   || 'issues';
  renderPage('cleanup');
}

function toggleCleanupStage(stage) {
  const h = State.cleanupFilters.hiddenStages;
  const idx = h.indexOf(stage);
  if (idx === -1) h.push(stage); else h.splice(idx, 1);
  renderPage('cleanup');
}

function debounceCleanup() {
  clearTimeout(cleanupSearchTimer);
  State.cleanupFilters.search = document.getElementById('cu-search')?.value || '';
  cleanupSearchTimer = setTimeout(() => renderPage('cleanup'), 280);
}

function toggleCleanupMine() {
  State.cleanupFilters.mineOnly = !State.cleanupFilters.mineOnly;
  renderPage('cleanup');
}

function clearCleanupFilters() {
  State.cleanupFilters = { issue: '', search: '', person: '', hiddenStages: [], sort: 'issues', mineOnly: false };
  renderPage('cleanup');
}

// ── Orphan estimator repair ────────────────────────────────────────────────────
let _orphanData = null; // cached until user applies fix

async function loadOrphanPanel() {
  const wrap = document.getElementById('orphan-panel');
  if (!wrap) return;
  wrap.innerHTML = '<em style="color:var(--text-muted);font-size:13px">Scanning…</em>';
  try {
    _orphanData = await api.get('/api/admin/orphan-estimators');
  } catch (e) {
    wrap.innerHTML = '<em style="color:#dc2626;font-size:13px">Could not load scan results.</em>';
    return;
  }
  renderOrphanPanel();
}

function renderOrphanPanel() {
  const wrap = document.getElementById('orphan-panel');
  if (!wrap || !_orphanData) return;
  if (_orphanData.length === 0) {
    wrap.innerHTML = '<span style="color:#16a34a;font-size:13px;font-weight:600">✅ No orphaned estimator references found.</span>';
    return;
  }

  const rows = _orphanData.map(r => {
    const sel = `orphan-sel-${r.bid_id}`;
    const optionsHtml = r.candidates.map(c =>
      `<option value="${c.id}" ${r.suggested===c.id?'selected':''}>${esc(c.initials)} – ${esc(c.name)} (${esc(c.role)})</option>`
    ).join('');
    return `
      <tr>
        <td style="font-size:13px">${esc(r.project_name)}${r.bid_number ? `<br><small style="color:var(--text-muted)">#${esc(r.bid_number)}</small>` : ''}</td>
        <td><span class="badge badge-stage">${stageName(r.stage)}</span></td>
        <td style="font-size:12px;max-width:200px;word-break:break-word;color:var(--text-muted)">${esc(r.notes || r.estimate_approved_by || '')}</td>
        <td>
          <select id="${sel}" class="form-control" style="font-size:12px;padding:3px 6px">
            <option value="">— skip —</option>
            ${optionsHtml}
          </select>
        </td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div style="font-size:13px;font-weight:600;color:#d97706;margin-bottom:10px">
      ⚠️ ${_orphanData.length} bid${_orphanData.length!==1?'s':''} found with estimator initials in notes/fields but no estimator assigned.
      Review the suggested matches below and click <strong>Apply Fixes</strong>.
    </div>
    <div class="table-wrapper" style="max-height:320px;overflow-y:auto;margin-bottom:10px">
      <table>
        <thead><tr><th>Project</th><th>Stage</th><th>Notes / Field</th><th>Assign Estimator</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" onclick="applyOrphanFixes()">✅ Apply Fixes</button>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('orphan-card').style.display='none'">Dismiss</button>
    </div>`;
}

async function applyOrphanFixes() {
  if (!_orphanData) return;
  const fixes = _orphanData
    .map(r => ({ bid_id: r.bid_id, estimator_id: document.getElementById(`orphan-sel-${r.bid_id}`)?.value || '' }))
    .filter(f => f.estimator_id);
  if (!fixes.length) { alert('No estimators selected — nothing to apply.'); return; }
  try {
    const result = await api.post('/api/admin/fix-orphan-estimators', { fixes });
    alert(`✅ Fixed ${result.fixed} bid${result.fixed!==1?'s':''}. The page will now reload.`);
    _orphanData = null;
    renderPage('cleanup');
  } catch (e) { alert('Error: ' + e.message); }
}

async function renderCleanup(main) {
  main.innerHTML = '<div class="loading-screen"><div class="spinner"></div><p>Loading…</p></div>';

  // Fetch all non-deleted bids across every stage
  const allBids = await api.get('/api/bids?stage=opportunity,active_bid,active_co,follow_up,awarded,not_awarded,closed');

  // Tag every bid with its issues
  const tagged = allBids.map(b => ({ ...b, _issues: getBidIssues(b) }));
  const withIssues = tagged.filter(b => b._issues.length > 0);

  // Compute per-issue counts (across all bids, before filtering)
  const issueCounts = {};
  withIssues.forEach(b => b._issues.forEach(i => { issueCounts[i.key] = (issueCounts[i.key] || 0) + 1; }));

  // Issue chip definitions (only show chips that have data)
  const CHIP_DEFS = [
    { key: 'no_price',       label: 'No Price',         color: '#dc2626' },
    { key: 'no_customer',    label: 'No Customer',      color: '#9333ea' },
    { key: 'no_estimator',   label: 'No Estimator',     color: '#2563eb' },
    { key: 'no_salesperson', label: 'No Salesperson',   color: '#059669' },
    { key: 'no_due_date',    label: 'No Due Date',      color: '#d97706' },
    { key: 'no_followup',    label: 'No Follow-up',     color: '#ea580c' },
    { key: 'stale_followup', label: 'Follow-up 30d+',   color: '#b91c1c' },
    { key: 'stale',          label: '6mo+ Old',         color: '#a78bfa' },
    { key: 'very_stale',     label: '1yr+ Old',         color: '#78716c' },
  ].filter(c => issueCounts[c.key]);

  const { issue, search, person, hiddenStages, sort, mineOnly } = State.cleanupFilters;

  // Apply filters
  let filtered = withIssues;

  if (issue)               filtered = filtered.filter(b => b._issues.some(i => i.key === issue));
  if (hiddenStages.length) filtered = filtered.filter(b => !hiddenStages.includes(b.stage));
  if (person) {
    const pid = Number(person);
    filtered = filtered.filter(b => b.estimator_id === pid || b.salesperson_id === pid);
  }
  if (mineOnly && State.currentUser) {
    const uid = State.currentUser.id;
    filtered = filtered.filter(b => b.estimator_id === uid || b.salesperson_id === uid);
  }
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filtered = filtered.filter(b =>
      re.test(b.project_name) || re.test(b.bid_number || '') ||
      re.test(b.customer || '') || re.test(b.job_number || '')
    );
  }

  // Sort
  if (sort === 'issues') {
    filtered.sort((a, b) => b._issues.length - a._issues.length || a.project_name.localeCompare(b.project_name));
  } else if (sort === 'oldest') {
    filtered.sort((a, b) => {
      if (!a.date_received && !b.date_received) return 0;
      if (!a.date_received) return 1;
      if (!b.date_received) return -1;
      return a.date_received.localeCompare(b.date_received);
    });
  } else if (sort === 'stage') {
    const so = ['active_bid','active_co','follow_up','opportunity','awarded','not_awarded','closed'];
    filtered.sort((a, b) => so.indexOf(a.stage) - so.indexOf(b.stage));
  } else if (sort === 'name') {
    filtered.sort((a, b) => a.project_name.localeCompare(b.project_name));
  }

  // ── Stage counts (before stage filter, after other filters) ───────────────
  const STAGE_DEFS = [
    { key: 'active_bid',   label: 'Active Bid',    color: '#2563eb' },
    { key: 'active_co',    label: 'Change Order',  color: '#7c3aed' },
    { key: 'follow_up',    label: 'Follow Up',     color: '#d97706' },
    { key: 'opportunity',  label: 'Opportunity',   color: '#0891b2' },
    { key: 'awarded',      label: 'Awarded',       color: '#16a34a' },
    { key: 'not_awarded',  label: 'Not Awarded',   color: '#dc2626' },
    { key: 'closed',       label: 'Closed',        color: '#78716c' },
  ];
  const stageCounts = {};
  withIssues.forEach(b => { stageCounts[b.stage] = (stageCounts[b.stage] || 0) + 1; });
  const activeStages = STAGE_DEFS.filter(s => stageCounts[s.key]);

  // ── Build chips ────────────────────────────────────────────────────────────
  const activeFilter = issue;
  const chipsHtml = `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
      <button class="cleanup-chip${!activeFilter ? ' active' : ''}"
              onclick="setCleanupFilter('issue','')"
              style="border-color:#64748b;${!activeFilter ? 'background:#64748b;color:#fff' : 'color:#64748b'}">
        All Issues <span class="chip-count">${withIssues.length}</span>
      </button>
      ${CHIP_DEFS.map(c => `
        <button class="cleanup-chip${activeFilter===c.key ? ' active' : ''}"
                onclick="setCleanupFilter('issue','${c.key}')"
                style="border-color:${c.color};${activeFilter===c.key ? `background:${c.color};color:#fff` : `color:${c.color}`}">
          ${c.label} <span class="chip-count">${issueCounts[c.key]}</span>
        </button>`).join('')}
    </div>
    ${activeStages.length > 1 ? `
    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:16px">
      <span style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-right:2px">Stages:</span>
      ${activeStages.map(s => {
        const hidden = hiddenStages.includes(s.key);
        return `<button class="cleanup-chip${!hidden ? ' active' : ''}"
          onclick="toggleCleanupStage('${s.key}')"
          style="border-color:${s.color};${!hidden ? `background:${s.color};color:#fff` : `color:${s.color};opacity:0.5`}">
          ${s.label} <span class="chip-count">${stageCounts[s.key]}</span>
        </button>`;
      }).join('')}
    </div>` : ''}`;

  // ── Filter bar ─────────────────────────────────────────────────────────────
  const allPeople = State.team.filter(m => m.active);
  const personOptions = allPeople
    .map(m => `<option value="${m.id}" ${person==m.id?'selected':''}>${esc(m.initials)} – ${esc(m.name)}</option>`)
    .join('');

  // ── Progress bar (% of all bids that are clean) ────────────────────────────
  const totalBids = allBids.length;
  const cleanPct  = totalBids > 0 ? Math.round((totalBids - withIssues.length) / totalBids * 100) : 100;
  const progressHtml = `
    <div style="margin-bottom:16px;background:var(--card-bg);border-radius:8px;padding:14px 16px;border:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:13px;font-weight:600;color:var(--text)">Data Quality Progress</span>
        <span style="font-size:13px;color:${cleanPct===100?'#16a34a':'var(--text-muted)'};font-weight:700">${cleanPct}% complete</span>
      </div>
      <div style="height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${cleanPct}%;background:${cleanPct>=80?'#16a34a':cleanPct>=50?'#d97706':'#dc2626'};border-radius:4px;transition:width 0.4s"></div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
        ${totalBids - withIssues.length} of ${totalBids} bids fully complete · ${withIssues.length} need attention
      </div>
    </div>`;

  // ── Table rows ─────────────────────────────────────────────────────────────
  function missingCell(val, label) {
    return val
      ? `<span>${esc(String(val))}</span>`
      : `<span style="color:#dc2626;font-size:11px;font-style:italic">${label}</span>`;
  }

  const rows = filtered.map(b => {
    const issueTags = b._issues.map(i =>
      `<span class="issue-tag" style="color:${i.color};background:${i.color}18;border-color:${i.color}40">${i.label}</span>`
    ).join('');

    return `
      <tr class="clickable-row" onclick="openJobPanel(${b.id})">
        <td class="td-project">${esc(b.project_name)}<small>${b.bid_number ? ' #' + esc(b.bid_number) : ''}</small></td>
        <td><span class="badge badge-stage">${stageName(b.stage)}</span></td>
        <td style="min-width:160px">${issueTags}</td>
        <td>${missingCell(b.customer, 'Missing')}</td>
        <td class="td-amount">${b.estimate_amount ? fmt(b.estimate_amount, 'currency') : '<span style="color:#dc2626;font-style:italic;font-size:12px">Missing</span>'}</td>
        <td>${b.estimator_initials   ? `<span class="initials-pill">${esc(b.estimator_initials)}</span>`   : '<span style="color:#dc2626;font-size:12px">—</span>'}</td>
        <td>${b.salesperson_initials ? `<span class="initials-pill" style="background:#dcfce7;color:#166534">${esc(b.salesperson_initials)}</span>` : '<span style="color:#dc2626;font-size:12px">—</span>'}</td>
        <td class="td-date">${fmt(b.date_received, 'date')}</td>
        <td onclick="event.stopPropagation()">
          <button class="btn btn-primary btn-sm"
            data-bid-id="${b.id}"
            data-issues="${esc(JSON.stringify(b._issues.map(i=>i.key)))}"
            onclick="openBidModalForFix(this)" title="Edit & fix this bid">✏️ Fix</button>
        </td>
      </tr>`;
  }).join('');

  // ── Assemble page ──────────────────────────────────────────────────────────
  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">🧹 Data Cleanup</div>
        <div class="page-subtitle">
          ${withIssues.length} bids with missing data · ${filtered.length} shown
          ${(issue||hiddenStages.length||person||mineOnly||search) ? ' <em style="color:var(--text-muted)">(filtered)</em>' : ''}
        </div>
      </div>
      <button class="btn btn-secondary" onclick="clearCleanupFilters()">Reset Filters</button>
    </div>

    ${State.currentUser?.is_admin ? `
    <div id="orphan-card" style="background:var(--card-bg);border:1px solid #d97706;border-radius:8px;padding:14px 16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:13px;font-weight:700;color:#d97706">🔍 Estimator Scan</span>
        <button class="btn btn-ghost btn-sm" onclick="loadOrphanPanel()">Scan Now</button>
      </div>
      <div id="orphan-panel" style="font-size:13px;color:var(--text-muted)">
        Click <strong>Scan Now</strong> to find bids where estimator initials appear in notes but no estimator is assigned.
      </div>
    </div>` : ''}

    ${progressHtml}
    ${chipsHtml}

    <div class="filter-bar">
      <input type="text" id="cu-search"
             placeholder="Search project, bid #, customer…"
             value="${esc(search)}" oninput="debounceCleanup()" />
      <select id="cu-person-filter" onchange="refreshCleanup()">
        <option value="">All People</option>
        ${personOptions}
      </select>
      <select id="cu-sort-filter" onchange="refreshCleanup()">
        <option value="issues">Sort: Most Issues</option>
        <option value="oldest">Sort: Oldest First</option>
        <option value="stage">Sort: By Stage</option>
        <option value="name">Sort: A–Z</option>
      </select>
      ${State.currentUser ? `<button class="mine-toggle ${mineOnly ? 'active' : ''}" onclick="toggleCleanupMine()"><span class="toggle-dot"></span> Mine Only</button>` : ''}
    </div>

    <div class="table-wrapper">
      ${filtered.length ? `
      <table>
        <thead><tr>
          <th>Project</th><th>Stage</th><th>Issues</th><th>Customer</th>
          <th>Amount</th><th>Est.</th><th>Sales</th><th>Received</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-state-icon">${withIssues.length === 0 ? '🏆' : '🔍'}</div>
        <div class="empty-state-title">${withIssues.length === 0 ? 'All bids are complete!' : 'No bids match your filters'}</div>
        <div class="empty-state-desc">${withIssues.length === 0 ? 'Great work — no missing data found.' : 'Try adjusting the filters above.'}</div>
      </div>`}
    </div>`;

  // Restore select values after render
  if (person) document.getElementById('cu-person-filter').value = person;
  if (sort !== 'issues') document.getElementById('cu-sort-filter').value = sort;
}

// ─────────────────────────────────────────────
// SETTINGS PAGE
// ─────────────────────────────────────────────
async function renderSettings(main) {
  const team = await api.get('/api/team');
  const isAdmin = State.currentUser?.is_admin;

  const rows = team.map(m => `
    <div class="team-row ${m.active ? '' : 'team-inactive'}">
      <div class="team-initials-circle" style="background:${m.role === 'salesperson' ? '#16a34a' : m.role === 'estimator/pm' ? '#7c3aed' : '#2563eb'}">${esc(m.initials)}</div>
      <div style="flex:1">
        <div class="team-name">${esc(m.name)} ${m.is_admin ? '<span style="font-size:11px;background:#6366f1;color:#fff;padding:1px 6px;border-radius:4px;margin-left:4px">Admin</span>' : ''}</div>
        <div class="team-role">${m.role}${m.email ? ' · ' + esc(m.email) : ''} ${m.active ? '' : '· <em>Inactive</em>'}</div>
      </div>
      ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="editTeamMember(${m.id})">Edit</button>` : ''}
      ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="resetMemberPassword(${m.id}, '${esc(m.name)}')">Reset PW</button>` : ''}
      ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="toggleTeamMember(${m.id}, ${m.active})">${m.active ? 'Deactivate' : 'Activate'}</button>` : ''}
    </div>`).join('');

  main.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">⚙️ Team Settings</div><div class="page-subtitle">Manage estimators, salespeople, and PMs</div></div>
      ${isAdmin ? '<button class="btn btn-primary" onclick="showAddTeamForm()">+ Add Member</button>' : ''}
    </div>

    <div class="card" style="max-width:640px;margin-bottom:20px;display:none" id="add-team-form">
    </div>

    <div class="card" style="max-width:640px">
      <div class="section-title">Team Members</div>
      <div class="team-table">${rows}</div>
    </div>

    ${isAdmin ? `
    <div class="card" style="max-width:640px;margin-top:20px">
      <div class="section-title">⏰ Follow-up Timelines</div>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
        Set the default number of days used to auto-suggest the next follow-up date
        when logging a contact on a bid.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
        <div class="form-group">
          <label class="form-label">Initial Follow-up (days after submission)</label>
          <input class="form-input" type="number" id="s-fu-initial" min="1" max="90"
                 value="${State.settings.fu_initial_days ?? 3}" style="width:100%" />
        </div>
        <div class="form-group">
          <label class="form-label">Recurring Follow-up (days between contacts)</label>
          <input class="form-input" type="number" id="s-fu-recurring" min="1" max="90"
                 value="${State.settings.fu_recurring_days ?? 7}" style="width:100%" />
        </div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="saveFollowupSettings()">Save Intervals</button>
      <span id="s-fu-saved" style="display:none;margin-left:10px;font-size:13px;color:#16a34a">✓ Saved</span>
    </div>` : ''}

    ${isAdmin ? `
    <div class="card" style="max-width:640px;margin-top:20px">
      <div class="section-title">📥 Import Excel File</div>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
        Upload the latest <strong>Estimating Calendar.xlsx</strong> to sync all bids into the database.
        Existing bids are matched by Bid # or project name and updated; new bids are inserted.
        Nothing is deleted.
      </p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="file" id="excel-file-input" accept=".xlsx"
               style="flex:1;min-width:200px;font-size:13px;color:var(--text-muted)" />
        <button class="btn btn-primary" onclick="importExcel()">Import &amp; Sync</button>
      </div>
      <div id="excel-import-result" style="margin-top:14px"></div>
    </div>` : ''}`;
}

function showAddTeamForm(memberId, name, initials, role, active, email, is_admin) {
  const formCard = document.getElementById('add-team-form');
  const isEdit = !!memberId;
  formCard.style.display = 'block';
  formCard.innerHTML = `
    <div class="section-title">${isEdit ? 'Edit' : 'Add'} Team Member</div>
    <input type="hidden" id="tm-id" value="${memberId || ''}" />
    <div class="form-grid-3">
      <div class="form-group"><label>Full Name</label><input type="text" id="tm-name" value="${esc(name || '')}" placeholder="Full name" /></div>
      <div class="form-group"><label>Initials</label><input type="text" id="tm-initials" value="${esc(initials || '')}" placeholder="JO" maxlength="4" /></div>
      <div class="form-group"><label>Role</label>
        <select id="tm-role">
          <option value="estimator" ${role === 'estimator' ? 'selected' : ''}>Estimator</option>
          <option value="salesperson" ${role === 'salesperson' ? 'selected' : ''}>Salesperson</option>
          <option value="estimator/pm" ${role === 'estimator/pm' ? 'selected' : ''}>Estimator/PM</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>Email Address</label>
      <input type="email" id="tm-email" value="${esc(email || '')}" placeholder="user@example.com" />
    </div>
    ${!isEdit ? `
    <div class="form-group">
      <label>Temporary Password <span class="optional">(optional)</span></label>
      <input type="password" id="tm-temp-password" placeholder="Temp password — user must change on first login" />
      <small class="field-hint">If set, user will be required to change password on first login.</small>
    </div>` : ''}
    <div class="form-group" style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="tm-is-admin" ${is_admin ? 'checked' : ''} style="width:auto" />
      <label for="tm-is-admin" style="margin:0">Admin (can manage team, see all bids)</label>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" onclick="saveTeamMember()">Save</button>
      <button class="btn btn-secondary" onclick="document.getElementById('add-team-form').style.display='none'">Cancel</button>
    </div>`;
}

function editTeamMember(id) {
  const m = State.team.find(t => t.id === id);
  if (!m) return;
  showAddTeamForm(m.id, m.name, m.initials, m.role, m.active, m.email, m.is_admin);
  document.getElementById('add-team-form').scrollIntoView({ behavior: 'smooth' });
}

async function saveTeamMember() {
  const id = document.getElementById('tm-id').value;
  const name = document.getElementById('tm-name').value.trim();
  const initials = document.getElementById('tm-initials').value.trim().toUpperCase();
  const role = document.getElementById('tm-role').value;
  const email = (document.getElementById('tm-email')?.value || '').trim();
  const is_admin = document.getElementById('tm-is-admin')?.checked || false;
  const temp_password = document.getElementById('tm-temp-password')?.value || '';
  if (!name || !initials) return alert('Name and initials are required.');
  try {
    if (id) {
      const payload = { name, initials, role, email: email || null, is_admin };
      await api.put(`/api/team/${id}`, payload);
    } else {
      const payload = { name, initials, role, email: email || null, is_admin };
      if (temp_password) payload.temp_password = temp_password;
      await api.post('/api/team', payload);
    }
    State.team = await api.get('/api/team');
    await renderSettings(document.getElementById('main'));
  } catch (e) { alert('Error: ' + e.message); }
}

async function resetMemberPassword(id, name) {
  const tempPw = prompt(`Enter a temporary password for ${name}:\n(They will be required to change it on next login)`);
  if (!tempPw) return;
  try {
    await api.post(`/api/team/${id}/reset-password`, { temp_password: tempPw });
    alert(`Temporary password set for ${name}. They will be prompted to change it on next login.`);
  } catch (e) { alert('Error: ' + e.message); }
}

async function saveFollowupSettings() {
  const initial   = Number(document.getElementById('s-fu-initial')?.value) || 3;
  const recurring = Number(document.getElementById('s-fu-recurring')?.value) || 7;
  try {
    State.settings = await api.put('/api/settings', { fu_initial_days: initial, fu_recurring_days: recurring });
    const saved = document.getElementById('s-fu-saved');
    if (saved) { saved.style.display = 'inline'; setTimeout(() => { saved.style.display = 'none'; }, 2000); }
  } catch (e) { alert('Save failed: ' + e.message); }
}

async function toggleTeamMember(id, currentActive) {
  await api.put(`/api/team/${id}`, { active: currentActive ? 0 : 1 });
  State.team = await api.get('/api/team');
  await renderSettings(document.getElementById('main'));
}

async function importExcel() {
  const input    = document.getElementById('excel-file-input');
  const resultEl = document.getElementById('excel-import-result');
  if (!input || !input.files.length) {
    resultEl.innerHTML = '<span style="color:var(--danger)">Please select an .xlsx file first.</span>';
    return;
  }
  const file = input.files[0];
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    resultEl.innerHTML = '<span style="color:var(--danger)">Only .xlsx files are supported.</span>';
    return;
  }

  resultEl.innerHTML = '<span style="color:var(--text-muted)">⏳ Uploading and syncing — this may take a moment…</span>';

  const reader = new FileReader();
  reader.onerror = () => {
    resultEl.innerHTML = '<span style="color:var(--danger)">Failed to read file.</span>';
  };
  reader.onload = async (e) => {
    // Convert ArrayBuffer → base64 in safe chunks
    const bytes = new Uint8Array(e.target.result);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const fileData = btoa(binary);

    try {
      const result = await api.post('/api/admin/sync-excel', { fileData });
      const errDetail = result.errors && result.errors.length
        ? `<div style="margin-top:8px;font-size:12px;color:var(--danger)">
             Errors:<br>${result.errors.map(e => `• ${esc(e.project)}: ${esc(e.message)}`).join('<br>')}
           </div>`
        : '';
      resultEl.innerHTML = `
        <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px;font-size:13px">
          ✅ <strong>Sync complete</strong><br>
          <span style="color:var(--text-muted)">
            Updated: <strong style="color:var(--text)">${result.update}</strong> &nbsp;·&nbsp;
            Inserted: <strong style="color:var(--text)">${result.insert}</strong> &nbsp;·&nbsp;
            Skipped: <strong style="color:var(--text)">${result.skip}</strong>
            ${result.error > 0 ? ` &nbsp;·&nbsp; Errors: <strong style="color:var(--danger)">${result.error}</strong>` : ''}
          </span>
          ${errDetail}
        </div>`;
    } catch (err) {
      resultEl.innerHTML = `<span style="color:var(--danger)">Sync failed: ${esc(err.message)}</span>`;
    }
  };
  reader.readAsArrayBuffer(file);
}

// ─────────────────────────────────────────────
// BID CHECKLIST
// ─────────────────────────────────────────────
const CHECKLIST = [
  { id: 'ps', label: 'Plans & Specs', items: [
    { id: 'ps1', label: 'Review Bid Invite email' },
    { id: 'ps2', label: 'Review Bid Site' },
    { id: 'ps3', label: 'Review Plans & Specs' },
    { id: 'ps4', label: 'Review photos' },
    { id: 'ps5', label: 'Check Google Maps / street view' },
    { id: 'ps6', label: 'Check Accubid scales' },
    { id: 'ps7', label: 'Ceiling heights and types' },
    { id: 'ps8', label: 'Logistics (labor factor for staging, waiting, badging, etc.)' },
    { id: 'ps9', label: 'Call architect — find other GCs to bid to' },
  ]},
  { id: 'ms', label: 'Miscellaneous', items: [
    { id: 'ms1', label: 'Bid type (budget? Final round?)' },
    { id: 'ms2', label: 'RACP' },
    { id: 'ms3', label: 'Buy American' },
    { id: 'ms4', label: 'Tax Exempt / KOZ etc.' },
    { id: 'ms5', label: 'ICRA Requirements' },
  ]},
  { id: 'pb', label: 'Pre-Bid', items: [
    { id: 'pb1', label: 'Pre Con' },
    { id: 'pb2', label: 'Pre Con with GC' },
    { id: 'pb3', label: 'Send RFIs' },
    { id: 'pb4', label: 'RFIs Answered?' },
  ]},
  { id: 'rq', label: 'Requests for Quotes (RFQs)', items: [
    { id: 'rq1',  label: 'Lighting Counts' },
    { id: 'rq2',  label: 'Attic Stock, Mockups' },
    { id: 'rq3',  label: 'Lighting Rep / Mixed Bag' },
    { id: 'rq4',  label: 'Lighting RFQ' },
    { id: 'rq5',  label: 'Gear Counts' },
    { id: 'rq6',  label: 'Gear Studies' },
    { id: 'rq7',  label: 'Gear RFQ' },
    { id: 'rq8',  label: 'Fire Alarm RFQ' },
    { id: 'rq9',  label: 'Nurse Call RFQ' },
    { id: 'rq10', label: 'Generator RFQ' },
    { id: 'rq11', label: 'Electrical Testing' },
    { id: 'rq12', label: 'Rigging RFQ' },
    { id: 'rq13', label: 'Misc RFQ (Wiremold / Poke-Thrus)' },
  ]},
  { id: 'to', label: 'Takeoff', items: [
    { id: 'to1',  label: 'Electrical Safe-Off / Demo' },
    { id: 'to2',  label: 'Temporary Power & Lighting' },
    { id: 'to3',  label: 'Lighting' },
    { id: 'to4',  label: 'Devices & Receptacles' },
    { id: 'to5',  label: 'Mechanical' },
    { id: 'to6',  label: 'Fire Alarm' },
    { id: 'to7',  label: 'Nurse Call' },
    { id: 'to8',  label: 'Low Voltage & Tele/Data' },
    { id: 'to9',  label: 'Access Controls & Security' },
    { id: 'to10', label: 'Distribution' },
    { id: 'to11', label: 'Review Extension' },
  ]},
  { id: 'rv', label: 'Review Quotes', items: [
    { id: 'rv1', label: 'Lighting Quote' },
    { id: 'rv2', label: 'Gear Quote w/ Studies' },
    { id: 'rv3', label: 'Electrical Testing Quote' },
    { id: 'rv4', label: 'Fire Alarm Quote' },
    { id: 'rv5', label: 'Nurse Call Quote' },
    { id: 'rv6', label: 'Rigging Quote' },
    { id: 'rv7', label: 'Generator Quote' },
    { id: 'rv8', label: 'Off-Hours Work' },
    { id: 'rv9', label: 'Review Project Schedule' },
  ]},
  { id: 'ae', label: 'Accubid Job Expenses', items: [
    { id: 'ae1',  label: 'Direct Labor (DirLb)' },
    { id: 'ae2',  label: 'Incidental Labor (IncLb)' },
    { id: 'ae3',  label: 'Indirect Labor (IndLb)' },
    { id: 'ae4',  label: 'Subcontractors (Subs)' },
    { id: 'ae5',  label: 'General Expenses (GenExp)' },
    { id: 'ae6',  label: 'Quoted Materials (QtMat)' },
    { id: 'ae7',  label: 'Final Price (FnPrc)' },
    { id: 'ae8',  label: 'Tax' },
    { id: 'ae9',  label: 'Bond' },
    { id: 'ae10', label: 'GenExp: add permits and inspections' },
    { id: 'ae11', label: 'Key Indicators (KeyInd) — enter Area' },
  ]},
  { id: 'bp', label: 'Bid Proposal', items: [
    { id: 'bp1', label: 'GC Scope of Work' },
    { id: 'bp2', label: 'Complete Bid for Customer' },
    { id: 'bp3', label: 'Verify Current Drawings' },
  ]},
  { id: 'sb', label: 'Schedule Bid Review', items: [
    { id: 'sb1', label: 'Calendar invite' },
    { id: 'sb2', label: 'Project HQ action item' },
  ]},
  { id: 'br', label: 'Bid Review', items: [
    { id: 'br1',  label: 'Project Schedule' },
    { id: 'br2',  label: 'GC Scope of Work' },
    { id: 'br3',  label: 'EMT vs. MC' },
    { id: 'br4',  label: 'Labor Rates & Jurisdiction' },
    { id: 'br5',  label: 'Remote Drivers' },
    { id: 'br6',  label: 'Current Drawings' },
    { id: 'br7',  label: 'Verify Correct Breakers' },
    { id: 'br8',  label: 'Lighting Rep' },
    { id: 'br9',  label: 'Review Vendor Quotes' },
    { id: 'br10', label: 'Equipment Rentals' },
    { id: 'br11', label: 'OH, Profit, Material, Tax' },
    { id: 'br12', label: 'Bonding and Insurance' },
    { id: 'br13', label: 'BIM' },
    { id: 'br14', label: 'Square Foot Pricing' },
    { id: 'br15', label: 'Tariff Exclusions' },
    { id: 'br16', label: 'Bid Proposal' },
  ]},
  { id: 'sn', label: 'Send', items: [
    { id: 'sn1', label: 'Send bid to customer(s)' },
    { id: 'sn2', label: 'Update Bid Tracker (Status, BidDateSent, BidRfcPrice, fill in missing GCs)' },
  ]},
];

const CHECKLIST_TOTAL = CHECKLIST.reduce((s, sec) => s + sec.items.length, 0);

function parseChecklist(raw) {
  const checked = new Set(), na = new Set();
  (raw || []).forEach(id => id.startsWith('na:') ? na.add(id.slice(3)) : checked.add(id));
  return { checked, na };
}

function clPct(checked, na) {
  const denom = CHECKLIST_TOTAL - na.size;
  return denom > 0 ? checked.size / denom : 1;
}

function clSummaryText(checked, na) {
  const denom = CHECKLIST_TOTAL - na.size;
  const pct   = Math.round(clPct(checked, na) * 100);
  return `${checked.size}/${denom} · ${pct}%${na.size ? ` · ${na.size} N/A` : ''}`;
}

function renderChecklistSection(bid) {
  const { checked, na } = parseChecklist(bid.checklist);
  const pct = Math.round(clPct(checked, na) * 100);

  const sections = CHECKLIST.map(sec => {
    const secDone = sec.items.filter(i => checked.has(i.id)).length;
    const secNA   = sec.items.filter(i => na.has(i.id)).length;
    const secDenom = sec.items.length - secNA;
    return `
      <div class="cl-section">
        <div class="cl-section-hdr">
          <span class="cl-section-name">${esc(sec.label)}</span>
          <span class="cl-section-count">${secDone}/${secDenom}${secNA ? ` · ${secNA} N/A` : ''}</span>
        </div>
        ${sec.items.map(item => {
          const isChecked = checked.has(item.id);
          const isNA      = na.has(item.id);
          const state     = isChecked ? 'checked' : isNA ? 'na' : '';
          return `
          <div class="cl-item${isChecked ? ' cl-item-done' : isNA ? ' cl-item-na' : ''}"
               data-bid-id="${bid.id}" data-item-id="${item.id}" data-state="${state}">
            <input type="checkbox" class="cl-checkbox"
                   ${isChecked ? 'checked' : ''} ${isNA ? 'disabled' : ''}
                   onchange="toggleChecklistItem(this,${bid.id},'${item.id}')" />
            <span class="cl-item-label">${esc(item.label)}</span>
            ${isNA
              ? `<span class="cl-na-tag" onclick="toggleChecklistNA(event,${bid.id},'${item.id}')">N/A</span>`
              : `<button class="cl-na-btn" type="button"
                         onclick="toggleChecklistNA(event,${bid.id},'${item.id}')">N/A</button>`}
          </div>`;
        }).join('')}
      </div>`;
  }).join('');

  return `
    <div class="jp-section" id="cl-section-${bid.id}">
      <div class="cl-header" onclick="toggleChecklistOpen(${bid.id})">
        <div style="flex:1;min-width:0">
          <div class="jp-section-title" style="margin:0">Bid Checklist
            <span class="cl-summary" id="cl-summary-${bid.id}">${clSummaryText(checked, na)}</span>
          </div>
          <div class="cl-progress-bar-wrap">
            <div class="cl-progress-bar-fill" id="cl-bar-${bid.id}" style="width:${pct}%"></div>
          </div>
        </div>
        <span class="cl-toggle-icon" id="cl-icon-${bid.id}">▶</span>
      </div>
      <div class="cl-body" id="cl-body-${bid.id}" style="display:none">
        ${sections}
      </div>
    </div>`;
}

function toggleChecklistOpen(bidId) {
  const body = document.getElementById(`cl-body-${bidId}`);
  const icon = document.getElementById(`cl-icon-${bidId}`);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (icon) icon.textContent = open ? '▶' : '▼';
}

let _clSaveTimer = null;

// Collect current checklist array from DOM state for a given bid
function getChecklistFromDOM(bidId) {
  const items = document.querySelectorAll(`.cl-item[data-bid-id="${bidId}"]`);
  const result = [];
  items.forEach(el => {
    const state  = el.dataset.state;
    const itemId = el.dataset.itemId;
    if (state === 'checked') result.push(itemId);
    if (state === 'na')      result.push('na:' + itemId);
  });
  return result;
}

function updateChecklistUI(bidId) {
  const items   = document.querySelectorAll(`.cl-item[data-bid-id="${bidId}"]`);
  const checked = new Set(), na = new Set();
  items.forEach(el => {
    if (el.dataset.state === 'checked') checked.add(el.dataset.itemId);
    if (el.dataset.state === 'na')      na.add(el.dataset.itemId);
  });
  const pct = clPct(checked, na);
  const summaryEl = document.getElementById(`cl-summary-${bidId}`);
  const barEl     = document.getElementById(`cl-bar-${bidId}`);
  if (summaryEl) summaryEl.textContent = clSummaryText(checked, na);
  if (barEl)     barEl.style.width = `${Math.round(pct * 100)}%`;
  return { checklist: getChecklistFromDOM(bidId), pct };
}

function saveChecklist(bidId) {
  clearTimeout(_clSaveTimer);
  _clSaveTimer = setTimeout(async () => {
    const { checklist, pct } = updateChecklistUI(bidId);
    try {
      await api.put(`/api/bids/${bidId}`, { checklist, estimate_pct_complete: pct });
    } catch (e) { console.error('Checklist save failed:', e.message); }
  }, 800);
}

function toggleChecklistItem(checkbox, bidId, itemId) {
  const row = checkbox.closest('.cl-item');
  if (!row) return;
  if (checkbox.checked) {
    row.dataset.state = 'checked';
    row.classList.add('cl-item-done');
    row.classList.remove('cl-item-na');
  } else {
    row.dataset.state = '';
    row.classList.remove('cl-item-done');
  }
  updateChecklistUI(bidId);
  saveChecklist(bidId);
}

function toggleChecklistNA(event, bidId, itemId) {
  event.preventDefault(); event.stopPropagation();
  const row = document.querySelector(`.cl-item[data-bid-id="${bidId}"][data-item-id="${itemId}"]`);
  if (!row) return;

  const currentState = row.dataset.state;
  if (currentState === 'na') {
    // Remove N/A → back to unchecked
    row.dataset.state = '';
    row.classList.remove('cl-item-na');
    // Restore checkbox + N/A button
    const cb = row.querySelector('.cl-checkbox');
    if (cb) { cb.checked = false; cb.disabled = false; }
    const tag = row.querySelector('.cl-na-tag');
    if (tag) tag.outerHTML = `<button class="cl-na-btn" type="button"
                                       onclick="toggleChecklistNA(event,${bidId},'${itemId}')">N/A</button>`;
  } else {
    // Set N/A — uncheck if checked
    const cb = row.querySelector('.cl-checkbox');
    if (cb) { cb.checked = false; cb.disabled = true; }
    row.dataset.state = 'na';
    row.classList.remove('cl-item-done');
    row.classList.add('cl-item-na');
    const btn = row.querySelector('.cl-na-btn');
    if (btn) btn.outerHTML = `<span class="cl-na-tag">N/A</span>`;
  }

  updateChecklistUI(bidId);
  saveChecklist(bidId);
}

// ─────────────────────────────────────────────
// CONTACTS PAGE
// ─────────────────────────────────────────────
let _contactsCache = [];   // full list; filtered client-side
let _ctDebounce    = null;

function fmtPhone(p) {
  if (!p) return '—';
  const d = String(p).replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  return p;
}

function refreshContacts() { renderContacts(document.getElementById('main')); }
function debounceContacts() {
  clearTimeout(_ctDebounce);
  _ctDebounce = setTimeout(refreshContacts, 250);
}
function clearContactFilters() {
  ['ct-search','ct-company-filter'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const nb = document.getElementById('ct-no-company-btn');
  if (nb) nb.classList.remove('active');
  refreshContacts();
}

async function renderContacts(main) {
  // Read filter values BEFORE wiping the DOM — they live inside main
  const search     = document.getElementById('ct-search')?.value.toLowerCase()        || '';
  const companyVal = document.getElementById('ct-company-filter')?.value               || '';
  const noCompany  = document.getElementById('ct-no-company-btn')?.classList.contains('active') || false;

  main.innerHTML = '<div class="loading-screen"><div class="spinner"></div></div>';

  // Only hit the API on first load; subsequent filter changes use the cache
  if (!_contactsCache.length) _contactsCache = await api.get('/api/contacts');

  const isAdmin = !!State.currentUser?.is_admin;

  // Client-side filter
  let contacts = _contactsCache;
  if (search) {
    contacts = contacts.filter(c =>
      (c.full_name  || '').toLowerCase().includes(search) ||
      (c.company    || '').toLowerCase().includes(search) ||
      (c.email      || '').toLowerCase().includes(search) ||
      (c.phone      || '').includes(search.replace(/\D/g,''))
    );
  }
  if (companyVal) contacts = contacts.filter(c => c.company === companyVal);
  if (noCompany)  contacts = contacts.filter(c => !c.company);

  // Stats
  const total      = _contactsCache.length;
  const withCo     = _contactsCache.filter(c => c.company).length;
  const withoutCo  = total - withCo;
  const companies  = [...new Set(_contactsCache.map(c => c.company).filter(Boolean))].sort();

  const coOptions  = companies.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  // Datalist for autocomplete in add/edit
  const datalistOpts = companies.map(c => `<option value="${esc(c)}">`).join('');

  const rows = contacts.map(c => {
    const loc = [c.city, c.state].filter(Boolean).join(', ');
    const coBadge = c.company
      ? `<span class="ct-company-name" onclick="editContactCompany(${c.id},event)">${esc(c.company)}</span>
         <span class="company-link" style="font-size:11px;margin-left:4px" data-company="${esc(c.company)}" onclick="openCompanyProfile(this.dataset.company);event.stopPropagation()">↗</span>`
      : `<button class="ct-assign-btn" onclick="editContactCompany(${c.id},event)">+ Assign</button>`;
    return `
      <tr>
        <td class="td-project">
          <span class="profile-link" data-contact-id="${c.id}"
                onclick="openContactProfile(this.dataset.contactId)"
                style="font-weight:600">${esc(c.full_name || '—')}</span>
        </td>
        <td id="ct-co-cell-${c.id}">${coBadge}</td>
        <td>${fmtPhone(c.phone)}</td>
        <td>${c.email ? `<a href="mailto:${esc(c.email)}" style="color:var(--primary)">${esc(c.email)}</a>` : '—'}</td>
        <td style="color:var(--text-muted);font-size:13px">${esc(loc) || '—'}</td>
        <td><div class="actions">
          <button class="btn btn-ghost btn-sm" onclick="openContactModal(${c.id})" title="Edit">✏️</button>
          ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="promptDeleteContact(${c.id},'${esc(c.full_name||'')}')" title="Delete">🗑️</button>` : ''}
        </div></td>
      </tr>`;
  }).join('');

  main.innerHTML = `
    <datalist id="company-datalist">${datalistOpts}</datalist>

    <div class="page-header">
      <div>
        <div class="page-title">👥 Contacts</div>
        <div class="page-subtitle">
          ${total} contacts · ${withCo} with company ·
          <button class="btn-inline-link" onclick="toggleContactNoCompany()">
            ${withoutCo} without company
          </button>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${isAdmin ? `<button class="btn btn-secondary" onclick="importContactsCSV()">📥 Import CSV</button>` : ''}
        <button class="btn btn-primary" onclick="openContactModal(null)">+ Add Contact</button>
      </div>
    </div>

    <div class="filter-bar">
      <input type="text" id="ct-search" placeholder="Search name, email, phone, company…"
             value="${esc(search)}" oninput="debounceContacts()" />
      <select id="ct-company-filter" onchange="refreshContacts()">
        <option value="">All Companies</option>
        ${coOptions}
      </select>
      <button id="ct-no-company-btn" class="mine-toggle${noCompany?' active':''}"
              onclick="toggleContactNoCompany()">
        <span class="toggle-dot"></span> No Company
      </button>
      <button class="btn btn-secondary btn-sm" onclick="clearContactFilters()">Clear</button>
    </div>

    <div class="table-wrapper">
      ${contacts.length ? `
      <table>
        <thead><tr>
          <th>Name</th><th>Company</th><th>Phone</th><th>Email</th>
          <th>Location</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-state-icon">👥</div>
        <div class="empty-state-title">No contacts found</div>
        <div class="empty-state-desc">Try adjusting your filters or import a CSV.</div>
      </div>`}
    </div>

    <!-- Add/Edit modal (hidden) -->
    <div id="contact-modal" class="modal-overlay" style="display:none" onclick="closeContactModal(event)">
      <div class="modal-box" style="max-width:520px">
        <div class="modal-header">
          <span id="contact-modal-title">Add Contact</span>
          <button class="modal-close" onclick="closeContactModalForce()">×</button>
        </div>
        <div id="contact-modal-body"></div>
      </div>
    </div>`;

  // Restore filter values after render
  if (companyVal) document.getElementById('ct-company-filter').value = companyVal;
  if (noCompany)  document.getElementById('ct-no-company-btn').classList.add('active');
}

function toggleContactNoCompany() {
  const btn = document.getElementById('ct-no-company-btn');
  if (btn) btn.classList.toggle('active');
  refreshContacts();
}

// ── Inline company edit ───────────────────────────────────────────────────────
function editContactCompany(id, e) {
  e.stopPropagation();
  const cell = document.getElementById(`ct-co-cell-${id}`);
  if (!cell || cell.querySelector('input')) return; // already editing
  const current = _contactsCache.find(c => c.id === id)?.company || '';
  cell.innerHTML = `
    <div style="display:flex;gap:4px;align-items:center">
      <input id="ct-co-input-${id}" type="text" list="company-datalist"
             value="${esc(current)}" placeholder="Company name…"
             style="flex:1;font-size:13px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--text)"
             onkeydown="if(event.key==='Enter')saveContactCompany(${id});if(event.key==='Escape')refreshContacts();" />
      <button class="btn btn-primary btn-sm" style="white-space:nowrap" onclick="saveContactCompany(${id})">Save</button>
      <button class="btn btn-ghost btn-sm" onclick="refreshContacts()">✕</button>
    </div>`;
  document.getElementById(`ct-co-input-${id}`)?.focus();
}

async function saveContactCompany(id) {
  const input = document.getElementById(`ct-co-input-${id}`);
  if (!input) return;
  const company = input.value.trim() || null;
  try {
    await api.put(`/api/contacts/${id}`, { company });
    const idx = _contactsCache.findIndex(c => c.id === id);
    if (idx !== -1) _contactsCache[idx].company = company;
    refreshContacts();
  } catch (e) { alert('Save failed: ' + e.message); }
}

// ── Add / Edit modal ──────────────────────────────────────────────────────────
function openContactModal(id) {
  const modal = document.getElementById('contact-modal');
  const title = document.getElementById('contact-modal-title');
  const body  = document.getElementById('contact-modal-body');
  if (!modal) return;

  const c = id ? (_contactsCache.find(x => x.id === id) || {}) : {};
  title.textContent = id ? 'Edit Contact' : 'Add Contact';

  body.innerHTML = `
    <div style="padding:20px 24px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div class="form-group">
        <label class="form-label">First Name</label>
        <input class="form-input" id="cm-first" value="${esc(c.first_name||'')}" placeholder="First name" />
      </div>
      <div class="form-group">
        <label class="form-label">Last Name</label>
        <input class="form-input" id="cm-last" value="${esc(c.last_name||'')}" placeholder="Last name" />
      </div>
      <div class="form-group">
        <label class="form-label">Suffix</label>
        <input class="form-input" id="cm-suffix" value="${esc(c.suffix||'')}" placeholder="Jr, Sr, III…" />
      </div>
      <div class="form-group">
        <label class="form-label">Company</label>
        <input class="form-input" id="cm-company" list="company-datalist"
               value="${esc(c.company||'')}" placeholder="Company name" />
      </div>
      <div class="form-group">
        <label class="form-label">Phone</label>
        <input class="form-input" id="cm-phone" value="${esc(c.phone||'')}" placeholder="2155551234" />
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input class="form-input" id="cm-email" type="email" value="${esc(c.email||'')}" placeholder="email@company.com" />
      </div>
      <div class="form-group">
        <label class="form-label">City</label>
        <input class="form-input" id="cm-city" value="${esc(c.city||'')}" placeholder="Philadelphia" />
      </div>
      <div class="form-group">
        <label class="form-label">State</label>
        <input class="form-input" id="cm-state" value="${esc(c.state||'')}" placeholder="PA" />
      </div>
      <div class="form-group" style="grid-column:span 2">
        <label class="form-label">Notes</label>
        <textarea class="form-input" id="cm-notes" rows="2" placeholder="Any notes…">${esc(c.notes||'')}</textarea>
      </div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;padding:0 24px 20px">
      <button class="btn btn-secondary" onclick="closeContactModalForce()">Cancel</button>
      <button class="btn btn-primary" onclick="saveContactModal(${id||'null'})">
        ${id ? 'Save Changes' : 'Add Contact'}
      </button>
    </div>`;

  modal.style.display = 'flex';
}

function closeContactModal(e) { if (e.target === e.currentTarget) closeContactModalForce(); }
function closeContactModalForce() {
  const m = document.getElementById('contact-modal'); if (m) m.style.display = 'none';
}

async function saveContactModal(id) {
  const payload = {
    first_name: document.getElementById('cm-first')?.value.trim()   || null,
    last_name:  document.getElementById('cm-last')?.value.trim()    || null,
    suffix:     document.getElementById('cm-suffix')?.value.trim()  || null,
    company:    document.getElementById('cm-company')?.value.trim() || null,
    phone:      document.getElementById('cm-phone')?.value.replace(/\D/g,'') || null,
    email:      document.getElementById('cm-email')?.value.trim()   || null,
    city:       document.getElementById('cm-city')?.value.trim()    || null,
    state:      document.getElementById('cm-state')?.value.trim()   || null,
    notes:      document.getElementById('cm-notes')?.value.trim()   || null,
  };
  if (!payload.first_name && !payload.last_name) {
    alert('Please enter at least a first or last name.'); return;
  }
  try {
    if (id) {
      const updated = await api.put(`/api/contacts/${id}`, payload);
      const idx = _contactsCache.findIndex(c => c.id === id);
      if (idx !== -1) _contactsCache[idx] = updated;
    } else {
      const created = await api.post('/api/contacts', payload);
      _contactsCache.unshift(created);
    }
    closeContactModalForce();
    refreshContacts();
  } catch (e) { alert('Save failed: ' + e.message); }
}

async function promptDeleteContact(id, name) {
  if (!confirm(`Delete contact "${name}"? This cannot be undone.`)) return;
  try {
    await api.del(`/api/contacts/${id}`);
    _contactsCache = _contactsCache.filter(c => c.id !== id);
    refreshContacts();
  } catch (e) { alert('Delete failed: ' + e.message); }
}

// ── CSV import (admin) ────────────────────────────────────────────────────────
async function importContactsCSV() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.csv';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const loadingEl = document.querySelector('.page-subtitle');
    if (loadingEl) loadingEl.textContent = '⏳ Importing…';

    const reader = new FileReader();
    reader.onload = async (e) => {
      const bytes = new Uint8Array(e.target.result);
      let binary = '', chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk)
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      const fileData = btoa(binary);
      try {
        const result = await api.post('/api/admin/import-contacts', { fileData });
        alert(`✅ Import complete\nInserted: ${result.insert}\nUpdated: ${result.update}\nSkipped: ${result.skip}${result.error ? `\nErrors: ${result.error}` : ''}`);
        _contactsCache = [];   // force reload
        refreshContacts();
      } catch (err) { alert('Import failed: ' + err.message); }
    };
    reader.readAsArrayBuffer(file);
  };
  input.click();
}

// ─────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────
let _calDayMap = {}; // dateStr -> [{bid, type}]  — populated by buildCalendarGrid

function openCalDayModal(dateStr) {
  const items = _calDayMap[dateStr] || [];
  if (!items.length) return;
  const label = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  document.getElementById('cal-day-modal-title').textContent = label;
  document.getElementById('cal-day-modal-body').innerHTML = items.map(({ bid, type }) => {
    const color = type === 'due' ? estimatorColor(bid.estimator_id) : '#64748b';
    const typeLabel = type === 'due' ? '📐 Due date' : '📞 Follow-up';
    return `
      <div class="cal-modal-row" onclick="openJobPanel(${bid.id});hideCalDayModal()">
        <span class="cal-modal-dot" style="background:${color}"></span>
        <div class="cal-modal-info">
          <span class="cal-modal-name">${esc(bid.project_name)}</span>
          <span class="cal-modal-meta">${typeLabel}
            ${bid.estimator_initials ? ` · <span class="initials-pill">${esc(bid.estimator_initials)}</span>` : ''}
            ${bid.salesperson_initials ? `<span class="initials-pill" style="background:#dcfce7;color:#166534">${esc(bid.salesperson_initials)}</span>` : ''}
            ${bid.customer ? ` · ${esc(bid.customer)}` : ''}
          </span>
        </div>
        <span class="badge badge-stage" style="flex-shrink:0">${stageName(bid.stage)}</span>
      </div>`;
  }).join('');
  document.getElementById('cal-day-modal').style.display = 'flex';
}

function hideCalDayModal() {
  document.getElementById('cal-day-modal').style.display = 'none';
}

const ESTIMATOR_PALETTE = ['#2563eb','#16a34a','#dc2626','#d97706','#7c3aed','#0891b2','#be185d','#ea580c'];
function estimatorColor(id) {
  if (!id) return '#64748b';
  return ESTIMATOR_PALETTE[Number(id) % ESTIMATOR_PALETTE.length];
}

function findWeekConflicts(bids) {
  const weekMap = {};
  bids.forEach(b => {
    if (!b.estimator_id || !b.estimate_due_date) return;
    const d = new Date(b.estimate_due_date + 'T00:00:00');
    const dow = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    const wk = mon.toISOString().split('T')[0];
    const key = `${b.estimator_id}-${wk}`;
    if (!weekMap[key]) weekMap[key] = { estimatorId: b.estimator_id, estimatorInitials: b.estimator_initials, estimatorName: b.estimator_name, weekStart: wk, bids: [] };
    weekMap[key].bids.push(b);
  });
  return Object.values(weekMap).filter(w => w.bids.length >= 2).sort((a,b) => b.bids.length - a.bids.length);
}

function buildCalendarGrid(year, month, bids, filterType) {
  const firstDay    = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startDOW    = firstDay.getDay();
  const today       = new Date().toISOString().split('T')[0];
  const pad         = n => String(n).padStart(2,'0');

  // Reset and populate the global day map
  _calDayMap = {};
  const add = (dateStr, bid, type) => {
    if (!dateStr) return;
    const d = dateStr.substring(0,10);
    if (parseInt(d.substring(5,7))-1 !== month || parseInt(d.substring(0,4)) !== year) return;
    if (!_calDayMap[d]) _calDayMap[d] = [];
    _calDayMap[d].push({ bid, type });
  };
  bids.forEach(b => {
    if (filterType !== 'followups_only') add(b.estimate_due_date, b, 'due');
    if (filterType !== 'due_only')       add(b.next_followup_date, b, 'fu');
  });

  const headers = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    .map(d => `<div class="cal-hdr-cell">${d}</div>`).join('');

  let cells = '';
  for (let i = 0; i < startDOW; i++) cells += '<div class="cal-day-empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const ds      = `${year}-${pad(month+1)}-${pad(d)}`;
    const isToday = ds === today;
    const items   = _calDayMap[ds] || [];
    const shown   = items.slice(0, 3);
    const extra   = items.length - 3;
    const hasItems = items.length > 0;

    const chips = shown.map(({ bid, type }) => {
      if (type === 'due') {
        const c = estimatorColor(bid.estimator_id);
        // hex color at 65% opacity — dark enough for white text to pop
        const bg = c + 'a6';
        return `<div class="cal-chip" style="background:${bg};border-left-color:${c}">
          <span class="cal-chip-txt">${esc(bid.project_name)}</span>
          ${bid.estimator_initials ? `<span class="cal-chip-ini" style="color:#fff">${esc(bid.estimator_initials)}</span>` : ''}
        </div>`;
      }
      return `<div class="cal-chip cal-chip-fu">
        <span class="cal-chip-txt">📞 ${esc(bid.project_name)}</span>
      </div>`;
    }).join('');

    cells += `<div class="cal-day${isToday?' cal-day-today':''}${hasItems?' cal-day-clickable':''}"
      ${hasItems ? `onclick="openCalDayModal('${ds}')"` : ''}>
      <div class="cal-day-num${isToday?' cal-day-num-today':''}">${d}</div>
      <div class="cal-day-chips">
        ${chips}
        ${extra > 0 ? `<button class="cal-chip-more" onclick="event.stopPropagation();openCalDayModal('${ds}')">+${extra} more</button>` : ''}
      </div>
    </div>`;
  }

  const rem = (startDOW + daysInMonth) % 7;
  if (rem) for (let i = rem; i < 7; i++) cells += '<div class="cal-day-empty"></div>';

  return `<div class="cal-hdr">${headers}</div><div class="cal-grid">${cells}</div>`;
}

function navCalendar(dir) {
  let m = State.calMonth + dir, y = State.calYear;
  if (m < 0)  { m = 11; y--; }
  if (m > 11) { m = 0;  y++; }
  State.calMonth = m; State.calYear = y;
  renderPage('calendar');
}

async function renderCalendar(main) {
  main.innerHTML = '<div class="loading-screen"><div class="spinner"></div><p>Loading…</p></div>';
  const bids = await api.get('/api/bids?stage=opportunity,active_bid,active_co,follow_up');
  const { calYear: year, calMonth: month, calFilter } = State;
  const monthName = new Date(year, month, 1).toLocaleDateString('en-US', { month:'long', year:'numeric' });

  const estimators = State.team.filter(m => m.active && (m.role==='estimator'||m.role==='estimator/pm'));
  const legendHtml = [
    ...estimators.map(m => `<span class="cal-legend-item"><span class="cal-legend-dot" style="background:${estimatorColor(m.id)}"></span>${esc(m.initials)}</span>`),
    `<span class="cal-legend-item"><span class="cal-legend-dot" style="background:var(--sidebar-hover-bg);border:1px dashed #94a3b8"></span>Follow-up</span>`,
  ].join('');

  main.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">🗓️ Calendar</div></div>
    </div>
    <div class="cal-controls">
      <button class="btn btn-ghost btn-sm" onclick="navCalendar(-1)">‹ Prev</button>
      <span class="cal-month-label">${esc(monthName)}</span>
      <button class="btn btn-ghost btn-sm" onclick="navCalendar(1)">Next ›</button>
      <button class="btn btn-secondary btn-sm" onclick="State.calYear=new Date().getFullYear();State.calMonth=new Date().getMonth();renderPage('calendar')">Today</button>
      <select class="cal-filter-select" onchange="State.calFilter=this.value;renderPage('calendar')">
        <option value="all" ${calFilter==='all'?'selected':''}>Due Dates + Follow-ups</option>
        <option value="due_only" ${calFilter==='due_only'?'selected':''}>Due Dates Only</option>
        <option value="followups_only" ${calFilter==='followups_only'?'selected':''}>Follow-ups Only</option>
      </select>
    </div>
    ${buildCalendarGrid(year, month, bids, calFilter)}
    <div class="cal-legend">${legendHtml}</div>`;
}

// ─────────────────────────────────────────────
// BID FORM MODAL
// ─────────────────────────────────────────────
function openBidModalForFix(el) {
  const bidId = +el.dataset.bidId;
  const issueKeys = JSON.parse(el.dataset.issues || '[]');
  openBidModal(bidId, null, issueKeys);
}

const ISSUE_FIELD_MAP = {
  no_price:       ['f-estimate_amount'],
  no_customer:    ['f-customer'],
  no_estimator:   ['f-estimator_id'],
  no_salesperson: ['f-salesperson_id'],
  no_due_date:    ['f-estimate_due_date'],
  no_followup:    ['f-next_followup_date'],
  stale_followup: ['f-next_followup_date'],
  very_stale:     ['f-stage'],
  stale:          ['f-stage'],
};

function highlightBidFormIssues(issueKeys) {
  document.querySelectorAll('.field-needs-fix').forEach(el => el.classList.remove('field-needs-fix'));
  if (!issueKeys || !issueKeys.length) return;
  issueKeys.forEach(key => {
    (ISSUE_FIELD_MAP[key] || []).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('field-needs-fix');
    });
  });
}

function openBidModal(bidId = null, defaultStage = 'opportunity', highlightIssues = null) {
  const modal = document.getElementById('bid-modal');
  const form = document.getElementById('bid-form');
  form.reset();
  document.getElementById('bid-id').value = '';
  document.getElementById('bid-modal-title').textContent = bidId ? 'Edit Bid' : 'Add New Bid';

  populateTeamDropdowns('f-estimator_id', 'f-salesperson_id');
  loadSubEstimatorsIntoForm([]);  // clear any previous rows

  if (bidId) {
    api.get(`/api/bids/${bidId}`).then(b => {
      document.getElementById('bid-id').value = b.id;
      document.getElementById('f-bid_number').value = b.bid_number || '';
      document.getElementById('f-job_number').value = b.job_number || '';
      document.getElementById('f-stage').value = b.stage;
      document.getElementById('f-project_name').value = b.project_name;
      document.getElementById('f-status').value = b.status || 'Open';
      document.getElementById('f-estimate_amount').value = b.estimate_amount || '';
      document.getElementById('f-estimator_id').value = b.estimator_id || '';
      document.getElementById('f-salesperson_id').value = b.salesperson_id || '';
      document.getElementById('f-customer').value = b.customer || '';
      document.getElementById('f-customer2').value = b.customer2 || '';
      document.getElementById('f-customer3').value = b.customer3 || '';
      document.getElementById('f-customer4').value = b.customer4 || '';
      document.getElementById('f-customer5').value = b.customer5 || '';
      document.getElementById('f-date_received').value = b.date_received || '';
      document.getElementById('f-estimate_due_date').value = b.estimate_due_date || '';
      document.getElementById('f-estimate_start_date').value = b.estimate_start_date || '';
      document.getElementById('f-date_estimate_sent').value = b.date_estimate_sent || '';
      document.getElementById('f-estimate_pct_complete').value = b.estimate_pct_complete ? Math.round(b.estimate_pct_complete * 100) : '';
      document.getElementById('f-estimate_approved_by').value = b.estimate_approved_by || '';
      document.getElementById('f-bid_result').value = b.bid_result || '';
      document.getElementById('f-next_followup_date').value = b.next_followup_date || '';
      document.getElementById('f-notes').value = b.notes || '';
      document.getElementById('f-award_date').value = b.award_date || '';
      document.getElementById('f-awarded_contractor').value = b.awarded_contractor || '';
      loadSubEstimatorsIntoForm(b.sub_estimators || []);
      if (highlightIssues) highlightBidFormIssues(highlightIssues);
    });
  } else {
    document.getElementById('f-stage').value = defaultStage;
    document.getElementById('f-date_received').value = today();
  }

  modal.style.display = 'flex';
}

// ── Duplicate bid number detection ───────────────────────────────────────────
async function checkBidNumberDuplicate() {
  const val     = document.getElementById('f-bid_number')?.value.trim();
  const warnEl  = document.getElementById('bid-number-warning');
  const editId  = document.getElementById('bid-id')?.value; // empty on new bids
  if (!warnEl) return;
  if (!val) { warnEl.style.display = 'none'; return; }

  const existing = await api.get(`/api/bids/check-duplicate?bid_number=${encodeURIComponent(val)}`).catch(() => null);

  // Ignore if it's the same bid we're editing
  if (!existing || (editId && String(existing.id) === String(editId))) {
    warnEl.style.display = 'none';
    return;
  }

  const phaseCount = (existing.phases || []).length;
  warnEl.style.display = 'block';
  warnEl.innerHTML = `
    ⚠️ <strong>${esc(val)}</strong> already exists:
    <strong>${esc(existing.project_name)}</strong>
    · ${stageName(existing.stage)}
    ${phaseCount ? `· ${phaseCount} phase${phaseCount>1?'s':''} on record` : ''}
    <br>
    <span style="margin-top:4px;display:inline-flex;gap:8px">
      <button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px"
              onclick="closeBidModal();openJobPanel(${existing.id})">
        View existing bid
      </button>
      <button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px;color:#d97706"
              onclick="closeBidModal();openJobPanel(${existing.id});setTimeout(()=>openNewPhaseModal(${existing.id}),300)">
        Add new phase to it
      </button>
    </span>`;
}

// ── Sub-estimator rows ────────────────────────────────────────────────────────
function addSubEstimatorRow(estimatorId = '', scope = '') {
  const list = document.getElementById('sub-estimators-list');
  if (!list) return;
  const estimators = State.team.filter(m => m.active && (m.role === 'estimator' || m.role === 'estimator/pm'));
  const opts = estimators.map(m =>
    `<option value="${m.id}" ${String(m.id) === String(estimatorId) ? 'selected' : ''}>${esc(m.initials)} – ${esc(m.name)}</option>`
  ).join('');
  const row = document.createElement('div');
  row.className = 'sub-est-row';
  row.innerHTML = `
    <select class="sub-est-select">
      <option value="">-- Select Estimator --</option>
      ${opts}
    </select>
    <input type="text" class="sub-est-scope" placeholder="Scope (Fire Alarm, Data/LV…)" value="${esc(scope)}" />
    <button type="button" class="btn btn-ghost btn-sm sub-est-remove" onclick="this.closest('.sub-est-row').remove()" title="Remove">✕</button>`;
  list.appendChild(row);
}

function getSubEstimatorsFromForm() {
  return Array.from(document.querySelectorAll('.sub-est-row')).map(row => ({
    estimator_id: Number(row.querySelector('.sub-est-select')?.value) || null,
    scope:        row.querySelector('.sub-est-scope')?.value.trim() || null,
  })).filter(se => se.estimator_id);
}

function loadSubEstimatorsIntoForm(subEstimators) {
  const list = document.getElementById('sub-estimators-list');
  if (list) list.innerHTML = '';
  (subEstimators || []).forEach(se => addSubEstimatorRow(se.estimator_id, se.scope || ''));
}

function closeBidModal() {
  highlightBidFormIssues([]);
  document.getElementById('bid-modal').style.display = 'none';
}

async function saveBid() {
  const id = document.getElementById('bid-id').value;
  const pctRaw = document.getElementById('f-estimate_pct_complete').value;
  const data = {
    bid_number: document.getElementById('f-bid_number').value.trim(),
    job_number: document.getElementById('f-job_number').value.trim(),
    stage: document.getElementById('f-stage').value,
    project_name: document.getElementById('f-project_name').value.trim(),
    status: document.getElementById('f-status').value,
    estimate_amount: document.getElementById('f-estimate_amount').value || null,
    estimator_id: document.getElementById('f-estimator_id').value || null,
    salesperson_id: document.getElementById('f-salesperson_id').value || null,
    customer: document.getElementById('f-customer').value.trim(),
    customer2: document.getElementById('f-customer2').value.trim(),
    customer3: document.getElementById('f-customer3').value.trim(),
    customer4: document.getElementById('f-customer4').value.trim(),
    customer5: document.getElementById('f-customer5').value.trim(),
    date_received: document.getElementById('f-date_received').value || null,
    estimate_due_date: document.getElementById('f-estimate_due_date').value || null,
    estimate_start_date: document.getElementById('f-estimate_start_date').value || null,
    date_estimate_sent: document.getElementById('f-date_estimate_sent').value || null,
    estimate_pct_complete: pctRaw !== '' ? parseFloat(pctRaw) / 100 : null,
    estimate_approved_by: document.getElementById('f-estimate_approved_by').value.trim(),
    bid_result: document.getElementById('f-bid_result').value.trim(),
    next_followup_date: document.getElementById('f-next_followup_date').value || null,
    notes: document.getElementById('f-notes').value.trim(),
    award_date: document.getElementById('f-award_date').value || null,
    awarded_contractor: document.getElementById('f-awarded_contractor').value.trim(),
    sub_estimators: getSubEstimatorsFromForm(),
  };

  if (!data.project_name) { alert('Project name is required.'); return; }

  try {
    if (id) await api.put(`/api/bids/${id}`, data);
    else await api.post('/api/bids', data);
    closeBidModal();
    const panelId = State.currentPanelBidId;
    await renderPage(State.currentPage);
    await updateBadges();
    if (panelId) openJobPanel(panelId);
  } catch (e) { alert('Error saving: ' + e.message); }
}

// ─────────────────────────────────────────────
// FOLLOW-UP MODAL
// ─────────────────────────────────────────────
async function openFollowupModal(bidId) {
  const [bid, followups] = await Promise.all([
    api.get(`/api/bids/${bidId}`),
    api.get(`/api/bids/${bidId}/followups`)
  ]);

  document.getElementById('followup-bid-id').value = bidId;
  document.getElementById('followup-bid-name').textContent = bid.project_name;
  document.getElementById('fu-date').value = today();
  document.getElementById('fu-notes').value = '';
  document.getElementById('fu-response').value = '';
  document.getElementById('fu-customer_contact').value = '';
  document.getElementById('fu-method').value = '';

  // Smart follow-up default based on company settings
  const s = State.settings || {};
  const initialDays    = s.fu_initial_days    ?? 3;
  const recurringDays  = s.fu_recurring_days  ?? 7;
  // Use initial interval if bid was just submitted and has no follow-up set yet;
  // otherwise use recurring interval
  const isFirstFollowup = bid.date_estimate_sent && !bid.next_followup_date;
  const daysToAdd = isFirstFollowup ? initialDays : recurringDays;
  const smartDefault = new Date(Date.now() + daysToAdd * 86400000).toISOString().split('T')[0];
  document.getElementById('fu-next_date').value = smartDefault;

  // Populate quick-pick buttons
  const quickPickEl = document.getElementById('fu-quick-picks');
  if (quickPickEl) {
    const picks = [3, 7, 14, 30];
    quickPickEl.innerHTML = picks.map(d => {
      const date = new Date(Date.now() + d * 86400000).toISOString().split('T')[0];
      return `<button type="button" class="btn btn-ghost btn-sm fu-quick-btn"
                      onclick="document.getElementById('fu-next_date').value='${date}'">+${d}d</button>`;
    }).join('')
      + `<span style="font-size:11px;color:var(--text-muted);margin-left:4px">suggested: +${daysToAdd}d</span>`;
  }

  populateTeamDropdownSingle('fu-contacted_by');
  // Auto-select current user as "Contacted By"
  if (State.currentUser) {
    document.getElementById('fu-contacted_by').value = State.currentUser.initials;
  }

  const histEl = document.getElementById('followup-history');
  if (followups.length) {
    histEl.innerHTML = `
      <div class="followup-history-title">Previous Contacts (${followups.length})</div>
      ${followups.map(f => `
        <div class="history-entry">
          <div class="history-entry-date">${fmt(f.followup_date, 'date')} ${f.contact_method ? '· ' + esc(f.contact_method) : ''} ${f.contacted_by ? '· By: ' + esc(f.contacted_by) : ''} ${f.customer_contact ? '· With: ' + esc(f.customer_contact) : ''}</div>
          <div class="history-entry-notes">${esc(f.notes)}</div>
          ${f.response ? `<div class="history-entry-response">Response: ${esc(f.response)}</div>` : ''}
        </div>`).join('')}`;
  } else {
    histEl.innerHTML = '';
  }

  document.getElementById('followup-modal').style.display = 'flex';
}

function closeFollowupModal() {
  document.getElementById('followup-modal').style.display = 'none';
}

async function saveFollowup() {
  const bidId = document.getElementById('followup-bid-id').value;
  const notes = document.getElementById('fu-notes').value.trim();
  if (!notes) { alert('Notes are required.'); return; }

  const data = {
    followup_date: document.getElementById('fu-date').value,
    contacted_by: document.getElementById('fu-contacted_by').value,
    contact_method: document.getElementById('fu-method').value,
    customer_contact: document.getElementById('fu-customer_contact').value.trim(),
    notes,
    response: document.getElementById('fu-response').value.trim(),
    next_followup_date: document.getElementById('fu-next_date').value || null,
  };

  try {
    await api.post(`/api/bids/${bidId}/followups`, data);
    closeFollowupModal();
    const panelId = State.currentPanelBidId;
    await renderPage(State.currentPage);
    await updateBadges();
    if (panelId) openJobPanel(panelId);
  } catch (e) { alert('Error: ' + e.message); }
}

// ─────────────────────────────────────────────
// STAGE MODAL
// ─────────────────────────────────────────────
function openStageModal(bidId, currentStage) {
  document.getElementById('stage-bid-id').value = bidId;
  document.getElementById('stage-select').value = currentStage;
  document.getElementById('stage-followup-date').value = '';
  document.getElementById('stage-award-date').value = '';
  document.getElementById('stage-sent-date').value = today();

  api.get(`/api/bids/${bidId}`).then(b => {
    document.getElementById('stage-bid-name').textContent = b.project_name;
  });

  handleStageSelectChange();
  document.getElementById('stage-modal').style.display = 'flex';
}

function closeStageModal() {
  document.getElementById('stage-modal').style.display = 'none';
}

function handleStageSelectChange() {
  const stage = document.getElementById('stage-select').value;
  document.getElementById('stage-followup-row').style.display = stage === 'follow_up' ? 'block' : 'none';
  document.getElementById('stage-award-row').style.display = stage === 'awarded' ? 'block' : 'none';
  document.getElementById('stage-sent-row').style.display = stage === 'follow_up' ? 'block' : 'none';
}

document.getElementById('stage-modal').addEventListener('change', e => {
  if (e.target.id === 'stage-select') handleStageSelectChange();
});

async function saveStage() {
  const bidId = document.getElementById('stage-bid-id').value;
  const stage = document.getElementById('stage-select').value;
  const data = { stage };

  if (stage === 'follow_up') {
    const fuDate = document.getElementById('stage-followup-date').value;
    const sentDate = document.getElementById('stage-sent-date').value;
    if (fuDate) data.next_followup_date = fuDate;
    if (sentDate) data.date_estimate_sent = sentDate;
    data.status = 'Pending Award';
  }
  if (stage === 'awarded') {
    const awardDate = document.getElementById('stage-award-date').value;
    if (awardDate) data.award_date = awardDate;
    data.status = 'Awarded';
  }
  if (stage === 'not_awarded') {
    data.status = 'Not Awarded';
  }

  try {
    await api.put(`/api/bids/${bidId}`, data);
    closeStageModal();
    const panelId = State.currentPanelBidId;
    await renderPage(State.currentPage);
    await updateBadges();
    if (panelId) openJobPanel(panelId);
  } catch (e) { alert('Error: ' + e.message); }
}

// ─────────────────────────────────────────────
// TEAM DROPDOWNS
// ─────────────────────────────────────────────
function populateTeamDropdowns(estId, salId) {
  const estimators = State.team.filter(m => m.role === 'estimator' || m.role === 'estimator/pm');
  const salespeople = State.team.filter(m => m.role === 'salesperson' || m.role === 'estimator/pm');

  const estEl = document.getElementById(estId);
  const salEl = document.getElementById(salId);
  if (estEl) {
    estEl.innerHTML = '<option value="">-- Select Estimator --</option>' +
      estimators.map(m => `<option value="${m.id}">${esc(m.initials)} – ${esc(m.name)}</option>`).join('');
  }
  if (salEl) {
    salEl.innerHTML = '<option value="">-- Select Salesperson --</option>' +
      salespeople.map(m => `<option value="${m.id}">${esc(m.initials)} – ${esc(m.name)}</option>`).join('');
  }
}

function populateTeamDropdownSingle(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '<option value="">-- Select --</option>' +
    State.team.filter(m => m.active).map(m => `<option value="${esc(m.initials)}">${esc(m.initials)} – ${esc(m.name)}</option>`).join('');
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
});

// Close modals on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const anyModalOpen = [...document.querySelectorAll('.modal-overlay')].some(m => m.style.display !== 'none');
    if (anyModalOpen) {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    } else {
      closeJobPanel();
    }
  }
});

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
const AVATAR_COLORS = [
  '#2563eb','#16a34a','#d97706','#dc2626','#7c3aed',
  '#0891b2','#c2410c','#059669','#4f46e5','#be185d'
];

function avatarColor(initials) {
  let n = 0;
  for (const c of initials) n = (n + c.charCodeAt(0)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[n];
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function firstName(name) {
  return name ? name.split(' ')[0] : '';
}

function showLoginOverlay() {
  document.getElementById('login-overlay').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function hideLoginOverlay() {
  document.getElementById('login-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

async function submitLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  if (!email || !password) { errEl.textContent = 'Please enter your email and password.'; errEl.style.display = 'block'; return; }
  try {
    const member = await api.post('/api/auth/login', { email, password });
    State.currentUser = member;
    State.team = await api.get('/api/team');
    if (member.must_change_password) {
      document.getElementById('login-overlay').style.display = 'none';
      const cpOverlay = document.getElementById('change-password-overlay');
      cpOverlay.style.display = 'flex';
    } else {
      hideLoginOverlay();
      updateSidebarUser(member);
      await onHashChange();
    }
  } catch(e) {
    errEl.textContent = e.message || 'Invalid email or password.';
    errEl.style.display = 'block';
  }
}

function checkPasswordStrength() {
  const pwd = document.getElementById('new-password')?.value || '';
  const set = (id, met) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = (met ? '✓ ' : '✗ ') + el.textContent.slice(2);
    el.className = met ? 'met' : '';
  };
  set('req-length',  pwd.length >= 8);
  set('req-upper',   /[A-Z]/.test(pwd));
  set('req-lower',   /[a-z]/.test(pwd));
  set('req-number',  /[0-9]/.test(pwd));
  set('req-special', /[^A-Za-z0-9]/.test(pwd));
}

async function submitNewPassword() {
  const pwd = document.getElementById('new-password').value;
  const confirm = document.getElementById('confirm-password').value;
  const errEl = document.getElementById('change-pw-error');
  errEl.style.display = 'none';
  if (pwd !== confirm) { errEl.textContent = 'Passwords do not match.'; errEl.style.display = 'block'; return; }
  const strong = pwd.length >= 8 && /[A-Z]/.test(pwd) && /[a-z]/.test(pwd) && /[0-9]/.test(pwd) && /[^A-Za-z0-9]/.test(pwd);
  if (!strong) { errEl.textContent = 'Password does not meet all requirements.'; errEl.style.display = 'block'; return; }
  try {
    await api.post('/api/auth/set-password', { password: pwd });
    State.currentUser.must_change_password = false;
    document.getElementById('change-password-overlay').style.display = 'none';
    hideLoginOverlay();
    updateSidebarUser(State.currentUser);
    await onHashChange();
  } catch(e) {
    errEl.textContent = e.message || 'Failed to set password.';
    errEl.style.display = 'block';
  }
}

async function logout() {
  await api.post('/api/auth/logout', {});
  State.currentUser = null;
  State.mineOnly = false;
  State.globalSearch = '';
  const fab = document.getElementById('quick-log-fab');
  if (fab) fab.style.display = 'none';
  // Hide and clear search bar
  const sw = document.getElementById('sidebar-search-wrap');
  if (sw) sw.style.display = 'none';
  const inp = document.getElementById('global-search-input');
  if (inp) inp.value = '';
  const clearBtn = document.getElementById('sidebar-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  document.getElementById('app').style.display = 'none';
  showLoginOverlay();
}

function updateSidebarUser(user) {
  if (!user) return;
  const el = document.getElementById('sidebar-user');
  el.style.display = 'flex';
  document.getElementById('sidebar-user-avatar').textContent = user.initials;
  document.getElementById('sidebar-user-avatar').style.background = avatarColor(user.initials);
  document.getElementById('sidebar-user-name').textContent = user.name;
  document.getElementById('sidebar-user-role').textContent = user.role;
  const fab = document.getElementById('quick-log-fab');
  if (fab) fab.style.display = 'flex';
  // Show global search bar
  const sw = document.getElementById('sidebar-search-wrap');
  if (sw) sw.style.display = 'block';
}

// (PIN input removed — now using email/password auth)

// ─────────────────────────────────────────────
// QUICK LOG
// ─────────────────────────────────────────────
function openQuickLog() {
  State.quickLogBidId = null;
  document.getElementById('ql-search').value = '';
  document.getElementById('ql-results').innerHTML = '';
  document.getElementById('ql-search-section').style.display = 'block';
  document.getElementById('ql-form-section').style.display = 'none';
  document.getElementById('ql-save-btn').style.display = 'none';
  document.getElementById('quick-log-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('ql-search').focus(), 50);
}

function closeQuickLog() {
  document.getElementById('quick-log-modal').style.display = 'none';
  State.quickLogBidId = null;
}

function resetQuickLogSearch() {
  State.quickLogBidId = null;
  document.getElementById('ql-search').value = '';
  document.getElementById('ql-results').innerHTML = '';
  document.getElementById('ql-search-section').style.display = 'block';
  document.getElementById('ql-form-section').style.display = 'none';
  document.getElementById('ql-save-btn').style.display = 'none';
  setTimeout(() => document.getElementById('ql-search').focus(), 50);
}

let qlDebounceTimer;
function debounceQuickLogSearch() {
  clearTimeout(qlDebounceTimer);
  const q = document.getElementById('ql-search').value.trim();
  if (!q) { document.getElementById('ql-results').innerHTML = ''; return; }
  document.getElementById('ql-results').innerHTML = '<div class="ql-searching">Searching…</div>';
  qlDebounceTimer = setTimeout(quickLogSearch, 250);
}

async function quickLogSearch() {
  const q = document.getElementById('ql-search').value.trim();
  if (!q) return;
  try {
    const bids = await api.get(`/api/bids?search=${encodeURIComponent(q)}&stage=opportunity,active_bid,active_co,follow_up`);
    const resultsEl = document.getElementById('ql-results');
    if (!bids.length) {
      resultsEl.innerHTML = '<div class="ql-no-results">No matching projects found</div>';
      return;
    }
    resultsEl.innerHTML = bids.slice(0, 10).map(b => `
      <div class="ql-result-item" onclick="selectQuickLogBid(${b.id})">
        <div class="ql-result-name">${esc(b.project_name)}</div>
        <div class="ql-result-meta">
          ${b.bid_number ? `#${esc(b.bid_number)} &nbsp;·&nbsp; ` : ''}
          ${stageName(b.stage)}
          ${b.customer ? ` &nbsp;·&nbsp; ${esc(b.customer)}` : ''}
          ${b.estimate_amount ? ` &nbsp;·&nbsp; ${fmt(b.estimate_amount, 'currency')}` : ''}
          ${b.salesperson_initials ? ` &nbsp;·&nbsp; Sales: <strong>${esc(b.salesperson_initials)}</strong>` : ''}
          ${b.estimator_initials ? ` &nbsp;·&nbsp; Est: <strong>${esc(b.estimator_initials)}</strong>` : ''}
        </div>
      </div>`).join('');
  } catch (e) {
    document.getElementById('ql-results').innerHTML = '<div class="ql-no-results">Error searching</div>';
  }
}

async function selectQuickLogBid(bidId) {
  const bid = await api.get(`/api/bids/${bidId}`);
  State.quickLogBidId = bidId;

  // Show selected bid info
  document.getElementById('ql-selected-bid').innerHTML = `
    <div class="ql-selected-name">${esc(bid.project_name)}</div>
    <div class="ql-selected-meta">
      ${bid.bid_number ? `#${esc(bid.bid_number)} &nbsp;·&nbsp; ` : ''}
      <span class="badge badge-stage" style="font-size:11px">${stageName(bid.stage)}</span>
      ${bid.customer ? ` &nbsp;·&nbsp; ${esc(bid.customer)}` : ''}
      ${bid.estimate_amount ? ` &nbsp;·&nbsp; ${fmt(bid.estimate_amount, 'currency')}` : ''}
    </div>`;

  // Pre-fill fields
  document.getElementById('ql-date').value = today();
  document.getElementById('ql-notes').value = '';
  document.getElementById('ql-response').value = '';
  document.getElementById('ql-customer_contact').value = '';
  document.getElementById('ql-method').value = 'Phone';
  document.getElementById('ql-next_date').value =
    bid.next_followup_date || new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];

  // Populate & auto-select contacted-by
  populateTeamDropdownSingle('ql-contacted_by');
  if (State.currentUser) document.getElementById('ql-contacted_by').value = State.currentUser.initials;

  // Switch to form view
  document.getElementById('ql-search-section').style.display = 'none';
  document.getElementById('ql-form-section').style.display = 'block';
  document.getElementById('ql-save-btn').style.display = 'inline-flex';
  setTimeout(() => document.getElementById('ql-notes').focus(), 50);
}

async function saveQuickLog() {
  const bidId = State.quickLogBidId;
  const notes = document.getElementById('ql-notes').value.trim();
  if (!bidId) return;
  if (!notes) { alert('Notes are required.'); document.getElementById('ql-notes').focus(); return; }

  const data = {
    followup_date:    document.getElementById('ql-date').value,
    contacted_by:     document.getElementById('ql-contacted_by').value,
    contact_method:   document.getElementById('ql-method').value,
    customer_contact: document.getElementById('ql-customer_contact').value.trim(),
    notes,
    response:         document.getElementById('ql-response').value.trim(),
    next_followup_date: document.getElementById('ql-next_date').value || null,
  };

  const btn = document.getElementById('ql-save-btn');
  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    await api.post(`/api/bids/${bidId}/followups`, data);
    closeQuickLog();
    await renderPage(State.currentPage);
    await updateBadges();
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.textContent = 'Log Contact';
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────
// JOB DETAIL PANEL
// ─────────────────────────────────────────────
async function openJobPanel(bidId) {
  State.currentPanelBidId = bidId;
  const panel = document.getElementById('job-panel');
  const overlay = document.getElementById('job-panel-overlay');
  const body = document.getElementById('job-panel-body');
  document.getElementById('job-panel-title').textContent = 'Loading…';
  body.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Loading…</div>';
  overlay.style.display = 'block';
  panel.classList.add('open');
  try {
    const isAwarded = false; // will be set after bid loads
    const [bid, followups, contacts, linkedCOs] = await Promise.all([
      api.get(`/api/bids/${bidId}`),
      api.get(`/api/bids/${bidId}/followups`),
      api.get(`/api/bids/${bidId}/contacts`),
      api.get(`/api/bids/${bidId}/linked-cos`),
    ]);
    document.getElementById('job-panel-title').textContent = bid.project_name;
    body.innerHTML = renderJobPanelContent(bid, followups, contacts, linkedCOs);
  } catch (e) {
    body.innerHTML = `<div class="text-danger" style="padding:16px">Error loading: ${esc(e.message)}</div>`;
  }
}

function closeJobPanel() {
  const panel = document.getElementById('job-panel');
  const overlay = document.getElementById('job-panel-overlay');
  if (!panel) return;
  panel.classList.remove('open');
  if (overlay) overlay.style.display = 'none';
  State.currentPanelBidId = null;
}

function renderJobPanelContent(bid, followups, contacts = [], linkedCOs = []) {
  // Declare customerList first — used by both the contacts section and detailFields
  const customerList = [bid.customer, bid.customer2, bid.customer3, bid.customer4, bid.customer5].filter(Boolean);

  // Individual customer names as clickable company-profile links
  const customerLinks = customerList.map(c =>
    `<span class="company-link" data-company="${esc(c)}" onclick="openCompanyProfile(this.dataset.company)">${esc(c)}</span>`
  ).join('<span style="color:var(--text-muted)"> · </span>');

  const detailFields = [
    customerList.length ? `<div class="jp-field"><span class="jp-label">Customer</span><span class="jp-value">${customerLinks}</span></div>` : '',
    bid.estimate_amount ? `<div class="jp-field"><span class="jp-label">Estimate Amount</span><span class="jp-value">${fmt(bid.estimate_amount, 'currency')}</span></div>` : '',
    bid.estimator_initials ? `<div class="jp-field"><span class="jp-label">Estimator</span><span class="jp-value"><span class="initials-pill">${esc(bid.estimator_initials)}</span></span></div>` : '',
    (bid.sub_estimators||[]).length ? `<div class="jp-field"><span class="jp-label">Sub-Estimators</span><span class="jp-value">${
      bid.sub_estimators.map(se => {
        const m = State.team.find(t => t.id === se.estimator_id);
        if (!m) return '';
        return `<span class="initials-pill initials-pill-sub" title="${esc(m.name)}">${esc(m.initials)}</span>${se.scope ? `<span style="font-size:12px;color:var(--text-muted);margin-left:4px">${esc(se.scope)}</span>` : ''}`;
      }).join('<span style="margin:0 6px;color:var(--border)">·</span>')
    }</span></div>` : '',
    bid.salesperson_initials ? `<div class="jp-field"><span class="jp-label">Salesperson</span><span class="jp-value"><span class="initials-pill" style="background:#dcfce7;color:#166534">${esc(bid.salesperson_initials)}</span></span></div>` : '',
  ].filter(Boolean).join('');

  const dateFields = [
    bid.date_received ? `<div class="jp-field"><span class="jp-label">Date Received</span><span class="jp-value">${fmt(bid.date_received, 'date')}</span></div>` : '',
    bid.estimate_due_date ? `<div class="jp-field"><span class="jp-label">Due Date</span><span class="jp-value">${fmt(bid.estimate_due_date, 'date')}</span></div>` : '',
    bid.estimate_start_date ? `<div class="jp-field"><span class="jp-label">Start Date</span><span class="jp-value">${fmt(bid.estimate_start_date, 'date')}</span></div>` : '',
    bid.date_estimate_sent ? `<div class="jp-field"><span class="jp-label">Estimate Sent</span><span class="jp-value">${fmt(bid.date_estimate_sent, 'date')}</span></div>` : '',
    bid.next_followup_date ? `<div class="jp-field"><span class="jp-label">Next Follow-up</span><span class="jp-value">${fmt(bid.next_followup_date, 'date')} <em style="color:var(--text-muted);font-size:12px">(${relativeTime(bid.next_followup_date)})</em></span></div>` : '',
    bid.award_date ? `<div class="jp-field"><span class="jp-label">Award Date</span><span class="jp-value">${fmt(bid.award_date, 'date')}</span></div>` : '',
  ].filter(Boolean).join('');

  const progressSection = bid.estimate_pct_complete ? `
    <div class="jp-section">
      <div class="jp-section-title">Progress</div>
      <div class="jp-field"><span class="jp-label">% Complete</span><span class="jp-value">${Math.round(bid.estimate_pct_complete * 100)}%</span></div>
      ${bid.estimate_approved_by ? `<div class="jp-field"><span class="jp-label">Approved By</span><span class="jp-value">${esc(bid.estimate_approved_by)}</span></div>` : ''}
      ${bid.bid_result ? `<div class="jp-field"><span class="jp-label">Bid Result</span><span class="jp-value">${esc(bid.bid_result)}</span></div>` : ''}
    </div>` : '';

  const notesSection = bid.notes ? `
    <div class="jp-section">
      <div class="jp-section-title">Notes</div>
      <div class="jp-notes-box">${esc(bid.notes)}</div>
    </div>` : '';

  const awardSection = bid.awarded_contractor ? `
    <div class="jp-section">
      <div class="jp-section-title">Award</div>
      <div class="jp-field"><span class="jp-label">Contractor</span><span class="jp-value">${esc(bid.awarded_contractor)}</span></div>
    </div>` : '';

  const followupHistory = followups.length ? `
    <div class="jp-section">
      <div class="jp-section-title">Follow-up History (${followups.length})</div>
      ${followups.map(f => `
        <div class="jp-history-entry">
          <div class="jp-history-date">
            ${fmt(f.followup_date, 'date')}
            ${f.contact_method ? ' · ' + esc(f.contact_method) : ''}
            ${f.contacted_by ? ' · By: ' + esc(f.contacted_by) : ''}
            ${f.customer_contact ? ' · With: ' + esc(f.customer_contact) : ''}
          </div>
          <div>${esc(f.notes)}</div>
          ${f.response ? `<div style="color:var(--text-muted);margin-top:4px;font-size:12px">→ ${esc(f.response)}</div>` : ''}
        </div>`).join('')}
    </div>` : '';

  // ── Customer Contacts section — one slot per customer ─────────────────────
  // (customerList already declared at top of function)

  // Build a lookup: customer_name → [linked contacts]
  const contactsByCustomer = {};
  contacts.forEach(({ customer_name, contact }) => {
    if (!contactsByCustomer[customer_name]) contactsByCustomer[customer_name] = [];
    contactsByCustomer[customer_name].push(contact);
  });

  const customerRows = customerList.map(custName => {
    const linked = contactsByCustomer[custName] || [];
    const linkedCards = linked.map(c => `
      <div class="jp-contact-card">
        <div class="jp-contact-info">
          <div class="jp-contact-name profile-link"
               data-contact-id="${c.id}"
               onclick="openContactProfile(this.dataset.contactId)">${esc(c.full_name)}</div>
          <div class="jp-contact-meta">
            ${c.phone ? `<a href="tel:${esc(c.phone)}" class="jp-contact-link">${fmtPhone(c.phone)}</a>` : ''}
            ${c.phone && c.email ? ' &nbsp;·&nbsp; ' : ''}
            ${c.email ? `<a href="mailto:${esc(c.email)}" class="jp-contact-link" style="color:var(--primary)">${esc(c.email)}</a>` : ''}
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" style="flex-shrink:0;color:var(--text-muted)"
                onclick="unlinkBidContact(${bid.id},'${esc(custName)}',${c.id})" title="Remove">✕</button>
      </div>`).join('');

    const searchId = `jp-search-${bid.id}-${btoa(encodeURIComponent(custName)).replace(/[^a-z0-9]/gi,'')}`;
    return `
      <div class="jp-customer-block">
        <div class="jp-customer-header">
          <span class="jp-customer-name">${esc(custName)}</span>
          <button class="btn btn-ghost btn-sm" onclick="toggleLinkSearch('${searchId}',${bid.id},'${esc(custName)}')">
            ${linked.length ? '+ Add' : '+ Link Contact'}
          </button>
        </div>
        ${linkedCards || '<div class="jp-no-contact">No contact linked</div>'}
        <div id="${searchId}" style="display:none;margin-top:8px">
          <input type="text" class="form-input" style="margin-bottom:6px"
                 placeholder="Search by name, company, email…"
                 oninput="filterLinkSearch(this,'${searchId}-results',${bid.id},'${esc(custName)}')" />
          <div id="${searchId}-results" class="jp-ct-results-box"></div>
        </div>
      </div>`;
  }).join('');

  const contactsSection = `
    <div class="jp-section">
      <div class="jp-section-title">Customer Contacts</div>
      ${customerList.length
        ? customerRows
        : '<div style="font-size:13px;color:var(--text-muted)">No customers on this bid yet.</div>'}
    </div>`;

  return `
    <div class="jp-section">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
        <span class="badge badge-stage">${stageName(bid.stage)}</span>
        ${statusBadge(bid.status)}
        ${bid.bid_number ? `<span style="font-size:12px;color:var(--text-muted)">#${esc(bid.bid_number)}</span>` : ''}
        ${bid.job_number ? `<span style="font-size:12px;color:var(--text-muted)">Job: ${esc(bid.job_number)}</span>` : ''}
      </div>
    </div>
    ${renderLifecycleSection(bid, linkedCOs)}
    ${contactsSection}
    ${renderRemindersSection(bid)}
    ${detailFields ? `<div class="jp-section"><div class="jp-section-title">Details</div>${detailFields}</div>` : ''}
    ${dateFields ? `<div class="jp-section"><div class="jp-section-title">Dates</div>${dateFields}</div>` : ''}
    ${progressSection}
    ${renderChecklistSection(bid)}
    ${notesSection}
    ${awardSection}
    ${followupHistory}`;
}

// ── Bid Lifecycle (phases + linked COs) ──────────────────────────────────────

const PHASE_LABELS = ['50% Budget', '80% DD', 'CD Pricing', 'Final Bid', 'Re-Bid', 'Value Engineering', 'Custom'];

function renderLifecycleSection(bid, linkedCOs = []) {
  const phases   = bid.phases || [];
  const isCO     = !!bid.job_number && bid.stage !== 'awarded';
  const isActive = ['opportunity','active_bid','active_co','follow_up'].includes(bid.stage);
  const hasPhases = phases.length > 0;
  const hasLinkedCOs = linkedCOs.length > 0;

  // Always show for active bids so the "New Phase" button is accessible
  if (!hasPhases && !hasLinkedCOs && !bid.parent_bid_id && !isActive && bid.stage !== 'awarded') return '';

  // Phase timeline rows
  const phaseRows = phases.map((p, i) => {
    const estM = State.team.find(t => t.id === p.estimator_id);
    const clDone = (p.checklist || []).filter(id => !id.startsWith('na:')).length;
    const clNA   = (p.checklist || []).filter(id => id.startsWith('na:')).length;
    const clDenom = CHECKLIST_TOTAL - clNA;
    const clPct  = clDenom > 0 ? Math.round(clDone / clDenom * 100) : 0;
    const subs   = (p.sub_estimators || []).map(se => {
      const m = State.team.find(t => t.id === se.estimator_id);
      return m ? `<span class="initials-pill initials-pill-sub" title="${esc(m.name)}">${esc(m.initials)}</span>` : '';
    }).join('');
    return `
      <div class="lifecycle-phase">
        <div class="lifecycle-phase-marker">${i + 1}</div>
        <div class="lifecycle-phase-body">
          <div class="lifecycle-phase-title">
            ${esc(p.label || `Phase ${p.phase_num}`)}
            ${p.date_submitted ? `<span class="lifecycle-meta">submitted ${fmt(p.date_submitted,'date')}</span>` : ''}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
            ${estM ? `<span class="initials-pill" style="transform:scale(.85);transform-origin:left">${esc(estM.initials)}</span>` : ''}
            ${subs}
            ${p.amount ? `<strong style="color:var(--text)">${fmt(p.amount,'currency')}</strong>` : ''}
            ${p.customers?.length ? `<span>${p.customers.join(' · ')}</span>` : ''}
            ${p.checklist?.length ? `<span style="color:var(--primary)">${clDone}/${clDenom} checklist (${clPct}%)</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  // Linked CO rows
  const coRows = linkedCOs.map(co => {
    const estM = State.team.find(t => t.id === co.estimator_id);
    return `
      <div class="lifecycle-co-row clickable-row" onclick="closeJobPanel();setTimeout(()=>openJobPanel(${co.id}),80)">
        <span class="badge badge-co" style="flex-shrink:0">CO</span>
        <span style="flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(co.project_name)}${co.bid_number?` <span style="color:var(--text-muted);font-size:11px">#${esc(co.bid_number)}</span>`:''}</span>
        ${estM ? `<span class="initials-pill" style="transform:scale(.85)">${esc(estM.initials)}</span>` : ''}
        <span style="font-size:12px;color:var(--text-muted);flex-shrink:0">${fmt(co.estimate_amount,'currency')}</span>
        <span class="badge badge-stage" style="flex-shrink:0;font-size:10px">${stageName(co.stage)}</span>
      </div>`;
  }).join('');

  // Parent bid link (on COs)
  const parentSection = bid.parent_bid_id ? `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
      Linked to bid:
      <button class="btn-inline-link" onclick="closeJobPanel();setTimeout(()=>openJobPanel(${bid.parent_bid_id}),80)">
        View parent bid →
      </button>
    </div>` : '';

  // Link CO search (on non-CO bids)
  const linkCOSearch = !isCO ? `
    <div id="lc-search-wrap-${bid.id}" style="display:none;margin-top:8px">
      <input type="text" class="form-input" style="margin-bottom:6px"
             placeholder="Search by bid #, project name…"
             oninput="filterLinkCOSearch(this,${bid.id})" />
      <div id="lc-search-results-${bid.id}" class="jp-ct-results-box"></div>
    </div>` : '';

  return `
    <div class="jp-section">
      <div class="jp-section-title">🔄 Bid Lifecycle</div>
      ${parentSection}
      ${phaseRows}
      ${hasPhases || bid.stage === 'awarded' ? `<div class="lifecycle-current-marker">▶ Current Phase</div>` : ''}
      ${isActive ? `
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="openNewPhaseModal(${bid.id})">
          + Save as Phase / Start New Round
        </button>` : ''}
      ${hasLinkedCOs || bid.stage === 'awarded' ? `
        <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)">Change Orders${hasLinkedCOs?` (${linkedCOs.length})`:''}</span>
            <button class="btn btn-ghost btn-sm" onclick="toggleLinkCOSearch(${bid.id})">+ Link CO</button>
          </div>
          ${coRows || '<div style="font-size:12px;color:var(--text-muted)">No change orders linked yet.</div>'}
          ${linkCOSearch}
        </div>` : ''}
    </div>`;
}

// ── New Phase Modal ───────────────────────────────────────────────────────────
function openNewPhaseModal(bidId) {
  const existing = document.getElementById('new-phase-modal');
  if (existing) existing.remove();

  const opts = PHASE_LABELS.map(l => `<option>${l}</option>`).join('');
  const div = document.createElement('div');
  div.id = 'new-phase-modal';
  div.className = 'modal-overlay';
  div.onclick = e => { if (e.target === div) div.remove(); };
  div.innerHTML = `
    <div class="modal-box modal-small">
      <div class="modal-header">
        <span style="font-weight:700">Save Phase & Start New Round</span>
        <button class="modal-close" onclick="document.getElementById('new-phase-modal').remove()">×</button>
      </div>
      <div style="padding:20px 24px">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
          The current checklist, amount, estimator and customers will be saved as a completed phase.
          The checklist will then be cleared for the new round.
        </p>
        <div class="form-group" style="margin-bottom:16px">
          <label class="form-label">Label for this phase (what you're saving)</label>
          <select class="form-input" id="np-label">
            ${opts}
          </select>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-secondary" onclick="document.getElementById('new-phase-modal').remove()">Cancel</button>
          <button class="btn btn-primary" onclick="confirmNewPhase(${bidId})">Save Phase & Continue</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(div);
}

async function confirmNewPhase(bidId) {
  const label = document.getElementById('np-label')?.value || '';
  try {
    await api.post(`/api/bids/${bidId}/phases`, { label });
    document.getElementById('new-phase-modal')?.remove();
    openJobPanel(bidId);
  } catch (e) { alert('Failed to save phase: ' + e.message); }
}

// ── Link CO to parent bid ─────────────────────────────────────────────────────
let _linkedCOSearchBids = null;

async function toggleLinkCOSearch(bidId) {
  const wrap = document.getElementById(`lc-search-wrap-${bidId}`);
  if (!wrap) return;
  const opening = wrap.style.display === 'none';
  wrap.style.display = opening ? 'block' : 'none';
  if (opening) {
    if (!_linkedCOSearchBids) {
      // Load active COs and follow-up COs
      _linkedCOSearchBids = await api.get('/api/bids?stage=active_co,follow_up');
    }
    filterLinkCOSearch(wrap.querySelector('input'), bidId);
    wrap.querySelector('input')?.focus();
  }
}

function filterLinkCOSearch(input, bidId) {
  const q = (input?.value || '').toLowerCase();
  const results = document.getElementById(`lc-search-results-${bidId}`);
  if (!results || !_linkedCOSearchBids) return;

  const matches = _linkedCOSearchBids
    .filter(b => b.job_number) // only COs have job_number
    .filter(b =>
      (b.project_name || '').toLowerCase().includes(q) ||
      (b.bid_number   || '').toLowerCase().includes(q) ||
      (b.job_number   || '').toLowerCase().includes(q)
    ).slice(0, 12);

  results.innerHTML = matches.length
    ? matches.map(b => `
        <div class="jp-ct-result" onclick="linkCOToParent(${bidId},${b.id},'${esc(b.project_name)}')">
          <div style="font-weight:600;font-size:13px">${esc(b.project_name)}</div>
          <div style="font-size:12px;color:var(--text-muted)">
            ${b.job_number?`Job: ${esc(b.job_number)}`:''}${b.bid_number?` · #${esc(b.bid_number)}`:''}
          </div>
        </div>`).join('')
    : '<div style="padding:10px 12px;font-size:13px;color:var(--text-muted)">No change orders found.</div>';
}

async function linkCOToParent(parentBidId, coId, coName) {
  try {
    await api.put(`/api/bids/${coId}/link-parent`, { parent_bid_id: parentBidId });
    _linkedCOSearchBids = null;
    openJobPanel(parentBidId);
  } catch (e) { alert('Failed to link: ' + e.message); }
}

// ── Bid Reminders ────────────────────────────────────────────────────────────

function renderRemindersSection(bid) {
  const reminders = (bid.reminders || []).sort((a, b) => a.remind_on.localeCompare(b.remind_on));
  const cards = reminders.map(r => {
    const daysAway = Math.round((new Date(r.remind_on + 'T00:00:00') - new Date()) / 86400000);
    const isPast   = daysAway < 0;
    const isToday  = daysAway === 0;
    const isSoon   = daysAway <= 7;
    const color    = isPast || isToday ? '#dc2626' : isSoon ? '#d97706' : '#16a34a';
    const label    = isPast ? `${Math.abs(daysAway)}d ago` : isToday ? 'Today' : `in ${daysAway}d`;
    return `
      <div class="jp-reminder-card">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;color:${color};margin-bottom:2px">
            📅 ${fmt(r.remind_on, 'date')} <span style="font-weight:400;opacity:.8">(${label})</span>
          </div>
          <div style="font-size:13px;color:var(--text)">${esc(r.note)}</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="color:var(--text-muted);flex-shrink:0"
                onclick="deleteReminderFromPanel(${bid.id},'${r.rid}')" title="Remove">✕</button>
      </div>`;
  }).join('');

  return `
    <div class="jp-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="jp-section-title" style="margin:0">📌 Reminders${reminders.length ? ` (${reminders.length})` : ''}</div>
        <button class="btn btn-ghost btn-sm" onclick="toggleAddReminder(${bid.id})">+ Add</button>
      </div>
      <div id="jp-reminders-list-${bid.id}">
        ${cards || '<div style="font-size:13px;color:var(--text-muted)">No reminders set.</div>'}
      </div>
      <div id="jp-add-reminder-${bid.id}" style="display:none;margin-top:10px;padding:10px;background:#f8fafc;border-radius:6px;border:1px solid var(--border)">
        <div class="form-group" style="margin-bottom:8px">
          <label class="form-label">Reminder Date</label>
          <input type="date" class="form-input" id="jp-rem-date-${bid.id}" />
        </div>
        <div class="form-group" style="margin-bottom:10px">
          <label class="form-label">Note</label>
          <input type="text" class="form-input" id="jp-rem-note-${bid.id}"
                 placeholder="e.g. Check for updated drawings — GC said August" />
        </div>
        <div style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn btn-secondary btn-sm" onclick="toggleAddReminder(${bid.id})">Cancel</button>
          <button class="btn btn-primary btn-sm" onclick="saveReminder(${bid.id})">Save Reminder</button>
        </div>
      </div>
    </div>`;
}

function toggleAddReminder(bidId) {
  const box = document.getElementById(`jp-add-reminder-${bidId}`);
  if (!box) return;
  const opening = box.style.display === 'none';
  box.style.display = opening ? 'block' : 'none';
  if (opening) {
    // Default to 30 days from now
    const d = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const dateEl = document.getElementById(`jp-rem-date-${bidId}`);
    if (dateEl) { dateEl.value = d; }
    document.getElementById(`jp-rem-note-${bidId}`)?.focus();
  }
}

async function saveReminder(bidId) {
  const note     = document.getElementById(`jp-rem-note-${bidId}`)?.value.trim();
  const remind_on = document.getElementById(`jp-rem-date-${bidId}`)?.value;
  if (!note)      { alert('Please enter a note for this reminder.'); return; }
  if (!remind_on) { alert('Please select a reminder date.'); return; }
  try {
    await api.post(`/api/bids/${bidId}/reminders`, { note, remind_on });
    openJobPanel(bidId);
  } catch (e) { alert('Failed to save reminder: ' + e.message); }
}

async function deleteReminderFromPanel(bidId, rid) {
  try {
    await api.del(`/api/bids/${bidId}/reminders/${rid}`);
    openJobPanel(bidId);
  } catch (e) { alert('Failed to remove reminder: ' + e.message); }
}

// ── Bid contact link/unlink/quick-create ─────────────────────────────────────
let _allContactsForSearch = null; // lazy-loaded once

async function ensureContactsLoaded() {
  if (!_allContactsForSearch) _allContactsForSearch = await api.get('/api/contacts');
}

async function toggleLinkSearch(searchId, bidId, customerName) {
  const box = document.getElementById(searchId);
  if (!box) return;
  const opening = box.style.display === 'none';
  box.style.display = opening ? 'block' : 'none';
  if (opening) {
    await ensureContactsLoaded();
    const input = box.querySelector('input');
    if (input) { input.value = ''; input.focus(); }
    renderLinkResults(searchId + '-results', bidId, customerName, '');
  }
}

function filterLinkSearch(inputEl, resultsId, bidId, customerName) {
  const q = (inputEl?.value || '').toLowerCase();
  renderLinkResults(resultsId, bidId, customerName, q);
}

function renderLinkResults(resultsId, bidId, customerName, q) {
  const results = document.getElementById(resultsId);
  if (!results || !_allContactsForSearch) return;

  const matches = _allContactsForSearch.filter(c =>
    (c.full_name || '').toLowerCase().includes(q) ||
    (c.company   || '').toLowerCase().includes(q) ||
    (c.email     || '').toLowerCase().includes(q)
  ).slice(0, 15);

  const rows = matches.map(c => `
    <div class="jp-ct-result" onclick="linkBidContact(${bidId},'${esc(customerName)}',${c.id})">
      <div style="font-weight:600;font-size:13px">${esc(c.full_name)}</div>
      <div style="font-size:12px;color:var(--text-muted)">
        ${[c.company, c.email].filter(Boolean).map(esc).join(' · ')}
      </div>
    </div>`).join('');

  // Always show "+ Create new contact" at the bottom
  const createBtn = `
    <div class="jp-ct-create" onclick="showQuickCreateContact('${esc(customerName)}',${bidId})">
      <span style="font-size:16px;font-weight:700">+</span>
      Create new contact${q ? ` for "${esc(q)}"` : ''}
    </div>`;

  results.innerHTML = rows + createBtn;
}

async function linkBidContact(bidId, customerName, contactId) {
  try {
    await api.post(`/api/bids/${bidId}/contacts`, { customer_name: customerName, contact_id: contactId });
    _allContactsForSearch = null; // refresh cache next time
    openJobPanel(bidId);
  } catch (e) { alert('Failed to link: ' + e.message); }
}

async function unlinkBidContact(bidId, customerName, contactId) {
  try {
    await api.post(`/api/bids/${bidId}/contacts/unlink`, { customer_name: customerName, contact_id: contactId });
    openJobPanel(bidId);
  } catch (e) { alert('Failed to unlink: ' + e.message); }
}

// ── Contact & Company Profile Modal ──────────────────────────────────────────

async function openContactProfile(contactId) {
  const id = Number(contactId);
  // Look up contact details from cache or fetch
  let contact = (_allContactsForSearch || _contactsCache || []).find(c => c.id === id);
  if (!contact) contact = await api.get(`/api/contacts/${id}`);

  showProfileModal({
    title:    contact.full_name,
    subtitle: [contact.company, fmtPhone(contact.phone), contact.email].filter(Boolean).join(' · '),
    fetchUrl: `/api/contacts/${id}/bids`,
    icon:     '👤',
  });
}

async function openCompanyProfile(companyName) {
  showProfileModal({
    title:    companyName,
    subtitle: 'Company',
    fetchUrl: `/api/companies/bids?name=${encodeURIComponent(companyName)}`,
    icon:     '🏢',
  });
}

async function showProfileModal({ title, subtitle, fetchUrl, icon }) {
  // Remove any existing profile modal
  document.getElementById('profile-modal-overlay')?.remove();

  // Create overlay with spinner
  const overlay = document.createElement('div');
  overlay.id = 'profile-modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box modal-large" style="max-height:85vh;overflow:hidden;display:flex;flex-direction:column">
      <div class="modal-header">
        <div>
          <div style="font-size:18px;font-weight:800">${icon} ${esc(title)}</div>
          ${subtitle ? `<div style="font-size:13px;color:var(--text-muted);margin-top:2px">${esc(subtitle)}</div>` : ''}
        </div>
        <button class="modal-close" onclick="document.getElementById('profile-modal-overlay').remove()">×</button>
      </div>
      <div id="profile-modal-content" style="flex:1;overflow-y:auto;padding:20px 24px">
        <div class="loading-screen" style="height:120px"><div class="spinner"></div></div>
      </div>
    </div>`;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);

  try {
    const { bids, stats } = await api.get(fetchUrl);

    const winPct = stats.winRate !== null ? `${stats.winRate}%` : '—';
    const statsHtml = `
      <div class="profile-stats">
        <div class="profile-stat">
          <div class="profile-stat-val">${stats.total}</div>
          <div class="profile-stat-lbl">Total Bids</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-val" style="color:var(--primary)">${stats.active}</div>
          <div class="profile-stat-lbl">Active</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-val" style="color:var(--success)">${stats.wins}</div>
          <div class="profile-stat-lbl">Wins</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-val" style="color:var(--danger)">${stats.losses}</div>
          <div class="profile-stat-lbl">Losses</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-val" style="color:${stats.winRate >= 50 ? 'var(--success)' : stats.winRate !== null ? 'var(--amber)' : 'var(--text-muted)'}">${winPct}</div>
          <div class="profile-stat-lbl">Win Rate</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-val" style="color:#16a34a">${fmtCompact(stats.wonValue)}</div>
          <div class="profile-stat-lbl">Won Value</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-val">${fmtCompact(stats.totalValue)}</div>
          <div class="profile-stat-lbl">Total Pipeline</div>
        </div>
      </div>`;

    const rows = bids.map(b => {
      const customers = [b.customer, b.customer2, b.customer3, b.customer4, b.customer5].filter(Boolean).join(', ');
      const stageClass = b.stage === 'awarded' ? 'color:var(--success);font-weight:700'
        : b.stage === 'not_awarded' ? 'color:var(--danger)' : '';
      return `
        <tr class="clickable-row" onclick="document.getElementById('profile-modal-overlay').remove();setTimeout(()=>openJobPanel(${b.id}),80)">
          <td class="td-project">${esc(b.project_name)}${b.bid_number ? `<small> #${esc(b.bid_number)}</small>` : ''}</td>
          <td><span class="badge badge-stage" style="${stageClass}">${stageName(b.stage)}</span></td>
          <td style="font-size:12px;color:var(--text-muted)">${esc(customers) || '—'}</td>
          <td>${fmt(b.estimate_amount, 'currency')}</td>
          <td>${b.estimator_initials ? `<span class="initials-pill">${esc(b.estimator_initials)}</span>` : '—'}</td>
          <td style="color:var(--text-muted);font-size:12px">${fmt(b.date_received, 'date')}</td>
        </tr>`;
    }).join('');

    const tableHtml = bids.length ? `
      <div style="margin-top:16px">
        <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">
          Bid History (${bids.length})
        </div>
        <div class="table-wrapper">
          <table>
            <thead><tr>
              <th>Project</th><th>Stage</th><th>Customer(s)</th>
              <th>Amount</th><th>Est.</th><th>Received</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>` : `<div class="empty-state" style="height:100px"><div class="empty-state-desc">No bids linked yet.</div></div>`;

    document.getElementById('profile-modal-content').innerHTML = statsHtml + tableHtml;
  } catch (e) {
    document.getElementById('profile-modal-content').innerHTML =
      `<div class="text-danger">Error loading: ${esc(e.message)}</div>`;
  }
}

// ── Quick-create contact from job panel ───────────────────────────────────────
function showQuickCreateContact(customerName, bidId) {
  // Inject a mini-form into the panel body (replaces the search area temporarily)
  const existing = document.getElementById('jp-quick-create');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'jp-quick-create';
  div.style.cssText = 'position:fixed;bottom:0;right:0;width:500px;max-width:100vw;background:var(--card-bg);border-top:2px solid var(--primary);padding:20px;z-index:960;box-shadow:0 -4px 20px rgba(0,0,0,.15)';
  div.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <strong style="font-size:14px">New Contact — ${esc(customerName)}</strong>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('jp-quick-create').remove()">✕</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="form-group">
        <label class="form-label">First Name*</label>
        <input class="form-input" id="qc-first" placeholder="First" />
      </div>
      <div class="form-group">
        <label class="form-label">Last Name*</label>
        <input class="form-input" id="qc-last" placeholder="Last" />
      </div>
      <div class="form-group" style="grid-column:span 2">
        <label class="form-label">Company</label>
        <input class="form-input" id="qc-company" value="${esc(customerName)}" list="company-datalist" />
      </div>
      <div class="form-group">
        <label class="form-label">Phone</label>
        <input class="form-input" id="qc-phone" placeholder="2155551234" />
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input class="form-input" id="qc-email" type="email" placeholder="email@company.com" />
      </div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn btn-secondary" onclick="document.getElementById('jp-quick-create').remove()">Cancel</button>
      <button class="btn btn-primary" onclick="saveQuickContact('${esc(customerName)}',${bidId})">Create &amp; Link</button>
    </div>`;
  document.body.appendChild(div);
  document.getElementById('qc-first')?.focus();
}

async function saveQuickContact(customerName, bidId) {
  const first = document.getElementById('qc-first')?.value.trim();
  const last  = document.getElementById('qc-last')?.value.trim();
  if (!first && !last) { alert('Enter at least a first or last name.'); return; }

  const payload = {
    first_name: first || null,
    last_name:  last  || null,
    company:    document.getElementById('qc-company')?.value.trim() || null,
    phone:      document.getElementById('qc-phone')?.value.replace(/\D/g,'') || null,
    email:      document.getElementById('qc-email')?.value.trim().toLowerCase() || null,
  };

  try {
    const created = await api.post('/api/contacts', payload);
    // Add to local cache immediately
    if (_allContactsForSearch) _allContactsForSearch.unshift(created);
    // Link to bid
    await api.post(`/api/bids/${bidId}/contacts`, { customer_name: customerName, contact_id: created.id });
    document.getElementById('jp-quick-create')?.remove();
    openJobPanel(bidId);
  } catch (e) { alert('Failed to create contact: ' + e.message); }
}

function openBidModalFromPanel() {
  if (!State.currentPanelBidId) return;
  openBidModal(State.currentPanelBidId);
}

function openFollowupModalFromPanel() {
  if (!State.currentPanelBidId) return;
  openFollowupModal(State.currentPanelBidId);
}

function openStageModalFromPanel() {
  if (!State.currentPanelBidId) return;
  api.get(`/api/bids/${State.currentPanelBidId}`).then(b => {
    openStageModal(State.currentPanelBidId, b.stage);
  });
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
async function init() {
  // Team data may return 401 if no session yet — suppress and let login refetch
  [State.team, State.settings] = await Promise.all([
    api.get('/api/team').catch(() => []),
    api.get('/api/settings').catch(() => ({ fu_initial_days: 3, fu_recurring_days: 7 })),
  ]);
  window.addEventListener('hashchange', onHashChange);

  // Ctrl/Cmd+K → focus global search
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const inp = document.getElementById('global-search-input');
      if (inp && State.currentUser) { inp.focus(); inp.select(); }
    }
  });

  // Check existing session
  const me = await api.get('/api/auth/me').catch(() => null);
  if (me) {
    State.currentUser = me;
    if (me.must_change_password) {
      document.getElementById('app').style.display = 'none';
      const cpOverlay = document.getElementById('change-password-overlay');
      cpOverlay.style.display = 'flex';
    } else {
      updateSidebarUser(me);
      hideLoginOverlay();
      await onHashChange();
    }
  } else {
    showLoginOverlay();
  }
}

init().catch(console.error);
