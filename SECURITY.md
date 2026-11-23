# Security

## Read-only guarantee

DiskDelta v0 never deletes, moves, renames or changes anything on the drives it scans, by any code path.

- The folder walk (`src/scanner/walk.ts`) uses only `fs.promises.readdir` and `fs.promises.lstat`. A test (`tests/scanner.test.ts`, "read-only guarantee") replaces every function on `fs` and `fs.promises`, runs a scan, and fails if anything other than those two was called on the scanned tree or if any call carried open flags. Another test checks that sizes and modified times are unchanged after a scan, and a source check rejects write, delete, rename or attribute APIs in the scanner.
- Files Windows keeps locked (such as `pagefile.sys`) cannot even be `lstat`-ed; their size is read from the directory entry with one PowerShell `Get-Item` call, which opens nothing.
- Symlinks, junctions and other reparse points are never followed; a scan never starts at one. Hard-linked files are counted once.
- The only writes: snapshots in DiskDelta's own folder (`%LOCALAPPDATA%\DiskDelta\snapshots`, or `DISKDELTA_DATA_DIR`), where it only ever deletes snapshot files it wrote itself (keeping the last 10), and a report you export from the page or with `scan --json`. Exports refuse to overwrite an existing file.
- No admin rights are needed or requested.

## MCP server

`diskdelta mcp` exposes four tools: `drive_overview`, `what_grew`, `explain`, `cleanup_plan`. All are annotated `readOnlyHint: true`, `destructiveHint: false`. None can delete, move or change anything; inputs are validated with zod (absolute paths, days 1 to 365, limits 1 to 100). The server runs over stdio only and opens no network port. What the tools return (paths, sizes, labels) goes to the AI app that started the server.

## Local web server

The page is served by a small HTTP server inside the program:

- It binds to `127.0.0.1` only, on a fixed default port (41823) or a free port if that one is taken.
- A random token (24 bytes) is created per run and put in the page URL. Every request must carry it (query `t` or header `X-DiskDelta-Token`); it is compared in constant time.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS-rebinding attacks.
- Requests with an `Origin` other than the server itself, or with `Sec-Fetch-Site: cross-site` or `same-site`, are refused. No CORS headers are ever sent.
- POST bodies must be JSON and at most 64 KB, so plain HTML forms from other sites cannot post to it.
- The page is sent with a strict Content-Security-Policy (`default-src 'none'`, scripts and styles only with a per-run nonce, `connect-src 'self'`, `frame-ancestors 'none'`), plus `X-Frame-Options: DENY`, `nosniff` and `no-referrer`.
- The server stops when the page is closed (heartbeat), or after an idle timeout (60 minutes by default).

These protections are covered by `tests/ui-server.test.ts`.

## Offline

No telemetry, no update check, no analytics, no fonts, scripts or images from the internet. `tests/offline.test.ts` checks the source for outbound network APIs and the page for external resources.

## Reporting a problem

Please open a GitHub issue for anything that is not sensitive. For a security problem, contact Northkeel Labs through [northkeellabs.com](https://northkeellabs.com) first and give us a reasonable time to fix it before publishing details.
