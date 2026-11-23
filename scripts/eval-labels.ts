// Label eval: runs every path in tests/eval/paths.json through the rules engine with the file's fictional
// environment and reports accuracy per expected label. Appends each run to tests/eval/eval-output.txt.
// Exit code 1 when any case fails.
//   npm run eval

import { appendFileSync, readFileSync } from "node:fs";
import { PatternRulesEngine, type RulesFile } from "../src/rules/engine.ts";

interface Case {
  path: string;
  expected: "safe" | "check_first" | "do_not_touch" | "unknown";
  owner?: string;
  /** Expected rule id, when the case also checks which rule labelled it. */
  rule?: string;
  group?: boolean;
  siblings?: string[];
  note?: string;
}

const data = JSON.parse(readFileSync("tests/eval/paths.json", "utf8")) as { env: Record<string, string>; cases: Case[] };
const rules = JSON.parse(readFileSync("rules/rules.json", "utf8")) as RulesFile;
const engine = new PatternRulesEngine(rules, data.env);

const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  console.log(s);
};
const per = new Map<string, { ok: number; total: number }>();
let failures = 0;
let ownerChecks = 0;
let ownerOk = 0;

log(`Label eval ${new Date().toISOString()}  rules: ${engine.size}  cases: ${data.cases.length}`);
for (const c of data.cases) {
  const r = engine.classify(c.path, c.siblings ? { siblingNames: c.siblings } : {});
  const got = r.known ? r.label : "unknown";
  const stat = per.get(c.expected) ?? { ok: 0, total: 0 };
  stat.total++;
  let pass = got === c.expected;
  if (c.group && !r.group) pass = false;
  if (c.rule && r.ruleId !== c.rule) pass = false;
  if (pass) stat.ok++;
  per.set(c.expected, stat);
  let ownerNote = "";
  if (c.owner !== undefined) {
    ownerChecks++;
    if (r.owner === c.owner) ownerOk++;
    else ownerNote = `  owner expected "${c.owner}", got "${r.owner}"`;
  }
  if (!pass || ownerNote) {
    failures += pass ? 0 : 1;
    log(`${pass ? "PASS" : "FAIL"}  ${c.path}  expected ${c.expected}${c.group ? " (group)" : ""}, got ${got}${r.group ? " (group)" : ""} via ${r.ruleId ?? "-"}${c.rule ? ` (expected rule ${c.rule})` : ""}${ownerNote}`);
  }
}
log("Accuracy per expected label:");
for (const k of ["safe", "check_first", "do_not_touch", "unknown"]) {
  const s = per.get(k) ?? { ok: 0, total: 0 };
  log(`  ${k.padEnd(13)} ${s.ok}/${s.total}  ${s.total ? ((100 * s.ok) / s.total).toFixed(1) : "-"}%`);
}
const total = data.cases.length;
log(`  overall       ${total - failures}/${total}  ${((100 * (total - failures)) / total).toFixed(1)}%`);
log(`  owner hints   ${ownerOk}/${ownerChecks}`);
appendFileSync("tests/eval/eval-output.txt", lines.join("\n") + "\n\n");
process.exit(failures > 0 || ownerOk < ownerChecks ? 1 : 0);
