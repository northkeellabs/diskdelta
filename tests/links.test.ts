// The narrowed offline check must still fail on anything that loads from, or links to, another address.
import { describe, expect, it } from "vitest";
import { expectOnlyAllowedLinks } from "./links.ts";

const A = 'target="_blank" rel="noopener noreferrer"';

describe("offline link check", () => {
  it("accepts exactly the three allowed anchors", () => {
    expect(() => expectOnlyAllowedLinks(`<a class="ext" href="https://github.com/northkeellabs/diskdelta" ${A}>DiskDelta</a> <a href="https://northkeellabs.com" ${A}>x</a> <a href="https://northkeellabs.com/diskdelta" ${A}>y</a>`)).not.toThrow();
  });

  it.each([
    ["another host in an anchor", '<a href="https://example.com/">x</a>'],
    ["a lookalike host in an anchor", '<a href="https://northkeellabs.com.evil.example/">x</a>'],
    ["another path on the company host", '<a href="https://northkeellabs.com/other">x</a>'],
    ["an external script", '<script src="https://cdn.example/x.js"></script>'],
    ["a protocol-relative image", '<img src="//cdn.example/x.png">'],
    ["an external stylesheet", '<link rel="stylesheet" href="https://fonts.example/f.css">'],
    ["an @import", "<style>@import 'https://fonts.example/f.css';</style>"],
    ["a css url()", "<style>a{background:url(https://cdn.example/x.png)}</style>"],
    ["an external URL in script text", '<script>const u = "https://tracker.example/p";</script>'],
  ])("rejects %s", (_name, html) => {
    expect(() => expectOnlyAllowedLinks(html)).toThrow();
  });
});

describe("offline link check, bundled report template", () => {
  it("skips only the exact placeholder shape and only when told the page is bundled", () => {
    const tpl = '<a href="${e}" target="_blank">x</a>';
    expect(() => expectOnlyAllowedLinks(tpl, true)).not.toThrow();
    expect(() => expectOnlyAllowedLinks(tpl)).toThrow();
    expect(() => expectOnlyAllowedLinks('<a href="${e}https://example.com">x</a>', true)).toThrow();
  });
});
