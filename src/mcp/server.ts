// MCP layer: four read-only tools over the Core API. No tool deletes, moves or changes anything.
// Scans happen on demand inside a tool call; a scan of the same folder (or one above it) from the last
// 15 minutes is reused.

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CoreError, type CandidateRow, type DiskDeltaCore, type FileRow, type HotspotRow, type LabelView } from "../core/api.ts";
import { formatBytes, formatCount, formatDuration } from "../util/format.ts";
import { isAbsolute } from "../util/winpath.ts";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const Path = z
  .string()
  .min(2)
  .max(1000)
  .refine((p) => isAbsolute(p), "Must be an absolute Windows path such as C:\\ or C:\\Users\\you\\AppData")
  .describe("Absolute Windows path of a drive or folder, for example C:\\ or C:\\Users\\you\\AppData\\Local");
const Days = z.number().int().min(1).max(365).default(30).describe("Look-back window in days (1-365). Default 30.");
const Limit = z.number().int().min(1).max(100).default(15).describe("Maximum rows to return (1-100). Default 15.");

function ok(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const labelOf = (l: LabelView) => (l.known ? l.label : "unknown");
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "unknown");
const fileOut = (f: FileRow) => ({ path: f.path, now: formatBytes(f.size), created: day(f.created), modified: day(f.modified) });

function hotspotOut(r: HotspotRow) {
  return {
    path: r.path,
    ...(r.scope !== "all" ? { scope: r.scope === "own" ? "files directly in this folder" : r.scope === "rest" ? "smaller subfolders together" : `group of ${r.groupCount} sibling folders` } : {}),
    new: formatBytes(r.newBytes),
    changed_growth_unknown: formatBytes(r.changedBytes),
    label: labelOf(r),
    what: r.what,
    ...(r.owner && !r.known ? { owner_hint: r.owner } : {}),
  };
}

function candidateOut(c: CandidateRow, rank: number) {
  return { rank, path: c.path, size: formatBytes(c.bytes), new: formatBytes(c.newBytes), changed_growth_unknown: formatBytes(c.changedBytes), label: labelOf(c), reason: c.reason, reclaim: c.reclaim, ...(c.command ? { command: c.command } : {}), ...(c.notes ? { notes: c.notes } : {}) };
}

