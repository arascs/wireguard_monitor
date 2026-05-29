const FIREWALL_CHAINS = ['INPUT', 'OUTPUT', 'FORWARD'];

function parseKernelSemver(raw) {
  const s = String(raw || '').split('-')[0];
  const parts = s.split('.').map((p) => parseInt(p, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function cmpKernelSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function isSshRootLoginEnabled(info) {
  if (typeof info.sshPermitRootLoginRaw === 'string') {
    const v = info.sshPermitRootLoginRaw.trim().toLowerCase();
    return ['yes', 'prohibit-password', 'without-password'].includes(v);
  }
  return info.sshRootLogin === true;
}

function chainPolicyIsDrop(policies, chain) {
  if (!policies || typeof policies !== 'object') return false;
  return String(policies[chain] || '').trim().toUpperCase() === 'DROP';
}

function isFirewallDropOnAllChains(info) {
  const policies = info.firewallPolicies;
  if (policies && typeof policies === 'object' && !Array.isArray(policies)) {
    return FIREWALL_CHAINS.every((chain) => chainPolicyIsDrop(policies, chain));
  }
  return info.firewallActive === true;
}

function isUserExpired(expireDay) {
  if (expireDay == null || expireDay === '') return false;
  const exp = parseInt(expireDay, 10);
  if (Number.isNaN(exp)) return false;
  return exp < Math.floor(Date.now() / 1000);
}

module.exports = {
  parseKernelSemver,
  cmpKernelSemver,
  isSshRootLoginEnabled,
  isFirewallDropOnAllChains,
  isUserExpired
};
