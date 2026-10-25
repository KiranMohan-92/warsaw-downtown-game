import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickEncoding, staticClientResponse } from './staticClient.ts';

let fixture: string;
let root: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(process.cwd(), '.static-client-test-'));
  root = join(fixture, 'dist');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Warsaw Downtown</title>');
  await writeFile(join(root, 'assets', 'index-AbCd1234.js'), 'export const game = true;');
  await writeFile(join(root, 'manifest.json'), '{"version":1}');
  await writeFile(join(root, 'model.bin'), Buffer.alloc(64 * 1024, 7));
  await writeFile(join(root, 'photo.jpg'), Buffer.alloc(64 * 1024, 7));
  await writeFile(join(root, 'texture.webp'), Buffer.alloc(64 * 1024, 7));
  await writeFile(join(fixture, 'private.txt'), 'not public');
  // Directory junctions also work on Windows without symlink privileges.
  await symlink(fixture, join(root, 'escape'), 'junction');
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

function request(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<Response> {
  return staticClientResponse(
    root,
    new Request(`https://game.example${path}`, { method, headers }),
  );
}

describe('static client (without a listening server)', () => {
  it('serves room query links from the index with revalidation', async () => {
    const response = await request('/?room=ABC123');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('Warsaw Downtown');
  });

  it('caches fingerprinted assets, but revalidates public manifests', async () => {
    const script = await request('/assets/index-AbCd1234.js');
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toContain('immutable');
    const manifest = await request('/manifest.json');
    expect(manifest.headers.get('cache-control')).toBe('no-cache');
  });

  it('answers HEAD with the same headers and no body', async () => {
    const response = await request('/', 'HEAD');
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await response.text()).toBe('');
  });

  it('does not turn missing paths, directories or dotfiles into HTML', async () => {
    for (const path of ['/missing.js', '/not-a-client-route', '/assets', '/.env']) {
      expect((await request(path)).status).toBe(404);
    }
  });

  it('rejects malformed paths, traversal and symlinks outside the static root', async () => {
    for (const path of ['/%ZZ', '/%00', '/%2e%2e%2fprivate.txt', '/..%5cprivate.txt']) {
      expect((await request(path)).status).toBe(400);
    }
    expect((await request('/escape/private.txt')).status).toBe(404);
  });

  it('does not accept writes to static files', async () => {
    const response = await request('/', 'POST');
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('compresses geometry for clients that accept it, never JPEGs', async () => {
    const br = await request('/model.bin', 'GET', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('vary')).toBe('accept-encoding');
    const body = Buffer.from(await br.arrayBuffer());
    expect(Number(br.headers.get('content-length'))).toBe(body.length);
    expect(body.length).toBeLessThan(1024);
    expect(brotliDecompressSync(body).equals(Buffer.alloc(64 * 1024, 7))).toBe(true);
    const gz = await request('/model.bin', 'GET', { 'accept-encoding': 'gzip' });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).length).toBe(64 * 1024);
    const plain = await request('/model.bin');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(Number(plain.headers.get('content-length'))).toBe(64 * 1024);
    const jpg = await request('/photo.jpg', 'GET', { 'accept-encoding': 'br' });
    expect(jpg.headers.get('content-encoding')).toBeNull();
    // Shipped textures are WebP: typed for the browser's decoder, already compressed.
    const webp = await request('/texture.webp', 'GET', { 'accept-encoding': 'br' });
    expect(webp.headers.get('content-type')).toBe('image/webp');
    expect(webp.headers.get('content-encoding')).toBeNull();
    expect(Number(webp.headers.get('content-length'))).toBe(64 * 1024);
    const head = await request('/model.bin', 'HEAD', { 'accept-encoding': 'br' });
    expect(head.headers.get('content-length')).toBe(br.headers.get('content-length'));
  });

  it('picks brotli over gzip and honours q=0', () => {
    expect(pickEncoding('gzip, br')).toBe('br');
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding(null)).toBeNull();
  });

  it('an explicit q=0 excludes an encoding even when a wildcard accepts the rest (RFC 9110)', () => {
    expect(pickEncoding('gzip;q=0, *;q=1')).toBeNull();
    expect(pickEncoding('br;q=0, *')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip;q=0, *')).toBeNull();
    expect(pickEncoding('GZIP; Q=0, *')).toBeNull();
    expect(pickEncoding('gzip;q=0.000, *;q=0.5')).toBeNull();
    // The wildcard only covers what isn't listed, and `*;q=0` rejects everything unlisted.
    expect(pickEncoding('*;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('*;q=0')).toBeNull();
    expect(pickEncoding('*')).toBe('gzip');
    // identity says nothing about br/gzip.
    expect(pickEncoding('identity;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('identity, br;q=0.5')).toBe('br');
    // Higher q wins; brotli breaks ties.
    expect(pickEncoding('br;q=0.2, gzip;q=0.8')).toBe('gzip');
    expect(pickEncoding('br;q=0.8, gzip;q=0.8')).toBe('br');
    expect(pickEncoding('gzip;q=0.001, br;q=0')).toBe('gzip');
  });

  it('revalidates with an ETag: 304 without a body when unchanged', async () => {
    const first = await request('/model.bin', 'GET', { 'accept-encoding': 'br' });
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^W\/"/);
    const again = await request('/model.bin', 'GET', {
      'if-none-match': etag!,
      'accept-encoding': 'br',
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    const other = await request('/model.bin', 'GET', { 'if-none-match': 'W/"stale"' });
    expect(other.status).toBe(200);
  });
});
