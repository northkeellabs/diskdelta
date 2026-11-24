import { expect } from "vitest";

// The offline promise: the page loads nothing from the internet. A link the user clicks is navigation, not a load,
// so exactly these three addresses may appear as <a href>. Any other external URL, and any external URL in
// src, <link>, @import, url() or fetch, still fails.
export const ALLOWED_LINKS = ["https://github.com/northkeellabs/diskdelta", "https://northkeellabs.com", "https://northkeellabs.com/diskdelta"];

/**
 * @param bundled the page also contains the bundled report code, whose HTML template writes `<a href="${url}">` (a
 *   placeholder filled from the allowed constants at export time, tested in core.test.ts). Only that exact shape is skipped.
 */
export function expectOnlyAllowedLinks(page: string, bundled = false): void {
  // every static <a href> points at one of the allowed addresses
  for (const m of page.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["']/gi)) {
    if (bundled && /^\$\{[\w$]+\}$/.test(m[1])) continue;
    expect(ALLOWED_LINKS, `<a href="${m[1]}">`).toContain(m[1]);
  }
  // with the allowed anchors removed, no attribute may point anywhere external
  const rest = page.replace(/<a\b[^>]*\bhref\s*=\s*["'](?:https:\/\/github\.com\/northkeellabs\/diskdelta|https:\/\/northkeellabs\.com(?:\/diskdelta)?)["'][^>]*>/gi, "<a>");
  expect(rest).not.toMatch(/(src|href|action|poster|srcset|data)\s*=\s*["']?(https?:)?\/\//i);
  expect(rest).not.toMatch(/<link\b[^>]*https?:/i);
  expect(rest).not.toMatch(/@import|url\(\s*["']?(https?:)?\/\//i);
  // every URL anywhere in the file is an allowed link or the SVG namespace identifier (never fetched)
  for (const u of page.match(/https?:\/\/[^\s"'<>)\\]+/g) ?? []) {
    if (u === "http://www.w3.org/2000/svg") continue;
    expect(ALLOWED_LINKS, u).toContain(u);
  }
}
