// diskdelta command line.
//   diskdelta                     open the page in your browser (local server on 127.0.0.1)
//   diskdelta --demo              the same, with a fictional PC
//   diskdelta mcp [--demo]        MCP server over stdio for AI apps
//   diskdelta scan <path>...      scan in the terminal and print a summary
// Configuration comes only from flags and environment variables (DISKDELTA_PORT, DISKDELTA_IDLE_MINUTES,
// DISKDELTA_DATA_DIR).

import { spawn } from "node:child_process";
import fs from "node:fs";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createCore, envFor, VERSION } from "./app.ts";
import { CoreError, type DiskDeltaCore } from "./core/api.ts";
import { buildMcpServer } from "./mcp/server.ts";
import { DEFAULT_PORT, startUiServer } from "./ui/server.ts";
import { formatBytes, formatCount, formatDuration } from "./util/format.ts";
import { isAbsolute, normalize } from "./util/winpath.ts";

const HELP = `DiskDelta ${VERSION} - what got added to your drives recently, and what is safe to remove. Read-only.

Usage:
  diskdelta [--demo] [--port N] [--no-open] [--idle-minutes N]
      Start the page on http://127.0.0.1 and open it in your browser.
  diskdelta mcp [--demo]
      Run the read-only MCP server over stdio (for Claude Desktop, Claude Code and other MCP apps).
  diskdelta scan <path>... [--days N] [--limit N] [--demo] [--json FILE]
      Scan drives or folders in the terminal and print what grew and what could be cleaned.
      --json FILE writes the full result as JSON to a new file (never overwrites).
  diskdelta --version | --help

Environment: DISKDELTA_PORT, DISKDELTA_IDLE_MINUTES, DISKDELTA_DATA_DIR (snapshot folder, default %LOCALAPPDATA%\\DiskDelta).
DiskDelta never deletes, moves or changes anything on the drives it scans.`;

interface Flags {
  demo: boolean;
  open: boolean;
  port?: number;
  idleMinutes?: number;
  days: number;
  limit: number;
  json?: string;
  rest: string[];
}

