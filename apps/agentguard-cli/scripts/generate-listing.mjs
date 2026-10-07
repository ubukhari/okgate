#!/usr/bin/env node
/** Writes server.json, llms.txt and the registry publish workflow from package.json. */
import { generateServerJson, registryPublishWorkflow, renderLlmsTxt } from "@agentwares/mcp-kit";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const serverJson = generateServerJson({
  name: "io.github.agentwares/agentguard",
  title: "agentguard",
  description:
    "MCP policy proxy: spend caps, approvals for destructive tools, kill switch, dry-run, audit log.",
  version: pkg.version,
  repository: {
    url: "https://github.com/agentwares/agentguard",
    source: "github",
    subfolder: "apps/agentguard-cli",
  },
  websiteUrl: "https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli",
  npmPackage: {
    identifier: "@agentwares/agentguard",
    version: pkg.version,
    runtimeHint: "npx",
    environmentVariables: [
      {
        name: "AGENTGUARD_CONFIG",
        description:
          "Path to agentguard.yaml (default ./agentguard.yaml). If unset and that file does not exist, agentguard serves only its own read-only tools: agentguard_get_status, agentguard_get_report, agentguard_verify_audit_log",
        isRequired: false,
        format: "filepath",
      },
      {
        name: "AGENTGUARD_KILL",
        description: "Set to 1 to halt every tool call (kill switch)",
        isRequired: false,
      },
    ],
  },
});
// The registry entry has no package arguments: a client spawns bare `npx @agentwares/agentguard`, and the CLI
// serves the stdio proxy when stdout is a pipe (see cli.ts).
writeFileSync(path.join(root, "server.json"), JSON.stringify(serverJson, null, 2) + "\n");

writeFileSync(
  path.join(root, "llms.txt"),
  renderLlmsTxt({
    name: "agentguard",
    summary:
      "MCP policy proxy for AI agents: hard spend limits, destructive-action gating with approvals, kill switch, scoped agent keys, dry-run writes with mutation diffs, semantic loop breaker, blast-radius caps, hash-chained audit log. CLI `npx @agentwares/agentguard`; SDK `@agentwares/agentguard-sdk`. No LLM calls, no phone-home, no account.",
    description: [
      "Set up: `npx -y @agentwares/agentguard init` in the project directory writes agentguard.yaml (dry-run) and routes the project's MCP servers through the proxy. The same command ships as a Claude Code plugin (`/plugin marketplace add agentwares/agentguard`, then `/plugin install agentguard@agentwares`) and a Gemini CLI extension (`gemini extensions install https://github.com/agentwares/agentguard`).",
      "",
      "Started with no agentguard.yaml (an editor install button, a registry install, the repo's Dockerfile), the proxy fronts no servers and serves three read-only tools of its own: `agentguard_get_status` (what it guards, caps used and remaining, kill switch, pending approvals), `agentguard_get_report` (what a run did, or would have done in dry-run) and `agentguard_verify_audit_log` (the hash chain). With upstreams configured, the agent sees only the upstreams' tools.",
      "",
      "Hook mode: `npx -y @agentwares/agentguard hooks install` (add `--client codex`, `--client gemini` or `--client all`) writes a pre-execution hook (Claude Code PreToolUse, Codex PreToolUse, Gemini CLI BeforeTool) that checks the coding agent's own shell commands, file edits and MCP calls against the same agentguard.yaml. Irreversible commands (git push, merges, tag deletion, rm outside the workspace, package publish, sending mail or messages, edits to the guard itself) run only on a recent turn a person typed that names the action; in Claude Code that is read from the session transcript, and text the model writes never counts. Otherwise the agent gets APPROVAL_REQUIRED with an id, and `agentguard approve <id>` lets the identical command run once. Dry-run (log only) until `hooks.mode: enforce`.",
      "",
      "Audit: `npx -y @agentwares/agentguard audit [--since 7d|30d|all] [--json]` reads the repository's CLAUDE.md, AGENTS.md, GEMINI.md and .cursor/rules (and `audit.rules` in agentguard.yaml) and this machine's Claude Code and Codex sessions in it, and reports per rule how many sessions broke it and when. Rules are recognised by a pattern library with no LLM (never push to main, never force-push, never --no-verify, run X before pushing, use pnpm not npm, do not edit or commit a path, no new dependencies without asking, never rm outside the repo, never publish, never deploy, never run a named command), or stated with an inline `<!-- agentguard: <check> -->`. It runs locally and sends nothing; `--json` carries counts, rule ids and dates only. `--enforce` writes the checkable rules into agentguard.yaml as hook-mode rules in dry-run and installs the hook. The plugin's `/agentguard:audit` has your own agent judge the rules no script can check.",
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
        title: "npm: @agentwares/agentguard",
        url: "https://www.npmjs.com/package/@agentwares/agentguard",
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
    tagPattern: "agentguard-v*",
    workflowName: "Publish agentguard to the MCP Registry",
  }),
);
console.log("wrote server.json, llms.txt, publish-mcp.workflow.yml");
