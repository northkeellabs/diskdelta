# Contributing

The labels DiskDelta shows come from [`rules/rules.json`](rules/rules.json). Adding or fixing a rule is the most useful contribution, and it needs no TypeScript.

## How changes get in

- **Pull requests only.** Nothing is pushed to `main` directly, also not by maintainers. Fork the repository, make your change on a branch, and open a pull request.
- **All checks must pass.** CI runs `npm run typecheck`, `npm test` and `npm run eval` on Windows for every pull request. A pull request with a failing check is not merged.
- To suggest a rule without writing it, open a "New or changed rule" issue. For bugs, use the "Bug report" issue form. Never paste your real user name or private folder names; use `%LOCALAPPDATA%` and similar.

## Run the tests

Needs Windows and Node 22 or newer.

```
npm ci
npm run typecheck   # TypeScript
npm test            # all vitest suites, including the rules schema and every rule's examples
npm run eval        # label eval: tests/eval/paths.json, accuracy per label
npm run demo        # after npm run build: the page on a fictional PC, to check your change by eye
```

## Add a rule

1. Find the folder on your own PC and write down its path using a Windows location instead of your user name: `%LOCALAPPDATA%\SomeApp\Cache`, not your real path. Use `?:\` for "any drive" and `**\` for "a folder with this name anywhere".
2. Add an entry:

```json
{
  "id": "someapp-cache",
  "category": "app-cache",
  "match": ["%LOCALAPPDATA%\\SomeApp\\Cache"],
  "label": "safe",
  "what": "SomeApp's download cache, rebuilt when needed.",
  "reclaim": "In SomeApp: Settings > Storage > Clear cache. Or close SomeApp and delete the contents.",
  "examples": {
    "match": ["%LOCALAPPDATA%\\SomeApp\\Cache\\data"],
    "no_match": ["%LOCALAPPDATA%\\SomeApp\\Profiles"]
  }
}
```

3. Run `npm test` and `npm run eval`. The tests check the schema, that every `match` example is labelled by your rule, and that no `no_match` example is.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lower-case words joined by `-`, unique |
| `category` | yes | One of `temp`, `leftovers`, `browser-cache`, `app-cache`, `package-cache`, `dev-build`, `model-store`, `vm-disk`, `app-data`, `installed-apps`, `system`, `personal`, `container` |
| `match` | yes | One or more path patterns (see above). `*` inside a folder name matches any characters |
| `label` | yes | `safe`, `check_first` or `do_not_touch` |
| `what` | yes | One line: what this is |
| `reclaim` | yes | How to free the space. Prefer the owning app's own command or setting |
| `notes` | no | Caveats |
| `inherit` | no | Default `true`: also covers everything inside. `false`: only the folder itself |
| `candidate` | no | Default `true`: offered in cleanup plans |
| `descend` | no | Default `false`: growth reports show the folder as one unit. `true`: they look inside |
| `cap_inside` | no | `check_first`: nothing inside may be labelled safe (used for personal folders) |
| `kind`, `min_siblings` | no | `sibling_group`: matches only when at least `min_siblings` sibling folders share a name prefix |
| `examples` | yes | `match` and `no_match` lists, at least one each |

## Labels

- `safe`: the content is rebuilt or downloaded again when needed (caches, build output, installer leftovers), or already deleted. Say in `what` or `notes` what the user loses (a slower first start, a re-download).
- `check_first`: only the user can decide (models, virtual disks, personal files, project environments).
- `do_not_touch`: deleting by hand breaks something. `reclaim` must say what to do instead (uninstall, the app's own command, a Windows setting).

Never label personal data `safe`. Do not copy rules from other tools; write them from what you know and can check. If you are not sure what a folder holds, it is `check_first`.

## Label eval

`tests/eval/paths.json` holds fictional paths with the label a careful person would give them. If your rule changes an expected label, fix the rule, not the expectation, unless the expectation is wrong; say which in the pull request.

## Code

TypeScript, ESM, Node 22. `npm run typecheck` and `npm test` must pass. The scanner must stay read-only; the read-only test will fail otherwise.
