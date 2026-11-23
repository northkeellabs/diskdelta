import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.ts";

describe("version", () => {
  it("src/version.ts matches package.json (the exe, the MCP server and the page all show it)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("package-lock.json carries the same version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });
});
