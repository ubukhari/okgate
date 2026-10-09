#!/usr/bin/env node
/** Writes server.json, llms.txt and the registry publish workflow from package.json. */
import { generateServerJson, registryPublishWorkflow, renderLlmsTxt } from "@agentwares/mcp-kit";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// How to run it, mirrored from src/install.ts (src/distribution.test.ts fails when they differ):
// until the new npm names are published, npm serves the okgate bin from @agentwares/agentguard.
const INSTALL = "npx -p @agentwares/agentguard okgate";
const RUN = "npx -y -p @agentwares/agentguard okgate";
const OLD_NAMES_UNTIL = "2027-01-15";
/** npm still serves okgate under the old package names (flip-npm-names.mjs changes INSTALL). */
const NPM_INTERIM = INSTALL.includes(" -p ");
const SDK = NPM_INTERIM ? "@agentwares/agentguard-sdk" : "@agentwares/okgate-sdk";

const serverJson = generateServerJson({
  // A new registry name: names are immutable, so io.github.agentwares/agentguard is deprecated in
  // favour of this one rather than renamed. npm's `mcpName` (package.json) must match it.
  name: pkg.mcpName,
  title: "okgate",
  description:
    "Nothing irreversible without an OK: MCP policy proxy with spend caps, approvals, kill switch.",
  version: pkg.version,
  repository: {
    url: "https://github.com/agentwares/agentguard",
    source: "github",
    subfolder: "apps/agentguard-cli",
  },
  websiteUrl: "https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli",
  npmPackage: {
    identifier: pkg.name,
    version: pkg.version,
    runtimeHint: "npx",
    environmentVariables: [
      {
        name: "OKGATE_CONFIG",
        description:
          "Path to okgate.yaml (default ./okgate.yaml, else ./agentguard.yaml; AGENTGUARD_CONFIG also works). With neither file, okgate serves only its own read-only tools: okgate_get_status, okgate_get_report, okgate_verify_audit_log",
        isRequired: false,
        format: "filepath",
      },
      {
        name: "OKGATE_KILL",
        description:
          "Set to 1 to halt every tool call (kill switch); AGENTGUARD_KILL=1 does the same",
        isRequired: false,
      },
    ],
  },
});
// The registry entry has no package arguments: a client spawns bare `npx @agentwares/agentguard`, which
// runs the package's `agentguard` bin (the one named like the package), the same CLI as `okgate`. It
// serves the stdio proxy when stdout is a pipe (see cli.ts).
writeFileSync(path.join(root, "server.json"), JSON.stringify(serverJson, null, 2) + "\n");

writeFileSync(
  path.join(root, "llms.txt"),
  renderLlmsTxt({
    name: "okgate",
    summary: `Nothing irreversible without an OK. okgate (formerly agentguard) is an MCP policy proxy and coding-agent hook: hard spend limits, destructive-action gating with approvals, kill switch, scoped agent keys, dry-run writes with mutation diffs, semantic loop breaker, blast-radius caps, hash-chained audit log. CLI \`${INSTALL}\`; SDK \`${SDK}\`. No LLM calls, no phone-home, no account.`,
    description: [
      `Set up: \`${RUN} init\` in the project directory writes okgate.yaml (dry-run) and routes the project's MCP servers through the proxy. The same command ships as a Claude Code plugin (\`/plugin marketplace add agentwares/okgate\`, then \`/plugin install okgate@agentwares\`) and a Gemini CLI extension (\`gemini extensions install https://github.com/agentwares/okgate\`).`,
      "",
      `Started with no okgate.yaml (an editor install button, a registry install, the repo's Dockerfile), the proxy fronts no servers and serves three read-only tools of its own: \`okgate_get_status\` (what it guards, caps used and remaining, kill switch, pending approvals), \`okgate_get_report\` (what a run did, or would have done in dry-run) and \`okgate_verify_audit_log\` (the hash chain). The agentguard_* names they had before the rename still work until ${OLD_NAMES_UNTIL}. With upstreams configured, the agent sees only the upstreams' tools.`,
      "",
      `Renamed from agentguard on 8 Oct 2026: agentguard.yaml, an existing .agentguard/ directory, AGENTGUARD_* variables, the \`agentguard\` bin and the agentguard_* tool names keep working${NPM_INTERIM ? "; npm serves the \`okgate\` bin from @agentwares/agentguard until @agentwares/okgate is published" : "; @agentwares/agentguard runs @agentwares/okgate"}.`,
      "",
      `Hook mode: \`${RUN} hooks install\` (add \`--client codex\`, \`--client gemini\` or \`--client all\`) writes a pre-execution hook (Claude Code PreToolUse, Codex PreToolUse, Gemini CLI BeforeTool) that checks the coding agent's own shell commands, file edits and MCP calls against the same okgate.yaml. Irreversible commands (git push, merges, tag deletion, rm outside the workspace, package publish, sending mail or messages, edits to the guard itself) run only on a recent turn a person typed that names the action; in Claude Code that is read from the session transcript, and text the model writes never counts. Otherwise the agent gets APPROVAL_REQUIRED with an id, and \`${INSTALL} approve <id>\` lets the identical command run once. Dry-run (log only) until \`hooks.mode: enforce\`.`,
      "",
      `Audit: \`${RUN} audit [--since 7d|30d|all] [--json]\` reads the repository's CLAUDE.md, AGENTS.md, GEMINI.md and .cursor/rules (and \`audit.rules\` in okgate.yaml) and this machine's Claude Code and Codex sessions in it, and reports per rule how many sessions broke it and when. Rules are recognised by a pattern library with no LLM (never push to main, never force-push, never --no-verify, run X before pushing, use pnpm not npm, do not edit or commit a path, no new dependencies without asking, never rm outside the repo, never publish, never deploy, never run a named command), or stated with an inline \`<!-- okgate: <check> -->\` (\`<!-- agentguard: … -->\` still works). It runs locally and sends nothing; \`--json\` carries counts, rule ids and dates only. \`--enforce\` writes the checkable rules into okgate.yaml as hook-mode rules in dry-run and installs the hook. The plugin's \`/okgate:audit\` has your own agent judge the rules no script can check.`,
    ].join("\n"),
    links: [
      {
        title: "README (install in 60 seconds)",
        url: "https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli#readme",
      },
      {
        title: "Policy file reference",
        url: "https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli#policy",
      },
      {
        title: "SDK / middleware",
        url: "https://github.com/agentwares/agentguard/tree/main/packages/agentguard-sdk#readme",
      },
      {
        title: `npm: ${pkg.name}`,
        url: `https://www.npmjs.com/package/${pkg.name}`,
      },
      {
        title: "Permission-diff GitHub Action",
        url: "https://github.com/agentwares/agentguard/tree/main/permission-diff",
      },
    ],
    tools: [],
  }),
);

writeFileSync(
  path.join(root, "publish-mcp.workflow.yml"),
  // Registry publishing only: GitHub OIDC, no secrets. npm publishing stays in the
  // monorepo (`scripts/publish-npm.sh`), and must happen first — the registry verifies
  // that the published npm package carries `mcpName`.
  registryPublishWorkflow({
    serverJsonPath: "apps/agentguard-cli/server.json",
    tagPattern: "okgate-v*",
    workflowName: "Publish okgate to the MCP Registry",
  }),
);
console.log("wrote server.json, llms.txt, publish-mcp.workflow.yml");
