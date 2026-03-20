// ── Shared state ──────────────────────────────────────────────
let currentTab = 'audit'; // 'audit' | 'sessions' | 'security'
let auditData = [];       // raw audit log entries
let sessionData = [];     // raw session log entries
let securityData = [];    // raw security event entries

// ── Filter helpers ────────────────────────────────────────────
function toMs(datetimeLocalValue) {
  return datetimeLocalValue ? new Date(datetimeLocalValue).getTime() : null;
}

function containsCI(str, query) {
  return !query || String(str || '').toLowerCase().includes(query.toLowerCase().trim());
}

// ── Render audit rows with current filters ────────────────────
function renderAuditRows() {
  const tbody = document.getElementById('log-body');
  if (!tbody) return;

  const tsFrom  = toMs(document.getElementById('audit-filter-ts-from')?.value);
  const tsTo    = toMs(document.getElementById('audit-filter-ts-to')?.value);
  const admin   = document.getElementById('audit-filter-admin')?.value;
  const action  = document.getElementById('audit-filter-action')?.value;

  tbody.innerHTML = '';

  (auditData).forEach((entry, idx) => {
    const ts = new Date(entry.timestamp).getTime();
    if (tsFrom !== null && ts < tsFrom) return;
    if (tsTo   !== null && ts > tsTo)   return;
    if (!containsCI(entry.admin,  admin))  return;
    if (!containsCI(entry.action, action)) return;

    const dateStr = new Date(entry.timestamp).toLocaleString();
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${dateStr}</td>
      <td>${entry.admin}</td>
      <td>${entry.action}</td>
      <td><button data-idx="${idx}" class="btn-view-details">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-view-details').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = btn.getAttribute('data-idx');
      const entry = auditData[idx];
      if (entry) alert(JSON.stringify(entry.details, null, 2));
    });
  });
}

// ── Render session rows with current filters ──────────────────
function renderSessionRows() {
  const tbody = document.getElementById('log-body');
  if (!tbody) return;

  const startFrom  = toMs(document.getElementById('sess-filter-start-from')?.value);
  const startTo    = toMs(document.getElementById('sess-filter-start-to')?.value);
  const endFrom    = toMs(document.getElementById('sess-filter-end-from')?.value);
  const endTo      = toMs(document.getElementById('sess-filter-end-to')?.value);
  const peerIpQ    = document.getElementById('sess-filter-peer-ip')?.value;
  const peerNameQ  = document.getElementById('sess-filter-peer-name')?.value;
  const appQ       = document.getElementById('sess-filter-app')?.value;

  tbody.innerHTML = '';

  (sessionData).forEach((entry, idx) => {
    const startTs = new Date(entry.start_time).getTime();
    const endTs   = new Date(entry.end_time).getTime();
    const peerIp  = entry.source ? entry.source.split(':')[0] : '';

    if (startFrom !== null && startTs < startFrom) return;
    if (startTo   !== null && startTs > startTo)   return;
    if (endFrom   !== null && endTs   < endFrom)   return;
    if (endTo     !== null && endTs   > endTo)     return;
    if (!containsCI(peerIp,          peerIpQ))   return;
    if (!containsCI(entry.peer_name, peerNameQ)) return;
    if (!containsCI(entry.service,   appQ))       return;

    const startStr = new Date(entry.start_time).toLocaleString();
    const endStr   = new Date(entry.end_time).toLocaleString();
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${startStr}</td>
      <td>${endStr}</td>
      <td>${peerIp}</td>
      <td>${entry.peer_name || ''}</td>
      <td>${entry.service || ''}</td>
      <td><button data-idx="${idx}" class="btn-view-details">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-view-details').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = btn.getAttribute('data-idx');
      const entry = sessionData[idx];
      if (entry) {
        alert(JSON.stringify({
          direction1:   entry.direction1,
          direction2:   entry.direction2,
          total_bytes:  entry.total_bytes,
          duration_sec: entry.duration_sec
        }, null, 2));
      }
    });
  });
}

