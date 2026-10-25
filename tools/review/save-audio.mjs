/** One-shot local artifact receiver for the self-authored OfflineAudioContext review page. */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('../gameplay-captures/2026-10-07/market-quality');
const destination = resolve(directory, 'market-gunfire-before-after.wav');
const server = createServer(async (request, response) => {
  if (request.headers.origin !== 'http://127.0.0.1:5174' || request.url !== '/capture') {
    response.writeHead(403).end();
    return;
  }
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5174');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
      response.writeHead(400).end();
      return;
    }
    await mkdir(directory, { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ path: destination, bytes: bytes.length }));
    console.log(JSON.stringify({ saved: destination, bytes: bytes.length }));
    server.close();
  } catch (error) {
    response.writeHead(500).end();
    console.error(error.message);
    server.close();
  }
});
server.listen(5193, '127.0.0.1', () => console.log('Local WAV receiver ready on 127.0.0.1:5193'));
