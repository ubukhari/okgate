/**
 * Hook mode: the coding agent's own shell commands and file edits, checked against the same
 * `agentguard.yaml` as MCP calls. A pre-execution hook (Claude Code `PreToolUse`, Codex
 * `PreToolUse`, Gemini CLI `BeforeTool`) hands over one tool call; `hookActionFromInput` turns
 * it into a `HookAction`, `assessHookAction` applies the rules, and `Guard.preflight` applies
 * the stateful parts (kill switch, approvals, the human-turn gate, loop breaker, caps, audit).
 *
 * Web-standard: no file system here. The CLI reads stdin, the transcript and the policy.
 */
import { classifyByName, type MutationVerb, type ToolClass } from "./classify.js";
import type { CounterDelta } from "./caps.js";
import type { GuardErrorBody } from "./errors.js";
import { firstMatch, firstPathMatch } from "./glob.js";
import { BUILTIN_IRREVERSIBLE, type BuiltinIrreversible, type Policy } from "./policy.js";
import {
  basename,
  commandText,
  isWithin,
  normalizePath,
  parseShell,
  redactCommandLine,
  resolvePath,
  type ShellWord,
  type SimpleCommand,
} from "./shell.js";

export type HookClient = "claude-code" | "codex" | "gemini-cli";
export const HOOK_CLIENTS: readonly HookClient[] = ["claude-code", "codex", "gemini-cli"];

/** What a human turn names each built-in class with. Extend per rule with `irreversible.mentions`. */
export const DEFAULT_MENTIONS: Record<BuiltinIrreversible, string[]> = {
  "git-push": ["push", "ship"],
  merge: ["merge", "ship", "land"],
  "tag-delete": ["tag", "release"],
  // not "clean": "clean up the build" is an in-workspace request, not consent to delete outside it
  "rm-outside-workspace": ["rm", "delete", "remove", "wipe", "erase"],
  publish: ["publish", "release", "ship"],
  send: [
    "send",
    "email",
    "mail",
    "message",
    "post",
    "comment",
    "reply",
    "notify",
    "issue",
    "pr",
    "pull request",
    "review",
  ],
  "guard-config": ["agentguard", "hook", "hooks", "policy", "guard"],
};

export interface HookAction {
  client: HookClient;
  /** the harness's tool name: `Bash`, `Write`, `apply_patch`, `run_shell_command`, `mcp__crm__delete` */
  tool: string;
  kind: "shell" | "edit" | "tool";
  command?: string;
  /** absolute paths an edit tool writes */
  paths: string[];
  /** absolute directory the call runs in */
  cwd: string;
  /** what an approval and the loop breaker compare */
  identity: unknown;
  /** what the audit log records (redacted again before writing) */
  logArgs: unknown;
  sessionId: string;
  transcriptPath?: string;
}

export interface HookContext {
  /** the project root: CLAUDE_PROJECT_DIR, GEMINI_PROJECT_DIR, the policy's directory or cwd */
  workspace: string;
  home?: string;
  /** directories `rm` may clear without a human turn (system temp, the session scratchpad) */
  tmpDirs: string[];
  /** agentguard's own state: approvals, audit log, kill switch */
  stateDir: string;
  /** files whose edit changes the guard itself: the policy file and the hook settings files */
  guardFiles: string[];
}

export interface IrreversibleMatch {
  rule: string;
  verb: MutationVerb;
  /** what was matched, one line */
  summary: string;
  /** words a human turn names it with */
  mentions: string[];
}

