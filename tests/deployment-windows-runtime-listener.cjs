const fs = require('node:fs');
const http = require('node:http');

module.exports = function startListenerFixture() {
  const mode = process.env.RUNTIME_LISTENER_ADDRESS;
  const createServer = () => http.createServer((req, res) => {
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