// ── Render security rows with current filters ──────────────────
function renderSecurityRows() {
  const tbody = document.getElementById('log-body');
  if (!tbody) return;

  const tsFrom  = toMs(document.getElementById('security-filter-ts-from')?.value);
  const tsTo    = toMs(document.getElementById('security-filter-ts-to')?.value);
  const eventQ  = document.getElementById('security-filter-event')?.value;
  const ifaceQ  = document.getElementById('security-filter-interface')?.value;
  const peerQ   = document.getElementById('security-filter-peer-name')?.value;

  tbody.innerHTML = '';

  (securityData).forEach((entry, idx) => {
    const ts = new Date(entry.timestamp).getTime();
    if (tsFrom !== null && ts < tsFrom) return;
    if (tsTo   !== null && ts > tsTo)   return;
    if (!containsCI(entry.event_name, eventQ)) return;
    if (!containsCI(entry.details?.interface, ifaceQ)) return;
    if (!containsCI(entry.details?.peer_name, peerQ)) return;

    const dateStr = new Date(entry.timestamp).toLocaleString();
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${dateStr}</td>
      <td>${entry.event_name}</td>
      <td><button data-idx="${idx}" class="btn-view-details">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-view-details').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = btn.getAttribute('data-idx');
      const entry = securityData[idx];
      if (entry) alert(JSON.stringify(entry.details, null, 2));
    });
  });
}