export interface HookAssessment {
  class: ToolClass;
  verb: MutationVerb;
  /** one line for the audit log and messages (credentials masked) */
  summary: string;
  commands: SimpleCommand[];
  /** absolute paths the call writes or deletes (edit targets and shell write targets) */
  writes: string[];
  /** refused by a rule, whatever the human turn */
  denied?: GuardErrorBody;
  /** a rule asks for a human's approval */
  approval?: { rule: string; reason: string };
  irreversible: IrreversibleMatch[];
  /** subject to the loop breaker (file edits) */
  loop: boolean;
  delta: CounterDelta;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Which harness sent this hook input, when the installer did not say. */
export function detectHookClient(input: unknown): HookClient {
  if (!isObject(input)) return "claude-code";
  if (input.hook_event_name === "BeforeTool") return "gemini-cli";
  if (typeof input.turn_id === "string" || input.tool_name === "apply_patch") return "codex";
  return "claude-code";
}

const CLAUDE_SHELL = new Set(["Bash", "PowerShell"]);
const CLAUDE_EDIT = new Set(["Write", "Edit", "MultiEdit"]);

/**
 * Normalize one pre-execution hook input. `cwd` falls back to `fallbackCwd`. Returns undefined
 * for input that is not a tool call.
 */
export function hookActionFromInput(
  client: HookClient,
  input: unknown,
  fallbackCwd = "",
): HookAction | undefined {
  if (!isObject(input)) return undefined;
  const tool = str(input.tool_name);
  if (!tool) return undefined;
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  const cwd = normalizePath(str(input.cwd) ?? fallbackCwd);
  const sessionId = str(input.session_id) ?? "unknown";
  const transcriptPath = str(input.transcript_path) ?? undefined;
  const base = { client, tool, cwd, sessionId, transcriptPath };

  const shell = (command: string, runIn = cwd): HookAction => ({
    ...base,
    cwd: runIn,
    kind: "shell",
    command,
    paths: [],
    identity: { command },
    logArgs: { command: redactCommandLine(command) },
  });
  const edit = (paths: string[], identity: unknown): HookAction => ({
    ...base,
    kind: "edit",
    paths: paths.map((p) => resolvePath(cwd, p)),
    identity,
    logArgs: { paths: paths.map((p) => resolvePath(cwd, p)) },
  });
  const other = (): HookAction => ({
    ...base,
    kind: "tool",
    paths: [],
    identity: toolInput,
    logArgs: toolInput,
  });

  if (client === "claude-code") {
    if (CLAUDE_SHELL.has(tool)) return shell(str(toolInput.command) ?? "");
    if (CLAUDE_EDIT.has(tool)) {
      const path = str(toolInput.file_path) ?? "";
      return edit([path], {
        file_path: path,
        content: toolInput.content,
        old_string: toolInput.old_string,
        new_string: toolInput.new_string,
        edits: toolInput.edits,
      });
    }
    if (tool === "NotebookEdit") {
      const path = str(toolInput.notebook_path) ?? str(toolInput.file_path) ?? "";
      return edit([path], { ...toolInput });
    }
    return other();
  }
  if (client === "codex") {
    if (tool === "Bash" || tool === "exec_command" || tool === "shell") {
      const raw = toolInput.command ?? toolInput.cmd;
      const command = Array.isArray(raw)
        ? raw.map((a) => shellQuote(String(a))).join(" ")
        : (str(raw) ?? "");
      return shell(
        command,
        str(toolInput.workdir) ? resolvePath(cwd, str(toolInput.workdir)!) : cwd,
      );
    }
    if (tool === "apply_patch") {
      const patch = str(toolInput.command) ?? str(toolInput.input) ?? str(toolInput.patch) ?? "";
      return edit(patchPaths(patch), { command: patch });
    }
    return other();
  }
  // gemini-cli
  if (tool === "run_shell_command") {
    const dir = str(toolInput.dir_path) ?? str(toolInput.directory);
    return shell(str(toolInput.command) ?? "", dir ? resolvePath(cwd, dir) : cwd);
  }
  if (tool === "write_file" || tool === "replace") {
    const path = str(toolInput.file_path) ?? str(toolInput.absolute_path) ?? "";
    return edit([path], { ...toolInput });
  }
  return other();
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Files named in a Codex `apply_patch` envelope. */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const m = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim());
    if (m) out.push(m[1]!.trim());
  }
  return [...new Set(out)];
}

/** MCP tool name without the harness prefix: `mcp__crm__delete_contact` → `delete_contact`. */
export function bareToolName(tool: string): string {
  const cc = /^mcp__[^_](?:[^_]|_(?!_))*__(.+)$/.exec(tool);
  if (cc) return cc[1]!;
  return tool;
}

function builtinsEnabled(policy: Policy): Set<BuiltinIrreversible> {
  const b = policy.hooks.irreversible.builtins;
  if (b === true) return new Set(BUILTIN_IRREVERSIBLE);
  if (b === false) return new Set();
  return new Set(b);
}

