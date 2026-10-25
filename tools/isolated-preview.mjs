// Run this checkout beside the original without sharing ports or game sessions.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const host = '127.0.0.1';
const clientPort = 5174;
const gamePort = 2568;

async function available(port) {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, host, resolve);
  });
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
}

// Refuse occupied ports; never stop someone else's preview.
await available(clientPort);
await available(gamePort);

const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

function run(cwd, entry, args, env) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: fileURLToPath(new URL(cwd, root)),
    env: { ...process.env, ...env },
    stdio: 'inherit',
    windowsHide: true,
  });
  children.push(child);
  child.on('error', (error) => {
    console.error(error);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stop(code || 1);
  });
}

run('packages/server/', 'node_modules/tsx/dist/cli.mjs', ['src/main.ts'], {
  GAME_HOST: host,
  GAME_PORT: String(gamePort),
  NODE_ENV: 'development',
});
run(
  'packages/client/',
  'node_modules/vite/bin/vite.js',
  ['--host', host, '--port', String(clientPort), '--strictPort'],
  { VITE_SERVER_URL: `http://${host}:${gamePort}` },
);
console.log(`Isolated preview: http://${host}:${clientPort}/ (game server ${gamePort})`);
