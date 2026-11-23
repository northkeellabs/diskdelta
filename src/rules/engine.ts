// PatternRulesEngine: labels a path with the rules in rules/rules.json.
//
// How a label is chosen (documented in README "How it decides what is safe"):
// 1. Every rule pattern is expanded with this PC's environment (%TEMP% etc.) and tested against the path and each of
//    its parent folders. A rule matches a parent only if it "inherits" (the default).
// 2. The most specific match wins: the deepest matched folder; then the pattern with more literal segments; then
//    the rule that comes first in the file.
// 3. Floating rules (patterns starting with **, such as node_modules) cannot override a do_not_touch folder above
//    them: node_modules inside Program Files stays do_not_touch.
// 4. Inside a folder whose rule has cap_inside (personal folders), nothing is labelled safe; safe becomes check_first.
// 5. No match: "unknown - check first", with an owner hint taken from the AppData / ProgramData / Program Files path.

import type { Classification, ClassifyContext, Label, RulesEngine } from "../core/types.ts";
import { normalize, segments } from "../util/winpath.ts";

export interface RuleExample {
  path: string;
  siblings: string[];
}

export interface Rule {
  id: string;
  category: string;
  kind?: "path" | "sibling_group";
  min_siblings?: number;
  match: string[];
  label: Label;
  what: string;
  reclaim: string;
  /** The command the page offers to copy; it also appears in reclaim. */
  command?: string;
  notes?: string;
  inherit?: boolean;
  cap_inside?: "check_first";
  candidate?: boolean;
  descend?: boolean;
  examples: { match: Array<string | RuleExample>; no_match: Array<string | RuleExample> };
}

export interface RulesFile {
  version: 1;
  rules: Rule[];
}

type Seg = { t: "lit"; v: string } | { t: "glob"; re: RegExp } | { t: "any" } | { t: "drive" };

interface Compiled {
  rule: Rule;
  index: number;
  segs: Seg[];
  floating: boolean;
  literals: number;
}

