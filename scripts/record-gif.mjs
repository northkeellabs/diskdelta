#!/usr/bin/env node
// Records docs/walkthrough.gif: a short scripted walkthrough of --demo mode (fictional PC).
// Drives a headless Edge/Chrome over the DevTools protocol, captures frames, encodes them with gifenc.
//   npm run build && node scripts/record-gif.mjs [out.gif]

import gifenc from "gifenc";
import { PNG } from "pngjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sleep, startBrowser, startDemoServer } from "./lib-browser.mjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;
const out = process.argv[2] || "docs/walkthrough.gif";
const W = 1280;
const H = 800;
const SCALE = 0.75;

const server = await startDemoServer(41998, 450);
const b = await startBrowser(W, H);
await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await b.cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const frames = [];
async function frame(holdMs) {
  const shot = await b.cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: SCALE } });
  frames.push({ png: Buffer.from(shot.data, "base64"), delay: holdMs });
}
const click = (js) => b.evaluate(`(() => { const el = ${js}; if (!el) return false; el.scrollIntoView({block:"center"}); el.click(); window.scrollTo(0,0); return true; })()`);
const h1Is = (s) => `(document.querySelector("main h1")||{}).textContent?.startsWith(${JSON.stringify(s)})`;

await b.cdp("Page.navigate", { url: server.url });
await b.waitFor(`!!document.querySelector(".drive .ring")`);
await sleep(600);
await frame(2200);

// scan C: from its drive card
await click(`[...document.querySelectorAll(".drive button")].find(x => x.textContent === "Scan C:")`);
await b.waitFor(`!!document.getElementById("progress-view")`);
for (let i = 0; i < 4; i++) {
  await sleep(450);
  await frame(450);
}
const ready = `!!document.querySelector(".hero") && !!document.querySelector(".tl-svg") && !!document.querySelector(".sun-svg") && !!document.querySelector(".sun-panel .panel-size")`;
await b.waitFor(ready, 30000);
await sleep(700);
await frame(3000);

// the biggest day in the timeline, and where its new files went
await b.evaluate(`(() => { const gs = [...document.querySelectorAll(".bar-g")]; const best = gs.map(g => [g, g.querySelector(".bar")?.getBBox().height || 0]).sort((a, b) => b[1] - a[1])[0][0]; best.dispatchEvent(new MouseEvent("click", { bubbles: true })); })()`);
await b.waitFor(`!!document.querySelector(".day-list")`);
await b.evaluate(`document.querySelector(".tl").scrollIntoView({ block: "start" }); window.scrollBy(0, -70);`);
await sleep(400);
await frame(2600);

// sunburst: drill into the largest folder, then one level deeper
await b.evaluate(`document.querySelector(".sun").scrollIntoView({ block: "center" })`);
await sleep(300);
await frame(1800);
for (const name of ["Users", "demo"]) {
  await b.evaluate(`(() => { const p = [...document.querySelectorAll(".sun-svg path.ring-1")].find(x => (x.getAttribute("aria-label") || "").startsWith(${JSON.stringify(name)} + ",")); p && p.dispatchEvent(new MouseEvent("click", { bubbles: true })); })()`);
  await b.waitFor(`(document.querySelector(".panel-title") || {}).textContent === ${JSON.stringify(name)}`);
  await sleep(500);
  await frame(2000);
}

// cleanup candidates in Details
await b.evaluate(`(() => { const d = document.getElementById("details-cleanup"); d.open = true; })()`);
await b.waitFor(`!!document.querySelector("#details-cleanup table")`);
await b.evaluate(`document.getElementById("details-cleanup").scrollIntoView({ block: "start" }); window.scrollBy(0, -60);`);
await sleep(400);
await frame(3000);

// export dialog
await b.evaluate(`window.scrollTo(0, 0); document.getElementById("export-btn").click()`);
await b.waitFor(`document.getElementById("export-dialog").open`);
await sleep(300);
await frame(2200);
await b.close();
server.stop();

const enc = GIFEncoder();
for (const f of frames) {
  const png = PNG.sync.read(f.png);
  const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
  const palette = quantize(rgba, 256);
  const index = applyPalette(rgba, palette);
  enc.writeFrame(index, png.width, png.height, { palette, delay: f.delay });
}
enc.finish();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, enc.bytes());
console.log(`${out}: ${frames.length} frames, ${(enc.bytes().length / 1024).toFixed(0)} KB`);
process.exit(0);
