const http = require('http');
const { parsePolicy, buildInjectScript } = require('./policyScript');
const { addRedirect, delRedirect } = require('./iptables');

const PROXY_BASE = parseInt(process.env.APP_PROXY_PORT_BASE || '19000', 10);
const active = new Map();

function proxyPortFor(appId) {
  return PROXY_BASE + parseInt(appId, 10);
}

function entryKey(row, policy) {
  return JSON.stringify({
    ip: row.IP,
    port: row.port,
    backend_host: row.backend_host || '127.0.0.1',
    backend_port: row.backend_port || row.port,
    policy
  });
}

function proxyRequest(req, res, backendHost, backendPort, injectScript, allowed) {
  if (!allowed.has(req.method)) {
    res.writeHead(405, { Allow: [...allowed].join(', '), 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const headers = { ...req.headers, host: `${backendHost}:${backendPort}` };
  const upstream = http.request(
    {
      hostname: backendHost,
      port: backendPort,
      path: req.url,
      method: req.method,
      headers
    },
    (upRes) => {
      const ct = upRes.headers['content-type'] || '';
      if (!injectScript || !ct.includes('text/html')) {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        return;
      }

      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        if (body.includes('</body>')) {
          body = body.replace('</body>', `${injectScript}</body>`);
        } else {
          body += injectScript;
        }
        const outHeaders = { ...upRes.headers };
        delete outHeaders['content-length'];
        delete outHeaders['transfer-encoding'];
        res.writeHead(upRes.statusCode, outHeaders);
        res.end(body);
      });
    }
  );

  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    }
  });

  req.pipe(upstream);
}

function stopApp(appId) {
  const entry = active.get(appId);
  if (!entry) return;
  if (entry.server) entry.server.close();
  delRedirect(entry.destIp, entry.destPort, entry.proxyPort);
  active.delete(appId);
}

function startApp(row) {
  const policy = parsePolicy(row.policy_json);
  if (!policy) return;

  const appId = row.id;
  const destIp = String(row.IP).trim();
  const destPort = parseInt(row.port, 10);
  const backendHost = String(row.backend_host || '127.0.0.1').trim();
  const backendPort = parseInt(row.backend_port, 10) || destPort;
  const proxyPort = proxyPortFor(appId);
  const key = entryKey(row, policy);

  const existing = active.get(appId);
  if (existing && existing.key === key) return;
  if (existing) stopApp(appId);

  const allowed = new Set(policy.allowed_methods);
  const injectScript = buildInjectScript(policy);

  const server = http.createServer((req, res) => {
    proxyRequest(req, res, backendHost, backendPort, injectScript, allowed);
  });

  server.on('error', (e) => {
    console.error(`[app-proxy] app ${appId} listen error:`, e.message);
  });

  server.listen(proxyPort, '0.0.0.0', () => {
    try {
      addRedirect(destIp, destPort, proxyPort);
      active.set(appId, { server, proxyPort, destIp, destPort, key });
      console.log(`[app-proxy] app ${appId} ${destIp}:${destPort} -> :${proxyPort} -> ${backendHost}:${backendPort}`);
    } catch (e) {
      server.close();
      console.error(`[app-proxy] app ${appId} iptables error:`, e.message);
    }
  });
}

async function syncAppProxies(mysql, dbConfig) {
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(
      'SELECT id, IP, port, status, policy_json, backend_host, backend_port FROM applications'
    );
    const want = new Set();
    for (const row of rows) {
      if (parseInt(row.status, 10) !== 1 || !row.policy_json) continue;
      want.add(row.id);
      startApp(row);
    }
    for (const appId of [...active.keys()]) {
      if (!want.has(appId)) stopApp(appId);
    }
  } finally {
    if (conn) await conn.end();
  }
}

module.exports = { syncAppProxies, stopApp, proxyPortFor };
