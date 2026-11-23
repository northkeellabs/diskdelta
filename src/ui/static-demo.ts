// Static browser demo: the same page and the same Core API, running entirely in the browser on the fictional
// demo PC. No server, no disk access, no network. Built into docs/demo/index.html by scripts/build-demo-site.mjs
// for hosting as a plain static file (for example at northkeellabs.com/diskdelta).

import { DiskDeltaCore } from "../core/api.ts";
import type { Snapshot, SnapshotInfo, SnapshotStore } from "../core/types.ts";
import { RULES_TEXT } from "../generated/assets.ts";
import { PatternRulesEngine, type RulesFile } from "../rules/engine.ts";
import { DEMO_ENV, DemoDriveProvider, DemoScanner } from "../scanner/demo.ts";
import { VERSION } from "../version.ts";
import { handleApi } from "./routes.ts";

/** The browser demo keeps no snapshots. */
class NoSnapshotStore implements SnapshotStore {
  async save(s: Snapshot): Promise<SnapshotInfo> {
    return { id: "browser-demo", root: s.root, createdAt: s.createdAt, bytes: 0 };
  }
  async list(): Promise<SnapshotInfo[]> {
    return [];
  }
  async load(): Promise<Snapshot> {
    throw new Error("The browser demo keeps no snapshots.");
  }
}

const core = new DiskDeltaCore({
  mode: "demo",
  drives: new DemoDriveProvider(),
  scanner: new DemoScanner(Date.now, 120),
  rules: new PatternRulesEngine(JSON.parse(RULES_TEXT) as RulesFile, DEMO_ENV),
  snapshots: new NoSnapshotStore(),
});

(globalThis as any).DISKDELTA_STATIC = {
  version: VERSION,
  async api(method: string, path: string, params: Record<string, string>, body: unknown) {
    const r = await handleApi(core, { version: VERSION, env: DEMO_ENV, allowExport: false }, { method, path, query: new URLSearchParams(params), body });
    return r ?? { status: 404, body: { error: "Not found." } };
  },
  onEvent(fn: (e: { type: string; job: unknown }) => void) {
    return core.onEvent(fn);
  },
};
