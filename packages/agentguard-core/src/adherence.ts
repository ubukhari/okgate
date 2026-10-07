/**
 * Adherence: did a coding agent keep the rules `extractRules` found, session by session?
 *
 * The readers here turn transcript lines into steps — the tool calls an agent made — using hook
 * mode's own reading of a tool call (`hookActionFromInput`, `assessHookAction`, `parseShell`) and
 * of a person's turn (`classifyTranscriptEntry`). Their input is one parsed JSON line at a time;
 * the CLI streams the files. `evaluateChecks` applies the checks to one transcript group (a
 * Claude Code session with its subagents, or a Codex rollout) and returns only counts, times,
 * line numbers and hashed call ids: nothing in a `GroupAudit` holds transcript text, so it can be
 * cached and summarized without carrying a command, a path or a prompt anywhere. `describeStep`
 * rebuilds the one-line evidence for the screen from a step that is still in memory.
 *
 * Verified 7 October 2026 against local transcripts (structure only): Claude Code 2.1.x writes
 * `tool_use` blocks in assistant entries (`id`, `name`, `input` — the hook's `tool_name` /
 * `tool_input`), `cwd`, `sessionId` and `gitBranch` on every entry, the tool's result in the next
 * user entry (`tool_result` with `tool_use_id`, `toolUseResult.gitOperation` {push|commit: {branch}}
 * for git commands, `toolDenialKind` when the harness refused the call); subagent transcripts carry
 * the parent's `sessionId`. Codex rollouts start with `session_meta` (`id`, `cwd`,
 * `parent_thread_id` for subagents) and write tool calls as `response_item` `function_call`
 * (`exec_command` {cmd, workdir}, `shell` {command[]}), `local_shell_call` and `custom_tool_call`
 * (`apply_patch`, and `exec`, whose input is JavaScript and is not read).
 *
 * Web-standard: no file system here.
 */
import {
  DEFAULT_MENTIONS,
  assessHookAction,
  hookActionFromInput,
  type HookAction,
} from "./hook.js";
import { globToRegExp, matchesPath } from "./glob.js";
import { defaultPolicy, type BuiltinIrreversible, type Policy } from "./policy.js";
import {
  PACKAGE_MANAGERS,
  stableHash,
  type CheckKind,
  type CheckSpec,
  type PackageManager,
  type Rule,
  type RuleCheck,
} from "./rules.js";
import {
  basename,
  commandText,
  isWithin,
  normalizePath,
  redactCommandLine,
  resolvePath,
  type SimpleCommand,
} from "./shell.js";
import { classifyTranscriptEntry, entryText, evaluateHumanTurn } from "./transcript.js";

export type AuditClient = "claude-code" | "codex";

/** One tool call an agent made. In memory only: `action` holds the command line or the paths. */
export interface AuditStep {
  /** the call's id (`toolu_…`, Codex `call_…`) */
  id: string;
  at: number;
  session: string;
  client: AuditClient;
  action: HookAction;
  /**
   * the branch checked out when the call was made (Claude Code `gitBranch`, main thread only);
   * "" when unknown
   */
  branch: string;
  /** what Claude Code recorded the git command did (`toolUseResult.gitOperation`) */
  pushedBranch?: string;
  committedBranch?: string;
  /** the harness refused the call (a rejected permission prompt, auto mode's classifier) */
  refused: boolean;
  /** which file of the group, and the 1-based line the call is on */
  file: number;
  line: number;
}

/** A turn a person typed. In memory only. */
export interface AuditTurn {
  session: string;
  at: number;
  text: string;
  assistantBefore?: string;
}

export interface AuditSession {
  id: string;
  client: AuditClient;
  start: number;
  end: number;
  /** the transcript says which turns a person typed (Claude Code yes, Codex no) */
  turnsKnown: boolean;
}

export interface TranscriptAudit {
  sessions: AuditSession[];
  steps: AuditStep[];
  turns: AuditTurn[];
  /** tool calls whose input is not a command line or a file edit (Codex's JavaScript `exec`) */
  unread: number;
}

export interface AuditReaderOptions {
  /** is this working directory part of the audited repository? */
  inRepo(cwd: string): boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const time = (v: unknown): number | undefined => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

class SessionBook {
  readonly sessions = new Map<string, AuditSession>();
  touch(id: string, client: AuditClient, at: number, turnsKnown: boolean): void {
    const s = this.sessions.get(id);
    if (!s) this.sessions.set(id, { id, client, start: at, end: at, turnsKnown });
    else {
      s.start = Math.min(s.start, at);
      s.end = Math.max(s.end, at);
    }
  }
}

const REFUSAL =
  /doesn't want to (proceed|take this action)|tool use was rejected|permission to use [^\n]* (was )?denied|was blocked by/i;

/** Claude Code transcript lines → steps and turns. Feed every file of a session's group. */
export class ClaudeCodeAuditReader {
  private readonly book = new SessionBook();
  private readonly steps: AuditStep[] = [];
  private readonly byId = new Map<string, AuditStep>();
  private readonly turns: AuditTurn[] = [];
  private readonly lastAssistant = new Map<string, string>();

  constructor(private readonly opts: AuditReaderOptions) {}

