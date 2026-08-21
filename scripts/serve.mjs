#!/usr/bin/env node
/** Minimal static server for local development of the site itself. */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4173;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
  const target = resolve(ROOT, rel);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const s = await stat(target);
    if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': s.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
