import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ownerHint, PatternRulesEngine, siblingGroup, type RuleExample, type RulesFile } from "../src/rules/engine.ts";
import { FICTIONAL_ENV } from "./helpers.ts";

const rules = JSON.parse(readFileSync("rules/rules.json", "utf8")) as RulesFile;
const schema = JSON.parse(readFileSync("rules/rules.schema.json", "utf8"));
const engine = new PatternRulesEngine(rules, FICTIONAL_ENV);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function validator() {
  const ajv = new (Ajv as any)({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

/** Expands %VAR% in an example with the fictional environment. */
function expand(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, k: string) => FICTIONAL_ENV[k.toUpperCase()] ?? `%${k}%`);
}
const asExample = (e: string | RuleExample): RuleExample => (typeof e === "string" ? { path: e, siblings: [] } : e);

describe("rules file schema", () => {
  it("rules/rules.json is valid", () => {
    const v = validator();
    const ok = v(rules);
    expect(v.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects a missing field, an unknown field, a bad label and a bad pattern", () => {
    const v = validator();
    const bad = clone(rules);
    delete (bad.rules[0] as any).reclaim;
    (bad.rules[1] as any).surprise = 1;
    (bad.rules[2] as any).label = "maybe";
    bad.rules[3].match = ["Users\\*\\Temp"];
    expect(v(bad)).toBe(false);
    const msg = JSON.stringify(v.errors);
    expect(msg).toContain("reclaim");
    expect(msg).toContain("additional");
    expect(msg).toContain("/rules/2/label");
    expect(msg).toContain("/rules/3/match/0");
  });

  it("requires min_siblings for a sibling_group rule and at least one example of each kind", () => {
    const v = validator();
    const bad = clone(rules);
    const g = bad.rules.find((r) => r.kind === "sibling_group")!;
    delete g.min_siblings;
    bad.rules[0].examples.no_match = [];
    expect(v(bad)).toBe(false);
    const msg = JSON.stringify(v.errors);
    expect(msg).toContain("min_siblings");
    expect(msg).toContain("no_match");
  });

  it("a rule's copyable command appears word for word in its reclaim text", () => {
    const withCmd = rules.rules.filter((r) => r.command);
    expect(withCmd.length).toBeGreaterThanOrEqual(10);
    for (const r of withCmd) expect(r.reclaim, r.id).toContain(r.command!);
    expect(engine.classify("C:\\hiberfil.sys").command).toBe("powercfg /h off");
    expect(engine.classify("C:\\Users\\alex\\AppData\\Local\\Fooware").command).toBeNull();
  });

  it("rule ids are unique", () => {
    const ids = rules.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("every rule matches its positive examples and not its negative examples", () => {
  for (const r of rules.rules) {
    it(r.id, () => {
      for (const e of r.examples.match.map(asExample)) {
        const c = engine.classify(expand(e.path), { siblingNames: e.siblings });
        expect(c.ruleId, `${e.path} should match ${r.id}`).toBe(r.id);
      }
      for (const e of r.examples.no_match.map(asExample)) {
        const c = engine.classify(expand(e.path), { siblingNames: e.siblings });
        expect(c.ruleId, `${e.path} should not match ${r.id}`).not.toBe(r.id);
      }
    });
  }
});

describe("label decisions", () => {
  const L = (p: string, siblings?: string[]) => engine.classify(p, siblings ? { siblingNames: siblings } : {});

  it("nothing inside a personal folder is safe, even a node_modules or a cache", () => {
    const c = L("C:\\Users\\alex\\Documents\\projects\\webapp\\node_modules");
    expect(c.ruleId).toBe("node-modules");
    expect(c.label).toBe("check_first");
    expect(c.capped).toBe(true);
    expect(L("C:\\Users\\alex\\OneDrive - Contoso\\Slack\\Cache").label).toBe("check_first");
    for (const p of ["Documents", "Desktop", "Pictures", "Videos", "Music", "Downloads"]) expect(L(`C:\\Users\\alex\\${p}`).label).toBe("check_first");
  });

  it("a floating rule cannot soften a do_not_touch folder above it", () => {
    const c = L("C:\\Program Files\\nodejs\\node_modules");
    expect(c.label).toBe("do_not_touch");
    expect(c.ruleId).toBe("program-files");
    expect(L("C:\\Users\\alex\\AppData\\Roaming\\Claude\\vm_bundles\\x\\node_modules").label).toBe("do_not_touch");
  });

  it("node_modules elsewhere is safe", () => {
    expect(L("D:\\code\\app\\node_modules").label).toBe("safe");
  });

  it("the deepest match wins: a cache inside a browser profile is safe, the profile is check_first", () => {
    expect(L("C:\\Users\\alex\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache").label).toBe("safe");
    expect(L("C:\\Users\\alex\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default").label).toBe("check_first");
  });

  it("unknown folders are check_first with an owner hint from the path", () => {
    const c = L("C:\\Users\\alex\\AppData\\Local\\Fooware\\data");
    expect(c.known).toBe(false);
    expect(c.label).toBe("check_first");
    expect(c.owner).toBe("Fooware");
    expect(c.what).toContain("Fooware");
    expect(ownerHint("C:\\Users\\alex\\AppData\\Local\\Packages\\Contoso.NotesApp_8wekyb3d8bbwe\\x", engine.roots)).toBe("Contoso.NotesApp");
    expect(ownerHint("C:\\Users\\alex\\AppData\\Local\\Microsoft\\Teams\\x", engine.roots)).toBe("Microsoft Teams");
    expect(ownerHint("C:\\Users\\alex\\.zephyrtool", engine.roots)).toBe("zephyrtool");
    expect(ownerHint("D:\\Renders", engine.roots)).toBeNull();
  });

  it("detects repeated temp folders by shared prefix, but not a lone temp folder", () => {
    const sib = ["vitest-aaaa", "vitest-bbbb", "vitest-cccc", "vitest-dddd", "vitest-eeee", "claude"];
    const c = L("C:\\Users\\alex\\AppData\\Local\\Temp\\vitest-aaaa", sib);
    expect(c.ruleId).toBe("temp-repeated-folders");
    expect(c.group).toEqual({ prefix: "vitest-", count: 5 });
    expect(L("C:\\Users\\alex\\AppData\\Local\\Temp\\vitest-aaaa", sib.slice(0, 3)).ruleId).toBe("windows-temp");
    expect(L("C:\\Users\\alex\\AppData\\Local\\Temp\\claude", sib).ruleId).toBe("temp-claude-code");
    expect(siblingGroup("ab1", ["ab2", "ab3", "ab4", "ab5"], 3)).toBeNull();
  });

  it("labels the same places in other accounts' profiles (found in the live run)", () => {
    expect(L("C:\\Users\\Another Person\\AppData\\Local\\NVIDIA\\DXCache").ruleId).toBe("shader-caches");
    expect(L("C:\\Users\\Another Person\\Documents\\x\\node_modules").label).toBe("check_first");
    expect(L("C:\\Users\\Another Person\\AppData\\Local\\Claude-Data\\claude_x\\vm_bundles").label).toBe("do_not_touch");
    expect(L("C:\\Users\\Another Person\\AppData\\Local\\Fooware").owner).toBe("Fooware");
    expect(L("C:\\Users\\Another Person").ruleId).toBe("container-user-profile");
  });

  it("is case-insensitive and accepts forward slashes", () => {
    expect(L("c:/users/ALEX/appdata/local/NPM-CACHE").ruleId).toBe("npm-cache");
  });

  it("rules with environment roots that are not set are skipped, not misapplied", () => {
    const e = new PatternRulesEngine(rules, { SYSTEMDRIVE: "C:" });
    expect(e.classify("C:\\Users\\alex\\AppData\\Local\\npm-cache").ruleId).toBeNull();
    expect(e.classify("C:\\pagefile.sys").ruleId).toBe("page-and-swap-files");
  });
});