export const ENV_ROOTS = ["TEMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "WINDIR", "SYSTEMDRIVE"] as const;

/** Reads the environment roots the rules use. Keys are upper-case; values are normalized paths. */
export function envRoots(env: Record<string, string | undefined>): Record<string, string> {
  const get = (k: string) => {
    const hit = Object.keys(env).find((x) => x.toUpperCase() === k);
    return hit ? env[hit] : undefined;
  };
  const out: Record<string, string> = {};
  for (const k of ENV_ROOTS) {
    let v = get(k);
    if (!v && k === "TEMP") v = get("TMP");
    if (!v && k === "WINDIR") v = get("SYSTEMROOT");
    if (v) out[k] = normalize(v);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&");

function compileSeg(s: string): Seg {
  if (s === "**") return { t: "any" };
  if (s.includes("*")) return { t: "glob", re: new RegExp("^" + s.split("*").map(escapeRe).join(".*") + "$", "i") };
  return { t: "lit", v: s.toLowerCase() };
}

/**
 * Compiles one pattern. Patterns rooted in the current user's profile (%USERPROFILE%, %LOCALAPPDATA%, %APPDATA%,
 * %TEMP% when it lies in the profile) also get a second form that matches the same place in any other profile
 * under <drive>:\Users\<name>, so other accounts' caches and personal folders are labelled too.
 */
function compilePattern(p: string, roots: Record<string, string>): Array<{ segs: Seg[]; floating: boolean }> {
  const parts = p.split("\\").filter((x) => x.length > 0);
  const head = parts[0];
  const tail = parts.slice(1).map(compileSeg);
  const env = /^%(.+)%$/.exec(head);
  if (env) {
    const v = roots[env[1].toUpperCase()];
    if (!v) return [];
    const own: Seg[] = segments(v).map((s) => ({ t: "lit", v: s.toLowerCase() }));
    const out = [{ segs: [...own, ...tail], floating: false }];
    const profile = roots.USERPROFILE ? segments(roots.USERPROFILE) : null;
    const vs = segments(v);
    if (profile && profile.length === 3 && profile[1].toLowerCase() === "users" && vs.length >= 3 && profile.every((s, i) => vs[i]?.toLowerCase() === s.toLowerCase())) {
      const anyProfile: Seg[] = [{ t: "drive" }, { t: "lit", v: "users" }, { t: "glob", re: /^.*$/ }, ...vs.slice(3).map((s): Seg => ({ t: "lit", v: s.toLowerCase() }))];
      out.push({ segs: [...anyProfile, ...tail], floating: false });
    }
    return out;
  }
  if (head === "?:") return [{ segs: [{ t: "drive" }, ...tail], floating: false }];
  if (head === "**") return [{ segs: [{ t: "any" }, ...tail], floating: true }];
  return [];
}

function segMatch(seg: Seg, s: string): boolean {
  switch (seg.t) {
    case "lit":
      return seg.v === s.toLowerCase();
    case "glob":
      return seg.re.test(s);
    case "drive":
      return /^[a-z]:$/i.test(s);
    case "any":
      return true;
  }
}

/** Full match of pattern segments against path segments. */
function matchAll(pat: Seg[], path: string[], pi = 0, si = 0): boolean {
  if (pi === pat.length) return si === path.length;
  const seg = pat[pi];
  if (seg.t === "any") {
    for (let k = si; k <= path.length; k++) if (matchAll(pat, path, pi + 1, k)) return true;
    return false;
  }
  if (si >= path.length) return false;
  return segMatch(seg, path[si]) && matchAll(pat, path, pi + 1, si + 1);
}

/** Groups temp-folder names by shared prefix (at least 3 characters). Returns the prefix and group size, or null. */
export function siblingGroup(name: string, siblings: string[], min: number): { prefix: string; count: number } | null {
  const lower = name.toLowerCase();
  if (lower.length < 4) return null;
  const head = lower.slice(0, 3);
  const members = Array.from(new Set(siblings.map((s) => s.toLowerCase()).concat(lower))).filter((s) => s.startsWith(head));
  if (members.length < min) return null;
  let prefix = members[0];
  for (const m of members) {
    let i = 0;
    while (i < prefix.length && i < m.length && prefix[i] === m[i]) i++;
    prefix = prefix.slice(0, i);
  }
  if (prefix.length < 3) return null;
  return { prefix: name.slice(0, prefix.length), count: members.length };
}

const VENDORS = new Set(["microsoft", "google", "mozilla", "adobe", "apple", "jetbrains", "nvidia", "nvidia corporation", "intel", "amd", "bravesoftware", "packages", "programs"]);

/** "Which app owns this?" from the folder right below an app-data or program root. */
export function ownerHint(path: string, roots: Record<string, string>): string | null {
  const segs = segments(path);
  const bases: string[] = [];
  for (const k of ["LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"]) if (roots[k]) bases.push(roots[k]);
  if (roots.USERPROFILE) bases.push(normalize(roots.USERPROFILE + "\\AppData\\LocalLow"));
  let best: string[] | null = null;
  for (const b of bases) {
    const bs = segments(b);
    if (segs.length > bs.length && bs.every((s, i) => s.toLowerCase() === segs[i].toLowerCase())) {
      if (!best || bs.length > best.length) best = bs;
    }
  }
  if (best) {
    const first = segs[best.length];
    const second = segs[best.length + 1];
    const f = first.toLowerCase();
    if (f === "packages" && second) return second.replace(/_[a-z0-9]{13}$/i, "");
    if (f === "programs" && second) return second;
    if (VENDORS.has(f) && second) return `${first} ${second}`;
    return first;
  }
  // another account's app data: <drive>:\Users\<name>\AppData\Local|Roaming|LocalLow\<app>
  if (segs.length >= 6 && segs[1].toLowerCase() === "users" && segs[3].toLowerCase() === "appdata" && /^(local|roaming|locallow)$/i.test(segs[4])) {
    const first = segs[5];
    const f = first.toLowerCase();
    if ((f === "packages" || f === "programs") && segs[6]) return f === "packages" ? segs[6].replace(/_[a-z0-9]{13}$/i, "") : segs[6];
    if (VENDORS.has(f) && segs[6]) return `${first} ${segs[6]}`;
    return first;
  }
  if (roots.USERPROFILE) {
    const us = segments(roots.USERPROFILE);
    if (segs.length > us.length && us.every((s, i) => s.toLowerCase() === segs[i].toLowerCase())) {
      const first = segs[us.length];
      if (first.startsWith(".") && first.length > 1) return first.slice(1);
    }
  }
  return null;
}

export class PatternRulesEngine implements RulesEngine {
  private readonly compiled: Compiled[] = [];
  readonly roots: Record<string, string>;

  constructor(readonly file: RulesFile, env: Record<string, string | undefined>) {
    this.roots = envRoots(env);
    file.rules.forEach((rule, index) => {
      for (const p of rule.match) {
        for (const c of compilePattern(p, this.roots)) {
          const literals = c.segs.filter((s) => s.t === "lit").length;
          this.compiled.push({ rule, index, segs: c.segs, floating: c.floating, literals });
        }
      }
    });
  }

  get size(): number {
    return this.file.rules.length;
  }

  classify(pathIn: string, ctx: ClassifyContext = {}): Classification {
    const path = normalize(pathIn);
    const segs = segments(path);
    type Hit = { c: Compiled; depth: number; group?: { prefix: string; count: number } };
    const hits: Hit[] = [];
    for (const c of this.compiled) {
      const inherit = c.rule.inherit !== false && c.rule.kind !== "sibling_group";
      for (let depth = segs.length; depth >= 1; depth--) {
        if (depth < segs.length && !inherit) break;
        if (!matchAll(c.segs, segs.slice(0, depth))) continue;
        if (c.rule.kind === "sibling_group") {
          const g = ctx.siblingNames ? siblingGroup(segs[depth - 1], ctx.siblingNames, c.rule.min_siblings ?? 5) : null;
          if (!g) continue;
          hits.push({ c, depth, group: g });
        } else hits.push({ c, depth });
        break;
      }
    }
    // A do_not_touch folder blocks floating (**) rules below it that would give a softer label.
    const dntDepth = Math.min(...hits.filter((h) => h.c.rule.label === "do_not_touch").map((h) => h.depth), Infinity);
    const usable = hits.filter((h) => !(h.c.floating && h.c.rule.label !== "do_not_touch" && h.depth > dntDepth));
    usable.sort((a, b) => b.depth - a.depth || b.c.literals - a.c.literals || a.c.index - b.c.index);
    const win = usable[0];
    const capRule = hits.find((h) => h.c.rule.cap_inside);
    const owner = ownerHint(path, this.roots);

    if (!win) {
      return {
        path,
        label: "check_first",
        known: false,
        ruleId: null,
        category: null,
        what: owner ? `Unknown folder, probably belongs to ${owner}.` : "Unknown folder. DiskDelta has no rule for it.",
        reclaim: owner ? `Check what ${owner} is before removing anything; prefer its own uninstall or cleanup option.` : "Check what it is before removing anything.",
        notes: "",
        command: null,
        owner,
        matchedPath: null,
        capped: false,
        candidate: true,
        descend: true,
      };
    }
    const r = win.c.rule;
    let label: Label = r.label;
    let capped = false;
    if (label === "safe" && capRule) {
      label = capRule.c.rule.cap_inside!;
      capped = true;
    }
    const matchedPath = normalize(segs.slice(0, win.depth).join("\\"));
    let what = r.what;
    if (win.group) what = `${r.what} (${win.group.count} folders starting with "${win.group.prefix}")`;
    let notes = r.notes ?? "";
    if (capped) notes = [notes, "Inside a personal folder, so it is not labelled safe even though this kind of folder usually is."].filter(Boolean).join(" ");
    return {
      path,
      label,
      known: true,
      ruleId: r.id,
      category: r.category,
      what,
      reclaim: r.reclaim,
      command: r.command ?? null,
      notes,
      owner,
      matchedPath: /^[A-Z]:$/.test(matchedPath) ? matchedPath + "\\" : matchedPath,
      capped,
      candidate: label !== "do_not_touch" && r.candidate !== false,
      descend: r.descend === true || win.depth < segs.length,
      ...(win.group ? { group: win.group } : {}),
    };
  }
}
