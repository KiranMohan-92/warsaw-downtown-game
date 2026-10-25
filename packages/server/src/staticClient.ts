import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/**
 * Types worth compressing on the wire: text, glTF JSON/geometry (meshopt output still shrinks
 * ~40 % under brotli), HDR, WASM. WebP/JPEG/PNG/OGG are already compressed and go out as-is.
 */
const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.svg',
  '.wasm',
  '.glb',
  '.gltf',
  '.bin',
  '.hdr',
  '.txt',
]);
/** Below this, compression isn't worth a round of CPU. */
const MIN_COMPRESS = 1024;

type Encoding = 'br' | 'gzip';
/** Compressed bodies by file, keyed on its identity (size + mtime), so edits invalidate them. */
const compressed = new Map<string, { key: string; body: Promise<Uint8Array> }>();

/**
 * Best encoding the client accepts (RFC 9110 §12.5.3): an encoding's own q beats `*`, so an
 * explicit `q=0` always excludes it and `*` only speaks for encodings not listed. Highest q
 * wins, brotli breaks ties. A bare `*` stays conservative and means gzip (clients that send only
 * a wildcard predate brotli). `null` = identity.
 */
export function pickEncoding(accept: string | null): Encoding | null {
  if (!accept) return null;
  const weights = new Map<string, number>();
  for (const part of accept.toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const m = /^q\s*=\s*([0-9.]+)$/.exec(param);
      if (m) q = Number(m[1]);
    }
    weights.set(name, Number.isFinite(q) ? q : 0);
  }
  const br = weights.get('br') ?? 0;
  const gzip = weights.get('gzip') ?? weights.get('*') ?? 0;
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return null;
}

function compressedBody(
  filename: string,
  identity: string,
  encoding: Encoding,
  raw: () => Promise<Buffer>,
): Promise<Uint8Array> {
  const id = `${filename}|${encoding}`;
  const hit = compressed.get(id);
  if (hit?.key === identity) return hit.body;
  const body = raw().then(
    async (data) =>
      new Uint8Array(
        encoding === 'br'
          ? await brotli(data, {
              params: {
                [zlib.BROTLI_PARAM_QUALITY]: 9,
                [zlib.BROTLI_PARAM_SIZE_HINT]: data.length,
              },
            })
          : await gzipAsync(data, { level: 9 }),
      ),
  );
  compressed.set(id, { key: identity, body });
  body.catch(() => compressed.delete(id)); // a failed read is retried next time
  return body;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Only the built client is public. Query-only routes need no catch-all HTML fallback. */
export async function staticClientResponse(root: string, request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const response = errorResponse(405, 'Method not allowed');
    response.headers.set('allow', 'GET, HEAD');
    return response;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return errorResponse(400, 'Invalid path');
  }
  const parts = pathname.split('/');
  if (pathname.includes('\0') || pathname.includes('\\') || parts.includes('..')) {
    return errorResponse(400, 'Invalid path');
  }
  if (parts.some((part) => part.startsWith('.'))) return errorResponse(404, 'Not found');

  try {
    const publicRoot = await realpath(root);
    const filename = await realpath(
      resolve(publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`),
    );
    if (!filename.startsWith(`${publicRoot}${sep}`)) return errorResponse(404, 'Not found');
    const info = await stat(filename);
    if (!info.isFile()) return errorResponse(404, 'Not found');
    const fingerprinted = /^\/assets\/[^/]+-[\w-]{8,}\.[\w.]+$/.test(pathname);
    const ext = extname(filename);
    const headers: Record<string, string> = {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': fingerprinted ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      // `no-cache` means "revalidate": without a validator every visit re-downloads everything.
      etag: `W/"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`,
    };
    const compressible = COMPRESSIBLE.has(ext) && info.size >= MIN_COMPRESS;
    if (compressible) headers.vary = 'accept-encoding';
    const match = request.headers.get('if-none-match');
    if (match && match.split(',').some((tag) => tag.trim() === headers.etag)) {
      delete headers['content-type'];
      return new Response(null, { status: 304, headers });
    }
    const encoding = compressible ? pickEncoding(request.headers.get('accept-encoding')) : null;
    if (encoding) {
      const body = await compressedBody(filename, `${info.size}|${info.mtimeMs}`, encoding, () =>
        readFile(filename),
      );
      headers['content-encoding'] = encoding;
      headers['content-length'] = String(body.byteLength);
      return new Response(request.method === 'HEAD' ? null : body, { headers });
    }
    headers['content-length'] = String(info.size);
    return new Response(
      request.method === 'HEAD' ? null : new Uint8Array(await readFile(filename)),
      { headers },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR'].includes(String(error.code))
    ) {
      return errorResponse(404, 'Not found');
    }
    console.error('[server] static client read failed', error);
    return errorResponse(500, 'Could not load the client');
  }
}
