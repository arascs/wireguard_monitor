const { spawnSync } = require('child_process');
const { run, tryRun } = require('../../../common/utils');

const IPTABLES_COMMENT = 'VPN access rules';
const LOG_PREFIX = 'Blocked by VPN management: ';

function shellQuote(arg) {
  const s = String(arg);
  if (/^[a-zA-Z0-9._/:+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function resolveSourceIps(connection, rule) {
  if (rule.source_type === 'site') {
    const [rows] = await connection.execute(
      'SELECT site_allowedIPs FROM sites WHERE id = ?',
      [rule.source_value]
    );
    const ips = [];
    if (rows.length && rows[0].site_allowedIPs) {
      rows[0].site_allowedIPs.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).forEach((ip) => ips.push(ip));
    }
    return { type: 'ip', sources: ips };
  }
  if (rule.source_type === 'device') {
    const [devices] = await connection.execute(
      'SELECT allowed_ips FROM devices WHERE id = ?',
      [rule.source_value]
    );
    const ips = [];
    if (devices.length && devices[0].allowed_ips) {
      devices[0].allowed_ips.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).forEach((ip) => ips.push(ip));
    }
    return { type: 'ip', sources: ips };
  }
  if (rule.source_type === 'interface') {
    return { type: 'interface', iface: rule.source_value };
  }
  if (rule.source_type === 'all') {
    return { type: 'all' };
  }
  return { type: 'ip', sources: [] };
}

async function resolveDestinations(connection, rule) {
  if (rule.app_ip && rule.app_port) {
    return [{ destIp: rule.app_ip, destPort: rule.app_port }];
  }
  if (rule.application_id) {
    const [rows] = await connection.execute(
      'SELECT IP, port FROM applications WHERE id = ?',
      [rule.application_id]
    );
    if (rows.length && rows[0].IP && rows[0].port) {
      return [{ destIp: String(rows[0].IP).trim(), destPort: rows[0].port }];
    }
  }
  return [];
}

function resolveChain(destIp) {
  const r = spawnSync('ip', ['route', 'get', destIp], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').includes('local') ? 'INPUT' : 'FORWARD';
}

function commentArgs() {
  return ['-m', 'comment', '--comment', IPTABLES_COMMENT];
}

function destTail(destIp, destPort) {
  return ['-d', destIp, '-p', 'tcp', '--dport', String(destPort)];
}

function deleteArgs(chain, matchPrefix, isBlock) {
  const comment = commentArgs();
  if (isBlock) {
    return [
      ['-D', chain, ...matchPrefix, ...comment, '-j', 'DROP'],
      ['-D', chain, ...matchPrefix, ...comment, '-j', 'LOG', '--log-prefix', LOG_PREFIX]
    ];
  }
  return [['-D', chain, ...matchPrefix, ...comment, '-j', 'ACCEPT']];
}

function applyMatch(insertAction, chain, matchPrefix, isBlock) {
  const comment = commentArgs();
  if (isBlock) {
    run('iptables', [insertAction, chain, ...matchPrefix, ...comment, '-j', 'LOG', '--log-prefix', LOG_PREFIX]);
    run('iptables', [insertAction, chain, ...matchPrefix, ...comment, '-j', 'DROP']);
  } else {
    run('iptables', [insertAction, chain, ...matchPrefix, ...comment, '-j', 'ACCEPT']);
  }
}

function forEachMatch(source, destIp, destPort, fn) {
  const tail = destTail(destIp, destPort);
  if (source.type === 'all') {
    fn(tail);
  } else if (source.type === 'ip') {
    source.sources.forEach((src) => fn(['-s', src, ...tail]));
  } else if (source.type === 'interface') {
    fn(['-i', source.iface, ...tail]);
  }
}

async function processRuleIptables(insertAction, connection, rule) {
  const isBlock = rule.status >= 2;
  const source = await resolveSourceIps(connection, rule);
  if (source.type === 'ip' && !source.sources.length) {
    throw new Error('No source IPs resolved for rule');
  }
  if (source.type === 'interface' && !source.iface) {
    throw new Error('No interface specified for rule');
  }
  const destinations = await resolveDestinations(connection, rule);
  if (!destinations.length) {
    throw new Error('No destination applications resolved for rule');
  }

  const deleteArgLists = [];
  for (const dest of destinations) {
    const chain = resolveChain(dest.destIp);
    if (!chain) {
      throw new Error(`Failed to determine route for destination IP ${dest.destIp}`);
    }
    forEachMatch(source, dest.destIp, dest.destPort, (matchPrefix) => {
      if (insertAction) applyMatch(insertAction, chain, matchPrefix, isBlock);
      deleteArgs(chain, matchPrefix, isBlock).forEach((args) => deleteArgLists.push(args));
    });
  }
  return deleteArgLists;
}

function applyRuleIptables(insertAction, connection, rule) {
  return processRuleIptables(insertAction, connection, rule);
}

function buildDeleteArgLists(connection, rule) {
  return processRuleIptables(null, connection, rule);
}

function runDeleteCommands(deleteArgLists) {
  deleteArgLists.forEach((args) => {
    tryRun('iptables', args);
  });
}

function deleteCommandsShell(deleteArgLists) {
  return deleteArgLists
    .map((args) => `iptables ${args.map(shellQuote).join(' ')}`)
    .join('; ');
}

module.exports = {
  applyRuleIptables,
  buildDeleteArgLists,
  runDeleteCommands,
  deleteCommandsShell
};
