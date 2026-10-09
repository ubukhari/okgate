#!/usr/bin/env node
/**
 * `okgate` — MCP policy proxy: hard spend limits, destructive-action gating with approvals,
 * a kill switch, scoped credentials, dry-run writes, a loop breaker, blast-radius caps and a
 * hash-chained audit log. No LLM calls, no phone-home, no account.
 */
import { parseArgs, type ParsedArgs } from "./args.js";
import { version } from "./version.js";
import { INSTALL } from "./install.js";

export { version };
import { defaultIo, describeError, type Io } from "./context.js";
import { connectCommand } from "./commands/connect.js";
import { approvalsCommand, decideCommand, killCommand, resumeCommand } from "./commands/control.js";
import { hookCommand } from "./commands/hook.js";
import { hooksCommand } from "./commands/hooks.js";
import { keyCommand } from "./commands/keys.js";
import { permissionDiffCommand } from "./commands/permission-diff.js";
import { diffCommand, reportCommand, statusCommand, verifyCommand } from "./commands/report.js";

// The MCP SDK costs ~110 ms to load. `okgate hook pre-tool-use` runs before every guarded
// tool call of a coding agent and never needs it, so the commands that do load it on demand.
const proxyCommand = async (args: ParsedArgs, io: Io): Promise<number> =>
  (await import("./commands/proxy.js")).proxyCommand(args, io);
const initCommand = async (args: ParsedArgs, io: Io): Promise<number> =>
  (await import("./commands/init.js")).initCommand(args, io);
const toolsCommand = async (args: ParsedArgs, io: Io): Promise<number> =>
  (await import("./commands/tools.js")).toolsCommand(args, io);
const auditCommand = async (args: ParsedArgs, io: Io): Promise<number> =>
  (await import("./commands/audit.js")).auditCommand(args, io);

export const HELP = `okgate — MCP policy proxy for agents that touch production

  ${INSTALL} init
                                      read your MCP config, write okgate.yaml (dry-run), route every server through the proxy
  okgate report [--run id|--all]      what this run did / would have destroyed / spent, where it was halted
  okgate diff [--run id]              record-by-record mutation diff from a dry run
  okgate verify [audit.jsonl]         prove the hash-chained audit log was not edited
  okgate connect <key> [--write]      point this machine at your hosted proxy (paid tiers)

  okgate hooks install [--project|--user] [--client claude|codex|gemini|all]
                                      check a coding agent's own shell commands and file edits against okgate.yaml (dry-run first);
                                      irreversible commands (push, merge, publish, send, rm outside the repo) only on a turn a person typed
  okgate hooks uninstall | status
  okgate hook pre-tool-use            what the installed hook runs (reads the harness's JSON on stdin)

  okgate audit [--since 7d|30d|all] [--client claude|codex|all] [--json]
                                      which rules in CLAUDE.md / AGENTS.md / GEMINI.md / .cursor/rules your coding agents broke,
                                      from this machine's Claude Code and Codex sessions in this repo (nothing is sent anywhere)
  okgate audit --enforce [--preview]
                                      write the checkable rules into okgate.yaml as hook rules, in dry-run, and install the hook

  okgate proxy [--http --port 8788] [--agent name] [--run-id id] [--mode dry-run|enforce]
  okgate tools [--json]               the tools your agent will see, with class and why
  okgate status [--run id]            counters vs caps, kill state, pending approvals

  okgate kill [reason]                halt every run now (file + running HTTP proxy);  okgate resume
  okgate approvals [--all]            pending approvals;  okgate approve <id> | deny <id> [--note text]
  okgate key create <agent> [--allow 'crm_get_*']... [--deny p] [--writes n] [--spend n] [--mode m]
  okgate key list | revoke <agent>
  okgate permission-diff [--base ref] [--head ref] [--paths a,b] [--format markdown|json] [--fail-on-widen]

Options: --config <okgate.yaml> (or OKGATE_CONFIG), --json, --help, --version
Renamed from agentguard: agentguard.yaml, .agentguard/, AGENTGUARD_* and the agentguard bin keep working.
Docs: https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli`;

export async function main(argv: readonly string[], io: Io = defaultIo()): Promise<number> {
  const args: ParsedArgs = parseArgs(argv);
  if (args.flags.version) {
    io.out(version());
    return 0;
  }
  if (args.command === undefined && !args.flags.help && io.tty === false) {
    // An MCP client spawned bare `npx @agentwares/agentguard` — that is what server.json registers — and is
    // waiting for JSON-RPC on stdout. Serve the proxy instead of printing help into the stream.
    try {
      return await proxyCommand(args, io);
    } catch (err) {
      io.err(describeError(err));
      return 1;
    }
  }
  if (args.flags.help || args.command === undefined || args.command === "help") {
    io.out(HELP);
    return args.command === undefined && !args.flags.help ? 1 : 0;
  }
  try {
    switch (args.command) {
      case "init":
        return await initCommand(args, io);
      case "proxy":
      case "serve":
        return await proxyCommand(args, io);
      case "report":
        return await reportCommand(args, io);
      case "diff":
        return await diffCommand(args, io);
      case "verify":
        return await verifyCommand(args, io);
      case "connect":
        return await connectCommand(args, io);
      case "status":
        return await statusCommand(args, io);
      case "tools":
        return await toolsCommand(args, io);
      case "kill":
        return await killCommand(args, io);
      case "resume":
        return await resumeCommand(args, io);
      case "approve":
        return await decideCommand("approved", args, io);
      case "deny":
        return await decideCommand("denied", args, io);
      case "approvals":
        return await approvalsCommand(args, io);
      case "key":
      case "keys":
        return await keyCommand(args, io);
      case "permission-diff":
        return await permissionDiffCommand(args, io);
      case "hook":
        return await hookCommand(args, io);
      case "hooks":
        return await hooksCommand(args, io);
      case "audit":
        return await auditCommand(args, io);
      default:
        io.err(`unknown command "${args.command}"\n`);
        io.err(HELP);
        return 1;
    }
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }
}

// `okgate`, and `agentguard` (its name before the rename) for 90 days. A package that runs this
// CLI by importing it (the @agentwares/agentguard shim) sets the flag and calls main() itself.
const embedded =
  (globalThis as Record<symbol, unknown>)[Symbol.for("okgate.cli.embedded")] === true;
const isMain =
  !embedded &&
  process.argv[1] !== undefined &&
  /(^|[\\/])(cli\.[cm]?[jt]s|okgate|agentguard)$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${describeError(err)}\n`);
      process.exitCode = 1;
    },
  );
}
