/**
 * `agentguard hook pre-tool-use` — what a coding agent's pre-execution hook runs for each shell
 * command, file edit and MCP tool call: Claude Code `PreToolUse`, Codex `PreToolUse`, Gemini CLI
 * `BeforeTool`. Reads the harness's JSON on stdin and answers in that harness's format on
 * stdout (nothing else may go to stdout).
 *
 * - allow: no output, exit 0. The harness's own permission flow still applies; agentguard never
 *   answers "allow", so it can only take permissions away.
 * - deny: Claude Code / Codex `hookSpecificOutput.permissionDecision: "deny"`, Gemini CLI
 *   `decision: "deny"`, with the agentguard error body (`code`, `cause`, `fix`, `retryable`) as
 *   the reason the model reads, and a one-line `systemMessage` for the person.
 * - dry-run would-have-stopped: a `systemMessage` only; the call runs.
 * - an error inside agentguard: a `systemMessage` saying the call was NOT checked, exit 0. A
 *   broken policy file must not stop the agent; it must not pass silently either.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assessHookAction,
  detectHookClient,
  hookActionFromInput,
  type HookClient,
  type PreflightResult,
} from "@agentwares/agentguard-core";
import { flagString, type ParsedArgs } from "../args.js";
import {
  approvalUrlFor,
  createFileGuard,
  describeError,
  homeFrom,
  readRegistration,
  DEFAULT_POLICY_FILE,
  type Io,
} from "../context.js";
import { CLIENT_ALIASES, hookSettingsFiles } from "../hooks/clients.js";
import { humanTurnFromTranscript } from "../hooks/transcript-file.js";
import { loadPolicyFile } from "@agentwares/agentguard-core/node";

const RUN_PREFIX: Record<HookClient, string> = {
  "claude-code": "cc",
  codex: "codex",
  "gemini-cli": "gemini",
};

/** Walk up from `start` to the filesystem root looking for agentguard.yaml. */
function findPolicyUpwards(start: string): string | undefined {
  let dir = resolve(start);
  for (let i = 0; i < 64; i += 1) {
    const candidate = join(dir, DEFAULT_POLICY_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function projectDir(io: Io, inputCwd: string | undefined): string | undefined {
  return io.env.CLAUDE_PROJECT_DIR || io.env.GEMINI_PROJECT_DIR || inputCwd || undefined;
}

/** --config → AGENTGUARD_CONFIG → agentguard.yaml at or above the project → --fallback-config. */
export function resolveHookPolicy(
  args: ParsedArgs,
  io: Io,
  inputCwd: string | undefined,
): { path: string; found: "flag" | "env" | "project" | "fallback" } | undefined {
  const flag = flagString(args, "config");
  if (flag) return { path: resolve(io.cwd, flag), found: "flag" };
  if (io.env.AGENTGUARD_CONFIG)
    return { path: resolve(io.cwd, io.env.AGENTGUARD_CONFIG), found: "env" };
  const start = projectDir(io, inputCwd) ?? io.cwd;
  const near = findPolicyUpwards(start);
  if (near) return { path: near, found: "project" };
  const fallback = flagString(args, "fallback-config");
  if (fallback && existsSync(resolve(io.cwd, fallback)))
    return { path: resolve(io.cwd, fallback), found: "fallback" };
  return undefined;
}

function out(io: Io, value: unknown): void {
  io.out(JSON.stringify(value));
}

/** A systemMessage reaches the person in all three harnesses and changes no decision. */
function warn(io: Io, message: string): void {
  out(io, { systemMessage: message });
}

function respond(
  io: Io,
  client: HookClient,
  result: PreflightResult,
  summary: string,
  approveCommand: (id: string) => string,
): void {
  if (result.decision === "deny" && result.error) {
    const e = result.error;
    const reason = JSON.stringify(e);
    const id = result.approvalId ? `, approval ${result.approvalId}` : "";
    const approve =
      e.code === "APPROVAL_REQUIRED" && result.approvalId
        ? ` To let this exact command run once: ${approveCommand(result.approvalId)}`
        : "";
    const systemMessage = `agentguard refused "${summary.slice(0, 120)}" (${e.code}${id}): ${e.cause}${approve}`;
    if (client === "gemini-cli") out(io, { decision: "deny", reason, systemMessage });
    else
      out(io, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
        systemMessage,
      });
    return;
  }
  if (result.would) {
    out(io, {
      systemMessage: `agentguard (hooks.mode: dry-run) would have stopped "${summary.slice(0, 120)}" with ${result.would.code}: ${result.would.cause} — it ran; nothing is blocked until hooks.mode is enforce`,
    });
  }
}

export async function hookCommand(args: ParsedArgs, io: Io): Promise<number> {
  const event = args.positionals[0];
  if (event !== "pre-tool-use") {
    io.err(
      "usage: agentguard hook pre-tool-use [--client claude|codex|gemini] [--config agentguard.yaml] [--fallback-config path]\n" +
        "  run by a coding agent's pre-execution hook, with the hook's JSON on stdin; `agentguard hooks install` sets it up",
    );
    return 1;
  }
  const flagClient = flagString(args, "client");
  let client: HookClient = (flagClient && CLIENT_ALIASES[flagClient]) || "claude-code";
  try {
    const raw = (await io.stdin?.()) ?? "";
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!flagClient) client = detectHookClient(input);
    const inputCwd = typeof input.cwd === "string" ? input.cwd : undefined;
    const policyRef = resolveHookPolicy(args, io, inputCwd);
    if (!policyRef) return 0; // no agentguard.yaml for this project: nothing to enforce
    const loaded = loadPolicyFile(policyRef.path, { env: io.env, allowMissingEnv: true });
    const action = hookActionFromInput(client, input, inputCwd ?? io.cwd);
    if (!action) return 0;
    const home = homeFrom(io);
    const workspace =
      projectDir(io, undefined) ??
      (policyRef.found === "project" ? dirname(policyRef.path) : undefined) ??
      action.cwd;
    const tmpDirs = [
      tmpdir(),
      io.env.TMPDIR,
      typeof input.scratchpad_dir === "string" ? input.scratchpad_dir : undefined,
      "/tmp",
      "/private/tmp",
      "/var/folders",
      "/private/var/folders",
    ].filter((d): d is string => Boolean(d));
    const ctx = {
      workspace: resolve(workspace),
      home,
      tmpDirs,
      stateDir: loaded.stateDir,
      guardFiles: [loaded.path, ...hookSettingsFiles({ cwd: resolve(workspace), home })],
    };
    const assessment = assessHookAction(loaded.policy, action, ctx);
    const reg = readRegistration(loaded);
    const { guard } = createFileGuard(loaded, {
      env: io.env,
      approvalUrl: approvalUrlFor(reg),
      log: (line) => io.err(line),
    });
    const configHint =
      policyRef.found === "project" && dirname(policyRef.path) === resolve(workspace)
        ? ""
        : ` --config ${JSON.stringify(policyRef.path)}`;
    const approveCommand = (id: string): string =>
      `npx @agentwares/agentguard approve ${id}${configHint}`;
    const result = await guard.preflight({
      action,
      assessment,
      runId: `${RUN_PREFIX[client]}_${action.sessionId}`,
      humanTurn: () =>
        client === "claude-code"
          ? humanTurnFromTranscript(action.transcriptPath, {
              requireOrigin: loaded.policy.hooks.irreversible.require_origin,
            })
          : {
              missing: `${client} transcripts are not a verified format for this check, so an irreversible command needs \`agentguard approve\``,
            },
      approveCommand,
    });
    respond(io, client, result, assessment.summary, approveCommand);
    return 0;
  } catch (err) {
    warn(
      io,
      `agentguard hook error — this call was NOT checked: ${describeError(err).replace(/\s+/g, " ").slice(0, 400)}`,
    );
    return 0;
  }
}