export function mentionsFor(policy: Policy, rule: string): string[] {
  const extra = policy.hooks.irreversible.mentions[rule] ?? [];
  const builtin = (DEFAULT_MENTIONS as Record<string, string[]>)[rule];
  if (builtin) return [...builtin, ...extra];
  const custom = policy.hooks.irreversible.rules.find((r) => r.name === rule);
  const base = custom && custom.mentions.length > 0 ? custom.mentions : [rule];
  return [...base, ...extra];
}

const RULE_VERB: Record<BuiltinIrreversible, MutationVerb> = {
  "git-push": "send",
  merge: "update",
  "tag-delete": "delete",
  "rm-outside-workspace": "delete",
  publish: "send",
  send: "send",
  "guard-config": "update",
};

const READ_ONLY_BINS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "pwd",
  "echo",
  "printf",
  "which",
  "type",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "less",
  "more",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "yq",
  "diff",
  "cmp",
  "date",
  "whoami",
  "id",
  "uname",
  "hostname",
  "printenv",
  "true",
  "false",
  "test",
  "[",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "nl",
  "column",
  "comm",
  "sleep",
  "seq",
  "ps",
  "env",
]);
const GIT_READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "grep",
  "reflog",
  "cat-file",
  "ls-tree",
  "merge-base",
  "rev-list",
  "whatchanged",
]);

function isReadOnly(cmd: SimpleCommand): boolean {
  const bin = basename(cmd.argv[0] ?? "");
  if (cmd.redirects.some((r) => WRITE_REDIRECTS.has(r.op) && !isDevNull(r.target.text)))
    return false;
  if (bin === "git") return GIT_READ.has(cmd.argv[1] ?? "");
  if (bin === "sed" || bin === "awk") return !cmd.argv.some((a) => /^-i|^--in-place/.test(a));
  if (bin === "find")
    return !cmd.argv.some((a) => a === "-delete" || a.startsWith("-exec") || a.startsWith("-ok"));
  return READ_ONLY_BINS.has(bin);
}

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const isDevNull = (t: string): boolean =>
  t === "/dev/null" || t === "/dev/stderr" || t === "/dev/stdout";

interface Target {
  path?: string;
  /** a word we cannot resolve (depends on a variable) */
  unknown?: string;
}

const TMP_VARS = /^\$\{?(TMPDIR|TMP|TEMP|RUNNER_TEMP)(\}|:-[^}]*\})?/;

