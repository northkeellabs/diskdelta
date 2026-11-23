#!/usr/bin/env node
// Builds dist/cli.js, the npm package's bin: one ESM file with the page and rules embedded.
// Runtime dependencies (@modelcontextprotocol/server, zod) stay external and are installed by npm.

import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "info",
});
