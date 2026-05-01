// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const State = {
  team: [],
  currentPage: '',
  currentUser: null,
  mineOnly: false,
  loginPendingId: null,
  currentPanelBidId: null,
  dashboardView: 'mine',
  quickLogBidId: null,
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
      case 'digest':        return await renderDigest(main);
      case 'history':       return await renderHistory(main);
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

  // View toggle (only when logged in)
  const viewToggle = State.currentUser ? `
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
      <span class="activity-time">${relativeTime(b.updated_at?.split('T')[0])}</span>
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
        <td class="td-amount">${fmt(b.estimate_amount, 'currency')}</td>
        <td>
          <div class="progress-bar"><div class="progress-fill ${pctWidth >= 100 ? 'complete' : ''}" style="width:${pctWidth}%"></div></div>
          <small style="color:var(--text-muted);font-size:11px">${pctWidth}%</small>
        </td>
        <td class="td-date ${dueDateClass}">${fmt(b.estimate_due_date, 'date')}</td>
        <td>${b.estimator_initials ? `<span class="initials-pill">${esc(b.estimator_initials)}</span>` : '—'}</td>
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
        <td class="td-amount">${fmt(b.estimate_amount, 'currency')}</td>
        <td><div class="progress-bar"><div class="progress-fill ${pctWidth >= 100 ? 'complete' : ''}" style="width:${pctWidth}%"></div></div><small style="color:var(--text-muted);font-size:11px">${pctWidth}%</small></td>
        <td class="td-date ${dueDateClass}">${fmt(b.estimate_due_date, 'date')}</td>
        <td>${b.estimator_initials ? `<span class="initials-pill">${esc(b.estimator_initials)}</span>` : '—'}</td>
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
  ['fu-search','fu-stage-filter','fu-urgency-filter','fu-owner-filter'].forEach(id => {
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
  const searchVal  = document.getElementById('fu-search')?.value || '';
  const stageVal   = document.getElementById('fu-stage-filter')?.value || '';
  const urgencyVal = document.getElementById('fu-urgency-filter')?.value || '';
  const ownerVal   = document.getElementById('fu-owner-filter')?.value || '';
  const sortVal    = document.getElementById('fu-sort-filter')?.value || 'urgency';

  const params = new URLSearchParams({ stage: stageVal || 'opportunity,active_bid,active_co,follow_up' });
  if (searchVal) params.set('search', searchVal);
  if (State.mineOnly && State.currentUser) params.set('mine_only', 'true');

  let bids = await api.get('/api/bids?' + params.toString());

  // Client-side owner filter: salesperson owns it if assigned, otherwise estimator
  if (ownerVal) {
    bids = bids.filter(b =>
      b.salesperson_id ? b.salesperson_id == ownerVal : b.estimator_id == ownerVal
    );
  }

  // Client-side urgency filter
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

  const ownerOptions = State.team.filter(m => m.active)
    .map(m => `<option value="${m.id}">${esc(m.initials)} – ${esc(m.name)}</option>`).join('');

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
    const urgency = b.next_followup_date ? followupUrgency(b) : 'none';
    const rowClass = urgency === 'overdue' ? 'row-overdue' : urgency === 'today' ? 'row-due-soon' : '';
    return `
      <tr class="${rowClass} clickable-row" onclick="openJobPanel(${b.id})">
        <td class="td-project">${esc(b.project_name)}<small>${b.bid_number ? '#' + esc(b.bid_number) : ''}</small></td>
        <td class="td-customer">${esc(b.customer) || '—'}</td>
        <td class="td-amount">${fmt(b.estimate_amount, 'currency')}</td>
        <td><span class="badge badge-stage">${stageName(b.stage)}</span></td>
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
        <div class="page-subtitle">${bids.length} record${bids.length !== 1 ? 's' : ''} · ${overdueCnt} overdue · ${todayCnt} due today · ${weekCnt} this week</div>
      </div>
      <button class="btn btn-primary" onclick="openBidModal(null,'follow_up')">+ Add</button>
    </div>

    <div class="filter-bar">
      <input type="text" id="fu-search" placeholder="Search project, bid #, customer…" value="${esc(searchVal)}" oninput="debounceFollowUps()" />
      <select id="fu-stage-filter" onchange="refreshFollowUps()">
        <option value="">All Stages</option>
        <option value="opportunity">Opportunity</option>
        <option value="active_bid">Active Bid</option>
        <option value="active_co">Change Order</option>
        <option value="follow_up">Follow Up</option>
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
            <th>Project</th><th>Customer</th><th>Amount</th><th>Stage</th>
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

  if (stageVal)   document.getElementById('fu-stage-filter').value = stageVal;
  if (urgencyVal) document.getElementById('fu-urgency-filter').value = urgencyVal;
  if (ownerVal)   document.getElementById('fu-owner-filter').value = ownerVal;
  if (sortVal !== 'urgency') document.getElementById('fu-sort-filter').value = sortVal;
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
          <div class="digest-section-title">📤 Bids Submitted This Week</div>
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

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
        <div class="digest-section">
          <div class="digest-section-title">👷 By Estimator</div>
          <table class="digest-table">
            <thead><tr><th>Estimator</th><th style="text-align:center">Active Bids</th><th style="text-align:right">Value</th></tr></thead>
            <tbody>${estimatorRows}</tbody>
          </table>
        </div>
        <div class="digest-section">
          <div class="digest-section-title">📞 By Salesperson</div>
          <table class="digest-table">
            <thead><tr><th>Salesperson</th><th style="text-align:center">Active</th><th style="text-align:center">Overdue F/U</th></tr></thead>
            <tbody>${salespersonRows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────
// SETTINGS PAGE
// ─────────────────────────────────────────────
async function renderSettings(main) {
  const team = await api.get('/api/team');

  const rows = team.map(m => `
    <div class="team-row ${m.active ? '' : 'team-inactive'}">
      <div class="team-initials-circle" style="background:${m.role === 'salesperson' ? '#16a34a' : m.role === 'estimator/pm' ? '#7c3aed' : '#2563eb'}">${esc(m.initials)}</div>
      <div style="flex:1">
        <div class="team-name">${esc(m.name)}</div>
        <div class="team-role">${m.role} ${m.active ? '' : '· <em>Inactive</em>'}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="editTeamMember(${m.id})">Edit</button>
      <button class="btn btn-ghost btn-sm" onclick="toggleTeamMember(${m.id}, ${m.active})">${m.active ? 'Deactivate' : 'Activate'}</button>
    </div>`).join('');

  main.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">⚙️ Team Settings</div><div class="page-subtitle">Manage estimators, salespeople, and PMs</div></div>
      <button class="btn btn-primary" onclick="showAddTeamForm()">+ Add Member</button>
    </div>

    <div class="card" style="max-width:640px;margin-bottom:20px;display:none" id="add-team-form">
    </div>

    <div class="card" style="max-width:640px">
      <div class="section-title">Team Members</div>
      <div class="team-table">${rows}</div>
    </div>`;
}

function showAddTeamForm(memberId, name, initials, role, active) {
  const formCard = document.getElementById('add-team-form');
  const isEdit = !!memberId;
  formCard.style.display = 'block';
  formCard.innerHTML = `
    <div class="section-title">${isEdit ? 'Edit' : 'Add'} Team Member</div>
    <input type="hidden" id="tm-id" value="${memberId || ''}" />
    <div class="form-grid-3">
      <div class="form-group"><label>Full Name</label><input type="text" id="tm-name" value="${name || ''}" placeholder="Full name" /></div>
      <div class="form-group"><label>Initials</label><input type="text" id="tm-initials" value="${initials || ''}" placeholder="JO" maxlength="4" /></div>
      <div class="form-group"><label>Role</label>
        <select id="tm-role">
          <option value="estimator" ${role === 'estimator' ? 'selected' : ''}>Estimator</option>
          <option value="salesperson" ${role === 'salesperson' ? 'selected' : ''}>Salesperson</option>
          <option value="estimator/pm" ${role === 'estimator/pm' ? 'selected' : ''}>Estimator/PM</option>
        </select>
      </div>
    </div>
    ${isEdit ? `
    <div class="form-group">
      <label>Login PIN (optional, 4 digits)</label>
      <input type="password" id="tm-pin" maxlength="4" inputmode="numeric" placeholder="Leave blank for no PIN" style="max-width:140px" />
      <small class="field-hint">Set a PIN to secure this person's login. Leave blank to allow login by name only.</small>
    </div>` : ''}
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" onclick="saveTeamMember()">Save</button>
      <button class="btn btn-secondary" onclick="document.getElementById('add-team-form').style.display='none'">Cancel</button>
    </div>`;
}

function editTeamMember(id) {
  const m = State.team.find(t => t.id === id);
  if (!m) return;
  showAddTeamForm(m.id, m.name, m.initials, m.role, m.active);
  document.getElementById('add-team-form').scrollIntoView({ behavior: 'smooth' });
}

async function saveTeamMember() {
  const id = document.getElementById('tm-id').value;
  const name = document.getElementById('tm-name').value.trim();
  const initials = document.getElementById('tm-initials').value.trim().toUpperCase();
  const role = document.getElementById('tm-role').value;
  const pinEl = document.getElementById('tm-pin');
  const pin = pinEl ? pinEl.value.trim() : null;
  if (!name || !initials) return alert('Name and initials are required.');
  if (pin && !/^\d{4}$/.test(pin)) return alert('PIN must be exactly 4 digits.');
  try {
    if (id) {
      const payload = { name, initials, role };
      if (pin !== null) payload.pin = pin || null;
      await api.put(`/api/team/${id}`, payload);
    } else {
      await api.post('/api/team', { name, initials, role });
    }
    State.team = await api.get('/api/team');
    await renderSettings(document.getElementById('main'));
  } catch (e) { alert('Error: ' + e.message); }
}

async function toggleTeamMember(id, currentActive) {
  await api.put(`/api/team/${id}`, { active: currentActive ? 0 : 1 });
  State.team = await api.get('/api/team');
  await renderSettings(document.getElementById('main'));
}

// ─────────────────────────────────────────────
// BID FORM MODAL
// ─────────────────────────────────────────────
function openBidModal(bidId = null, defaultStage = 'opportunity') {
  const modal = document.getElementById('bid-modal');
  const form = document.getElementById('bid-form');
  form.reset();
  document.getElementById('bid-id').value = '';
  document.getElementById('bid-modal-title').textContent = bidId ? 'Edit Bid' : 'Add New Bid';

  populateTeamDropdowns('f-estimator_id', 'f-salesperson_id');

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
    });
  } else {
    document.getElementById('f-stage').value = defaultStage;
    document.getElementById('f-date_received').value = today();
  }

  modal.style.display = 'flex';
}

function closeBidModal() {
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

  const defaultFollowup = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
  document.getElementById('fu-next_date').value = bid.next_followup_date || defaultFollowup;

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
  renderLoginGrid();
}

function hideLoginOverlay() {
  document.getElementById('login-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

function renderLoginGrid() {
  const sales = State.team.filter(m => m.role === 'salesperson' && m.active);
  const estimators = State.team.filter(m => m.role === 'estimator' && m.active);

  function memberCard(m) {
    const color = avatarColor(m.initials);
    return `
      <button class="login-member-btn" onclick="selectLoginMember(${m.id})" id="lm-${m.id}">
        <div class="login-avatar" style="background:${color}">${esc(m.initials)}</div>
        <div class="login-member-name">${esc(firstName(m.name))}</div>
      </button>`;
  }

  document.getElementById('login-grid-sales').innerHTML = sales.map(memberCard).join('');
  document.getElementById('login-grid-estimators').innerHTML = estimators.map(memberCard).join('');
}

function selectLoginMember(memberId) {
  State.loginPendingId = memberId;
  document.querySelectorAll('.login-member-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById(`lm-${memberId}`)?.classList.add('selected');

  const member = State.team.find(m => m.id === memberId);
  if (member?.pin) {
    // Show PIN entry
    document.getElementById('login-selected-name').textContent =
      `Signing in as ${member.name}`;
    document.getElementById('login-pin-section').style.display = 'block';
    document.getElementById('login-error').style.display = 'none';
    const digits = document.querySelectorAll('.pin-digit');
    digits.forEach(d => d.value = '');
    digits[0].focus();
  } else {
    // No PIN — log in directly
    loginWithId(memberId, '');
  }
}

async function loginWithId(memberId, pin) {
  try {
    const user = await api.post('/api/auth/login', { memberId, pin });
    State.currentUser = user;
    document.getElementById('login-pin-section').style.display = 'none';
    updateSidebarUser(user);
    hideLoginOverlay();
    await onHashChange();
  } catch (e) {
    const errEl = document.getElementById('login-error');
    errEl.textContent = 'Incorrect PIN. Please try again.';
    errEl.style.display = 'block';
    document.querySelectorAll('.pin-digit').forEach(d => d.value = '');
    document.querySelectorAll('.pin-digit')[0].focus();
  }
}

function submitPin() {
  const pin = [...document.querySelectorAll('.pin-digit')].map(d => d.value).join('');
  if (pin.length < 4) {
    const errEl = document.getElementById('login-error');
    errEl.textContent = 'Please enter all 4 digits.';
    errEl.style.display = 'block';
    return;
  }
  loginWithId(State.loginPendingId, pin);
}

function cancelPinEntry() {
  document.getElementById('login-pin-section').style.display = 'none';
  document.querySelectorAll('.login-member-btn').forEach(b => b.classList.remove('selected'));
  State.loginPendingId = null;
}

async function logout() {
  await api.post('/api/auth/logout', {});
  State.currentUser = null;
  State.mineOnly = false;
  const fab = document.getElementById('quick-log-fab');
  if (fab) fab.style.display = 'none';
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
}

// PIN input — auto-advance between digits
document.querySelectorAll('.pin-digit').forEach((input, i, arr) => {
  input.addEventListener('input', () => {
    if (input.value && i < arr.length - 1) arr[i + 1].focus();
    if (input.value && i === arr.length - 1) submitPin();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !input.value && i > 0) arr[i - 1].focus();
    if (e.key === 'Enter') submitPin();
  });
});

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
    const [bid, followups] = await Promise.all([
      api.get(`/api/bids/${bidId}`),
      api.get(`/api/bids/${bidId}/followups`)
    ]);
    document.getElementById('job-panel-title').textContent = bid.project_name;
    body.innerHTML = renderJobPanelContent(bid, followups);
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

function renderJobPanelContent(bid, followups) {
  const customers = [bid.customer, bid.customer2, bid.customer3, bid.customer4, bid.customer5]
    .filter(Boolean).join(', ');

  const detailFields = [
    customers ? `<div class="jp-field"><span class="jp-label">Customer</span><span class="jp-value">${esc(customers)}</span></div>` : '',
    bid.estimate_amount ? `<div class="jp-field"><span class="jp-label">Estimate Amount</span><span class="jp-value">${fmt(bid.estimate_amount, 'currency')}</span></div>` : '',
    bid.estimator_initials ? `<div class="jp-field"><span class="jp-label">Estimator</span><span class="jp-value"><span class="initials-pill">${esc(bid.estimator_initials)}</span></span></div>` : '',
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

  return `
    <div class="jp-section">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
        <span class="badge badge-stage">${stageName(bid.stage)}</span>
        ${statusBadge(bid.status)}
        ${bid.bid_number ? `<span style="font-size:12px;color:var(--text-muted)">#${esc(bid.bid_number)}</span>` : ''}
        ${bid.job_number ? `<span style="font-size:12px;color:var(--text-muted)">Job: ${esc(bid.job_number)}</span>` : ''}
      </div>
    </div>
    ${detailFields ? `<div class="jp-section"><div class="jp-section-title">Details</div>${detailFields}</div>` : ''}
    ${dateFields ? `<div class="jp-section"><div class="jp-section-title">Dates</div>${dateFields}</div>` : ''}
    ${progressSection}
    ${notesSection}
    ${awardSection}
    ${followupHistory}`;
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
  State.team = await api.get('/api/team');

  // Check existing session
  const me = await api.get('/api/auth/me').catch(() => null);
  if (me) {
    State.currentUser = me;
    updateSidebarUser(me);
    hideLoginOverlay();
    window.addEventListener('hashchange', onHashChange);
    await onHashChange();
  } else {
    showLoginOverlay();
    window.addEventListener('hashchange', onHashChange);
  }
}

init().catch(console.error);