/** Resolve a path argument where the command runs. */
function resolveTarget(word: ShellWord, cwd: string, ctx: HookContext): Target {
  let text = word.text;
  if (word.dynamic) {
    if (ctx.home) text = text.replace(/^\$\{?HOME\}?(?=\/|$)/, ctx.home);
    // something under the temp dir, never the temp dir itself
    if (TMP_VARS.test(text)) return { path: `${normalizePath(ctx.tmpDirs[0] ?? "/tmp")}/…` };
    const cut = text.search(/\$|`/);
    if (cut >= 0) {
      const prefix = text.slice(0, cut);
      const slash = prefix.lastIndexOf("/");
      if (slash < 0) return { unknown: word.text };
      const dir = resolvePath(cwd || ctx.workspace, prefix.slice(0, slash) || "/");
      // `rm -rf ./$x` could be the directory itself when $x is empty
      if (dir === normalizePath(ctx.workspace) || !isWithin(dir, ctx.workspace))
        return isTemp(dir, ctx) ? { path: dir } : { unknown: word.text };
      return { path: `${dir}/…` };
    }
  }
  const glob = text.search(/[*?[]/);
  if (glob >= 0) {
    const prefix = text.slice(0, glob);
    const slash = prefix.lastIndexOf("/");
    text = slash >= 0 ? prefix.slice(0, slash) || "/" : ".";
    const dir = resolvePath(cwd || ctx.workspace, text);
    return { path: dir === normalizePath(ctx.workspace) ? `${dir}/*` : dir };
  }
  return { path: resolvePath(cwd || ctx.workspace, text) };
}

function isTemp(path: string, ctx: HookContext): boolean {
  return ctx.tmpDirs.some((d) => d && isWithin(path, normalizePath(d)));
}

function positional(words: ShellWord[], start = 1): ShellWord[] {
  const out: ShellWord[] = [];
  let options = true;
  for (const w of words.slice(start)) {
    if (options && w.text === "--") {
      options = false;
      continue;
    }
    if (options && w.text.startsWith("-") && w.text !== "-") continue;
    out.push(w);
  }
  return out;
}

/** Paths a simple command writes or deletes. */
function shellWriteTargets(cmd: SimpleCommand, ctx: HookContext): Target[] {
  const out: Target[] = [];
  for (const r of cmd.redirects) {
    if (!WRITE_REDIRECTS.has(r.op) || /^\d+$|^-$/.test(r.target.text) || isDevNull(r.target.text))
      continue;
    out.push(resolveTarget(r.target, cmd.cwd, ctx));
  }
  const bin = basename(cmd.argv[0] ?? "");
  const args = positional(cmd.words);
  const add = (ws: ShellWord[]): void => {
    for (const w of ws) out.push(resolveTarget(w, cmd.cwd, ctx));
  };
  if (
    [
      "tee",
      "rm",
      "rmdir",
      "unlink",
      "shred",
      "touch",
      "truncate",
      "mv",
      "srm",
      "trash",
      "trash-put",
    ].includes(bin)
  )
    add(args);
  else if (["cp", "install", "ln", "rsync"].includes(bin) && args.length > 1) add(args.slice(-1));
  else if (
    (bin === "sed" || bin === "perl") &&
    cmd.argv.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))
  ) {
    // the first positional word is the script (`-e` / `-f` values included), the rest are files
    add(args.slice(1));
  } else if (bin === "dd") {
    for (const a of cmd.words) if (a.text.startsWith("of=")) add([{ ...a, text: a.text.slice(3) }]);
  }
  return out;
}

const RM_BINS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash", "trash-put"]);
const MAIL_BINS = new Set(["sendmail", "mail", "mailx", "mutt", "neomutt", "msmtp", "swaks"]);
const MESSAGING_HOSTS =
  /\b(hooks\.slack\.com|slack\.com\/api\/chat\.|discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot[^/\s]*\/send|api\.sendgrid\.com|api\.resend\.com|api\.postmarkapp\.com|api\.mailgun\.net|api\.twilio\.com|graph\.microsoft\.com\/[^\s]*\/sendMail|gmail\.googleapis\.com\/[^\s]*\/send|outlook\.office\.com\/webhook)/i;
const GH_SEND: Record<string, Set<string>> = {
  pr: new Set([
    "create",
    "comment",
    "review",
    "edit",
    "close",
    "reopen",
    "ready",
    "lock",
    "unlock",
  ]),
  issue: new Set([
    "create",
    "comment",
    "edit",
    "close",
    "reopen",
    "delete",
    "transfer",
    "lock",
    "unlock",
    "pin",
    "unpin",
    "develop",
  ]),
  gist: new Set(["create", "edit", "delete"]),
  discussion: new Set(["create", "comment"]),
};
const GLAB_SEND: Record<string, Set<string>> = {
  mr: new Set(["create", "note", "approve", "close", "reopen", "update"]),
  issue: new Set(["create", "note", "close", "reopen", "update", "delete"]),
};

function has(argv: string[], ...flags: string[]): boolean {
  return argv.some(
    (a) => flags.includes(a) || flags.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)),
  );
}

