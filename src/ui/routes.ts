// The page's API as a plain function over the Core API. Used by the local HTTP server (src/ui/server.ts) and by the
// static browser demo (src/ui/static-demo.ts), so both serve exactly the same answers.

import { CoreError, type DiskDeltaCore } from "../core/api.ts";

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: any;
}

export interface ApiResult {
  status: number;
  body: unknown;
  type?: string;
}

export interface RouteContext {
  version: string;
  env: Record<string, string | undefined>;
  /** false in the static demo: there is no disk to write a report to (the page downloads it instead). */
  allowExport: boolean;
}

const num = (v: string | null, d: number) => (v === null || v === "" ? d : Number(v));

/** Answers one API call. Returns null for an unknown route. CoreError becomes a 400 with its message. */
export async function handleApi(core: DiskDeltaCore, ctx: RouteContext, req: ApiRequest): Promise<ApiResult | null> {
  const { method, path: p, query: q } = req;
  const ok = (body: unknown, type?: string): ApiResult => ({ status: 200, body, ...(type ? { type } : {}) });
  try {
    if (method === "GET" && p === "/api/state") {
      return ok({ mode: core.mode, version: ctx.version, rules: core.rulesCount, job: core.job(), scans: core.scans(), exportSuggestion: { md: core.suggestedExportPath("md", ctx.env), html: core.suggestedExportPath("html", ctx.env) } });
    }
    if (method === "GET" && p === "/api/drives") return ok(await core.listDrives());
    if (method === "POST" && p === "/api/scan") {
      const targets = req.body?.targets;
      if (!Array.isArray(targets) || targets.some((x: unknown) => typeof x !== "string")) throw new CoreError("targets must be a list of paths.");
      return ok(core.startScan(targets));
    }
    if (method === "POST" && p === "/api/cancel") return ok({ cancelled: core.cancelScan() });
    const path = q.get("path") ?? "";
    const days = num(q.get("days"), 30);
    if (method === "GET") {
      switch (p) {
        case "/api/folder":
          return ok(core.folder(path, { days, limit: num(q.get("limit"), 500) }));
        case "/api/grew":
          return ok(core.whatGrew(path, { days, limit: num(q.get("limit"), 50) }));
        case "/api/timeline":
          return ok(core.timeline(path, { days }));
        case "/api/timeline-day":
          return ok(core.timelineDay(path, { age: num(q.get("age"), 1), limit: num(q.get("limit"), 10) }));
        case "/api/changed":
          return ok(core.changedOld(path, { days, limit: num(q.get("limit"), 50) }));
        case "/api/largest":
          return ok(core.largestFiles(path, { limit: num(q.get("limit"), 100) }));
        case "/api/treemap":
          return ok(core.treemap(path, { days, depth: num(q.get("depth"), 2), maxChildren: num(q.get("max"), 40) }));
        case "/api/cleanup":
          return ok(core.cleanupPlan(path, { days, limit: num(q.get("limit"), 50) }));
        case "/api/explain":
          return ok(core.explain(path, { days }));
        case "/api/skipped":
          return ok(core.skipped({ limit: num(q.get("limit"), 500) }));
        case "/api/report": {
          const format = q.get("format") === "html" ? "html" : "md";
          return ok(await core.report(format, { days }), format === "html" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8");
        }
      }
    }
    if (method === "POST" && p === "/api/export") {
      if (!ctx.allowExport) throw new CoreError("Saving to a path is not available in the browser demo.");
      const b = req.body ?? {};
      const format = b.format === "html" ? "html" : b.format === "md" ? "md" : null;
      if (!format) throw new CoreError("format must be md or html.");
      if (typeof b.path !== "string") throw new CoreError("path is required.");
      return ok(await core.exportReport(format, b.path, { days: Number(b.days ?? 30) }));
    }
    return null;
  } catch (e) {
    if (e instanceof CoreError) return { status: 400, body: { error: e.message } };
    return { status: 500, body: { error: "Unexpected error.", detail: e instanceof Error ? e.message : String(e) } };
  }
}
