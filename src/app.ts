// Composition root: picks the module implementations for live or demo mode and builds the Core API.
// The only file that knows every concrete implementation.

import { join } from "node:path";
import { DiskDeltaCore } from "./core/api.ts";
import { WindowsDriveProvider } from "./drives/windows.ts";
import { RULES_TEXT } from "./generated/assets.ts";
import { PatternRulesEngine, type RulesFile } from "./rules/engine.ts";
import { DEMO_ENV, DemoDriveProvider, DemoScanner } from "./scanner/demo.ts";
import { WalkScanner } from "./scanner/walk.ts";
import { FileSnapshotStore, MemorySnapshotStore } from "./snapshot/store.ts";

export { VERSION } from "./version.ts";

export interface AppOptions {
  demo: boolean;
  env?: Record<string, string | undefined>;
  /** Folder for snapshots. Default %LOCALAPPDATA%\DiskDelta. Ignored in demo mode (snapshots stay in memory). */
  dataDir?: string;
  clock?: () => number;
}

export function loadRules(): RulesFile {
  return JSON.parse(RULES_TEXT) as RulesFile;
}

export function defaultDataDir(env: Record<string, string | undefined>): string | null {
  if (env.DISKDELTA_DATA_DIR) return env.DISKDELTA_DATA_DIR;
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "DiskDelta") : null;
}

export function createCore(o: AppOptions): DiskDeltaCore {
  const env = o.env ?? process.env;
  if (o.demo) {
    return new DiskDeltaCore({
      mode: "demo",
      drives: new DemoDriveProvider(),
      scanner: new DemoScanner(o.clock, Math.max(0, Number(env.DISKDELTA_DEMO_DELAY_MS ?? 0) || 0)),
      rules: new PatternRulesEngine(loadRules(), DEMO_ENV),
      snapshots: new MemorySnapshotStore(),
      clock: o.clock,
    });
  }
  const dataDir = o.dataDir ?? defaultDataDir(env);
  return new DiskDeltaCore({
    mode: "live",
    drives: new WindowsDriveProvider(),
    scanner: new WalkScanner(),
    rules: new PatternRulesEngine(loadRules(), env),
    snapshots: dataDir ? new FileSnapshotStore(join(dataDir, "snapshots"), 10) : new MemorySnapshotStore(),
    clock: o.clock,
  });
}

export function envFor(demo: boolean): Record<string, string | undefined> {
  return demo ? DEMO_ENV : process.env;
}
