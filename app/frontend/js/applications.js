let allApplications = [];

const ICON_DISABLE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0-.708-.708L8 7.293 5.354 4.646z"/></svg>';
const ICON_ENABLE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M10.97 4.97a.235.235 0 0 0-.02.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-1.071-1.05z"/></svg>';
const ICON_EDIT = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/></svg>';
const ICON_DELETE = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>';

const METHOD_OPTS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

function parsePolicyField(app) {
  const raw = app.policy_json != null ? app.policy_json : app.policy;
  if (raw == null || raw === '') return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function policyLabel(app) {
  const p = parsePolicyField(app);
  if (!p) return '—';
  const parts = [];
  if (p.print === false) parts.push('no print');
  if (p.clipboard === false) parts.push('no clipboard');
  if (p.download === false) parts.push('no download');
  if (p.allowed_methods && p.allowed_methods.length) parts.push(p.allowed_methods.join(','));
  return parts.length ? parts.join('; ') : 'on';
}

function readPolicyForm(prefix) {
  const enabled = document.getElementById(`${prefix}-policy-enabled`)?.checked;
  if (!enabled) return null;
  const methods = [];
  METHOD_OPTS.forEach((m) => {
    const el = document.getElementById(`${prefix}-method-${m}`);
    if (el && el.checked) methods.push(m);
  });
  if (!methods.length) {
    alert('Select at least one allowed HTTP method');
    return undefined;
  }
  return {
    print: !document.getElementById(`${prefix}-disable-print`)?.checked,
    clipboard: !document.getElementById(`${prefix}-disable-clipboard`)?.checked,
    download: !document.getElementById(`${prefix}-disable-download`)?.checked,
    allowed_methods: methods
  };
}

function fillPolicyForm(prefix, app) {
  const p = parsePolicyField(app);
  const on = !!p;
  document.getElementById(`${prefix}-policy-enabled`).checked = on;
  document.getElementById(`${prefix}-disable-print`).checked = on && p.print === false;
  document.getElementById(`${prefix}-disable-clipboard`).checked = on && p.clipboard === false;
  document.getElementById(`${prefix}-disable-download`).checked = on && p.download === false;
  const methods = on && Array.isArray(p.allowed_methods) ? p.allowed_methods : ['GET', 'HEAD', 'POST'];
  METHOD_OPTS.forEach((m) => {
    const el = document.getElementById(`${prefix}-method-${m}`);
    if (el) el.checked = methods.includes(m);
  });
  document.getElementById(`${prefix}-backend-host`).value = app.backend_host || '127.0.0.1';
  document.getElementById(`${prefix}-backend-port`).value = app.backend_port != null ? app.backend_port : '';
}

function readBackendFields(prefix) {
  return {
    backend_host: document.getElementById(`${prefix}-backend-host`)?.value.trim() || '127.0.0.1',
    backend_port: document.getElementById(`${prefix}-backend-port`)?.value.trim() || ''
  };
}

function renderApplicationsTable() {
  const tbody = document.getElementById('applications-tbody');
  tbody.innerHTML = '';
  allApplications.forEach((app) => {
    const enabled = parseInt(app.status, 10) !== 0;
    const tr = document.createElement('tr');
    let actions = '';
    if (enabled) {
      actions += `<button class="btn-icon" title="Disable" data-action="disable" data-id="${app.id}">${ICON_DISABLE}</button>`;
    } else {
      actions += `<button class="btn-icon" title="Enable" data-action="enable" data-id="${app.id}">${ICON_ENABLE}</button>`;
    }
    actions += `<button class="btn-icon" title="Edit" data-action="edit" data-id="${app.id}">${ICON_EDIT}</button>`;
    actions += `<button class="btn-icon" title="Delete" data-action="delete" data-id="${app.id}">${ICON_DELETE}</button>`;
    tr.innerHTML = `
      <td>${app.name}</td>
      <td>${app.type}</td>
      <td>${app.IP}</td>
      <td>${app.port}</td>
      <td>${policyLabel(app)}</td>
      <td>${enabled ? 'Enabled' : 'Disabled'}</td>
      <td class="actions-cell">${actions}</td>
    `;
    tr.querySelectorAll('.btn-icon').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        if (action === 'enable') enableApplication(id);
        else if (action === 'disable') disableApplication(id);
        else if (action === 'edit') openEditApplicationModal(id);
        else if (action === 'delete') deleteApplication(id);
      });
    });
    tbody.appendChild(tr);
  });
}

async function loadApplications() {
  try {
    const res = await fetch('/api/applications');
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load applications');
      return;
    }
    allApplications = data.applications || [];
    renderApplicationsTable();
  } catch (e) {
    alert(e.message || 'Error loading applications');
  }
}

