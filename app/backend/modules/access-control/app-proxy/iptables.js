const { run, tryRun } = require('../../../common/utils');

function redirectArgs(destIp, destPort, proxyPort) {
  return ['-t', 'nat', '-p', 'tcp', '-d', destIp, '--dport', String(destPort), '-j', 'REDIRECT', '--to-ports', String(proxyPort)];
}

function addRedirect(destIp, destPort, proxyPort) {
  const base = redirectArgs(destIp, destPort, proxyPort);
  if (tryRun('iptables', ['-t', 'nat', '-C', 'PREROUTING', ...base]).status === 0) return;
  run('iptables', ['-t', 'nat', '-A', 'PREROUTING', ...base]);
}

function delRedirect(destIp, destPort, proxyPort) {
  const base = redirectArgs(destIp, destPort, proxyPort);
  while (tryRun('iptables', ['-t', 'nat', '-D', 'PREROUTING', ...base]).status === 0) { /* remove all */ }
}

module.exports = { addRedirect, delRedirect };
