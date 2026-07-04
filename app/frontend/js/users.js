let allUsers = [];

const ICON_EDIT = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/></svg>';
const ICON_DELETE = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>';

function formatEpoch(epoch) {
  if (!epoch) return '';
  const n = parseInt(epoch, 10);
  if (Number.isNaN(n)) return '';
  const d = new Date(n * 1000);
  return d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN');
}

function epochToDateInput(epoch) {
  if (!epoch) return '';
  const n = parseInt(epoch, 10);
  if (Number.isNaN(n)) return '';
  const d = new Date(n * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function renderUsersTable() {
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '';
  allUsers.forEach((user) => {
    const tr = document.createElement('tr');
    const actions = `
      <button class="btn-icon" title="Edit" data-action="edit" data-user="${encodeURIComponent(user.username)}">${ICON_EDIT}</button>
      <button class="btn-icon" title="Delete" data-action="delete" data-user="${encodeURIComponent(user.username)}">${ICON_DELETE}</button>
    `;
    tr.innerHTML = `
      <td>${user.username}</td>
      <td>${formatEpoch(user.create_day)}</td>
      <td>${formatEpoch(user.expire_day) || 'Never'}</td>
      <td class="actions-cell">${actions}</td>
    `;
    tr.querySelectorAll('.btn-icon').forEach((btn) => {
      btn.addEventListener('click', () => {
        const username = decodeURIComponent(btn.dataset.user);
        const action = btn.dataset.action;
        if (action === 'edit') openEditUserModal(username);
        else if (action === 'delete') deleteUser(username);
      });
    });
    tbody.appendChild(tr);
  });
}

async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load users');
      return;
    }
    allUsers = data.users || [];
    renderUsersTable();
  } catch (e) {
    alert(e.message || 'Error loading users');
  }
}

function openEditUserModal(username) {
  const user = allUsers.find((u) => u.username === username);
  if (!user) return;
  document.getElementById('edit-user-username').value = user.username;
  document.getElementById('edit-user-expire').value = epochToDateInput(user.expire_day);
  document.getElementById('edit-user-modal').classList.add('open');
}

function closeEditUserModal() {
  document.getElementById('edit-user-modal')?.classList.remove('open');
}

function openCreateUserModal() {
  document.getElementById('create-user-form')?.reset();
  document.getElementById('create-user-modal')?.classList.add('open');
}

function closeCreateUserModal() {
  document.getElementById('create-user-modal')?.classList.remove('open');
}

async function deleteUser(username) {
  if (!confirm(`Delete user "${username}"? This will also remove their devices.`)) return;
  const res = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.success) loadUsers();
  else alert(data.error || 'Cannot delete user');
}

document.addEventListener('DOMContentLoaded', () => {
  loadUsers();

  document.getElementById('btn-add-user')?.addEventListener('click', openCreateUserModal);

  document.getElementById('create-user-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('user-username').value.trim();
    const password = document.getElementById('user-password').value;
    const expireDay = document.getElementById('user-expire').value;
    if (!username || !password) return;

    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, expireDay })
    });
    const data = await res.json();
    if (data.success) {
      closeCreateUserModal();
      loadUsers();
    } else {
      alert(data.error || 'Cannot create user');
    }
  });

  document.getElementById('create-user-cancel')?.addEventListener('click', closeCreateUserModal);
  document.getElementById('create-user-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'create-user-modal') closeCreateUserModal();
  });

  document.getElementById('edit-user-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('edit-user-username').value;
    const expireDate = document.getElementById('edit-user-expire').value;
    const res = await fetch(`/api/users/${encodeURIComponent(username)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expireDate })
    });
    const data = await res.json();
    if (data.success) {
      closeEditUserModal();
      loadUsers();
    } else {
      alert(data.error || 'Cannot update user');
    }
  });

  document.getElementById('edit-user-cancel')?.addEventListener('click', closeEditUserModal);
  document.getElementById('edit-user-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'edit-user-modal') closeEditUserModal();
  });

  document.getElementById('btn-export-users')?.addEventListener('click', () => {
    const rows = allUsers.map((u) => [
      u.username,
      formatEpoch(u.create_day),
      formatEpoch(u.expire_day) || 'Never'
    ]);
    if (window.openExportModal) {
      window.openExportModal({
        title: 'Users List',
        filename: 'users_report',
        headers: ['Username', 'Create Day', 'Expire Day'],
        rows
      });
    }
  });
});