/** The built-in irreversible classes one simple command falls into. */
function builtinShellMatches(
  cmd: SimpleCommand,
  ctx: HookContext,
): { rule: BuiltinIrreversible; summary: string }[] {
  const out: { rule: BuiltinIrreversible; summary: string }[] = [];
  const argv = cmd.argv;
  const bin = basename(argv[0] ?? "");
  const line = redactCommandLine(commandText(cmd)).slice(0, 160);
  const sub = argv[1];
  const sub2 = argv[2];

  if (bin === "git") {
    if (sub === "push" && !has(argv, "--dry-run", "-n", "--help", "-h"))
      out.push({ rule: "git-push", summary: line });
    if (sub === "tag" && has(argv, "-d", "--delete"))
      out.push({ rule: "tag-delete", summary: line });
  }
  if (bin === "gh" && sub) {
    if (sub === "pr" && sub2 === "merge") out.push({ rule: "merge", summary: line });
    else if (sub === "release" && (sub2 === "delete" || sub2 === "delete-asset"))
      out.push({ rule: "tag-delete", summary: line });
    else if (sub === "release" && (sub2 === "create" || sub2 === "upload" || sub2 === "edit"))
      out.push({ rule: "publish", summary: line });
    else if (sub2 && GH_SEND[sub]?.has(sub2)) out.push({ rule: "send", summary: line });
    else if (sub === "api") {
      const method = ghApiMethod(argv);
      if (method !== "GET") {
        const endpoint = argv.slice(2).find((a) => !a.startsWith("-") && a.includes("/")) ?? "";
        out.push({
          rule: /\/merge$/.test(endpoint) && method === "PUT" ? "merge" : "send",
          summary: line,
        });
      }
    }
  }
  if (bin === "glab" && sub) {
    if (sub === "mr" && sub2 === "merge") out.push({ rule: "merge", summary: line });
    else if (sub === "release" && sub2 === "create") out.push({ rule: "publish", summary: line });
    else if (sub2 && GLAB_SEND[sub]?.has(sub2)) out.push({ rule: "send", summary: line });
  }
  if (isPublish(bin, argv)) out.push({ rule: "publish", summary: line });
  if (MAIL_BINS.has(bin)) out.push({ rule: "send", summary: line });
  if (
    ["curl", "wget", "http", "https", "xh", "httpie"].includes(bin) &&
    argv.some((a) => MESSAGING_HOSTS.test(a))
  )
    out.push({ rule: "send", summary: line });

  if (RM_BINS.has(bin)) {
    const recursive =
      cmd.via === "find -delete" ||
      (bin === "rm" && argv.slice(1).some((a) => a === "--recursive" || /^-[a-zA-Z]*[rR]/.test(a)));
    for (const w of positional(cmd.words)) {
      const t = resolveTarget(w, cmd.cwd, ctx);
      if (t.unknown !== undefined) {
        if (recursive) {
          out.push({
            rule: "rm-outside-workspace",
            summary: `${line} — target "${t.unknown}" depends on a variable`,
          });
          break;
        }
        continue;
      }
      const path = t.path!;
      const ws = normalizePath(ctx.workspace);
      // the workspace itself or a directory holding it — even when that lives under a temp dir
      if (isWithin(ws, path)) {
        out.push({
          rule: "rm-outside-workspace",
          summary: `${line} — ${path === ws ? "the workspace itself" : `${path} contains the workspace`}`,
        });
        break;
      }
      if (isTemp(path, ctx)) continue;
      if (!isWithin(path, ws)) {
        out.push({
          rule: "rm-outside-workspace",
          summary: `${line} — ${path} is outside the workspace`,
        });
        break;
      }
    }
  }

  const agIdx = argv.findIndex((a) => isAgentguardBin(a));
  if (agIdx >= 0) {
    const verb = argv.slice(agIdx + 1).find((a) => !a.startsWith("-"));
    if (verb === "hooks" || verb === "init") out.push({ rule: "guard-config", summary: line });
  }
  return out;
}

function isAgentguardBin(arg: string): boolean {
  const b = basename(arg);
  return (
    b === "agentguard" ||
    /^agentguard@/.test(b) ||
    /agentguard[\\/](dist[\\/])?cli\.[cm]?js$/.test(arg)
  );
}

function ghApiMethod(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "-X" || a === "--method") return (argv[i + 1] ?? "GET").toUpperCase();
    if (a.startsWith("--method=")) return a.slice(9).toUpperCase();
    if (/^-X[A-Za-z]+$/.test(a)) return a.slice(2).toUpperCase();
  }
  // fields make `gh api` a POST
  return argv.some(
    (a) =>
      ["-f", "-F", "--field", "--raw-field", "--input"].includes(a) || /^--(raw-)?field=/.test(a),
  )
    ? "POST"
    : "GET";
}

function isPublish(bin: string, argv: string[]): boolean {
  const dry = has(argv, "--dry-run", "--dryrun", "-n");
  const sub = argv.slice(1).filter((a) => !a.startsWith("-"));
  if (["npm", "pnpm", "bun"].includes(bin))
    return (sub.includes("publish") || sub[0] === "unpublish" || sub[0] === "deprecate") && !dry;
  if (bin === "yarn")
    return (sub[0] === "publish" || (sub[0] === "npm" && sub[1] === "publish")) && !dry;
  if (bin === "cargo") return sub[0] === "publish" && !dry;
  if (bin === "twine") return sub[0] === "upload";
  if (bin === "gem") return sub[0] === "push";
  if (
    ["poetry", "uv", "hatch", "flit", "vsce", "ovsx", "lerna", "changeset", "changesets"].includes(
      bin,
    )
  )
    return sub[0] === "publish" && !dry;
  if (bin === "docker" || bin === "podman") return sub[0] === "push";
  if (bin === "semantic-release") return !dry;
  if (bin === "goreleaser")
    return sub[0] === "release" && !has(argv, "--snapshot", "--skip=publish");
  if (bin === "dotnet") return sub[0] === "nuget" && sub[1] === "push";
  return false;
}

