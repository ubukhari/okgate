/**
 * Shared CLI plumbing: locate and load the policy, build the file-backed guard, print things.
 */
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  Guard,
  POLICY_FILE,
  envTwin,
  type ApprovalRecord,
  type GuardEvent,
} from "@agentwares/agentguard-core";
import {
  FileApprovalStore,
  FileAuditSink,
  FileStateStore,
  findPolicyFile,
  killSwitchFor,
  loadPolicyFile,
  type FileKillSwitch,
  type LoadedPolicy,
} from "@agentwares/agentguard-core/node";
import { existsSync as exists, readFileSync } from "node:fs";
import { registrationPath, type HttpRegistration } from "./registration.js";
import { createAlerter } from "./notify.js";
import { flagString, type ParsedArgs } from "./args.js";

/** `okgate.yaml`; an existing `agentguard.yaml` is read when there is no `okgate.yaml`. */
export const DEFAULT_POLICY_FILE = POLICY_FILE;

import { homedir } from "node:os";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** false when stdout is a pipe — an MCP client spawned us and wants a server, not the help text */
  tty?: boolean;
  /** everything on stdin (hook mode reads the harness's JSON from it) */
  stdin?: () => Promise<string>;
}

/** Read stdin to the end, at most `maxBytes`, giving up after `timeoutMs`. Empty on a terminal. */
export function readStdin(maxBytes = 16 * 1024 * 1024, timeoutMs = 10_000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolveText) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (): void => {
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.pause();
      resolveText(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

/**
 * The user's home directory as this invocation sees it. Reads `io.env` rather than
 * calling homedir() so an injected environment is honoured — without this, tests
 * (and any sandboxed run) silently read the real user's client configs.
 */
export function homeFrom(io: Io): string {
  return io.env.HOME ?? io.env.USERPROFILE ?? homedir();
}

export function defaultIo(): Io {
  return {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
    cwd: process.cwd(),
    env: process.env,
    tty: process.stdout.isTTY === true,
    stdin: () => readStdin(),
  };
}

/** --config → OKGATE_CONFIG → AGENTGUARD_CONFIG → okgate.yaml, else agentguard.yaml, in cwd. */
export function policyPathFrom(args: ParsedArgs, io: Io): string {
  const named = flagString(args, "config") ?? envTwin(io.env, "CONFIG");
  return named !== undefined ? resolve(io.cwd, named) : findPolicyFile(io.cwd);
}

export function loadPolicyFor(
  args: ParsedArgs,
  io: Io,
  opts: { allowMissingEnv?: boolean } = {},
): LoadedPolicy {
  return loadPolicyFile(policyPathFrom(args, io), {
    env: io.env,
    allowMissingEnv: opts.allowMissingEnv,
  });
}

export interface FileGuard {
  guard: Guard;
  kill: FileKillSwitch;
  audit: FileAuditSink;
  approvals: FileApprovalStore;
  loaded: LoadedPolicy;
}

/** A guard wired to the state dir, audit file, KILL file and approvals of a loaded policy. */
export function createFileGuard(
  loaded: LoadedPolicy,
  opts: {
    onEvent?: (e: GuardEvent) => void | Promise<void>;
    approvalUrl?: (r: ApprovalRecord) => string | undefined;
    log?: (line: string) => void;
    alerts?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): FileGuard {
  const kill = killSwitchFor(loaded);
  const audit = new FileAuditSink(loaded.auditPath);
  const approvals = new FileApprovalStore(loaded.stateDir);
  const alerter =
    opts.alerts === false
      ? undefined
      : createAlerter({ policy: loaded.policy, approvalUrl: opts.approvalUrl, log: opts.log });
  const guard = new Guard({
    policy: loaded.policy,
    state: new FileStateStore(loaded.stateDir),
    audit,
    kill,
    approvals,
    env: opts.env ?? process.env,
    policyFile: basename(loaded.path),
    approvalUrl: opts.approvalUrl,
    onEvent: async (event) => {
      await opts.onEvent?.(event);
      await alerter?.(event);
    },
  });
  return { guard, kill, audit, approvals, loaded };
}

/** A running HTTP proxy for this policy, if one registered itself. */
export function readRegistration(loaded: LoadedPolicy): HttpRegistration | undefined {
  const file = registrationPath(loaded.stateDir);
  if (!exists(file)) return undefined;
  try {
    const reg = JSON.parse(readFileSync(file, "utf8")) as HttpRegistration;
    return reg;
  } catch {
    return undefined;
  }
}

export function approvalUrlFor(
  reg: HttpRegistration | undefined,
): ((r: ApprovalRecord) => string | undefined) | undefined {
  if (!reg) return undefined;
  return (r) => `${reg.baseUrl}/approve/${r.id}?token=${reg.token}`;
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function describeError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && "cause" in err) {
    const e = err as { code: string; cause: string; fix?: string };
    return `${e.code}: ${e.cause}${e.fix ? `\n  fix: ${e.fix}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}
