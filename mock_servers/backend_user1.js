import http from 'node:http';

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/users') {
    res.end('Hello from USERS instance 1!');
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

server.listen(8081, () => {
  console.log('Users backend instance 1 running on :8081');
});
