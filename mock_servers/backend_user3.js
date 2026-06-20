import http from 'node:http';

// Instance 3 deliberately responds slowly to exercise latency-aware strategies.
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/users') {
    setTimeout(() => {
      res.end('Hello from USERS instance 3!');
    }, 50);
    return;
  }
  if (path === '/health') {
    res.writeHead(200);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(8083, () => {
  console.log('Users backend instance 3 running on :8083');
});
