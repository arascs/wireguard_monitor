// ── Shared state ──────────────────────────────────────────────
let currentTab = 'audit';
let auditData    = [];
let sessionData  = [];
let securityData = [];

// pagination
let currentPage = 1;
let pageSize    = 20;
let filteredRows = []; // holds result of current filter pass

// ── Helpers ───────────────────────────────────────────────────
function toMs(v) { return v ? new Date(v).getTime() : null; }
function containsCI(str, q) { return !q || String(str || '').toLowerCase().includes(q.toLowerCase().trim()); }

// ── Combo-box (dropdown + free-text) ─────────────────────────
function initCombo(inputId, dropdownId, onSelect) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  if (!input || !dropdown) return;

  input.addEventListener('focus', () => dropdown.classList.add('open'));
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    dropdown.querySelectorAll('.combo-option').forEach(opt => {
      opt.style.display = !q || opt.dataset.value.includes(q) || opt.dataset.value === '' ? '' : 'none';
    });
    dropdown.classList.add('open');
    onSelect();
  });

  dropdown.querySelectorAll('.combo-option').forEach(opt => {
    opt.addEventListener('mousedown', e => {
      e.preventDefault();
      input.value = opt.dataset.value;
      dropdown.classList.remove('open');
      onSelect();
    });
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });
}

// ── Detail modal ──────────────────────────────────────────────
function showDetail(title, obj) {
  document.getElementById('detail-modal-title').textContent = title;
  const body = document.getElementById('detail-modal-body');
  body.innerHTML = '';
  if (!obj || typeof obj !== 'object') {
    body.innerHTML = `<span style="grid-column:1/-1;color:#888">No details</span>`;
  } else {
    Object.entries(obj).forEach(([k, v]) => {
      const label = document.createElement('div');
      label.className = 'detail-label';
      label.textContent = k.replace(/_/g, ' ');
      const value = document.createElement('div');
      value.className = 'detail-value';
      if (v === null || v === undefined) {
        value.textContent = '—';
      } else if (typeof v === 'object') {
        value.textContent = JSON.stringify(v, null, 2);
        value.style.whiteSpace = 'pre-wrap';
        value.style.fontFamily = 'monospace';
        value.style.fontSize = '0.82rem';
      } else {
        value.textContent = String(v);
      }
      body.appendChild(label);
      body.appendChild(value);
    });
  }
  document.getElementById('detail-modal').style.display = 'block';
}

// ── Pagination render ─────────────────────────────────────────
function renderPage(rows, renderRowFn) {
  const tbody = document.getElementById('log-body');
  tbody.innerHTML = '';
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  slice.forEach(renderRowFn);

  // pagination bar
  const info   = document.getElementById('pagination-info');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  info.textContent = total === 0 ? '0 records' : `${start + 1}–${Math.min(start + pageSize, total)} / ${total}`;
  btnPrev.disabled = currentPage <= 1;
  btnNext.disabled = currentPage >= totalPages;
}

// ── Audit ─────────────────────────────────────────────────────
function filterAudit() {
  const tsFrom = toMs(document.getElementById('audit-filter-ts-from')?.value);
  const tsTo   = toMs(document.getElementById('audit-filter-ts-to')?.value);
  const admin  = document.getElementById('audit-filter-admin')?.value;
  const action = document.getElementById('audit-filter-action')?.value;

  filteredRows = auditData.filter(e => {
    const ts = new Date(e.timestamp).getTime();
    if (tsFrom !== null && ts < tsFrom) return false;
    if (tsTo   !== null && ts > tsTo)   return false;
    if (!containsCI(e.admin,  admin))   return false;
    if (!containsCI(e.action, action))  return false;
    return true;
  });
}

