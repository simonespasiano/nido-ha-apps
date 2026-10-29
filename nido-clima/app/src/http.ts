import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

type Handler = (params: Record<string, string>, query: URLSearchParams, req: IncomingMessage, body: any) => unknown | Promise<unknown>;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Server HTTP minimale senza dipendenze: rotte GET in JSON + file statici. */
export class MiniServer {
  private routes: { method: string; parts: string[]; handler: Handler }[] = [];

  constructor(private publicDir: string) {}

  get(path: string, handler: Handler) {
    this.routes.push({ method: 'GET', parts: path.split('/').filter(Boolean), handler });
  }

  post(path: string, handler: Handler) {
    this.routes.push({ method: 'POST', parts: path.split('/').filter(Boolean), handler });
  }

  private match(method: string, pathname: string) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (r.parts.every((p, i) => p.startsWith(':') ? (params[p.slice(1)] = decodeURIComponent(parts[i]), true) : p === parts[i])) {
        return { handler: r.handler, params };
      }
    }
    return null;
  }

  private async serveStatic(pathname: string, res: ServerResponse) {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(this.publicDir, rel));
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Non trovato');
    }
  }

  listen(port: number) {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
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
          try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
          catch { throw new HttpError(400, 'JSON non valido'); }
        }
        const data = await m.handler(m.params, url.searchParams, req, body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
    return new Promise<void>(resolve => server.listen(port, '0.0.0.0', resolve));
  }
}
