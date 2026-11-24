// Report rendering (Markdown or a self-contained HTML page) from Core API views. Pure functions, no I/O.

import { formatBytes, formatCount, formatDuration } from "../util/format.ts";
import type { CandidateRow, DriveView, FileRow, HotspotRow, ScanSummary } from "./api.ts";
import type { SkippedItem } from "./types.ts";

export interface ReportData {
  generatedAt: string;
  mode: "live" | "demo";
  days: number;
  drives: DriveView[];
  scans: ScanSummary[];
  growth: Array<{ path: string; days: number; total: { newBytes: number; newFiles: number; changedBytes: number; changedFiles: number }; rows: HotspotRow[] }>;
  changedOld: Array<{ path: string; minBytes: number; files: FileRow[] }>;
  cleanup: Array<{ path: string; candidates: CandidateRow[]; note: string }>;
  skipped: { total: number; byReason: Record<string, number>; items: SkippedItem[] };
}

const LABEL_TEXT: Record<string, string> = { safe: "Safe to remove", check_first: "Check first", do_not_touch: "Do not touch" };
const labelText = (label: string, known: boolean) => (known ? LABEL_TEXT[label] : "Unknown - check first");
const scopeText = (r: HotspotRow) => (r.scope === "own" ? " (files directly here)" : r.scope === "rest" ? " (smaller subfolders together)" : r.scope === "group" ? ` (${r.groupCount} folders)` : "");

interface Table {
  title: string;
  intro?: string;
  head: string[];
  right: boolean[];
  rows: string[][];
  empty: string;
}

function tables(d: ReportData): Table[] {
  const out: Table[] = [];
  out.push({
    title: "Drives",
    head: ["Drive", "Label", "Type", "Size", "Used", "Free", "Used %"],
    right: [false, false, false, true, true, true, true],
    rows: d.drives.map((x) => [x.root, x.label || "-", x.type, formatBytes(x.size), formatBytes(x.used), formatBytes(x.free), `${x.usedPct}%`]),
    empty: "No drives found.",
  });
  out.push({
    title: "Scans",
    head: ["Scanned", "Finished", "Took", "Folders", "Files", "Size", "Skipped", "Links not followed"],
    right: [false, false, true, true, true, true, true, true],
    rows: d.scans.map((s) => [s.root, s.finishedAt.slice(0, 16).replace("T", " "), formatDuration(s.durationMs), formatCount(s.folders), formatCount(s.files), formatBytes(s.bytes), formatCount(s.skipped), formatCount(s.links)]),
    empty: "Nothing scanned yet.",
  });
  for (const g of d.growth) {
    out.push({
      title: `What grew in the last ${d.days} days: ${g.path}`,
      intro: `New files: ${formatBytes(g.total.newBytes)} (${formatCount(g.total.newFiles)} files created in the window). Separately, older files changed in the window, growth amount unknown: ${formatBytes(g.total.changedBytes)} (${formatCount(g.total.changedFiles)} files).`,
      head: ["Folder", "New files", "Older files changed (growth unknown)", "Label", "What it is"],
      right: [false, true, true, false, false],
      rows: g.rows.map((r) => [r.path + scopeText(r), r.newBytes ? formatBytes(r.newBytes) : "-", r.changedBytes ? formatBytes(r.changedBytes) : "-", labelText(r.label, r.known), r.what]),
      empty: "No new files and no changed files in this window.",
    });
  }
  for (const c of d.changedOld) {
    out.push({
      title: `Changed recently, growth amount unknown: ${c.path}`,
      intro: `Files of ${formatBytes(c.minBytes)} or more that existed before the window and were modified inside it. DiskDelta cannot tell how much they grew.`,
      head: ["File", "Now", "Created", "Modified"],
      right: [false, true, false, false],
      rows: c.files.map((f) => [f.path, formatBytes(f.size), f.created?.slice(0, 10) ?? "unknown", f.modified.slice(0, 10)]),
      empty: "None.",
    });
  }
  for (const c of d.cleanup) {
    out.push({
      title: `Cleanup candidates: ${c.path}`,
      intro: c.note,
      head: ["Folder", "Size", "New files", "Label", "Why", "How to reclaim"],
      right: [false, true, true, false, false, false],
      rows: c.candidates.map((r) => [r.path, formatBytes(r.bytes), r.newBytes ? formatBytes(r.newBytes) : "-", labelText(r.label, r.known), r.reason, r.reclaim]),
      empty: "No candidates found.",
    });
  }
  out.push({
    title: "Skipped (could not be read)",
    intro: Object.entries(d.skipped.byReason).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(", ") || undefined,
    head: ["Path", "Kind", "Reason"],
    right: [false, false, false],
    rows: d.skipped.items.map((s) => [s.path, s.kind, s.reason.replace(/_/g, " ")]),
    empty: "Nothing was skipped.",
  });
  return out;
}