  add(entry: unknown, line: number, file = 0): void {
    if (!isObject(entry)) return;
    const type = entry.type;
    if (type !== "assistant" && type !== "user") return;
    const at = time(entry.timestamp);
    const session = str(entry.sessionId);
    const cwd = str(entry.cwd);
    if (at === undefined || !session) return;
    const here = cwd !== undefined && this.opts.inRepo(cwd);
    const content = isObject(entry.message) ? entry.message.content : undefined;

    if (type === "assistant") {
      if (entry.isSidechain !== true) {
        const text = entryText(entry);
        if (text.trim()) this.lastAssistant.set(session, text);
      }
      if (!here || !Array.isArray(content)) return;
      this.book.touch(session, "claude-code", at, true);
      for (const block of content) {
        if (!isObject(block) || block.type !== "tool_use") continue;
        const id = str(block.id);
        const name = str(block.name);
        if (!id || !name || this.byId.has(id)) continue;
        const action = hookActionFromInput(
          "claude-code",
          { tool_name: name, tool_input: block.input, cwd, session_id: session },
          cwd,
        );
        if (!action || action.kind === "tool") continue;
        const step: AuditStep = {
          id,
          at,
          session,
          client: "claude-code",
          action,
          // A subagent's lines can carry the session's branch while it works in a worktree on
          // another (seen 7 Oct 2026: 34 commit/push calls in worktrees marked `main`), so only
          // the main thread's `gitBranch` is trusted.
          branch: entry.isSidechain === true ? "" : (str(entry.gitBranch) ?? ""),
          refused: false,
          file,
          line,
        };
        this.byId.set(id, step);
        this.steps.push(step);
      }
      return;
    }

    // a user entry: a tool's result, or a turn
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObject(block) || block.type !== "tool_result") continue;
        const step = this.byId.get(str(block.tool_use_id) ?? "");
        if (!step) continue;
        const resultText =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((b) => (isObject(b) && typeof b.text === "string" ? b.text : ""))
                  .join("\n")
              : "";
        if (
          entry.toolDenialKind !== undefined ||
          (block.is_error === true && REFUSAL.test(resultText.slice(0, 400)))
        )
          step.refused = true;
        const op = isObject(entry.toolUseResult) ? entry.toolUseResult.gitOperation : undefined;
        if (isObject(op)) {
          if (isObject(op.push)) step.pushedBranch = str(op.push.branch) ?? step.pushedBranch;
          if (isObject(op.commit))
            step.committedBranch = str(op.commit.branch) ?? step.committedBranch;
        }
      }
    }
    if (!here) return;
    if (classifyTranscriptEntry(entry).genuine) {
      this.book.touch(session, "claude-code", at, true);
      this.turns.push({
        session,
        at,
        text: entryText(entry),
        assistantBefore: this.lastAssistant.get(session),
      });
    }
  }

  result(): TranscriptAudit {
    return {
      sessions: [...this.book.sessions.values()],
      steps: this.steps,
      turns: this.turns,
      unread: 0,
    };
  }
}

/** Codex rollout lines → steps. Codex does not label a person's turns, so `turnsKnown` is false. */
export class CodexAuditReader {
  private readonly book = new SessionBook();
  private readonly steps: AuditStep[] = [];
  private readonly seen = new Set<string>();
  private session: string | undefined;
  private cwd = "";
  private here = false;
  private unread = 0;

  constructor(private readonly opts: AuditReaderOptions) {}

  /** false once the rollout is known to be about another directory: stop reading it */
  get relevant(): boolean {
    return this.session === undefined || this.here;
  }