/** Is this command the agent approving, denying or resuming its own held actions? */
function selfApproval(cmd: SimpleCommand): boolean {
  const argv = cmd.argv;
  const idx = argv.findIndex((a) => isAgentguardBin(a));
  if (idx < 0) return false;
  const verb = argv.slice(idx + 1).find((a) => !a.startsWith("-"));
  return verb === "approve" || verb === "deny" || verb === "resume";
}

function denial(cause: string, fix: string, details: Json): GuardErrorBody {
  return { code: "TOOL_DENIED", cause, fix, retryable: false, details };
}

/** Apply the policy's hook rules to one call. Pure: no state, no clock. */
export function assessHookAction(
  policy: Policy,
  action: HookAction,
  ctx: HookContext,
): HookAssessment {
  const hooks = policy.hooks;
  const enabled = builtinsEnabled(policy);
  const irreversible: IrreversibleMatch[] = [];
  const addMatch = (rule: string, summary: string, verb?: MutationVerb): void => {
    if (irreversible.some((m) => m.rule === rule)) return;
    irreversible.push({
      rule,
      verb: verb ?? (RULE_VERB as Record<string, MutationVerb>)[rule] ?? "execute",
      summary,
      mentions: mentionsFor(policy, rule),
    });
  };
  const pathCtx = { workspace: ctx.workspace, home: ctx.home };
  const stateDir = normalizePath(ctx.stateDir);
  const guardFiles = ctx.guardFiles.map((f) => normalizePath(f).toLowerCase());

  let commands: SimpleCommand[] = [];
  const writeTargets: Target[] = [];
  let summary: string;
  let cls: ToolClass = "write";
  let verb: MutationVerb = "execute";
  let denied: GuardErrorBody | undefined;
  let approval: HookAssessment["approval"];

  if (action.kind === "shell") {
    const command = action.command ?? "";
    summary = redactCommandLine(command.replace(/\s+/g, " ").trim()).slice(0, 240);
    commands = parseShell(command, { cwd: action.cwd, home: ctx.home });
    for (const cmd of commands) writeTargets.push(...shellWriteTargets(cmd, ctx));
    const whole = command.replace(/\s+/g, " ").trim();
    const texts = [whole, ...commands.map(commandText)];
    const matchShell = (patterns: readonly string[]): string | undefined => {
      for (const t of texts) {
        const hit = firstMatch(t, patterns);
        if (hit) return hit;
      }
      return undefined;
    };
    for (const cmd of commands) {
      if (selfApproval(cmd))
        denied ??= denial(
          "an agent may not approve, deny or resume its own held actions",
          "stop and ask the user to run the approval in their own terminal (or `!` + the command in Claude Code); do not try another way",
          { rule: "agentguard-self", command: summary },
        );
      for (const m of builtinShellMatches(cmd, ctx))
        if (enabled.has(m.rule)) addMatch(m.rule, m.summary);
    }
    const denyHit = matchShell(hooks.shell.deny);
    if (denyHit && !denied)
      denied = denial(
        `this command matches hooks.shell.deny "${denyHit}" in agentguard.yaml`,
        "do not run it or a variant of it; tell the user what you were trying to do and ask how to proceed",
        { rule: "hooks.shell.deny", pattern: denyHit, command: summary },
      );
    const approvalHit = matchShell(hooks.shell.approval);
    if (approvalHit)
      approval = {
        rule: "hooks.shell.approval",
        reason: `matches hooks.shell.approval "${approvalHit}"`,
      };
    for (const rule of hooks.irreversible.rules) {
      const hit = rule.shell.length > 0 ? matchShell(rule.shell) : undefined;
      if (hit) addMatch(rule.name, `${summary} (rule ${rule.name}: ${hit})`, "execute");
    }
    if (commands.length > 0 && commands.every(isReadOnly) && irreversible.length === 0) {
      cls = "read";
      verb = "read";
    }
  } else if (action.kind === "edit") {
    summary = `${action.tool} ${action.paths.join(", ")}`.slice(0, 240);
    for (const p of action.paths) writeTargets.push({ path: normalizePath(p) });
    verb = "update";
  } else {
    const bare = bareToolName(action.tool);
    summary = action.tool;
    const heuristic = classifyByName(bare);
    cls = heuristic.class;
    verb = heuristic.verb;
    const names = bare === action.tool ? [action.tool] : [action.tool, bare];
    const denyHit = names.map((n) => firstMatch(n, policy.deny)).find(Boolean);
    if (denyHit)
      denied = denial(
        `"${action.tool}" is denied by agentguard.yaml (deny: ${denyHit})`,
        "use a different tool; the operator can remove it from `deny`",
        { rule: "deny", pattern: denyHit },
      );
    const approvalHit = names.map((n) => firstMatch(n, policy.approval.tools)).find(Boolean);
    if (approvalHit)
      approval = { rule: "approval.tools", reason: `matches approval.tools "${approvalHit}"` };
    if (enabled.has("send") && heuristic.verb === "send")
      addMatch("send", `${action.tool} (${heuristic.reason})`);
    for (const rule of hooks.irreversible.rules) {
      const hit = names.map((n) => firstMatch(n, rule.tools)).find(Boolean);
      if (hit) addMatch(rule.name, `${action.tool} (rule ${rule.name}: ${hit})`, verb);
    }
  }

  // paths: the agentguard state directory, deny/approval patterns, guard files, rule paths
  const writes: string[] = [];
  for (const t of writeTargets) {
    if (t.path === undefined) continue;
    const path = t.path.endsWith("/…") || t.path.endsWith("/*") ? t.path.slice(0, -2) : t.path;
    writes.push(path);
    if (stateDir && isWithin(path, stateDir) && !denied)
      denied = denial(
        "agentguard's state directory (approvals, audit log, kill switch) is written only by agentguard",
        "do not modify it; ask the user if something there needs to change",
        { rule: "agentguard-self", path },
      );
    const denyHit = firstPathMatch(path, hooks.paths.deny, pathCtx);
    if (denyHit && !denied)
      denied = denial(
        `writing ${path} matches hooks.paths.deny "${denyHit}" in agentguard.yaml`,
        "leave this file alone; tell the user what change you wanted to make",
        { rule: "hooks.paths.deny", pattern: denyHit, path },
      );
    const approvalHit = firstPathMatch(path, hooks.paths.approval, pathCtx);
    if (approvalHit && !approval)
      approval = {
        rule: "hooks.paths.approval",
        reason: `writing ${path} matches hooks.paths.approval "${approvalHit}"`,
      };
    if (enabled.has("guard-config") && guardFiles.includes(path.toLowerCase()))
      addMatch("guard-config", `writes ${path}`);
    for (const rule of hooks.irreversible.rules) {
      const hit = firstPathMatch(path, rule.paths, pathCtx);
      if (hit) addMatch(rule.name, `writes ${path} (rule ${rule.name}: ${hit})`, "update");
    }
  }

  if (irreversible.length > 0) {
    cls = "write";
    verb = irreversible[0]!.verb;
  }
  const delta: CounterDelta = { hook_calls: 1 };
  if (action.kind === "shell") delta.shell_commands = 1;
  if (action.kind === "edit") delta.file_edits = 1;
  if (irreversible.length > 0) delta.irreversible = 1;
  return {
    class: cls,
    verb,
    summary,
    commands,
    writes: [...new Set(writes)],
    denied,
    approval,
    irreversible,
    // Identical edits repeated are an agent stuck. Irreversible commands are not counted: the
    // human-turn gate already allows one per turn, and a held push retried after `approve` must
    // not trip a loop verdict.
    loop: action.kind === "edit",
    delta,
  };
}

/** Words to show for an irreversible match in one line: `git-push (git push origin main)`. */
export function describeIrreversible(matches: readonly IrreversibleMatch[]): string {
  return matches.map((m) => `${m.rule} (${m.summary})`).join("; ");
}

/** Every rule's mentions merged, for the gate when one command trips several classes. */
export function allMentions(matches: readonly IrreversibleMatch[]): string[] {
  return [...new Set(matches.flatMap((m) => m.mentions))];
}
