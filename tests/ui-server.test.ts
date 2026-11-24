import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCore, VERSION } from "../src/app.ts";
import { DEMO_ENV } from "../src/scanner/demo.ts";
import { startUiServer, type UiServer } from "../src/ui/server.ts";
import { expectOnlyAllowedLinks } from "./links.ts";

let ui: UiServer;
const TOKEN = "test-token-0123456789abcdefghijkl";

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: ui.port, path, method: opts.method ?? "GET", headers: { Host: `127.0.0.1:${ui.port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

beforeAll(async () => {
  const core = createCore({ demo: true });
  ui = await startUiServer(core, { port: 0, version: VERSION, env: DEMO_ENV, token: TOKEN });
});
afterAll(async () => {
  await ui?.close();
});

describe("local server security", () => {
  it("binds to 127.0.0.1 only and puts the token in the URL", () => {
    expect(ui.url).toBe(`http://127.0.0.1:${ui.port}/?t=${TOKEN}`);
  });

  it("rejects a missing token and a wrong token", async () => {
    expect((await request("/api/state")).status).toBe(401);
    expect((await request("/api/state?t=wrong")).status).toBe(401);
    expect((await request("/", {})).status).toBe(401);
    expect((await request("/api/state", { headers: { "X-DiskDelta-Token": TOKEN.slice(0, -1) + "X" } })).status).toBe(401);
  });

  it("accepts the token in the query or the header", async () => {
    expect((await request(`/api/state?t=${TOKEN}`)).status).toBe(200);
    expect((await request("/api/state", { headers: { "X-DiskDelta-Token": TOKEN } })).status).toBe(200);
  });

  it("rejects a wrong Host header (DNS rebinding)", async () => {
    const r = await request(`/api/state?t=${TOKEN}`, { headers: { Host: `evil.example:${ui.port}` } });
    expect(r.status).toBe(403);
    expect((await request(`/api/state?t=${TOKEN}`, { headers: { Host: "127.0.0.1:1" } })).status).toBe(403);
    expect((await request(`/api/state?t=${TOKEN}`, { headers: { Host: `localhost:${ui.port}` } })).status).toBe(200);
  });

  it("rejects cross-origin requests, even with the right token, and never sends CORS headers", async () => {
    const r = await request(`/api/state?t=${TOKEN}`, { headers: { Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const s = await request(`/api/scan?t=${TOKEN}`, { method: "POST", headers: { Origin: "http://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ targets: ["C:\\"] }) });
    expect(s.status).toBe(403);
    expect((await request(`/api/state?t=${TOKEN}`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    const same = await request(`/api/state?t=${TOKEN}`, { headers: { Origin: `http://127.0.0.1:${ui.port}`, "Sec-Fetch-Site": "same-origin" } });
    expect(same.status).toBe(200);
    expect(same.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses non-JSON POST bodies (no form posts) and other methods", async () => {
    const r = await request(`/api/scan?t=${TOKEN}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "targets=C:\\" });
    expect(r.status).toBe(400);
    expect((await request(`/api/state?t=${TOKEN}`, { method: "OPTIONS" })).status).toBe(405);
    expect((await request(`/api/state?t=${TOKEN}`, { method: "DELETE" })).status).toBe(405);
  });

  it("serves the page with a strict Content-Security-Policy and no external resources", async () => {
    const r = await request(`/?t=${TOKEN}`);
    expect(r.status).toBe(200);
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(r.body).not.toContain("__NONCE__");
    expectOnlyAllowedLinks(r.body);
    // links are navigation: the policy must not restrict it (no navigate-to), and form-action only governs forms
    expect(csp).not.toContain("navigate-to");
    expect(r.body.match(/<a class="ext" href="https:[^"]*" target="_blank" rel="noopener noreferrer">/g)?.length).toBeGreaterThanOrEqual(4);
    expect(r.headers["x-frame-options"]).toBe("DENY");
  });

  it("runs a demo scan through the API and answers folder, growth and cleanup queries", async () => {
    const h = { "X-DiskDelta-Token": TOKEN, "Content-Type": "application/json" };
    const s = await request("/api/scan", { method: "POST", headers: h, body: JSON.stringify({ targets: ["D:\\"] }) });
    expect(s.status).toBe(200);
    for (let i = 0; i < 100; i++) {
      const st = JSON.parse((await request("/api/state", { headers: h })).body);
      if (st.job?.state !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const f = JSON.parse((await request(`/api/folder?path=${encodeURIComponent("D:\\")}&days=30`, { headers: h })).body);
    expect(f.children.length).toBeGreaterThan(2);
    const g = await request(`/api/grew?path=${encodeURIComponent("D:\\")}&days=7`, { headers: h });
    expect(g.status).toBe(200);
    const bad = await request(`/api/folder?path=relative&days=30`, { headers: h });
    expect(bad.status).toBe(400);
  });
});