// ── Fetch + set headers + render ──────────────────────────────
async function loadAuditLogs() {
  const tbody = document.getElementById('log-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const headerRow = document.getElementById('log-header-row');
  const securityHeader = document.getElementById('security-header-row');
  headerRow.innerHTML = `
    <th>Timestamp</th>
    <th>Admin</th>
    <th>Action</th>
    <th>Details</th>
  `;
  headerRow.style.display = '';
  securityHeader.style.display = 'none';

  try {
    const res = await fetch('/api/audit-logs', { credentials: 'same-origin' });
    let data;
    try { data = await res.json(); }
    catch (e) { alert('Failed to load logs: ' + e.message); return; }
    if (!data.success) { alert(data.error || 'Cannot load audit logs'); return; }

    auditData = data.logs || [];
    renderAuditRows();
  } catch (e) {
    alert(e.message || 'Error loading logs');
  }
}

async function loadSessionLogs() {
  const tbody = document.getElementById('log-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const headerRow = document.getElementById('log-header-row');
  const securityHeader = document.getElementById('security-header-row');
  headerRow.innerHTML = `
    <th>Start Time</th>
    <th>End Time</th>
    <th>Peer IP</th>
    <th>Peer Name</th>
    <th>App</th>
    <th>Details</th>
  `;
  headerRow.style.display = '';
  securityHeader.style.display = 'none';

  try {
    const res = await fetch('/api/session-logs', { credentials: 'same-origin' });
    let data;
    try { data = await res.json(); }
    catch (e) { alert('Failed to load session logs: ' + e.message); return; }
    if (!data.success) { alert(data.error || 'Cannot load session logs'); return; }

    sessionData = data.logs || [];
    renderSessionRows();
  } catch (e) {
    alert(e.message || 'Error loading session logs');
  }
}

// ── Fetch + set headers + render security ──────────────────────
async function loadSecurityLogs() {
  const tbody = document.getElementById('log-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const headerRow = document.getElementById('log-header-row');
  const securityHeader = document.getElementById('security-header-row');
  headerRow.style.display = 'none';
  securityHeader.style.display = '';

  try {
    const res = await fetch('/api/security-events', { credentials: 'same-origin' });
    let data;
    try { data = await res.json(); }
    catch (e) { alert('Failed to load security events: ' + e.message); return; }
    if (!data.success) { alert(data.error || 'Cannot load security events'); return; }

    securityData = data.events || [];
    renderSecurityRows();
  } catch (e) {
    alert(e.message || 'Error loading security events');
  }
}

// ── Tab switch ────────────────────────────────────────────────
function switchTo(type) {
  currentTab = type;
  const btnAudit    = document.getElementById('tab-audit');
  const btnSess     = document.getElementById('tab-sessions');
  const btnSec      = document.getElementById('tab-security');
  const title       = document.getElementById('section-title');
  const auditPanel  = document.getElementById('audit-filter-panel');
  const sessPanel   = document.getElementById('session-filter-panel');
  const secPanel    = document.getElementById('security-filter-panel');

  // reset toggle arrow to collapsed when switching tabs
  const toggleBtn = document.getElementById('btn-toggle-filter');
  if (toggleBtn) toggleBtn.textContent = '\u25BC Filter';
  auditPanel?.classList.remove('open');
  sessPanel?.classList.remove('open');
  secPanel?.classList.remove('open');

  if (type === 'audit') {
    btnAudit.classList.add('active');
    btnSess.classList.remove('active');
    btnSec.classList.remove('active');
    title.textContent = 'Admin actions';
    loadAuditLogs();
  } else if (type === 'sessions') {
    btnAudit.classList.remove('active');
    btnSess.classList.add('active');
    btnSec.classList.remove('active');
    title.textContent = 'Peer sessions';
    loadSessionLogs();
  } else if (type === 'security') {
    btnAudit.classList.remove('active');
    btnSess.classList.remove('active');
    btnSec.classList.add('active');
    title.textContent = 'Security events';
    loadSecurityLogs();
  }
}

// ── DOMContentLoaded ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const btnAudit   = document.getElementById('tab-audit');
  const btnSess    = document.getElementById('tab-sessions');
  const btnSec     = document.getElementById('tab-security');
  const toggleBtn  = document.getElementById('btn-toggle-filter');
  const auditPanel = document.getElementById('audit-filter-panel');
  const sessPanel  = document.getElementById('session-filter-panel');
  const secPanel   = document.getElementById('security-filter-panel');

  // Tab buttons
  if (btnAudit) btnAudit.addEventListener('click', () => switchTo('audit'));
  if (btnSess)  btnSess.addEventListener('click',  () => switchTo('sessions'));
  if (btnSec)   btnSec.addEventListener('click',   () => switchTo('security'));

  // Filter toggle
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const panel = currentTab === 'audit' ? auditPanel : currentTab === 'sessions' ? sessPanel : secPanel;
      if (!panel) return;
      const isOpen = panel.classList.toggle('open');
      toggleBtn.textContent = (isOpen ? '\u25B2' : '\u25BC') + ' Filter';
    });
  }

  // ── Audit filter inputs ──
  ['audit-filter-ts-from', 'audit-filter-ts-to', 'audit-filter-admin', 'audit-filter-action'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderAuditRows);
  });

  document.getElementById('audit-filter-reset')?.addEventListener('click', () => {
    ['audit-filter-ts-from', 'audit-filter-ts-to', 'audit-filter-admin', 'audit-filter-action']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    renderAuditRows();
  });

  // ── Session filter inputs ──
  ['sess-filter-start-from', 'sess-filter-start-to', 'sess-filter-end-from', 'sess-filter-end-to',
   'sess-filter-peer-ip', 'sess-filter-peer-name', 'sess-filter-app'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderSessionRows);
  });

  document.getElementById('sess-filter-reset')?.addEventListener('click', () => {
    ['sess-filter-start-from', 'sess-filter-start-to', 'sess-filter-end-from', 'sess-filter-end-to',
     'sess-filter-peer-ip', 'sess-filter-peer-name', 'sess-filter-app']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    renderSessionRows();
  });

  // ── Security filter inputs ──
  ['security-filter-ts-from', 'security-filter-ts-to', 'security-filter-event', 'security-filter-interface', 'security-filter-peer-name'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderSecurityRows);
  });

  document.getElementById('security-filter-reset')?.addEventListener('click', () => {
    ['security-filter-ts-from', 'security-filter-ts-to', 'security-filter-event', 'security-filter-interface', 'security-filter-peer-name']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    renderSecurityRows();
  });

  // Initial load
  switchTo('audit');
});