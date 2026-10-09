#!/usr/bin/env node
/**
 * The one commit that moves okgate to its own npm names (brief REN-1). Run it from the repo root
 * once an npm publish token exists for the new names, then follow what it prints:
 *
 *   node apps/agentguard-cli/scripts/flip-npm-names.mjs [--dry-run]
 *
 * Until then npm serves okgate as the `okgate` bin of @agentwares/agentguard (0.1.10 on), and the
 * workspace keeps the old package names, because those are the names with trusted publishers.
 *
 * What it changes:
 *   - @agentwares/agentguard        → @agentwares/okgate       0.2.0 (apps/agentguard-cli)
 *   - @agentwares/agentguard-core   → @agentwares/okgate-core  0.2.0 (packages/agentguard-core)
 *   - @agentwares/agentguard-sdk    → @agentwares/okgate-sdk   0.2.0 (packages/agentguard-sdk)
 *   - every dependent's dependency line and import specifier, including
 *     @agentwares/openclaw-budget-guard
 *   - src/install.ts NEW_NPM_NAMES = true, and every mirror of the install command
 *     (MIRRORS below; their tests fail if one is missed)
 *   - the publish lists: the new names first, then the three 0.2.0 shims under the old names
 *     (packages/agentguard-core/shim, packages/agentguard-sdk/shim, apps/agentguard-cli/shim)
 *   - the plugin and extension versions, and a 0.2.0 section in both changelogs
 *
 * Release order after the commit: publish the new names, then the shims, then
 * `npm deprecate` the old names "renamed to @agentwares/okgate…" (never unpublish: pinned hooks
 * must resolve), then regenerate and publish the registry entry (identifier @agentwares/okgate).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const DRY = process.argv.includes("--dry-run");
const VERSION = "0.2.0";
const RENAMES = [
  ["@agentwares/agentguard-core", "@agentwares/okgate-core"],
  ["@agentwares/agentguard-sdk", "@agentwares/okgate-sdk"],
  ["@agentwares/agentguard", "@agentwares/okgate"],
];
const NEW_NAME = Object.fromEntries(RENAMES);
const PACKAGES = {
  "packages/agentguard-core": "@agentwares/okgate-core",
  "packages/agentguard-sdk": "@agentwares/okgate-sdk",
  "apps/agentguard-cli": "@agentwares/okgate",
};
const DEPENDENTS = [
  "apps/agentguard-cli",
  "packages/agentguard-sdk",
  "apps/agentguard-hosted",
  "apps/agentguard-app",
  "assets/openclaw-budget-guard",
];
const SHIMS = [
  "packages/agentguard-core/shim",
  "packages/agentguard-sdk/shim",
  "apps/agentguard-cli/shim",
];
/** Copies of the install command outside src/install.ts: [file, before, after]. */
const MIRRORS = [
  [
    "apps/agentguard-cli/src/install.ts",
    "export const NEW_NPM_NAMES: boolean = false;",
    "export const NEW_NPM_NAMES: boolean = true;",
  ],
  [
    "apps/agentguard-cli/scripts/generate-listing.mjs",
    'const INSTALL = "npx -p @agentwares/agentguard okgate";',
    'const INSTALL = "npx @agentwares/okgate";',
  ],
  [
    "apps/agentguard-cli/scripts/generate-listing.mjs",
    'const RUN = "npx -y -p @agentwares/agentguard okgate";',
    'const RUN = "npx -y @agentwares/okgate";',
  ],
  [
    "apps/agentguard-hosted/src/hosts.ts",
    'export const OKGATE_INSTALL = "npx -p @agentwares/agentguard okgate";',
    'export const OKGATE_INSTALL = "npx @agentwares/okgate";',
  ],
];
const PUBLISH_LISTS = ["scripts/publish-npm.sh", ".github/workflows/publish-npm.yml"];
const VERSIONED = [
  "apps/agentguard-cli/distribution/root/gemini-extension.json",
  "apps/agentguard-cli/distribution/root/plugins/okgate/.claude-plugin/plugin.json",
  "apps/agentguard-cli/distribution/root/plugins/agentguard/.claude-plugin/plugin.json",
];
const CHANGELOGS = {
  "apps/agentguard-cli/CHANGELOG.md":
    "First release as `@agentwares/okgate`: `npx @agentwares/okgate`. `@agentwares/agentguard` 0.2.0 depends on it and runs it under the old name.",
  "packages/agentguard-core/CHANGELOG.md":
    "First release as `@agentwares/okgate-core`. `@agentwares/agentguard-core` 0.2.0 re-exports it.",
};