function renderAuditRows() {
  filterAudit();
  renderPage(filteredRows, (entry) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(entry.timestamp).toLocaleString()}</td>
      <td>${entry.admin}</td>
      <td>${entry.action}</td>
      <td><button class="btn-view-details">View</button></td>
    `;
    tr.querySelector('.btn-view-details').addEventListener('click', () =>
      showDetail(`Action: ${entry.action}`, entry.details)
    );
    document.getElementById('log-body').appendChild(tr);
  });
}

// ── Sessions ──────────────────────────────────────────────────
function filterSession() {
  const startFrom = toMs(document.getElementById('sess-filter-start-from')?.value);
  const startTo   = toMs(document.getElementById('sess-filter-start-to')?.value);
  const endFrom   = toMs(document.getElementById('sess-filter-end-from')?.value);
  const endTo     = toMs(document.getElementById('sess-filter-end-to')?.value);
  const peerIpQ   = document.getElementById('sess-filter-peer-ip')?.value;
  const peerNameQ = document.getElementById('sess-filter-peer-name')?.value;
  const appQ      = document.getElementById('sess-filter-app')?.value;

  filteredRows = sessionData.filter(e => {
    const startTs = new Date(e.start_time).getTime();
    const endTs   = new Date(e.end_time).getTime();
    const peerIp  = e.source ? e.source.split(':')[0] : '';
    if (startFrom !== null && startTs < startFrom) return false;
    if (startTo   !== null && startTs > startTo)   return false;
    if (endFrom   !== null && endTs   < endFrom)   return false;
    if (endTo     !== null && endTs   > endTo)     return false;
    if (!containsCI(peerIp,       peerIpQ))   return false;
    if (!containsCI(e.peer_name,  peerNameQ)) return false;
    if (!containsCI(e.service,    appQ))       return false;
    return true;
  });
}

function renderSessionRows() {
  filterSession();
  renderPage(filteredRows, (entry) => {
    const peerIp = entry.source ? entry.source.split(':')[0] : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(entry.start_time).toLocaleString()}</td>
      <td>${new Date(entry.end_time).toLocaleString()}</td>
      <td>${peerIp}</td>
      <td>${entry.peer_name || ''}</td>
      <td>${entry.service || ''}</td>
      <td><button class="btn-view-details">View</button></td>
    `;
    tr.querySelector('.btn-view-details').addEventListener('click', () =>
      showDetail('Session details', {
        peer_name:    entry.peer_name,
        source:       entry.source,
        service:      entry.service,
        start_time:   entry.start_time,
        end_time:     entry.end_time,
        duration_sec: entry.duration_sec,
        total_bytes:  entry.total_bytes,
        direction1:   entry.direction1,
        direction2:   entry.direction2
      })
    );
    document.getElementById('log-body').appendChild(tr);
  });
}

// ── Security ──────────────────────────────────────────────────
function filterSecurity() {
  const tsFrom = toMs(document.getElementById('security-filter-ts-from')?.value);
  const tsTo   = toMs(document.getElementById('security-filter-ts-to')?.value);
  const eventQ = document.getElementById('security-filter-event')?.value;
  const ifaceQ = document.getElementById('security-filter-interface')?.value;
  const peerQ  = document.getElementById('security-filter-peer-name')?.value;

  filteredRows = securityData.filter(e => {
    const ts = new Date(e.timestamp).getTime();
    if (tsFrom !== null && ts < tsFrom) return false;
    if (tsTo   !== null && ts > tsTo)   return false;
    if (!containsCI(e.event_name,          eventQ)) return false;
    if (!containsCI(e.details?.interface,  ifaceQ)) return false;
    if (!containsCI(e.details?.peer_name,  peerQ))  return false;
    return true;
  });
}

