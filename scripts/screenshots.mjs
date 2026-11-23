#!/usr/bin/env node
// Screenshots of every screen from --demo mode (fictional PC), in light and dark, plus the static browser demo.
//   npm run build && npm run build:demo && node scripts/screenshots.mjs <outdir> [--only name,name]

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sleep, startBrowser, startDemoServer } from "./lib-browser.mjs";

const out = process.argv[2] || "data/screenshots";
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx > 0 ? new Set(process.argv[onlyIdx + 1].split(",")) : null;
mkdirSync(out, { recursive: true });

const server = await startDemoServer();
const b = await startBrowser();
const base = server.url;
const staticBase = pathToFileURL(resolve("docs/demo/index.html")).href;

const overviewReady = `!!document.querySelector(".hero") && !!document.querySelector(".tl-svg, .tl-chart table") && !!document.querySelector(".sun-svg, .sun-chart table") && !!document.querySelector(".sun-panel .panel-size")`;
const h1Is = (s) => `(document.querySelector("main h1")||{}).textContent?.startsWith(${JSON.stringify(s)})`;
const enc = (s) => encodeURIComponent(s);
const SHOTS = [
  { name: "01-drives", hash: "", ready: `!!document.querySelector(".drive .ring")`, settle: 500 },
  { name: "02-scan-progress", hash: `scan=${enc("C:\\")}`, ready: `!!document.querySelector(".progress")`, settle: 900, viewport: true },
  { name: "03-overview", hash: `scan=${enc("C:\\")}`, ready: overviewReady, settle: 700 },
  { name: "04-overview-day", hash: `scan=${enc("C:\\")}&tl=max`, ready: `!!document.querySelector(".day-list")`, settle: 500 },
  { name: "05-overview-drilled", hash: `scan=${enc("C:\\")}&sun=${enc("C:\\Users\\demo")}`, ready: `(document.querySelector(".panel-title")||{}).textContent === "demo" && !!document.querySelector(".sun-svg")`, settle: 600 },
  { name: "06-sunburst-hover", hash: `scan=${enc("C:\\")}`, ready: overviewReady, settle: 700, hover: ".sun-svg path.ring-1", viewport: true, scroll: ".sun" },
  { name: "07-chart-tables", hash: `scan=${enc("C:\\")}&tltable=1&suntable=1`, ready: `document.querySelectorAll(".block table.grid").length >= 2`, settle: 400 },
  { name: "08-details-growth", hash: `scan=${enc("C:\\")}&open=growth,changed`, ready: `!!document.querySelector("#details-changed table")`, settle: 500 },
  { name: "09-details-size", hash: `scan=${enc("C:\\")}&open=size&path=${enc("C:\\Users\\demo\\AppData\\Local")}`, ready: `!!document.querySelector("#details-size .tile")`, settle: 600 },
  { name: "10-details-cleanup-skipped", hash: `scan=${enc("C:\\")}&open=cleanup,skipped`, ready: `!!document.querySelector("#details-skipped table")`, settle: 500 },
  { name: "11-export-dialog", hash: `scan=${enc("C:\\")}&export=1`, ready: `document.getElementById("export-dialog").open`, settle: 600, viewport: true },
  { name: "12-overview-d-7-days", hash: `scan=${enc("D:\\")}&days=7`, ready: overviewReady, settle: 700 },
  { name: "13-static-demo", static: true, hash: `scan=${enc("C:\\")}`, ready: overviewReady, settle: 700 },
];

const done = [];
for (const theme of ["light", "dark"]) {
  for (const s of SHOTS) {
    if (only && !only.has(s.name)) continue;
    await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await b.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await b.cdp("Page.navigate", { url: "about:blank" });
    await sleep(200);
    await b.cdp("Page.navigate", { url: (s.static ? staticBase : base) + (s.hash ? "#" + s.hash : "") });
    await b.waitFor(s.ready);
    await sleep(s.settle ?? 250);
    if (s.scroll) await b.evaluate(`document.querySelector(${JSON.stringify(s.scroll)}).scrollIntoView({block:"center"})`);
    if (s.hover) {
      const pt = await b.evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(s.hover)})].filter(e => !e.classList.contains("is-other")); const el = els[0]; if (!el) return null; const svg = el.ownerSVGElement; const vb = svg.viewBox.baseVal; const p = el.getPointAtLength(el.getTotalLength() * 0.12); const cx = vb.width / 2, cy = vb.height / 2; const d = Math.hypot(p.x - cx, p.y - cy) || 1; const q = svg.createSVGPoint(); q.x = p.x + ((cx - p.x) / d) * 10; q.y = p.y + ((cy - p.y) / d) * 10; const s = q.matrixTransform(svg.getScreenCTM()); return { x: s.x, y: s.y }; })()`);
      if (pt) { await b.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y }); await sleep(250); }
    }
    let height = 1000;
    if (!s.viewport) height = Math.min(9000, Math.max(1000, Math.ceil(await b.evaluate("document.documentElement.scrollHeight"))));
    await b.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    const shot = await b.cdp("Page.captureScreenshot", { format: "png" });
    const file = join(out, `${s.name}-${theme}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    done.push(file);
    console.log(file);
    if (!s.static) await b.waitFor(`fetch("/api/state",{headers:{"X-DiskDelta-Token":new URLSearchParams(location.search).get("t")}}).then(r=>r.json()).then(s=>!s.job||s.job.state!=="running")`, 30000).catch(() => {});
  }
}

await b.close();
server.stop();
console.log(`${done.length} screenshots in ${out}`);
process.exit(0);
