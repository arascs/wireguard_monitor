async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load users');
      return;
    }
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '';
    (data.users || []).forEach((user) => {
      const tr = document.createElement('tr');

      let createText = '';
      if (user.create_day) {
        const epochSeconds = parseInt(user.create_day, 10);
        if (!Number.isNaN(epochSeconds)) {
          const date = new Date(epochSeconds * 1000);
          createText = date.toLocaleDateString('vi-VN') + ' ' + date.toLocaleTimeString('vi-VN');
        }
      }

      let expireText = '';
      if (user.expire_day) {
        const epochSeconds = parseInt(user.expire_day, 10);
        if (!Number.isNaN(epochSeconds)) {
          const date = new Date(epochSeconds * 1000);
          expireText = date.toLocaleDateString('vi-VN') + ' ' + date.toLocaleTimeString('vi-VN');
        }
      }
      tr.innerHTML = `
        <td>${user.username}</td>
        <td>${createText}</td>
        <td>${expireText}</td>
        <td><button class="btn-delete" onclick="deleteUser('${user.username}')">Delete</button></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    alert(e.message || 'Error loading users');
  }
}

async function deleteUser(username) {
  if (!confirm(`Are you sure you want to delete user "${username}"? This will also disable all their devices.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data.success) {
      loadUsers();
      alert('User deleted successfully');
    } else {
      alert(data.error || 'Cannot delete user');
    }
  } catch (e) {
    alert(e.message || 'Error deleting user');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadUsers();

  const form = document.getElementById('create-user-form');

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('user-username').value.trim();
      const password = document.getElementById('user-password').value;
      const expireDay = document.getElementById('user-expire').value;
      if (!username || !password) {
        return;
      }

      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, expireDay })
      });
      const data = await res.json();
      if (data.success) {
        form.reset();
        loadUsers();
        alert('User created successfully');
      } else {
        alert(data.error || 'Cannot create user');
      }
    });
  }
});

