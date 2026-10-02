const fs = require('node:fs');
const http = require('node:http');

module.exports = function startListenerFixture() {
  const mode = process.env.RUNTIME_LISTENER_ADDRESS;
  let healthMode;
  let healthRequests = 0;
  const createServer = () => http.createServer((req, res) => {
    if (fs.existsSync('health-mode')) {
      const next = fs.readFileSync('health-mode', 'utf8');
      if (next !== healthMode) { healthMode = next; healthRequests = 0; }
      healthRequests++;
      fs.appendFileSync('health-requests', `${req.url}\n`);
      if (req.url !== '/api/auth/providers') { res.writeHead(404); res.end(); return; }
      if (healthMode === 'eventual' && healthRequests < 3) { res.writeHead(503); res.end('starting'); return; }
      res.setHeader('Content-Type', 'application/json');
      if (healthMode === 'wrong-providers') { res.end('{}'); return; }
      if (healthMode === 'hanging') { res.write('{'); return; }
      res.end(JSON.stringify({ 'admin-login': { id: 'admin-login', name: 'Admin', type: 'credentials',
        signinUrl: 'http://localhost/api/auth/signin/admin-login', callbackUrl: 'http://localhost/api/auth/callback/admin-login' } }));
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('owned-listener');
  });
  const save = (server, file) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, port: server.address().port }), { flag: 'wx' });
    fs.renameSync(`${file}.tmp`, file);
  };
  const server = createServer();
  if (mode === 'independent') {
    server.listen({ port: 0, host: '::', ipv6Only: true }, () => {
      const port = server.address().port;
      setTimeout(() => {
        const ipv4 = createServer();
        ipv4.listen({ port, host: '0.0.0.0' }, () => save(ipv4, 'listener.json'));
      }, 100);
    });
    return;
  }
  server.listen({ port: 0, host: mode, ipv6Only: false }, () => save(server, 'listener.json'));
  let rebinding = false;
  setInterval(() => {
    if (!rebinding && fs.existsSync('listener-rebind')) {
      rebinding = true;
      const port = server.address().port;
      server.close(() => setTimeout(() => {
        server.listen({ port, host: mode, ipv6Only: false }, () => save(server, 'listener-rebound.json'));
      }, 100));
    }
  }, 20);
};
