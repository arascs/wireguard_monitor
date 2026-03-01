async function loadUsersForRules() {
  const select = document.getElementById('rule-user-id');
  if (!select) return;
  select.innerHTML = '';
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    if (!data.success) return;
    (data.users || []).forEach((user) => {
      const opt = document.createElement('option');
      opt.value = user.id;
      opt.textContent = user.username;
      select.appendChild(opt);
    });
  } catch (e) {
    // ignore
  }
}

async function loadApplicationsForRules() {
  const select = document.getElementById('rule-application-id');
  if (!select) return;
  select.innerHTML = '';
  try {
    const res = await fetch('/api/applications');
    const data = await res.json();
    if (!data.success) return;
    (data.applications || []).forEach((app) => {
      const opt = document.createElement('option');
      opt.value = app.id;
      opt.textContent = app.name;
      select.appendChild(opt);
    });
  } catch (e) {
    // ignore
  }
}

async function loadAccessRules() {
  const tbody = document.getElementById('rules-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  try {
    const res = await fetch('/api/access-rules');
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load access rules');
      return;
    }
    (data.rules || []).forEach((rule) => {
      const tr = document.createElement('tr');
      const statusText = rule.status === 1 ? 'On' : 'Off';
      const btnLabel = rule.status === 1 ? 'Disable' : 'Enable';
      tr.innerHTML = `
        <td>${rule.name}</td>
        <td>${rule.source_label}</td>
        <td>${rule.application_name || ''}</td>
        <td>${rule.action}</td>
        <td>${statusText}</td>
        <td><button data-id="${rule.id}" class="toggle-rule-btn">${btnLabel}</button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.toggle-rule-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const row = (data.rules || []).find((r) => String(r.id) === String(id));
        if (!row) return;
        const path =
          row.status === 1 ? `/api/access-rules/${id}/disable` : `/api/access-rules/${id}/enable`;
        const res2 = await fetch(path, { method: 'POST' });
        const d2 = await res2.json();
        if (d2.success) {
          loadAccessRules();
        } else {
          alert(d2.error || 'Cannot toggle rule');
        }
      });
    });
  } catch (e) {
    alert(e.message || 'Error loading access rules');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sourceTypeSelect = document.getElementById('rule-source-type');
  const userGroup = document.getElementById('rule-source-user-group');
  const ipGroup = document.getElementById('rule-source-ip-group');
  const form = document.getElementById('create-rule-form');

  if (sourceTypeSelect && userGroup && ipGroup) {
    sourceTypeSelect.addEventListener('change', () => {
      const v = sourceTypeSelect.value;
      if (v === 'user') {
        userGroup.style.display = 'block';
        ipGroup.style.display = 'none';
      } else {
        userGroup.style.display = 'none';
        ipGroup.style.display = 'block';
      }
    });
  }

  loadUsersForRules();
  loadApplicationsForRules();
  loadAccessRules();

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('rule-name').value.trim();
      const sourceType = document.getElementById('rule-source-type').value;
      const userId = document.getElementById('rule-user-id').value;
      const sourceIp = document.getElementById('rule-source-ip').value.trim();
      const applicationId = document.getElementById('rule-application-id').value;
      const action = document.getElementById('rule-action').value;

      if (!name || !sourceType || !applicationId || !action) {
        return;
      }
      if (sourceType === 'user' && !userId) {
        return;
      }
      if (sourceType === 'ip' && !sourceIp) {
        return;
      }

      const body = {
        name,
        sourceType,
        sourceUserId: sourceType === 'user' ? parseInt(userId, 10) : null,
        sourceIp: sourceType === 'ip' ? sourceIp : null,
        applicationId: parseInt(applicationId, 10),
        action
      };

      const res = await fetch('/api/access-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        form.reset();
        if (sourceTypeSelect) {
          sourceTypeSelect.value = 'user';
          userGroup.style.display = 'block';
          ipGroup.style.display = 'none';
        }
        loadAccessRules();
      } else {
        alert(data.error || 'Cannot create access rule');
      }
    });
  }
});