  add(entry: unknown, line: number, file = 0): void {
    if (!isObject(entry)) return;
    const payload = isObject(entry.payload) ? entry.payload : {};
    const at = time(entry.timestamp);
    if (entry.type === "session_meta") {
      this.session = str(payload.parent_thread_id) ?? str(payload.id) ?? "codex";
      this.cwd = str(payload.cwd) ?? "";
      this.here = this.cwd !== "" && this.opts.inRepo(this.cwd);
      if (this.here && at !== undefined) this.book.touch(this.session, "codex", at, false);
      return;
    }
    if (!this.here || !this.session || at === undefined) return;
    if (entry.type === "turn_context") {
      this.cwd = str(payload.cwd) ?? this.cwd;
      return;
    }
    let toolName: string | undefined;
    let toolInput: Json | undefined;
    const kind = entry.type === "response_item" ? str(payload.type) : undefined;
    if (kind === "function_call") {
      const name = str(payload.name) ?? "";
      let args: unknown = payload.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = undefined;
        }
      }
      if (name === "exec_command" || name === "shell" || name === "container.exec") {
        if (isObject(args)) {
          toolName = name === "exec_command" ? "exec_command" : "shell";
          toolInput = args;
        }
      } else if (name === "apply_patch" && isObject(args)) {
        toolName = "apply_patch";
        toolInput = args;
      } else if (name === "js" || name === "exec") this.unread += 1;
    } else if (kind === "local_shell_call" && isObject(payload.action)) {
      toolName = "shell";
      toolInput = {
        command: payload.action.command,
        workdir: payload.action.working_directory,
      };
    } else if (kind === "custom_tool_call") {
      const name = str(payload.name) ?? "";
      if (name === "apply_patch" && typeof payload.input === "string") {
        toolName = "apply_patch";
        toolInput = { input: payload.input };
      } else if (name === "exec") this.unread += 1;
    }
    if (!toolName || !toolInput) return;
    const id = str(payload.call_id) ?? str(payload.id) ?? `${this.session}:${line}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    const action = hookActionFromInput(
      "codex",
      { tool_name: toolName, tool_input: toolInput, cwd: this.cwd, session_id: this.session },
      this.cwd,
    );
    if (!action || action.kind === "tool") return;
    this.book.touch(this.session, "codex", at, false);
    this.steps.push({
      id,
      at,
      session: this.session,
      client: "codex",
      action,
      branch: "",
      refused: false,
      file,
      line,
    });
  }

  result(): TranscriptAudit {
    return {
      sessions: [...this.book.sessions.values()],
      steps: this.steps,
      turns: [],
      unread: this.unread,
    };
  }
}

// ---------------------------------------------------------------------------- evaluation ---

export interface AuditContext {
  /** the audited repository's root, absolute */
  repoRoot: string;
  home?: string;
  /** directories `rm` may clear (system temp, scratchpads) */
  tmpDirs: string[];
}

/** One break of one check. Counts, times and positions only: safe to cache. */
export interface CheckBreak {
  at: number;
  session: string;
  /** a hash of the call's id: the same call in two transcripts counts once */
  step: string;
  /** where the call is: the file of the group and its 1-based line */
  file: number;
  line: number;
  /** what broke it: a simple command of the call (`index` into its commands), a path it wrote
   * (`index` into its writes), or the whole call */
  what: "command" | "path" | "call";
  index: number;
  /** the latest turn a person typed before it asked for this; null when the transcript cannot say */
  asked: boolean | null;
  refused: boolean;
}

export interface CheckOutcome {
  /** sessions in which something could have broken it (a push, for a push rule) */
  applicable: string[];
  breaks: CheckBreak[];
}

/** What one transcript group contributes. Holds no transcript text: this is what is cached. */
export interface GroupAudit {
  sessions: AuditSession[];
  checks: Record<string, CheckOutcome>;
  unread: number;
}

interface Prepared {
  step: AuditStep;
  commands: SimpleCommand[];
  /** absolute paths the call writes (edit targets and shell write targets) */
  writes: string[];
  irreversible: string[];
}

let cachedPolicy: Policy | undefined;
const auditPolicy = (): Policy => (cachedPolicy ??= defaultPolicy());

function prepare(step: AuditStep, ctx: AuditContext): Prepared {
  const a = assessHookAction(auditPolicy(), step.action, {
    workspace: ctx.repoRoot,
    home: ctx.home,
    tmpDirs: ctx.tmpDirs,
    stateDir: "",
    guardFiles: [],
  });
  return {
    step,
    commands: a.commands,
    writes: a.writes,
    irreversible: a.irreversible.map((m) => m.rule),
  };
}

const bin = (cmd: SimpleCommand | undefined): string => basename(cmd?.argv[0] ?? "");
const gitSub = (cmd: SimpleCommand): string | undefined =>
  bin(cmd) === "git" ? cmd.argv[1] : undefined;
const has = (argv: string[], ...flags: string[]): boolean =>
  argv.some(
    (a) => flags.includes(a) || flags.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)),
  );

/** Positional words after `start`, skipping options and the values of `withValue` options. */
function positionals(argv: string[], start: number, withValue: Set<string> = new Set()): string[] {
  const out: string[] = [];
  let options = true;
  for (let i = start; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (options && a === "--") {
      options = false;
      continue;
    }
    if (options && a.startsWith("-") && a !== "-") {
      if (withValue.has(a)) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

const PUSH_VALUE = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

/** Branches a `git push` writes, as far as the command line, the harness and the checkout say. */
function pushTargets(cmd: SimpleCommand, p: Prepared, index: number): string[] {
  const args = positionals(cmd.argv, 2, PUSH_VALUE);
  const refspecs = args.slice(1);
  if (has(cmd.argv, "--all", "--mirror", "--branches")) return ["*"];
  const current = currentBranch(p, index);
  if (refspecs.length > 0)
    return refspecs.map((r) => {
      const spec = r.replace(/^\+/, "");
      const dst = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
      const name = dst.replace(/^refs\/heads\//, "");
      return name === "HEAD" || name === "@" ? (current ?? "") : name;
    });
  const recorded = p.step.pushedBranch;
  if (recorded) return [recorded];
  return current ? [current] : [];
}

/**
 * The branch checked out where this command runs: Claude Code's `gitBranch`, unless the line
 * changed directory or branch before it (then unknown).
 */
function currentBranch(p: Prepared, index: number): string | undefined {
  const cmd = p.commands[index];
  if (!cmd || !p.step.branch) return undefined;
  if (cmd.cwd && normalizePath(cmd.cwd) !== normalizePath(p.step.action.cwd)) return undefined;
  for (const before of p.commands.slice(0, index)) {
    const sub = gitSub(before);
    if (sub === "checkout" || sub === "switch") return undefined;
  }
  return p.step.branch;
}

function isForcePush(cmd: SimpleCommand): boolean {
  const args = cmd.argv.slice(2);
  if (
    args.some(
      (a) => a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes",
    )
  )
    return true;
  if (args.some((a) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))) return true;
  return positionals(cmd.argv, 2, PUSH_VALUE)
    .slice(1)
    .some((r) => r.startsWith("+"));
}

const NO_VERIFY_SUBS = new Set([
  "commit",
  "push",
  "merge",
  "rebase",
  "cherry-pick",
  "am",
  "revert",
  "pull",
]);
const HOOKS_OFF = /\bHUSKY(_SKIP_HOOKS)?=(0|1|true|false)\b|core\.hookspath=/i;

function skipsHooks(cmd: SimpleCommand): boolean {
  const sub = gitSub(cmd);
  if (!sub || !NO_VERIFY_SUBS.has(sub)) return false;
  if (cmd.argv.includes("--no-verify")) return true;
  return sub === "commit" && cmd.argv.slice(2).some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a));
}

const isDryRun = (cmd: SimpleCommand): boolean => has(cmd.argv, "--dry-run", "-n");
const isPush = (cmd: SimpleCommand): boolean =>
  gitSub(cmd) === "push" && !has(cmd.argv, "--dry-run", "-n", "--help", "-h");
const isCommit = (cmd: SimpleCommand): boolean =>
  gitSub(cmd) === "commit" && !has(cmd.argv, "--dry-run", "--help", "-h");
const isPrCreate = (cmd: SimpleCommand): boolean =>
  (bin(cmd) === "gh" && cmd.argv[1] === "pr" && cmd.argv[2] === "create") ||
  (bin(cmd) === "glab" && cmd.argv[1] === "mr" && cmd.argv[2] === "create");

// package managers ------------------------------------------------------------------------

const PM_PACKAGE_SUBS: Record<PackageManager, Set<string> | "all"> = {
  npm: new Set([
    "install",
    "i",
    "in",
    "ins",
    "inst",
    "isntall",
    "add",
    "ci",
    "clean-install",
    "uninstall",
    "un",
    "remove",
    "rm",
    "update",
    "up",
    "upgrade",
    "run",
    "run-script",
    "test",
    "t",
    "start",
    "exec",
    "x",
    "init",
    "create",
    "dedupe",
    "prune",
    "link",
    "rebuild",
    "audit",
  ]),
  pnpm: "all",
  yarn: "all",
  bun: new Set(["install", "i", "add", "a", "remove", "rm", "update", "upgrade", "link", "pm"]),
};
const PM_NOT_PACKAGE = new Set([
  "--version",
  "-v",
  "--help",
  "-h",
  "help",
  "publish",
  "whoami",
  "login",
  "logout",
]);

/** Is this a package-manager command (install, add, run a script…) of one of the four? */
function packageCommand(cmd: SimpleCommand): PackageManager | undefined {
  const b = bin(cmd);
  if (!(PACKAGE_MANAGERS as readonly string[]).includes(b)) return undefined;
  const pm = b as PackageManager;
  const sub = positionals(
    cmd.argv,
    1,
    new Set(["--filter", "-F", "--dir", "-C", "--prefix", "--cwd", "--workspace"]),
  )[0];
  if (cmd.argv.length === 1) return pm === "yarn" || pm === "pnpm" || pm === "bun" ? pm : undefined;
  if (cmd.argv.slice(1).every((a) => PM_NOT_PACKAGE.has(a))) return undefined;
  if (!sub) return pm === "npm" ? undefined : pm;
  if (PM_NOT_PACKAGE.has(sub)) return undefined;
  const subs = PM_PACKAGE_SUBS[pm];
  return subs === "all" || subs.has(sub) ? pm : undefined;
}

const DEP_VALUE = new Set([
  "--filter",
  "-F",
  "--workspace",
  "--dir",
  "-C",
  "--prefix",
  "--cwd",
  "--registry",
  "--tag",
  "--save-prefix",
  "-r",
  "--requirement",
  "-c",
  "--constraint",
  "-e",
  "--editable",
  "--index-url",
  "-i",
  "--extra-index-url",
  "--group",
  "-G",
  "--optional",
  "--features",
  "--package",
  "-p",
]);

/** Packages a command adds to the project, if it adds any. */
export function addedPackages(cmd: SimpleCommand): string[] {
  let argv = cmd.argv;
  const b = bin(cmd);
  if ((b === "python" || b === "python3") && argv[1] === "-m" && argv[2]?.startsWith("pip"))
    argv = ["pip", ...argv.slice(3)];
  const name = basename(argv[0] ?? "");
  const sub = argv[1];
  const global = has(argv, "-g", "--global", "--user", "--system");
  let from = -1;
  if (name === "pnpm" && (sub === "add" || ((sub === "install" || sub === "i") && argv.length > 2)))
    from = 2;
  else if (name === "npm" && ["install", "i", "in", "isntall", "add"].includes(sub ?? "")) from = 2;
  else if (name === "yarn" && sub === "add") from = 2;
  else if (name === "bun" && ["add", "a", "install", "i"].includes(sub ?? "")) from = 2;
  else if ((name === "pip" || name === "pip3") && sub === "install") from = 2;
  else if (name === "uv" && sub === "add") from = 2;
  else if (name === "uv" && sub === "pip" && argv[2] === "install") from = 3;
  else if (["poetry", "cargo", "deno"].includes(name) && sub === "add") from = 2;
  else if (name === "go" && sub === "get") from = 2;
  else if (name === "composer" && sub === "require") from = 2;
  if (from < 0 || global) return [];
  if (
    argv
      .slice(from)
      .some((a) => a === "-r" || a === "--requirement" || a === "-e" || a === "--editable")
  )
    return [];
  return positionals(argv, from, DEP_VALUE).filter(
    (a) => a !== "." && !a.startsWith("./") && !a.startsWith("../") && !a.endsWith(".txt"),
  );
}

// deploys ---------------------------------------------------------------------------------

const VERCEL_DEPLOY = new Set(["deploy", "promote", "redeploy", "rollback", "alias"]);

/** Does this command deploy something? */
export function isDeploy(cmd: SimpleCommand): boolean {
  const b = bin(cmd);
  const sub = cmd.argv[1];
  const subs = positionals(
    cmd.argv,
    1,
    new Set(["--scope", "--token", "-t", "--cwd", "--project", "-c", "--config", "--app", "-a"]),
  );
  const first = subs[0];
  switch (b) {
    case "vercel":
      return first === undefined || VERCEL_DEPLOY.has(first);
    case "wrangler":
      return (
        first === "deploy" || first === "publish" || (first === "versions" && subs[1] === "deploy")
      );
    case "fly":
    case "flyctl":
      return first === "deploy";
    case "netlify":
    case "firebase":
    case "serverless":
    case "sls":
    case "cdk":
    case "eb":
    case "sam":
      return first === "deploy";
    case "railway":
      return first === "up" || first === "deploy";
    case "gcloud":
      return subs.includes("deploy");
    case "terraform":
    case "tofu":
      return first === "apply" || first === "destroy";
    case "pulumi":
      return first === "up" || first === "destroy";
    case "kubectl":
      return first === "apply" || first === "rollout" || first === "replace";
    case "helm":
      return first === "install" || first === "upgrade";
    case "heroku":
      return Boolean(sub && /^(container:release|releases:rollback)$/.test(sub));
    case "supabase":
      return (
        (first === "functions" && subs[1] === "deploy") || (first === "db" && subs[1] === "push")
      );
    default:
      return false;
  }
}

// required commands ----------------------------------------------------------------------

const TEST_BINS = new Set(["vitest", "jest", "pytest", "mocha", "ava", "tap", "phpunit", "rspec"]);
const LINT_BINS = new Set([
  "eslint",
  "ruff",
  "flake8",
  "pylint",
  "golangci-lint",
  "rubocop",
  "biome",
  "oxlint",
  "clippy",
]);
const TYPE_BINS = new Set(["tsc", "mypy", "pyright", "vue-tsc"]);

/** argv with `run` dropped after a package manager: `pnpm run check` ≡ `pnpm check`. */
function scriptArgv(argv: string[]): string[] {
  if (
    (PACKAGE_MANAGERS as readonly string[]).includes(basename(argv[0] ?? "")) &&
    (argv[1] === "run" || argv[1] === "run-script")
  )
    return [argv[0]!, ...argv.slice(2)];
  return argv;
}

/** Did this simple command run what `run "<command>" before …` asks for? */
export function runsRequired(cmd: SimpleCommand, required: string): boolean {
  const argv = scriptArgv(cmd.argv);
  const b = basename(argv[0] ?? "");
  const words = argv.slice(1).filter((a) => !a.startsWith("-"));
  if (required === "@tests")
    return (
      TEST_BINS.has(b) ||
      (b === "go" && words[0] === "test") ||
      (b === "cargo" && words[0] === "test") ||
      (b === "python" && argv.includes("pytest")) ||
      words.slice(0, 3).some((w) => w === "test" || w === "t" || w.startsWith("test:"))
    );
  if (required === "@lint")
    return LINT_BINS.has(b) || words.slice(0, 3).some((w) => w === "lint" || w.startsWith("lint:"));
  if (required === "@typecheck")
    return (
      TYPE_BINS.has(b) ||
      words.slice(0, 3).some((w) => w === "typecheck" || w === "type-check" || w === "tsc")
    );
  const want = scriptArgv(required.trim().split(/\s+/)).join(" ").toLowerCase();
  const have = argv.join(" ").toLowerCase();
  return have === want || have.startsWith(`${want} `);
}

// ------------------------------------------------------------------------------- checks ---

function mentionsFor(spec: CheckSpec, extra: string[] = []): string[] {
  const builtin = (rule: BuiltinIrreversible): string[] => DEFAULT_MENTIONS[rule];
  switch (spec.kind) {
    case "no-push":
      return builtin("git-push");
    case "no-commit-to":
      return ["commit"];
    case "no-force-push":
      return ["force", "force-push", "force push", "rewrite"];
    case "no-verify":
      return ["no-verify", "skip hooks", "skip the hooks", "without hooks", "bypass"];
    case "package-manager":
      return [...spec.forbid];
    case "no-edit":
    case "no-commit":
      return spec.paths.map((p) => basename(p.replace(/\/?\*.*$/, "")) || p).filter(Boolean);
    case "no-new-deps":
      return [
        "install",
        "dependency",
        "dependencies",
        "package",
        "packages",
        "library",
        "libraries",
        "deps",
        "dep",
        ...extra,
      ];
    case "no-rm-outside":
      return builtin("rm-outside-workspace");
    case "no-publish":
      return builtin("publish");
    case "no-deploy":
      return ["deploy", "ship", "release", "production", "prod"];
    case "never":
      return spec.commands.map((c) => c.replace(/[*?].*$/, "").trim()).filter(Boolean);
    default:
      return [];
  }
}

function neverGlob(command: string): RegExp {
  return globToRegExp(/[*?]/.test(command) ? command : `${command}*`);
}

interface Hit {
  p: Prepared;
  what: CheckBreak["what"];
  index: number;
  /** extra words that name it (package names) */
  mentions?: string[];
}

interface Judge {
  /** does this session give the check something to look at? */
  applies(p: Prepared): boolean;
  hits(p: Prepared): Hit[];
}

function judgeFor(spec: CheckSpec, ctx: AuditContext): Judge | "sequence" {
  const cmdHits = (p: Prepared, test: (cmd: SimpleCommand, i: number) => boolean): Hit[] => {
    const out: Hit[] = [];
    p.commands.forEach((cmd, i) => {
      if (test(cmd, i)) out.push({ p, what: "command", index: i });
    });
    return out;
  };
  const any = (): boolean => true;
  switch (spec.kind) {
    case "no-push": {
      const branches = new Set(spec.branches.map((b) => b.toLowerCase()));
      return {
        applies: (p) => p.commands.some(isPush),
        hits: (p) =>
          cmdHits(
            p,
            (cmd, i) =>
              isPush(cmd) &&
              pushTargets(cmd, p, i).some((t) => t === "*" || branches.has(t.toLowerCase())),
          ),
      };
    }
    case "no-force-push": {
      const branches = new Set(spec.branches.map((b) => b.toLowerCase()));
      return {
        applies: (p) => p.commands.some(isPush),
        hits: (p) =>
          cmdHits(
            p,
            (cmd, i) =>
              isPush(cmd) &&
              isForcePush(cmd) &&
              (branches.size === 0 ||
                pushTargets(cmd, p, i).some((t) => t === "*" || branches.has(t.toLowerCase()))),
          ),
      };
    }
    case "no-commit-to": {
      const branches = new Set(spec.branches.map((b) => b.toLowerCase()));
      return {
        applies: (p) => p.commands.some(isCommit),
        hits: (p) =>
          cmdHits(p, (cmd, i) => {
            if (!isCommit(cmd) || isDryRun(cmd)) return false;
            const branch = p.step.committedBranch ?? currentBranch(p, i);
            return branch !== undefined && branches.has(branch.toLowerCase());
          }),
      };
    }
    case "no-verify":
      return {
        applies: (p) => p.commands.some((c) => isCommit(c) || isPush(c)),
        hits: (p) => {
          const out = cmdHits(p, skipsHooks);
          if (out.length === 0 && HOOKS_OFF.test(p.step.action.command ?? "")) {
            const i = p.commands.findIndex((c) => isCommit(c) || isPush(c));
            if (i >= 0) out.push({ p, what: "command", index: i });
          }
          return out;
        },
      };
    case "run-before":
      return "sequence";
    case "package-manager": {
      const forbid = new Set<string>(spec.forbid);
      return {
        applies: (p) => p.commands.some((c) => packageCommand(c) !== undefined),
        hits: (p) =>
          cmdHits(p, (cmd) => {
            const pm = packageCommand(cmd);
            return pm !== undefined && forbid.has(pm);
          }),
      };
    }
    case "no-edit": {
      const pathCtx = { workspace: ctx.repoRoot, home: ctx.home };
      return {
        applies: (p) => p.writes.length > 0,
        hits: (p) => {
          const out: Hit[] = [];
          p.writes.forEach((w, i) => {
            if (isWithin(w, ctx.repoRoot) && spec.paths.some((g) => matchesPath(w, g, pathCtx)))
              out.push({ p, what: "path", index: i });
          });
          return out;
        },
      };
    }
    case "no-commit": {
      const pathCtx = { workspace: ctx.repoRoot, home: ctx.home };
      const isAdd = (c: SimpleCommand): boolean => gitSub(c) === "add";
      return {
        applies: (p) => p.commands.some(isAdd),
        hits: (p) =>
          cmdHits(p, (cmd) => {
            if (!isAdd(cmd)) return false;
            const base = cmd.cwd || p.step.action.cwd;
            return positionals(cmd.argv, 2, new Set(["--chmod", "--pathspec-from-file"])).some(
              (arg) => {
                if (arg === "." || arg === "-A") return false;
                const abs = resolvePath(base, arg);
                return spec.paths.some((g) => matchesPath(abs, g, pathCtx));
              },
            );
          }),
      };
    }
    case "no-new-deps":
      return {
        applies: (p) => p.commands.some((c) => addedPackages(c).length > 0),
        hits: (p) => {
          const out: Hit[] = [];
          p.commands.forEach((cmd, i) => {
            const names = addedPackages(cmd);
            if (names.length > 0)
              out.push({
                p,
                what: "command",
                index: i,
                mentions: names.flatMap((n) => {
                  const bare = n.replace(/@[^/@]*$/, "").replace(/[=<>~!].*$/, "");
                  return [bare, bare.split("/").pop() ?? bare].filter((x) => x.length > 1);
                }),
              });
          });
          return out;
        },
      };
    case "no-rm-outside":
      return {
        applies: (p) =>
          p.commands.some(
            (c) =>
              ["rm", "rmdir", "unlink", "shred", "trash"].includes(bin(c)) ||
              c.via === "find -delete",
          ),
        hits: (p) => {
          if (!p.irreversible.includes("rm-outside-workspace")) return [];
          const i = p.commands.findIndex((c) =>
            ["rm", "rmdir", "unlink", "shred", "trash", "srm", "trash-put"].includes(bin(c)),
          );
          return [{ p, what: i >= 0 ? "command" : "call", index: i }];
        },
      };
    case "no-publish":
      return {
        applies: any,
        hits: (p) => {
          if (!p.irreversible.includes("publish")) return [];
          const i = p.commands.findIndex((c) =>
            /publish|push|upload|release|deprecate/.test(c.argv.join(" ")),
          );
          return [{ p, what: i >= 0 ? "command" : "call", index: i }];
        },
      };
    case "no-deploy":
      return { applies: any, hits: (p) => cmdHits(p, isDeploy) };
    case "never": {
      const globs = spec.commands.map(neverGlob);
      return {
        applies: any,
        hits: (p) => {
          const out = cmdHits(p, (cmd) => globs.some((g) => g.test(commandText(cmd))));
          const whole = (p.step.action.command ?? "").replace(/\s+/g, " ").trim();
          if (out.length === 0 && whole && globs.some((g) => g.test(whole)))
            out.push({ p, what: "call", index: -1 });
          return out;
        },
      };
    }
  }
}

/** `run "<command>" before commit|push`, in session order: after the last edit, before each gate. */
/**
 * The working tree a path belongs to: a Claude Code worktree (`<repo>/.claude/worktrees/<name>`)
 * or the main checkout. A session's main thread and its subagents can work in different trees at
 * once, and an edit in one does not change what was checked in another.
 */
function treeOf(path: string, repoRoot: string): string {
  const p = normalizePath(path);
  const m = /^(.*?\/\.claude\/worktrees\/[^/]+)(\/|$)/.exec(p);
  return m ? m[1]!.toLowerCase() : normalizePath(repoRoot).toLowerCase();
}

function sequenceHits(
  spec: Extract<CheckSpec, { kind: "run-before" }>,
  steps: Prepared[],
  ctx: AuditContext,
): { applicable: boolean; hits: Hit[] } {
  const lastEdit = new Map<string, number>();
  const lastRun = new Map<string, number>();
  let applicable = false;
  const hits: Hit[] = [];
  let pos = 0;
  for (const p of steps) {
    // a call's writes happen as it starts: `sed -i … && pnpm check` edits, then checks
    pos += 1;
    for (const w of p.writes)
      if (isWithin(w, ctx.repoRoot)) lastEdit.set(treeOf(w, ctx.repoRoot), pos);
    p.commands.forEach((cmd, i) => {
      pos += 1;
      const tree = treeOf(cmd.cwd || p.step.action.cwd || ctx.repoRoot, ctx.repoRoot);
      if (runsRequired(cmd, spec.command)) {
        lastRun.set(tree, pos);
        return;
      }
      const gate =
        spec.before === "commit" ? isCommit(cmd) && !isDryRun(cmd) : isPush(cmd) || isPrCreate(cmd);
      if (!gate) return;
      applicable = true;
      const run = lastRun.get(tree) ?? -1;
      if (run < 0 || run < (lastEdit.get(tree) ?? -1)) hits.push({ p, what: "command", index: i });
    });
  }
  return { applicable, hits };
}

/** Did the latest turn a person typed before this call ask for it? null: the transcript cannot say. */
function askedFor(
  hit: Hit,
  spec: CheckSpec,
  session: AuditSession | undefined,
  turns: AuditTurn[],
): boolean | null {
  if (spec.kind === "run-before") return false;
  if (!session?.turnsKnown) return null;
  let turn: AuditTurn | undefined;
  for (const t of turns) {
    if (t.at > hit.p.step.at) break;
    turn = t;
  }
  if (!turn) return false;
  const verdict = evaluateHumanTurn({
    turn: {
      at: new Date(turn.at).toISOString(),
      text: turn.text,
      why: "",
      assistantBefore: turn.assistantBefore,
    },
    now: new Date(hit.p.step.at),
    windowS: Number.MAX_SAFE_INTEGER,
    requireMention: true,
    mentions: mentionsFor(spec, hit.mentions),
  });
  return verdict.ok;
}

/**
 * Apply each check to one transcript group. Returns counts, times and positions only — never a
 * command, a path or a person's words — keyed by `checkKey`.
 */
export function evaluateChecks(
  checks: readonly Pick<RuleCheck, "spec" | "key">[],
  audit: TranscriptAudit,
  ctx: AuditContext,
): GroupAudit {
  const sessions = new Map(audit.sessions.map((s) => [s.id, s]));
  const bySession = new Map<string, Prepared[]>();
  const ordered = [...audit.steps].sort(
    (a, b) => a.at - b.at || a.file - b.file || a.line - b.line,
  );
  for (const step of ordered) {
    const list = bySession.get(step.session) ?? [];
    list.push(prepare(step, ctx));
    bySession.set(step.session, list);
  }
  const turnsBySession = new Map<string, AuditTurn[]>();
  for (const t of [...audit.turns].sort((a, b) => a.at - b.at)) {
    const list = turnsBySession.get(t.session) ?? [];
    list.push(t);
    turnsBySession.set(t.session, list);
  }

  const out: Record<string, CheckOutcome> = {};
  for (const { spec, key } of checks) {
    if (out[key]) continue;
    const applicable: string[] = [];
    const breaks: CheckBreak[] = [];
    const judge = judgeFor(spec, ctx);
    for (const [session, steps] of bySession) {
      let applies = false;
      let hits: Hit[] = [];
      if (judge === "sequence") {
        if (spec.kind !== "run-before") continue;
        const r = sequenceHits(spec, steps, ctx);
        applies = r.applicable;
        hits = r.hits;
      } else {
        for (const p of steps) {
          if (!applies && judge.applies(p)) applies = true;
          hits.push(...judge.hits(p));
        }
      }
      if (applies || hits.length > 0) applicable.push(session);
      const seen = new Set<string>();
      for (const hit of hits) {
        const step = stableHash(hit.p.step.id);
        if (seen.has(step)) continue;
        seen.add(step);
        breaks.push({
          at: hit.p.step.at,
          session,
          step,
          file: hit.p.step.file,
          line: hit.p.step.line,
          what: hit.what,
          index: hit.index,
          asked: askedFor(hit, spec, sessions.get(session), turnsBySession.get(session) ?? []),
          refused: hit.p.step.refused,
        });
      }
    }
    out[key] = { applicable, breaks };
  }
  return { sessions: audit.sessions, checks: out, unread: audit.unread };
}

/**
 * One line of evidence for the screen: the simple command, or the path, that broke a check.
 * Credentials masked; paths inside the repository shown relative to it. Never cached or sent.
 */
export function describeStep(
  step: AuditStep,
  brk: Pick<CheckBreak, "what" | "index">,
  ctx: AuditContext,
): string {
  const p = prepare(step, ctx);
  const rel = (path: string): string =>
    isWithin(path, ctx.repoRoot) ? path.slice(normalizePath(ctx.repoRoot).length + 1) || "." : path;
  let text: string;
  if (brk.what === "path")
    text = `${step.action.tool} ${rel(p.writes[brk.index] ?? step.action.paths[0] ?? "")}`;
  else if (brk.what === "command" && p.commands[brk.index])
    text = commandText(p.commands[brk.index]!);
  else if (step.action.kind === "edit")
    text = `${step.action.tool} ${step.action.paths.map(rel).join(", ")}`;
  else text = step.action.command ?? step.action.tool;
  return redactCommandLine(text.replace(/\s+/g, " ").trim()).slice(0, 140);
}

// ------------------------------------------------------------------------------ summary ---

export interface CheckSummary {
  key: string;
  label: string;
  kind: CheckKind;
  via: RuleCheck["via"];
  sessionsApplicable: number;
  sessionsBroken: number;
  /** of the broken sessions, those where a person's latest turn asked for it */
  sessionsOnRequest: number;
  /** `unless-asked` checks: breaks in sessions whose transcript cannot say who asked (Codex) */
  sessionsUndetermined: number;
  breaks: number;
  refused: number;
}

/** A break with the group it came from, for the evidence lookup. */
export type LocatedBreak = CheckBreak & { group: number; key: string };

export type RuleStatus = "broken" | "kept" | "not-applicable" | "not-checkable";

export interface RuleSummary {
  rule: Rule;
  status: RuleStatus;
  sessionsBroken: number;
  checks: CheckSummary[];
  /** the latest breaks, newest first (at most three) */
  last: LocatedBreak[];
}

export interface AuditSummary {
  since?: number;
  sessions: number;
  sessionsByClient: Record<AuditClient, number>;
  unread: number;
  rules: RuleSummary[];
}

/** Fold the groups' results into one line per rule, for the sessions active since `since`. */
export function summarizeAudit(
  rules: readonly Rule[],
  groups: readonly GroupAudit[],
  opts: { since?: number } = {},
): AuditSummary {
  const since = opts.since;
  const sessions = new Map<string, AuditSession>();
  let unread = 0;
  for (const g of groups) {
    unread += g.unread;
    for (const s of g.sessions) {
      const prev = sessions.get(s.id);
      if (!prev) sessions.set(s.id, { ...s });
      else {
        prev.start = Math.min(prev.start, s.start);
        prev.end = Math.max(prev.end, s.end);
        prev.turnsKnown ||= s.turnsKnown;
      }
    }
  }
  const inWindow = new Set<string>();
  const byClient: Record<AuditClient, number> = { "claude-code": 0, codex: 0 };
  for (const s of sessions.values()) {
    if (since !== undefined && s.end < since) continue;
    inWindow.add(s.id);
    byClient[s.client] += 1;
  }

  const summaries = rules.map((rule): RuleSummary => {
    const brokenSessions = new Set<string>();
    const located: LocatedBreak[] = [];
    let anyApplicable = false;
    const checks = rule.checks.map((check): CheckSummary => {
      const applicable = new Set<string>();
      const counted = new Map<string, LocatedBreak>();
      groups.forEach((g, gi) => {
        const outcome = g.checks[check.key];
        if (!outcome) return;
        for (const s of outcome.applicable) if (inWindow.has(s)) applicable.add(s);
        for (const b of outcome.breaks) {
          if (!inWindow.has(b.session) || (since !== undefined && b.at < since)) continue;
          if (!counted.has(b.step)) counted.set(b.step, { ...b, group: gi, key: check.key });
        }
      });
      const broken = new Set<string>();
      const onRequest = new Set<string>();
      const undetermined = new Set<string>();
      let refused = 0;
      let breaks = 0;
      for (const b of counted.values()) {
        if (check.spec.unlessAsked && b.asked === true) continue;
        if (check.spec.unlessAsked && b.asked === null) {
          undetermined.add(b.session);
          continue;
        }
        breaks += 1;
        if (b.refused) refused += 1;
        broken.add(b.session);
        brokenSessions.add(b.session);
        if (b.asked === true) onRequest.add(b.session);
        located.push(b);
      }
      if (applicable.size > 0 || broken.size > 0) anyApplicable = true;
      return {
        key: check.key,
        label: check.label,
        kind: check.spec.kind,
        via: check.via,
        sessionsApplicable: new Set([...applicable, ...broken]).size,
        sessionsBroken: broken.size,
        sessionsOnRequest: onRequest.size,
        sessionsUndetermined: undetermined.size,
        breaks,
        refused,
      };
    });
    const status: RuleStatus =
      rule.checks.length === 0
        ? "not-checkable"
        : brokenSessions.size > 0
          ? "broken"
          : anyApplicable
            ? "kept"
            : "not-applicable";
    const seen = new Set<string>();
    const last = located
      .sort((a, b) => b.at - a.at)
      .filter((b) => (seen.has(b.step) ? false : (seen.add(b.step), true)))
      .slice(0, 3);
    return { rule, status, sessionsBroken: brokenSessions.size, checks, last };
  });

  return {
    since,
    sessions: inWindow.size,
    sessionsByClient: byClient,
    unread,
    rules: summaries,
  };
}

/** The label of a check for the screen, with what "applicable" means for it. */
export function applicableNoun(kind: CheckKind, spec?: CheckSpec): string {
  switch (kind) {
    case "no-push":
    case "no-force-push":
      return "pushed";
    case "no-commit-to":
      return "committed";
    case "no-verify":
      return "committed or pushed";
    case "run-before":
      return spec && spec.kind === "run-before" && spec.before === "commit"
        ? "committed"
        : "pushed or opened a PR";
    case "package-manager":
      return "ran a package manager";
    case "no-edit":
      return "wrote files";
    case "no-commit":
      return "staged files";
    case "no-new-deps":
      return "added packages";
    case "no-rm-outside":
      return "removed files";
    default:
      return "";
  }
}
