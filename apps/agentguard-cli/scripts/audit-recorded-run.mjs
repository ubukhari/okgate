#!/usr/bin/env node
/**
 * The recorded run in docs/reports/AG-AUDIT.md: `agentguard audit` on the synthetic history in
 * src/fixtures/audit-sessions.ts (rule files in every format, five Claude Code sessions and a
 * Codex rollout with known kept and broken rules), in a scratch directory with its own HOME, then
 * removed. Nothing here reads a real transcript or sends anything.
 *
 *   pnpm --filter @agentwares/agentguard build
 *   node apps/agentguard-cli/scripts/audit-recorded-run.mjs "$PWD/apps/agentguard-cli/dist/cli.js"
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cli = resolve(process.argv[2] ?? "apps/agentguard-cli/dist/cli.js");
const { writeSyntheticAuditHistory, AUDIT_CANARIES } = await import(
  pathToFileURL(join(dirname(cli), "index.js")).href
);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ag-audit-run-")));
const repo = join(scratch, "acme");
const home = join(scratch, "home");
mkdirSync(join(repo, ".git"), { recursive: true });
mkdirSync(home);
writeSyntheticAuditHistory({
  repo,
  claudeDir: join(home, ".claude", "projects"),
  codexDir: join(home, ".codex", "sessions"),
});

const clean = (text) => text.replaceAll(scratch, "<tmp>");
function run(args, { show = true } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: home, USER: "recorded-run" },
    encoding: "utf8",
    timeout: 60_000,
  });
  const ms = Date.now() - started;
  if (show) {
    console.log(`$ agentguard ${args.join(" ")}    # exit ${r.status}, ${ms} ms`);
    console.log(clean(r.stdout).trimEnd());
    if (r.stderr.trim()) console.log(clean(r.stderr).trimEnd());
    console.log("");
  }
  return { ...r, ms };
}

try {
  console.log(`# scratch: <tmp> (HOME=<tmp>/home); repository <tmp>/acme\n`);
  run(["audit"]);

  const json = run(["audit", "--json"], { show: false });
  const parsed = JSON.parse(json.stdout);
  console.log(`$ agentguard audit --json    # exit ${json.status}, ${json.ms} ms (from the cache)`);
  console.log(
    JSON.stringify(
      {
        sessions: parsed.sessions,
        sources: parsed.sources,
        rules: parsed.rules.map((r) => `R${r.n} ${r.status} ${r.sessions_broken}`),
        team_history: parsed.team_history,
      },
      null,
      1,
    ),
  );
  const cacheDir = join(home, ".agentguard", "audit-cache-v1");
  const cached = readdirSync(cacheDir).map((f) => readFileSync(join(cacheDir, f), "utf8"));
  const inCache = AUDIT_CANARIES.filter((c) => cached.some((t) => t.includes(c)));
  const inJson = AUDIT_CANARIES.filter((c) => json.stdout.includes(c));
  console.log(
    `\nmarker strings planted in prompts, replies, commands, tool output, paths and file contents: ${AUDIT_CANARIES.length}; found in the cache (${cached.length} files): ${inCache.length}; in --json: ${inJson.length}\n`,
  );

  run(["audit", "--since", "all", "--no-evidence"]);
  run(["audit", "--enforce", "--preview"]);
  run(["audit", "--enforce", "--command", "agentguard"]);
  run(["hooks", "status"]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
  console.log("(scratch directory removed)");
}
