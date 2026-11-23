// Offline guarantee: no code path makes a network call, and the page loads nothing from elsewhere.
import fs from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "generated" ? [] : files(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

describe("offline", () => {
  it("source has no outbound network APIs", () => {
    for (const f of files("src")) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\bfetch\(|https\.request|https\.get|http\.request|http\.get\(|net\.connect|net\.createConnection|tls\.connect|dgram|dns\.|WebSocket|XMLHttpRequest/);
      expect(src, f).not.toMatch(/telemetry|analytics|update-check|checkForUpdate/i);
    }
  });

  it("the local server listens on 127.0.0.1 only", () => {
    const src = fs.readFileSync("src/ui/server.ts", "utf8");
    const listens = src.match(/\.listen\([^)]*\)/g) ?? [];
    expect(listens.length).toBeGreaterThan(0);
    for (const l of listens) expect(l).toContain('"127.0.0.1"');
  });

  it("the page loads no external scripts, styles, fonts or images and only talks to its own server", () => {
    const page = fs.readFileSync("src/ui/page.html", "utf8");
    expect(page).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(page).not.toMatch(/@import|url\(\s*["']?https?:/i);
    const urls = page.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    // the SVG namespace is an identifier for createElementNS, not an address that is fetched
    for (const u of urls) expect(u).toMatch(/^(https:\/\/northkeellabs\.com|http:\/\/www\.w3\.org\/2000\/svg$)/);
    expect(page).not.toMatch(/\bfetch\(\s*["'`]https?:/);
  });

  it("the static browser demo is self-contained, has a strict CSP and makes no network calls", () => {
    if (!fs.existsSync("docs/demo/index.html")) return; // built by npm run build:demo
    const page = fs.readFileSync("docs/demo/index.html", "utf8");
    expect(page).toContain("connect-src 'none'");
    expect(page).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(page).toContain("DISKDELTA_STATIC");
    expect(page).not.toMatch(/\bfetch\(\s*["'`]https?:/);
  });
});