export function buildMcpServer(core: DiskDeltaCore, version: string): McpServer {
  const server = new McpServer(
    { name: "diskdelta", version },
    {
      instructions:
        "DiskDelta: read-only disk usage for Windows. Answers what was added to a drive recently and what is safe to remove. " +
        "Nothing can be deleted, moved or changed through these tools; propose actions and let the user carry them out. " +
        "Start with drive_overview. what_grew and cleanup_plan scan the given path on demand: a whole drive can take minutes, so prefer a narrower folder (for example the user's profile or AppData) when you can. " +
        "Labels: safe (rebuilt or re-downloaded when needed), check_first (the user must decide), do_not_touch (removing breaks something), unknown (no rule; check first). " +
        "'new' is the size of files created in the window. 'changed_growth_unknown' is the full size of older files modified in the window; how much they grew is unknown. The two are separate figures; never add them together or call their sum growth." +
        (core.mode === "demo" ? " DEMO MODE: all data is a fictional PC." : ""),
    },
  );

  function tool<S extends z.ZodObject>(name: string, description: string, inputSchema: S, run: (args: z.infer<S>) => Promise<Record<string, unknown>>) {
    server.registerTool(name, { description, inputSchema, annotations: READ }, (async (args: z.infer<S>) => {
      try {
        return ok(await run(args));
      } catch (exc) {
        if (exc instanceof CoreError) return fail(exc.message);
        return fail(`Unexpected error (${exc instanceof Error ? exc.message : "Error"}).`);
      }
    }) as never);
  }

  tool(
    "drive_overview",
    "Read-only. List every drive on this PC with label, type (fixed, removable, network, cloud), size, used, free and how full it is, plus which folders were already scanned in this session. Use this first.",
    z.object({}),
    async () => {
      const drives = await core.listDrives();
      return {
        mode: core.mode,
        drives: drives.map((d) => ({
          drive: d.root,
          label: d.label,
          type: d.type,
          size: formatBytes(d.size),
          used: formatBytes(d.used),
          free: formatBytes(d.free),
          used_pct: d.usedPct,
          scanned_by_default: d.scanByDefault,
          ...(d.remotePath ? { remote: d.remotePath } : {}),
        })),
        scans: core.scans().map((s) => ({ root: s.root, finished: s.finishedAt, took: formatDuration(s.durationMs), files: formatCount(s.files), size: formatBytes(s.bytes), skipped: s.skipped })),
      };
    },
  );

  tool(
    "what_grew",
    "Read-only. What was added or changed under a folder or drive in the last N days, as non-overlapping rows ranked by new bytes (folder, new bytes, separately the changed bytes with growth unknown, label, what it is), plus big old files that changed recently (growth amount unknown). Scans the path if it was not scanned in the last 15 minutes; a whole drive can take minutes.",
    z.object({ path: Path, days: Days, limit: Limit }),
    async ({ path, days, limit }) => {
      const scan = await core.ensureScanned(path);
      const g = core.whatGrew(path, { days, limit });
      const changed = core.changedOld(path, { days, limit: Math.min(limit, 10) });
      return {
        path: g.path,
        days: g.days,
        window_start: g.windowStart.slice(0, 10),
        scan: { root: scan.root, finished: scan.finishedAt, files: formatCount(scan.files), skipped: scan.skipped },
        total_new: formatBytes(g.total.newBytes),
        total_new_files: formatCount(g.total.newFiles),
        total_changed_growth_unknown: formatBytes(g.total.changedBytes),
        total_changed_files: formatCount(g.total.changedFiles),
        rows: g.rows.map(hotspotOut),
        changed_recently_growth_unknown: changed.files.map(fileOut),
      };
    },
  );

  tool(
    "explain",
    "Read-only. Explain one folder or file path: what it is, which app probably owns it, its label (safe, check_first, do_not_touch, unknown) and how to reclaim the space, preferring the owning app's own command. Adds size, new bytes and (separately) changed bytes if the path was scanned. Does not scan.",
    z.object({ path: Path }),
    async ({ path }) => {
      const e = core.explain(path, { days: 30 });
      const c = e.classification;
      return {
        path: e.path,
        label: labelOf(c),
        what: c.what,
        owner_hint: c.owner,
        reclaim: c.reclaim,
        ...(c.command ? { command: c.command } : {}),
        ...(c.notes ? { notes: c.notes } : {}),
        rule: c.ruleId,
        ...(c.matchedPath && c.matchedPath.toLowerCase() !== e.path.toLowerCase() ? { inside: c.matchedPath } : {}),
        scanned: e.scanned,
        ...(e.size
          ? {
              size: formatBytes(e.size.bytes),
              files: formatCount(e.size.files),
              new_last_30_days: formatBytes(e.size.newBytes),
              changed_last_30_days_growth_unknown: formatBytes(e.size.changedBytes),
              biggest_inside: (e.biggestInside ?? []).slice(0, 5).map((r) => ({ name: r.name, size: formatBytes(r.bytes), label: labelOf(r) })),
            }
          : { hint: "Not scanned yet. Call what_grew or cleanup_plan on this path (or a folder above it) to get sizes." }),
      };
    },
  );

  tool(
    "cleanup_plan",
    "Read-only. A ranked list of cleanup candidates under a folder or drive: safe items first, then check_first, then large unknown folders, each with size, new bytes and (separately) changed bytes in the window, label, reason and how to reclaim it. Proposes only; DiskDelta never deletes. Scans the path if it was not scanned in the last 15 minutes.",
    z.object({ path: Path, days: Days, limit: Limit }),
    async ({ path, days, limit }) => {
      await core.ensureScanned(path);
      const p = core.cleanupPlan(path, { days, limit });
      return { path: p.path, days: p.days, total_of_listed: formatBytes(p.totalCandidateBytes), note: p.note, candidates: p.candidates.map((c, i) => candidateOut(c, i + 1)) };
    },
  );

  return server;
}
