import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

type Handler = (params: Record<string, string>, query: URLSearchParams, req: IncomingMessage, body: any, res: ServerResponse) => unknown | Promise<unknown>;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp4': 'video/mp4',
};

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
/** Valore restituito da un handler che ha già scritto la risposta da sé. */
export const HANDLED = Symbol('handled');

/** Server HTTP minimale: rotte JSON, file statici, file con Range (video) e proxy verso go2rtc. */
export class MiniServer {
  private routes: { method: string; parts: string[]; handler: Handler }[] = [];
  private proxies: { prefix: string; port: number; guard?: () => string | null }[] = [];

  constructor(private publicDir: string) {}

  get(path: string, handler: Handler) { this.routes.push({ method: 'GET', parts: path.split('/').filter(Boolean), handler }); }
  post(path: string, handler: Handler) { this.routes.push({ method: 'POST', parts: path.split('/').filter(Boolean), handler }); }
  /** Inoltra /prefix/* a 127.0.0.1:port/* (anche WebSocket). */
  proxy(prefix: string, port: number, guard?: () => string | null) { this.proxies.push({ prefix, port, guard }); }

  private match(method: string, pathname: string) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (r.parts.every((p, i) => p.startsWith(':') ? (params[p.slice(1)] = decodeURIComponent(parts[i]), true) : p === parts[i])) return { handler: r.handler, params };
    }
    return null;
  }

  private async serveStatic(pathname: string, res: ServerResponse) {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(this.publicDir, rel));
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Non trovato'); }
  }

  private findProxy(pathname: string) {
    return this.proxies.find(p => pathname === p.prefix || pathname.startsWith(p.prefix + '/'));
  }

  private forward(req: IncomingMessage, res: ServerResponse, p: { prefix: string; port: number }) {
    const path = (req.url ?? '/').slice(p.prefix.length) || '/';
    const up = httpRequest({ host: '127.0.0.1', port: p.port, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${p.port}` } }, r => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('go2rtc non raggiungibile'); });
    req.pipe(up);
    res.on('close', () => up.destroy());
  }

  listen(port: number) {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const px = this.findProxy(url.pathname);
      if (px) {
        const denied = px.guard?.();
        if (denied) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(denied); return; }
        return this.forward(req, res, px);
      }
      if (method !== 'GET' && method !== 'POST') { res.writeHead(405); res.end(); return; }
      const m = this.match(method, url.pathname);
      if (!m) {
        if (method === 'GET') return this.serveStatic(url.pathname, res);
        res.writeHead(404); res.end(); return;
      }
      try {
        let body: any = undefined;
        if (method === 'POST') {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const c of req) { size += c.length; if (size > 65536) throw new HttpError(413, 'Richiesta troppo grande'); chunks.push(c); }
          try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw new HttpError(400, 'JSON non valido'); }
        }
        const data = await m.handler(m.params, url.searchParams, req, body, res);
        if (data === HANDLED) return;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      } catch (err) {
        if (res.headersSent) { res.end(); return; }
        const status = err instanceof HttpError ? err.status : 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
    // WebSocket della diretta: si inoltra il socket così com'è
    server.on('upgrade', (req, sock, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = this.findProxy(url.pathname);
      if (!p || p.guard?.()) { sock.destroy(); return; }
      const up = connect(p.port, '127.0.0.1', () => {
        const path = (req.url ?? '/').slice(p.prefix.length) || '/';
        const headers = Object.entries(req.headers).filter(([k]) => k !== 'host').map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        up.write(`${req.method} ${path} HTTP/1.1\r\nhost: 127.0.0.1:${p.port}\r\n${headers.join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(sock); sock.pipe(up);
      });
      const close = () => { up.destroy(); sock.destroy(); };
      up.on('error', close); sock.on('error', close); up.on('close', close); sock.on('close', close);
    });
    return new Promise<void>(r => server.listen(port, '0.0.0.0', r));
  }
}

/** Invia un file dentro `root` con supporto Range, necessario per scorrere i video nel browser. */
export async function sendFile(root: string, rel: string, req: IncomingMessage, res: ServerResponse) {
  const full = resolve(root, rel);
  if (!full.startsWith(resolve(root) + sep)) throw new HttpError(400, 'Percorso non valido');
  let st;
  try { st = await stat(full); } catch { throw new HttpError(404, 'File non trovato'); }
  const type = MIME[extname(full)] ?? 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(st.size - 1, end);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return HANDLED; }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=3600' });
    createReadStream(full, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' });
    createReadStream(full).pipe(res);
  }
  return HANDLED;
}