function parse(argv: string[]): Flags {
  const f: Flags = { demo: false, open: true, days: 30, limit: 15, rest: [] };
  const intArg = (name: string, v: string | undefined, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new CoreError(`${name} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--demo") f.demo = true;
    else if (a === "--no-open") f.open = false;
    else if (a === "--port") f.port = intArg("--port", argv[++i], 1, 65535);
    else if (a === "--idle-minutes") f.idleMinutes = intArg("--idle-minutes", argv[++i], 1, 1440);
    else if (a === "--days") f.days = intArg("--days", argv[++i], 1, 365);
    else if (a === "--limit") f.limit = intArg("--limit", argv[++i], 1, 200);
    else if (a === "--json") f.json = argv[++i];
    else if (a.startsWith("--")) throw new CoreError(`Unknown option ${a}. Try diskdelta --help.`);
    else f.rest.push(a);
  }
  if (f.port === undefined && process.env.DISKDELTA_PORT) f.port = intArg("DISKDELTA_PORT", process.env.DISKDELTA_PORT, 1, 65535);
  if (f.idleMinutes === undefined && process.env.DISKDELTA_IDLE_MINUTES) f.idleMinutes = intArg("DISKDELTA_IDLE_MINUTES", process.env.DISKDELTA_IDLE_MINUTES, 1, 1440);
  return f;
}

function openBrowser(url: string) {
  // url.dll's FileProtocolHandler opens the default browser without a console window.
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

async function runPage(f: Flags) {
  const core = createCore({ demo: f.demo });
  const ui = await startUiServer(core, { port: f.port ?? DEFAULT_PORT, idleMinutes: f.idleMinutes, version: VERSION, env: envFor(f.demo) });
  console.log(`DiskDelta ${VERSION}${f.demo ? " (demo: fictional PC)" : ""} is running at:\n  ${ui.url}\nClose the page to stop it, or press Ctrl+C. Nothing on your drives is changed.`);
  if (f.open) openBrowser(ui.url);
  const reason = await Promise.race([ui.done, new Promise<string>((r) => process.once("SIGINT", () => r("Ctrl+C")))]);
  console.log(`Stopping (${reason}).`);
  core.cancelScan();
  await ui.close();
  process.exit(0);
}

async function runMcp(f: Flags) {
  const core = createCore({ demo: f.demo });
  serveStdio(() => buildMcpServer(core, VERSION), { onerror: (e) => process.stderr.write(`diskdelta mcp: ${e.message}\n`) });
}

function printScan(core: DiskDeltaCore, roots: string[], f: Flags) {
  const out: Record<string, unknown>[] = [];
  for (const root of roots) {
    const s = core.scans().find((x) => x.root.toLowerCase() === normalize(root).toLowerCase());
    if (!s) continue;
    const g = core.whatGrew(root, { days: f.days, limit: f.limit });
    const ch = core.changedOld(root, { days: f.days, limit: 10 });
    const cl = core.cleanupPlan(root, { days: f.days, limit: f.limit });
    const sk = core.skipped({ path: root, limit: 20 });
    console.log(`\n== ${s.root}  scanned in ${formatDuration(s.durationMs)}: ${formatCount(s.files)} files, ${formatCount(s.folders)} folders, ${formatBytes(s.bytes)}; skipped ${formatCount(s.skipped)}; links not followed ${formatCount(s.links)}`);
    if (sk.total) console.log(`   skipped by reason: ${Object.entries(sk.byReason).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    console.log(`\n   New files in the last ${f.days} days: ${formatBytes(g.total.newBytes)} (${formatCount(g.total.newFiles)} files)`);
    console.log(`   Older files changed, growth unknown: ${formatBytes(g.total.changedBytes)} (${formatCount(g.total.changedFiles)} files)`);
    console.log(`\n   ${"New".padStart(10)}  ${"Changed".padStart(10)}  ${"Label".padEnd(12)}  Folder (ranked by new files)`);
    for (const r of g.rows) {
      const scope = r.scope === "own" ? " [files directly here]" : r.scope === "rest" ? " [smaller subfolders]" : r.scope === "group" ? ` [${r.groupCount} folders]` : "";
      console.log(`   ${(r.newBytes ? formatBytes(r.newBytes) : "-").padStart(10)}  ${(r.changedBytes ? formatBytes(r.changedBytes) : "-").padStart(10)}  ${(r.known ? r.label : "unknown").padEnd(12)}  ${r.path}${scope}`);
    }
    if (ch.files.length) {
      console.log(`\n   Changed recently, growth amount unknown:`);
      for (const x of ch.files) console.log(`   ${formatBytes(x.size).padStart(10)}  ${x.path}  (created ${x.created?.slice(0, 10) ?? "unknown"}, modified ${x.modified.slice(0, 10)})`);
    }
    console.log(`\n   Cleanup candidates (proposals only):`);
    for (const c of cl.candidates) console.log(`   ${formatBytes(c.bytes).padStart(10)}  ${(c.known ? c.label : "unknown").padEnd(12)}  ${c.path}`);
    out.push({ scan: s, whatGrew: g, changedOld: ch, cleanup: cl, skipped: sk });
  }
  return out;
}

async function runScan(f: Flags) {
  if (f.rest.length === 0) throw new CoreError("Give at least one drive or folder, for example: diskdelta scan C:\\");
  for (const p of f.rest) if (!isAbsolute(p)) throw new CoreError(`Not an absolute path: ${p}`);
  const core = createCore({ demo: f.demo });
  let last = 0;
  core.onEvent((e) => {
    if (e.type !== "progress" || !e.job.progress) return;
    const now = Date.now();
    if (now - last < 2000) return;
    last = now;
    const p = e.job.progress;
    process.stderr.write(`  ${p.root}  ${formatCount(p.files)} files, ${formatCount(p.folders)} folders, ${formatBytes(p.bytes)}, ${formatDuration(p.elapsedMs)}\n`);
  });
  process.once("SIGINT", () => core.cancelScan());
  core.startScan(f.rest);
  const job = await core.waitForJob();
  if (job?.state === "error") throw new CoreError(job.error ?? "Scan failed.");
  if (job?.state === "cancelled") console.log("Scan cancelled.");
  const result = printScan(core, f.rest, f);
  if (f.json) {
    const target = normalize(f.json);
    fs.writeFileSync(target, JSON.stringify({ version: VERSION, mode: core.mode, generatedAt: new Date().toISOString(), days: f.days, results: result }, null, 1), { flag: "wx" });
    console.log(`\nWrote ${target}`);
  }
}

export async function main(argv: string[]) {
  try {
    if (argv.includes("--version")) return console.log(VERSION);
    if (argv.includes("--help") || argv.includes("-h")) return console.log(HELP);
    const [cmd, ...rest] = argv;
    if (cmd === "mcp") return await runMcp(parse(rest));
    if (cmd === "scan") return await runScan(parse(rest));
    return await runPage(parse(argv));
  } catch (e) {
    console.error(e instanceof CoreError ? e.message : `Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
