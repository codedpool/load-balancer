// Spawns all mock backend servers as child processes.
// Run with: npm run mock   (or: node mock_servers/start.js)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const servers = [
  'backend_user1.js',
  'backend_user2.js',
  'backend_user3.js',
  'backend_post1.js',
  'backend_post2.js',
];

console.log('Starting backend servers...');

const children = servers.map((file) => {
  const child = spawn(process.execPath, [join(__dirname, file)], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    console.log(`${file} exited with code ${code}`);
  });
  return child;
});

function shutdown() {
  for (const child of children) {
    child.kill();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