function renderSecurityRows() {
  filterSecurity();
  renderPage(filteredRows, (entry) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(entry.timestamp).toLocaleString()}</td>
      <td>${entry.event_name}</td>
      <td><button class="btn-view-details">View</button></td>
    `;
    tr.querySelector('.btn-view-details').addEventListener('click', () =>
      showDetail(`Event: ${entry.event_name}`, entry.details)
    );
    document.getElementById('log-body').appendChild(tr);
  });
}

function rerender() {
  currentPage = 1;
  renderCurrent();
}

function renderCurrent() {
  if (currentTab === 'audit')         renderAuditRows();
  else if (currentTab === 'sessions') renderSessionRows();
  else                                renderSecurityRows();
}

async function loadAuditLogs() {
  setAuditHeaders();
  try {
    const res = await fetch('/api/audit-logs', { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.success) { alert(data.error || 'Cannot load audit logs'); return; }
    auditData = (data.logs || []).slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    currentPage = 1;
    renderAuditRows();
  } catch (e) { alert(e.message || 'Error loading logs'); }
}

async function loadSessionLogs() {
  setSessionHeaders();
  try {
    const res = await fetch('/api/session-logs', { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.success) { alert(data.error || 'Cannot load session logs'); return; }
    sessionData = data.logs || [];
    currentPage = 1;
    renderSessionRows();
  } catch (e) { alert(e.message || 'Error loading session logs'); }
}

async function loadSecurityLogs() {
  setSecurityHeaders();
  try {
    const res = await fetch('/api/security-events', { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.success) { alert(data.error || 'Cannot load security events'); return; }
    securityData = (data.events || []).slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    currentPage = 1;
    renderSecurityRows();
  } catch (e) { alert(e.message || 'Error loading security events'); }
}

// populate app dropdown from API
async function loadAppOptions() {
  try {
    const res = await fetch('/api/applications', { credentials: 'same-origin' });
    const data = await res.json();
    const apps = data.applications || [];
    const dd = document.getElementById('sess-app-dropdown');
    if (!dd) return;
    // keep first "All" option
    const allOpt = dd.querySelector('[data-value=""]');
    dd.innerHTML = '';
    if (allOpt) dd.appendChild(allOpt);
    apps.forEach(app => {
      const opt = document.createElement('div');
      opt.className = 'combo-option';
      opt.dataset.value = app.name;
      opt.textContent = app.name;
      opt.addEventListener('mousedown', e => {
        e.preventDefault();
        document.getElementById('sess-filter-app').value = app.name;
        dd.classList.remove('open');
        rerender();
      });
      dd.appendChild(opt);
    });
  } catch (_) {}
}

// ── Header helpers ────────────────────────────────────────────
function setAuditHeaders() {
  document.getElementById('log-header-row').innerHTML = `<th>Timestamp</th><th>Admin</th><th>Action</th><th>Details</th>`;
  document.getElementById('log-header-row').style.display = '';
  document.getElementById('security-header-row').style.display = 'none';
}
function setSessionHeaders() {
  document.getElementById('log-header-row').innerHTML = `<th>Start Time</th><th>End Time</th><th>Peer IP</th><th>Peer Name</th><th>App</th><th>Details</th>`;
  document.getElementById('log-header-row').style.display = '';
  document.getElementById('security-header-row').style.display = 'none';
}
function setSecurityHeaders() {
  document.getElementById('log-header-row').style.display = 'none';
  document.getElementById('security-header-row').style.display = '';
}

// ── Tab switch ────────────────────────────────────────────────
function switchTo(type) {
  currentTab = type;
  ['audit', 'sessions', 'security'].forEach(t => {
    document.getElementById(`tab-${t === 'audit' ? 'audit' : t === 'sessions' ? 'sessions' : 'security'}`)
      ?.classList.toggle('active', t === type);
  });
  const titles = { audit: 'Admin actions', sessions: 'Peer sessions', security: 'Security events' };
  document.getElementById('section-title').textContent = titles[type] || '';

  // collapse all filter panels
  const toggleBtn = document.getElementById('btn-toggle-filter');
  if (toggleBtn) toggleBtn.textContent = '\u25BC Filter';
  ['audit-filter-panel', 'session-filter-panel', 'security-filter-panel'].forEach(id =>
    document.getElementById(id)?.classList.remove('open')
  );

  if (type === 'audit')     loadAuditLogs();
  else if (type === 'sessions') loadSessionLogs();
  else loadSecurityLogs();
}

// ── DOMContentLoaded ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Tab buttons
  document.getElementById('tab-audit')?.addEventListener('click',     () => switchTo('audit'));
  document.getElementById('tab-sessions')?.addEventListener('click',  () => switchTo('sessions'));
  document.getElementById('tab-security')?.addEventListener('click',  () => switchTo('security'));

  // Filter toggle
  document.getElementById('btn-toggle-filter')?.addEventListener('click', () => {
    const panelId = currentTab === 'audit' ? 'audit-filter-panel'
                  : currentTab === 'sessions' ? 'session-filter-panel'
                  : 'security-filter-panel';
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    document.getElementById('btn-toggle-filter').textContent = (isOpen ? '\u25B2' : '\u25BC') + ' Filter';
  });

  // Combos with dropdown
  initCombo('audit-filter-action', 'audit-action-dropdown', rerender);
  initCombo('sess-filter-app',     'sess-app-dropdown',     rerender);
  initCombo('security-filter-event','security-event-dropdown', rerender);

  // Plain text filter inputs
  ['audit-filter-ts-from','audit-filter-ts-to','audit-filter-admin'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', rerender));

  ['sess-filter-start-from','sess-filter-start-to','sess-filter-end-from','sess-filter-end-to',
   'sess-filter-peer-ip','sess-filter-peer-name'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', rerender));

  ['security-filter-ts-from','security-filter-ts-to',
   'security-filter-interface','security-filter-peer-name'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', rerender));

  // Reset buttons
  document.getElementById('audit-filter-reset')?.addEventListener('click', () => {
    ['audit-filter-ts-from','audit-filter-ts-to','audit-filter-admin','audit-filter-action']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    rerender();
  });
  document.getElementById('sess-filter-reset')?.addEventListener('click', () => {
    ['sess-filter-start-from','sess-filter-start-to','sess-filter-end-from','sess-filter-end-to',
     'sess-filter-peer-ip','sess-filter-peer-name','sess-filter-app']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    rerender();
  });
  document.getElementById('security-filter-reset')?.addEventListener('click', () => {
    ['security-filter-ts-from','security-filter-ts-to','security-filter-event',
     'security-filter-interface','security-filter-peer-name']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    rerender();
  });

  // Page size
  document.getElementById('page-size-select')?.addEventListener('change', e => {
    pageSize = parseInt(e.target.value, 10);
    currentPage = 1;
    rerender();
  });

  // Prev / Next
  document.getElementById('btn-prev')?.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; renderCurrent(); }
  });
  document.getElementById('btn-next')?.addEventListener('click', () => {
    const totalPages = Math.ceil(filteredRows.length / pageSize);
    if (currentPage < totalPages) { currentPage++; renderCurrent(); }
  });

  // Detail modal close
  document.getElementById('detail-modal-close')?.addEventListener('click', () => {
    document.getElementById('detail-modal').style.display = 'none';
  });
  document.getElementById('detail-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('detail-modal'))
      document.getElementById('detail-modal').style.display = 'none';
  });

  // Load application list for session filter dropdown
  loadAppOptions();

  // Initial load
  switchTo('audit');
});