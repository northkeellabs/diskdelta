// Windows path helpers shared by all modules. Pure string functions, no file system access.
// Canonical form: backslashes, upper-case drive letter, no trailing backslash except on a drive root ("C:\").

export function normalize(p: string): string {
  let s = p.trim().replace(/\//g, "\\");
  if (s.startsWith("\\\\?\\")) s = s.slice(4);
  s = s.replace(/(?<!^)\\{2,}/g, "\\");
  if (/^[a-zA-Z]:$/.test(s)) s += "\\";
  if (/^[a-zA-Z]:\\/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (s.length > 3 && s.endsWith("\\")) s = s.replace(/\\+$/, "");
  return s;
}

export const key = (p: string): string => normalize(p).toLowerCase();

export function isAbsolute(p: string): boolean {
  const s = p.replace(/\//g, "\\");
  return /^[a-zA-Z]:\\/.test(s) || /^[a-zA-Z]:$/.test(s) || /^\\\\[^\\]+\\[^\\]+/.test(s);
}

export function join(dir: string, name: string): string {
  return dir.endsWith("\\") ? dir + name : dir + "\\" + name;
}

/** Path segments; a drive root "C:\" gives ["C:"]. */
export function segments(p: string): string[] {
  return normalize(p).split("\\").filter((x) => x.length > 0);
}

export function parent(p: string): string | null {
  const n = normalize(p);
  if (/^[A-Z]:\\$/.test(n)) return null;
  const i = n.lastIndexOf("\\");
  if (i < 0) return null;
  const up = n.slice(0, i);
  return /^[A-Z]:$/.test(up) ? up + "\\" : up;
}

export function basename(p: string): string {
  const n = normalize(p);
  if (/^[A-Z]:\\$/.test(n)) return n;
  return n.slice(n.lastIndexOf("\\") + 1);
}

/** True when `inner` is `outer` or lies inside it (case-insensitive). */
export function within(inner: string, outer: string): boolean {
  const a = key(inner);
  const b = key(outer);
  if (a === b) return true;
  return a.startsWith(b.endsWith("\\") ? b : b + "\\");
}