// Every mention of the product, the company or its web address is a link, in both formats.
const PRODUCT_URL = "https://github.com/northkeellabs/diskdelta";
const COMPANY_URL = "https://northkeellabs.com";
const MENTION = /(?:https?:\/\/)?northkeellabs\.com(?:\/[\w\-/]*)?|Northkeel Labs|DiskDelta/g;
const mentionUrl = (t: string) => (t === "DiskDelta" ? PRODUCT_URL : t === "Northkeel Labs" ? COMPANY_URL : /^https?:/.test(t) ? t : "https://" + t);
/** Replace each mention in already-escaped prose with a link. Paths and other non-prose text must not go through this. */
const linkMentions = (text: string, link: (label: string, url: string) => string) => text.replace(MENTION, (t) => link(t, mentionUrl(t)));
const mdLink = (label: string, url: string) => `[${label}](${url})`;
const htmlLink = (label: string, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
// Columns holding prose (not paths): the only table cells that get links.
const PROSE_COLUMNS = new Set(["What it is", "Why", "How to reclaim"]);

const mdCell = (s: string, code: boolean, prose = false) => {
  const t = s.replace(/\|/g, "/").replace(/\r?\n/g, " ");
  if (code) return "`" + t.replace(/`/g, "'") + "`";
  const e = t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return prose ? linkMentions(e, mdLink) : e;
};

function markdown(d: ReportData): string {
  const lines: string[] = [];
  lines.push(`# ${mdLink("DiskDelta", PRODUCT_URL)} report`, "");
  lines.push(`Generated ${d.generatedAt.slice(0, 16).replace("T", " ")} UTC${d.mode === "demo" ? " from DEMO data (a fictional PC)" : ""}. Window: last ${d.days} days. Read-only: nothing was changed.`, "");
  for (const t of tables(d)) {
    lines.push(`## ${t.title}`, "");
    if (t.intro) lines.push(linkMentions(t.intro, mdLink), "");
    if (t.rows.length === 0) {
      lines.push(t.empty, "");
      continue;
    }
    lines.push(`| ${t.head.join(" | ")} |`);
    lines.push(`| ${t.right.map((r) => (r ? "---:" : "---")).join(" | ")} |`);
    for (const r of t.rows) lines.push(`| ${r.map((c, i) => mdCell(c, i === 0, PROSE_COLUMNS.has(t.head[i]))).join(" | ")} |`);
    lines.push("");
  }
  lines.push(linkMentions("Made with DiskDelta by Northkeel Labs (https://northkeellabs.com/diskdelta).", mdLink), "");
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function html(d: ReportData): string {
  const parts: string[] = [];
  for (const t of tables(d)) {
    parts.push(`<h2>${esc(t.title)}</h2>`);
    if (t.intro) parts.push(`<p>${linkMentions(esc(t.intro), htmlLink)}</p>`);
    if (t.rows.length === 0) {
      parts.push(`<p class="empty">${esc(t.empty)}</p>`);
      continue;
    }
    const head = t.head.map((h, i) => `<th${t.right[i] ? ' class="n"' : ""}>${esc(h)}</th>`).join("");
    const body = t.rows.map((r) => `<tr>${r.map((c, i) => `<td${t.right[i] ? ' class="n"' : i === 0 ? ' class="p"' : ""}>${PROSE_COLUMNS.has(t.head[i]) ? linkMentions(esc(c), htmlLink) : esc(c)}</td>`).join("")}</tr>`).join("\n");
    parts.push(`<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DiskDelta report</title>
<style>
:root{color-scheme:light dark;--fg:#1c1c1c;--muted:#5f5f5f;--bg:#fff;--line:#e3e3e3;--head:#f5f5f5}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8e8;--muted:#a8a8a8;--bg:#1b1b1b;--line:#333;--head:#242424}}
body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:32px auto;max-width:1100px;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}p{margin:4px 0 10px;color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--head);font-weight:600}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.p{word-break:break-all;font-family:Consolas,monospace;font-size:12px}
.empty{font-style:italic}
a{color:#0a5fb4;text-underline-offset:2px}a:hover{color:#084f96}a:focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:2px}
@media (prefers-color-scheme:dark){a{color:#62a4f0}a:hover{color:#7db4f3}}
</style></head><body>
<h1>${htmlLink("DiskDelta", PRODUCT_URL)} report</h1>
<p>Generated ${esc(d.generatedAt.slice(0, 16).replace("T", " "))} UTC${d.mode === "demo" ? " from DEMO data (a fictional PC)" : ""}. Window: last ${d.days} days. Read-only: nothing was changed.</p>
${parts.join("\n")}
<p>${linkMentions("Made with DiskDelta by Northkeel Labs (https://northkeellabs.com/diskdelta).", htmlLink)}</p>
</body></html>
`;
}

export function renderReport(format: "md" | "html", d: ReportData): string {
  return format === "md" ? markdown(d) : html(d);
}
