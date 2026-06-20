import http from 'node:http';

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/posts') {
    res.end('Hello from POSTS instance 1!');
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

server.listen(8091, () => {
  console.log('Posts backend instance 1 running on :8091');
});
