// UI layer: a local web server for the page. Uses only the Core API.
//
// Protections (see SECURITY.md):
// - Binds to 127.0.0.1 only.
// - A random token per run is in the page URL and required on every request (query ?t= or X-DiskDelta-Token header),
//   compared in constant time.
// - Host header must be 127.0.0.1:<port> or localhost:<port> (blocks DNS rebinding).
// - Requests with an Origin other than this server, or Sec-Fetch-Site cross-site / same-site, are rejected.
//   No CORS headers are ever sent.
// - POST bodies must be JSON and at most 64 KB.
// - Strict Content-Security-Policy with a per-run nonce: the page can load nothing from anywhere else.
// Lifetime: the page sends a heartbeat every 15 s and a beacon when it closes. The server exits when no heartbeat
// arrives for 75 s, 5 s after the close beacon (unless the page comes back), or after an idle timeout.

import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CoreError, type DiskDeltaCore } from "../core/api.ts";
import { PAGE_HTML } from "../generated/assets.ts";
import { handleApi } from "./routes.ts";

export interface UiOptions {
  port?: number;
  /** Exit after this many minutes without any request from the page except heartbeats. Default 60. */
  idleMinutes?: number;
  heartbeatTimeoutMs?: number;
  /** Values exposed to the page (version, env for export suggestion). */
  version: string;
  env: Record<string, string | undefined>;
  onExit?: (reason: string) => void;
  /** Fixed token for tests. */
  token?: string;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
  /** Resolves with the reason when the server decides to exit. */
  done: Promise<string>;
}

export const DEFAULT_PORT = 41823;
const MAX_BODY = 64 * 1024;

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function startUiServer(core: DiskDeltaCore, o: UiOptions): Promise<UiServer> {
  const token = o.token ?? randomBytes(24).toString("base64url");
  const tokenBuf = Buffer.from(token);
  const nonce = randomBytes(16).toString("base64");
  let port = 0;
  let exitResolve!: (r: string) => void;
  const done = new Promise<string>((r) => (exitResolve = r));
  let exited = false;
  const exit = (reason: string) => {
    if (exited) return;
    exited = true;
    exitResolve(reason);
    o.onExit?.(reason);
  };

  const idleMs = (o.idleMinutes ?? 60) * 60_000;
  const hbTimeout = o.heartbeatTimeoutMs ?? 75_000;
  let lastActivity = Date.now();
  let lastHeartbeat = 0;
  let byeTimer: NodeJS.Timeout | null = null;
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (lastHeartbeat > 0 && now - lastHeartbeat > hbTimeout) exit("page closed (no heartbeat)");
    else if (now - lastActivity > idleMs && core.job()?.state !== "running") exit("idle timeout");
  }, 5000);
  watchdog.unref();

  const sse = new Set<http.ServerResponse>();
  const unsubscribe = core.onEvent((e) => {
    const data = `event: ${e.type}\ndata: ${JSON.stringify(e.job)}\n\n`;
    for (const res of sse) res.write(data);
  });

  const tokenOk = (req: http.IncomingMessage, url: URL) => {
    const given = url.searchParams.get("t") ?? (req.headers["x-diskdelta-token"] as string | undefined) ?? "";
    const b = Buffer.from(given);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const send = (res: http.ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.end(text);
  };

  const readJson = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return reject(new CoreError("Body must be JSON."));
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new CoreError("Body too large."));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          reject(new CoreError("Body is not valid JSON."));
        }
      });
      req.on("error", reject);
    });

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // 1. Host header: only our own loopback name and port (DNS rebinding protection).
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "Host not allowed." });
    // 2. Cross-origin requests are refused; no CORS headers are ever sent.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: "Cross-origin request refused." });
    const site = req.headers["sec-fetch-site"];
    if (site === "cross-site" || site === "same-site") return send(res, 403, { error: "Cross-site request refused." });
    if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "Method not allowed." });
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    // 3. Per-run token.
    if (!tokenOk(req, url)) return send(res, 401, { error: "Missing or wrong token. Open DiskDelta from the link it printed." });

    const p = url.pathname;
    if (p !== "/api/heartbeat" && p !== "/api/events") lastActivity = Date.now();
    if (byeTimer && p !== "/api/bye") {
      clearTimeout(byeTimer);
      byeTimer = null;
    }

    try {
      if (req.method === "GET" && p === "/") {
        const page = PAGE_HTML.replaceAll("__NONCE__", nonce);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
        return res.end(page);
      }
      if (req.method === "GET" && p === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
        res.write(`event: job\ndata: ${JSON.stringify(core.job())}\n\n`);
        sse.add(res);
        req.on("close", () => sse.delete(res));
        return;
      }
      if (req.method === "POST" && p === "/api/heartbeat") {
        lastHeartbeat = Date.now();
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/bye") {
        if (!byeTimer) byeTimer = setTimeout(() => exit("page closed"), 5000);
        return send(res, 200, { ok: true });
      }
      const body = req.method === "POST" ? await readJson(req) : undefined;
      const r = await handleApi(core, { version: o.version, env: o.env, allowExport: true }, { method: req.method!, path: p, query: url.searchParams, body });
      if (!r) return send(res, 404, { error: "Not found." });
      return send(res, r.status, r.body, r.type);
    } catch (e) {
      if (e instanceof CoreError) return send(res, 400, { error: e.message });
      return send(res, 500, { error: "Unexpected error.", detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "Unexpected error." });
    });
  });
  try {
    port = await listen(server, o.port ?? DEFAULT_PORT);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" && (e as NodeJS.ErrnoException).code !== "EACCES") throw e;
    port = await listen(server, 0);
  }

  const close = async () => {
    clearInterval(watchdog);
    if (byeTimer) clearTimeout(byeTimer);
    unsubscribe();
    for (const r of sse) r.end();
    sse.clear();
    const closed = new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
    await closed;
  };

  return { url: `http://127.0.0.1:${port}/?t=${token}`, port, token, close, done };
}
