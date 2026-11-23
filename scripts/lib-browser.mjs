// Shared helpers for scripts/screenshots.mjs and scripts/record-gif.mjs: start the demo server and a headless
// Edge/Chrome with a throwaway profile, and talk to it over the DevTools protocol on 127.0.0.1. Demo data only.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startDemoServer(port = 41999, delayMs = 350) {
  const server = spawn(process.execPath, ["dist/cli.js", "--demo", "--no-open", "--port", String(port)], { env: { ...process.env, DISKDELTA_DEMO_DELAY_MS: String(delayMs) }, stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    server.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/);
      if (m) resolve(m[0]);
    });
    server.on("exit", () => reject(new Error("demo server exited")));
  });
  return { url, stop: () => server.kill() };
}

export async function startBrowser(width = 1440, height = 1000) {
  const candidates = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"];
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) throw new Error("No Edge or Chrome found");
  const profile = mkdtempSync(join(tmpdir(), "dd-browser-"));
  const proc = spawn(exe, ["--headless=new", "--remote-debugging-port=9333", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let targets = [];
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {}
    await sleep(200);
  }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
  const waitFor = async (expr, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evaluate(expr).catch(() => false)) return true;
      await sleep(120);
    }
    throw new Error(`timeout waiting for ${expr}`);
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  const close = async () => {
    ws.close();
    proc.kill();
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  };
  return { cdp, evaluate, waitFor, close };
}