function resetPolicyForm(prefix) {
  document.getElementById(`${prefix}-policy-enabled`).checked = false;
  document.getElementById(`${prefix}-disable-print`).checked = true;
  document.getElementById(`${prefix}-disable-clipboard`).checked = true;
  document.getElementById(`${prefix}-disable-download`).checked = true;
  ['GET', 'HEAD', 'POST'].forEach((m) => {
    const el = document.getElementById(`${prefix}-method-${m}`);
    if (el) el.checked = true;
  });
  ['PUT', 'PATCH', 'DELETE'].forEach((m) => {
    const el = document.getElementById(`${prefix}-method-${m}`);
    if (el) el.checked = false;
  });
  document.getElementById(`${prefix}-backend-host`).value = '127.0.0.1';
  document.getElementById(`${prefix}-backend-port`).value = '';
}

function openEditApplicationModal(id) {
  const app = allApplications.find((a) => String(a.id) === String(id));
  if (!app) return;
  document.getElementById('edit-app-id').value = app.id;
  document.getElementById('edit-app-name').value = app.name || '';
  document.getElementById('edit-app-type').value = app.type || '';
  document.getElementById('edit-app-ip').value = app.IP || '';
  document.getElementById('edit-app-port').value = app.port || '';
  fillPolicyForm('edit', app);
  document.getElementById('edit-app-modal').classList.add('open');
}

function closeEditApplicationModal() {
  document.getElementById('edit-app-modal')?.classList.remove('open');
}

function openCreateApplicationModal() {
  document.getElementById('create-application-form')?.reset();
  resetPolicyForm('create');
  document.getElementById('create-app-modal')?.classList.add('open');
}

function closeCreateApplicationModal() {
  document.getElementById('create-app-modal')?.classList.remove('open');
}

async function enableApplication(id) {
  const res = await fetch(`/api/applications/${id}/enable`, { method: 'POST' });
  const data = await res.json();
  if (data.success) loadApplications();
  else alert(data.error || 'Cannot enable application');
}

async function disableApplication(id) {
  const res = await fetch(`/api/applications/${id}/disable`, { method: 'POST' });
  const data = await res.json();
  if (data.success) loadApplications();
  else alert(data.error || 'Cannot disable application');
}

async function deleteApplication(id) {
  const app = allApplications.find((a) => String(a.id) === String(id));
  if (!app || !confirm(`Delete application "${app.name}"?`)) return;
  const res = await fetch(`/api/applications/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.success) loadApplications();
  else alert(data.error || 'Cannot delete application');
}

document.addEventListener('DOMContentLoaded', () => {
  loadApplications();

  document.getElementById('btn-add-application')?.addEventListener('click', openCreateApplicationModal);

  document.getElementById('create-application-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('app-name').value.trim();
    const type = document.getElementById('app-type').value.trim();
    const IP = document.getElementById('app-ip').value.trim();
    const port = parseInt(document.getElementById('app-port').value, 10);
    if (!name || !type || !IP || !port) return;

    const policy = readPolicyForm('create');
    if (policy === undefined) return;
    const backend = readBackendFields('create');

    const res = await fetch('/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, IP, port, policy, ...backend })
    });
    const data = await res.json();
    if (data.success) {
      closeCreateApplicationModal();
      loadApplications();
    } else {
      alert(data.error || 'Cannot create application');
    }
  });

  document.getElementById('create-app-cancel')?.addEventListener('click', closeCreateApplicationModal);
  document.getElementById('create-app-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'create-app-modal') closeCreateApplicationModal();
  });

  document.getElementById('edit-application-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-app-id').value;
    const name = document.getElementById('edit-app-name').value.trim();
    const type = document.getElementById('edit-app-type').value.trim();
    const IP = document.getElementById('edit-app-ip').value.trim();
    const port = parseInt(document.getElementById('edit-app-port').value, 10);
    if (!id || !name || !type || !IP || !port) return;

    const policy = readPolicyForm('edit');
    if (policy === undefined) return;
    const backend = readBackendFields('edit');

    const res = await fetch(`/api/applications/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, IP, port, policy, ...backend })
    });
    const data = await res.json();
    if (data.success) {
      closeEditApplicationModal();
      loadApplications();
    } else {
      alert(data.error || 'Cannot update application');
    }
  });

  document.getElementById('edit-app-cancel')?.addEventListener('click', closeEditApplicationModal);
  document.getElementById('edit-app-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'edit-app-modal') closeEditApplicationModal();
  });
});