const changed = new Set();
const read = (f) => readFileSync(f, "utf8");
function write(file, text) {
  if (read(file) === text) return;
  changed.add(file);
  if (!DRY) writeFileSync(file, text);
}
function fail(message) {
  console.error(`flip-npm-names: ${message}`);
  process.exit(1);
}
if (!existsSync("pnpm-workspace.yaml")) fail("run it from the repository root");

// 1. the three packages
for (const [dir, name] of Object.entries(PACKAGES)) {
  const file = `${dir}/package.json`;
  const pkg = JSON.parse(read(file));
  if (pkg.name === name) fail(`${file} is already ${name}: the flip has run`);
  pkg.name = name;
  pkg.version = VERSION;
  if (dir === "apps/agentguard-cli") pkg.mcpName = "io.github.agentwares/okgate";
  write(file, JSON.stringify(pkg, null, 2) + "\n");
}

// 2. dependency lines and import specifiers
const renameSpecifiers = (text) =>
  RENAMES.reduce(
    (t, [from, to]) =>
      t.replace(new RegExp(`(["'\`])${from.replace("/", "\\/")}(?=["'\`/])`, "g"), `$1${to}`),
    text,
  );
for (const dir of DEPENDENTS) {
  const file = `${dir}/package.json`;
  const pkg = JSON.parse(read(file));
  let renamed = false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (!deps || !RENAMES.some(([from]) => from in deps)) continue;
    for (const [from, to] of RENAMES)
      if (from in deps) {
        deps[to] = deps[from];
        delete deps[from];
      }
    pkg[field] = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
    renamed = true;
  }
  if (renamed) write(file, JSON.stringify(pkg, null, 2) + "\n");
}
const SKIP = new Set(["node_modules", "dist", ".next", ".turbo", "shim", "coverage"]);
// imports the old names on purpose: it runs the shims, which are what the old names become
const KEEP = new Set(["apps/agentguard-cli/src/shims.test.ts"]);
function* code(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) yield* code(p);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) yield p;
  }
}
for (const dir of DEPENDENTS)
  for (const file of code(dir)) {
    if (KEEP.has(file)) continue;
    const text = read(file);
    // only real specifiers: `from "…"`, `import("…")`, `vi.mock("…")`, `require.resolve("…")`
    const next = text.replace(
      /((?:from|import|mock|resolve)\s*\(?\s*)(["'])(@agentwares\/agentguard(?:-core|-sdk)?)(?=["'/])/g,
      (_m, lead, quote, name) => `${lead}${quote}${NEW_NAME[name]}`,
    );
    write(file, next);
  }

// 3. the install command and its mirrors
for (const [file, before, after] of MIRRORS) {
  const text = read(file);
  if (!text.includes(before)) fail(`${file} no longer contains ${before}`);
  write(file, text.replace(before, after));
}

// 4. publish lists: shims right after the CLI
for (const file of PUBLISH_LISTS) {
  const text = read(file);
  const anchor = "apps/agentguard-cli apps/seatledger-cli";
  if (!text.includes(anchor)) fail(`${file}: no "${anchor}" in PKGS`);
  write(
    file,
    text.split(anchor).join(`apps/agentguard-cli ${SHIMS.join(" ")} apps/seatledger-cli`),
  );
}
{
  const file = "scripts/sync-oss-repos.sh";
  write(file, renameSpecifiers(read(file)));
}
{
  // the standing check covers the new names; the old ones stay listed (the shims are packages too)
  const file = "scripts/check-published-packages.mjs";
  const anchor = '  "@agentwares/agentguard",\n';
  const text = read(file);
  if (!text.includes(anchor)) fail(`${file}: no ${anchor.trim()} in PACKAGES`);
  write(
    file,
    text.replace(
      anchor,
      `${anchor}  "@agentwares/okgate-core",\n  "@agentwares/okgate-sdk",\n  "@agentwares/okgate",\n`,
    ),
  );
}

// 5. versions shown beside the package, and the release notes
for (const file of VERSIONED) {
  const json = JSON.parse(read(file));
  json.version = VERSION;
  write(file, JSON.stringify(json, null, 2) + "\n");
}
const today = new Date().toISOString().slice(0, 10);
for (const [file, note] of Object.entries(CHANGELOGS)) {
  const text = read(file);
  const at = text.indexOf("\n## ");
  write(file, `${text.slice(0, at)}\n## ${VERSION} — ${today}\n\n- ${note}\n${text.slice(at)}`);
}

// 6. every command shown to a person or an agent, in the forms npm serves after the flip
const SHOWN = [
  "README.md",
  "apps/agentguard-cli/README.md",
  "apps/agentguard-cli/PRIVACY.md",
  "packages/agentguard-core/README.md",
  "packages/agentguard-sdk/README.md",
  "apps/agentguard-app/README.md",
  "apps/agentguard-hosted/README.md",
  "apps/site/src/app/page.tsx",
  "assets/permission-diff-action/README.md",
  "docs/launch/agentguard.md",
  "docs/launch/HN-FACTS.md",
  ...[...walk("apps/agentguard-cli/distribution/root")].filter((f) => /\.(md|toml|json)$/.test(f)),
];
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}
for (const file of SHOWN) {
  if (!existsSync(file)) continue;
  const text = read(file)
    // `npx -y -p @agentwares/agentguard@latest okgate init` → `npx -y @agentwares/okgate@latest init`
    .replace(
      /npx (-y )?-p @agentwares\/agentguard(@\S+?)? okgate\b/g,
      (_m, y, v) => `npx ${y ?? ""}@agentwares/okgate${v ?? ""}`,
    )
    // a sentence that is only true while npm serves okgate under the old name
    .replace(/\n<!-- npm-interim[\s\S]*?<!-- \/npm-interim -->\n/g, "");
  write(file, text);
}
{
  // the Cursor and VS Code buttons carry the MCP entry init writes
  const file = "apps/agentguard-cli/README.md";
  const args = ["-y", "@agentwares/okgate", "proxy"];
  const cursor = encodeURIComponent(
    Buffer.from(JSON.stringify({ command: "npx", args })).toString("base64"),
  );
  const vscode = encodeURIComponent(JSON.stringify({ type: "stdio", command: "npx", args }));
  write(
    file,
    read(file)
      .replace(/(cursor\.com\/link\/mcp\/install\?name=okgate&config=)[^)\s]+/, `$1${cursor}`)
      .replace(/(vscode\.dev\/redirect\/mcp\/install\?name=okgate&config=)[^)\s]+/, `$1${vscode}`),
  );
}
for (const [file, from, to] of [
  // Glama builds the image from the package's new name
  [
    "apps/agentguard-cli/distribution/root/Dockerfile",
    /@agentwares\/agentguard\b/g,
    "@agentwares/okgate",
  ],
  [
    "apps/agentguard-cli/distribution/root/.github/workflows/release.yml",
    /npmjs\.com\/package\/@agentwares\/agentguard\//g,
    "npmjs.com/package/@agentwares/okgate/",
  ],
])
  write(file, read(file).replace(from, to));

// shorter names re-wrap some imports and tables; leave the tree as `pnpm check` wants it
if (!DRY && changed.size > 0)
  execFileSync("pnpm", ["exec", "prettier", "--write", "--ignore-unknown", ...changed], {
    stdio: "ignore",
  });

console.log(`${DRY ? "would change" : "changed"} ${changed.size} files:`);
for (const f of [...changed].sort()) console.log(`  ${f}`);
console.log(`
Next:
  pnpm install                                      # the lockfile follows the renames
  node apps/agentguard-cli/scripts/generate-listing.mjs   # server.json names @agentwares/okgate ${VERSION}
  pnpm check                                        # gate on its exit code
  git commit -am "okgate: publish under @agentwares/okgate, -core, -sdk ${VERSION}; old names become shims"
Then: CI publish (new names first, then the shims), npm deprecate the old names, registry.`);
