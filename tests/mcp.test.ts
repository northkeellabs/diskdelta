import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCore, VERSION } from "../src/app.ts";
import { buildMcpServer } from "../src/mcp/server.ts";

const NOW = Date.UTC(2026, 10, 23, 12);
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}, c = client) {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: r.structuredContent as any, text: (r.content as any)?.[0]?.text ?? "" };
}

beforeAll(async () => {
  const core = createCore({ demo: true, clock: () => NOW });
  const server = buildMcpServer(core, VERSION);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "diskdelta-test", version: "1.0.0" });
  await client.connect(ct);
});
afterAll(async () => {
  await client?.close();
});

describe("MCP tools (in-memory, demo data)", () => {
  it("lists exactly the four tools, all read-only, and says read-only in every description", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["cleanup_plan", "drive_overview", "explain", "what_grew"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect(t.description, t.name).toMatch(/^Read-only\./);
    }
  });

  it("server instructions say nothing can be deleted", () => {
    expect(client.getInstructions?.() ?? "").toMatch(/Nothing can be deleted/);
  });

  it("drive_overview returns human-readable sizes and types", async () => {
    const r = await call("drive_overview");
    expect(r.isError).toBe(false);
    expect(r.data.mode).toBe("demo");
    const c = r.data.drives.find((d: any) => d.drive === "C:\\");
    expect(c.size).toBe("476 GB");
    expect(c.type).toBe("fixed");
    expect(r.data.drives.find((d: any) => d.type === "network").scanned_by_default).toBe(false);
  });

  it("what_grew scans on demand and returns labelled rows plus changed files with unknown growth", async () => {
    const r = await call("what_grew", { path: "C:\\Users\\demo", days: 30, limit: 10 });
    expect(r.isError).toBe(false);
    expect(r.data.rows.length).toBeGreaterThan(3);
    expect(r.data.rows.length).toBeLessThanOrEqual(10);
    const models = r.data.rows.find((x: any) => x.path.endsWith(".ollama\\models"));
    expect(models.label).toBe("check_first");
    expect(models.new).toMatch(/GB$/);
    expect(r.data.changed_recently_growth_unknown.map((f: any) => f.path)).toEqual(expect.arrayContaining([expect.stringMatching(/docker_data\.vhdx$/)]));
    expect(r.data.total_new).toMatch(/GB$/);
    expect(r.data.total_changed_growth_unknown).toMatch(/GB$/);
    expect(JSON.stringify(r.data)).not.toMatch(/total_recent|"recent"/);
  });

  it("explain gives label, owner and reclaim, with sizes once scanned", async () => {
    const vm = await call("explain", { path: "C:\\Users\\demo\\AppData\\Roaming\\Claude\\vm_bundles" });
    expect(vm.data.label).toBe("do_not_touch");
    expect(vm.data.scanned).toBe(true);
    const unk = await call("explain", { path: "C:\\Users\\demo\\AppData\\Local\\Fooware" });
    expect(unk.data.label).toBe("unknown");
    expect(unk.data.owner_hint).toBe("Fooware");
    const notScanned = await call("explain", { path: "D:\\Renders" });
    expect(notScanned.data.scanned).toBe(false);
    expect(notScanned.data.hint).toMatch(/Not scanned/);
  });

  it("cleanup_plan ranks candidates and never includes do_not_touch", async () => {
    const r = await call("cleanup_plan", { path: "C:\\", days: 30, limit: 30 });
    expect(r.isError).toBe(false);
    expect(r.data.candidates[0].rank).toBe(1);
    expect(r.data.candidates[0].label).toBe("safe");
    expect(r.data.candidates.some((c: any) => c.label === "do_not_touch")).toBe(false);
    expect(r.data.note).toMatch(/never deletes/);
  });

  it("rejects bad input before any code runs", async () => {
    const rel = await call("what_grew", { path: "Users\\demo" });
    expect(rel.isError).toBe(true);
    const days = await call("what_grew", { path: "C:\\", days: 9999 });
    expect(days.isError).toBe(true);
    const missing = await call("cleanup_plan", { path: "C:\\No\\Such\\Folder" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/not found/i);
  });
});

describe("MCP over stdio (the real program, --demo)", () => {
  let stdioClient: Client;
  beforeAll(async () => {
    mkdirSync("node_modules/.cache/test-bin", { recursive: true });
    const outfile = resolve("node_modules/.cache/test-bin/cli.mjs");
    await build({ entryPoints: ["src/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile, packages: "external", logLevel: "warning" });
    stdioClient = new Client({ name: "diskdelta-stdio-test", version: "1.0.0" });
    await stdioClient.connect(new StdioClientTransport({ command: process.execPath, args: [outfile, "mcp", "--demo"] }));
  });
  afterAll(async () => {
    await stdioClient?.close();
  });

  it("answers drive_overview and what_grew over stdio", async () => {
    const d = await call("drive_overview", {}, stdioClient);
    expect(d.data.drives.length).toBe(5);
    const g = await call("what_grew", { path: "D:\\", days: 30 }, stdioClient);
    expect(g.isError).toBe(false);
    expect(g.data.rows[0].path).toMatch(/^D:\\/);
  });
});
