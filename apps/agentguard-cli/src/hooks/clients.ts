/**
 * Where each coding agent reads its pre-execution hooks, and the entry okgate writes there.
 * Verified 7 October 2026 against:
 *
 * - Claude Code: https://code.claude.com/docs/en/hooks — `hooks.PreToolUse[]` in
 *   `.claude/settings.json` (project) or `~/.claude/settings.json` (user); a matcher with
 *   characters beyond letters, digits, `_`, `-`, `,` and `|` is an unanchored regex; `timeout`
 *   in seconds.
 * - Codex CLI: https://developers.openai.com/codex/hooks — `hooks.PreToolUse[]` in
 *   `.codex/hooks.json` or `~/.codex/hooks.json`; the matcher is a regex over the tool name
 *   (`Bash`, `apply_patch`, `mcp__…`); `timeout` in seconds; a new hook runs only after the user
 *   trusts it in `/hooks`.
 * - Gemini CLI: https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md —
 *   `hooks.BeforeTool[]` in `.gemini/settings.json` or `~/.gemini/settings.json`; regex matcher
 *   over `run_shell_command`, `write_file`, `replace`, `mcp_…`; `timeout` in milliseconds.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LEGACY_POLICY_FILE,
  LEGACY_STATE_DIR,
  POLICY_FILE,
  STATE_DIR,
  type HookClient,
} from "@agentwares/agentguard-core";

export type InstallScope = "project" | "user";

export interface HookTarget {
  client: HookClient;
  label: string;
  scope: InstallScope;
  settingsPath: string;
  event: "PreToolUse" | "BeforeTool";
  matcher: string;
  handler: Record<string, unknown>;
  /** what the user has to do in the client before the hook runs */
  note?: string;
}

/** Tools worth a check: the shell, file writes and MCP tools. Reads are left alone. */
export const MATCHERS: Record<HookClient, string> = {
  "claude-code": "^(Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit)$|^mcp__",
  codex: "^(Bash|apply_patch)$|^mcp__",
  "gemini-cli": "^(run_shell_command|write_file|replace)$|^mcp_",
};

export const CLIENT_ALIASES: Record<string, HookClient> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  "gemini-cli": "gemini-cli",
};

export function hookTarget(
  client: HookClient,
  scope: InstallScope,
  where: { cwd: string; home: string },
  command: string,
  timeoutS = 30,
): HookTarget {
  const root = scope === "project" ? where.cwd : where.home;
  if (client === "claude-code")
    return {
      client,
      label: "Claude Code",
      scope,
      settingsPath: join(root, ".claude", "settings.json"),
      event: "PreToolUse",
      matcher: MATCHERS[client],
      handler: { type: "command", command, timeout: timeoutS, statusMessage: "okgate" },
    };
  if (client === "codex")
    return {
      client,
      label: "Codex CLI",
      scope,
      settingsPath: join(root, ".codex", "hooks.json"),
      event: "PreToolUse",
      matcher: MATCHERS[client],
      handler: { type: "command", command, timeout: timeoutS, statusMessage: "okgate" },
      note: "Codex runs a new hook only after you trust it: open /hooks in Codex and trust the okgate entry.",
    };
  return {
    client,
    label: "Gemini CLI",
    scope,
    settingsPath: join(root, ".gemini", "settings.json"),
    event: "BeforeTool",
    matcher: MATCHERS[client],
    handler: {
      name: "okgate",
      type: "command",
      command,
      timeout: timeoutS * 1000,
      description: "okgate: one rulebook for shell commands and file edits",
    },
    note:
      scope === "project"
        ? "Gemini CLI fingerprints project hooks: confirm the okgate hook the first time it asks."
        : undefined,
  };
}

/** Is this hook command one okgate wrote, under either name (agentguard before the rename)? */
export function isGuardHookCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    /okgate|agentguard/.test(command) &&
    /\bhook\s+pre-tool-use\b/.test(command)
  );
}

/**
 * The backup of a file okgate rewrites: `<file>.okgate-backup`, or the `<file>.agentguard-backup`
 * an okgate-era install left, which holds the older original and so wins.
 */
export function backupFor(path: string): { existing?: string; next: string } {
  const legacy = `${path}.agentguard-backup`;
  const next = `${path}.okgate-backup`;
  return { existing: [legacy, next].find((b) => existsSync(b)), next };
}

type Json = Record<string, unknown>;
interface MatcherGroup {
  matcher?: string;
  hooks?: Json[];
  [k: string]: unknown;
}

function readSettings(path: string): Json {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it or move it aside — okgate will not overwrite it`,
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${path} is not a JSON object; okgate will not overwrite it`);
  return parsed as Json;
}

function groupsOf(settings: Json, event: string): MatcherGroup[] {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const groups = (hooks as Json)[event];
  return Array.isArray(groups) ? (groups as MatcherGroup[]) : [];
}

/** The okgate handlers currently in a settings file. */
export function installedHandlers(target: HookTarget): Json[] {
  const settings = readSettings(target.settingsPath);
  return groupsOf(settings, target.event).flatMap((g) =>
    (g.hooks ?? []).filter((h) => isGuardHookCommand(h.command)),
  );
}

/**
 * Write (or update in place) the okgate entry, keeping every other setting and hook. The
 * first change to an existing file leaves a `*.okgate-backup` next to it (or keeps an agentguard-era `*.agentguard-backup`).
 */
export function installHook(target: HookTarget): {
  status: "added" | "updated" | "unchanged";
  backup?: string;
} {
  const existed = existsSync(target.settingsPath);
  const settings = readSettings(target.settingsPath);
  const hooks = (
    settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}
  ) as Json;
  const groups = groupsOf(settings, target.event);
  const isOurs = (h: Json): boolean => isGuardHookCommand(h.command);
  const ours = groups.flatMap((g) => (g.hooks ?? []).filter(isOurs));
  const exact = groups.some(
    (g) =>
      g.matcher === target.matcher &&
      g.hooks?.length === 1 &&
      JSON.stringify(g.hooks[0]) === JSON.stringify(target.handler),
  );
  if (exact && ours.length === 1) return { status: "unchanged" };
  const kept: MatcherGroup[] = [];
  for (const group of groups) {
    if (!(group.hooks ?? []).some(isOurs)) {
      kept.push(group);
      continue;
    }
    const others = (group.hooks ?? []).filter((h) => !isOurs(h));
    if (others.length > 0) kept.push({ ...group, hooks: others });
  }
  kept.push({ matcher: target.matcher, hooks: [target.handler] });
  const status = ours.length > 0 ? "updated" : "added";
  hooks[target.event] = kept;
  settings.hooks = hooks;
  let backup: string | undefined;
  if (existed) {
    const { existing, next } = backupFor(target.settingsPath);
    backup = existing ?? next;
    if (!existing) copyFileSync(target.settingsPath, backup);
  }
  mkdirSync(dirname(target.settingsPath), { recursive: true });
  writeFileSync(target.settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { status, backup };
}

/** Remove okgate's entries; other hooks and settings stay. Returns how many were removed. */
export function uninstallHook(target: HookTarget): number {
  if (!existsSync(target.settingsPath)) return 0;
  const settings = readSettings(target.settingsPath);
  const groups = groupsOf(settings, target.event);
  let removed = 0;
  const kept: MatcherGroup[] = [];
  for (const group of groups) {
    const others = (group.hooks ?? []).filter((h) => !isGuardHookCommand(h.command));
    removed += (group.hooks ?? []).length - others.length;
    if (others.length > 0) kept.push({ ...group, hooks: others });
  }
  if (removed === 0) return 0;
  const hooks = settings.hooks as Json;
  if (kept.length > 0) hooks[target.event] = kept;
  else delete hooks[target.event];
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  writeFileSync(target.settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return removed;
}

/** Every settings file that can hold a hook, project and user level: edits to them are guard-config. */
export function hookSettingsFiles(where: { cwd: string; home: string }): string[] {
  const out: string[] = [];
  for (const root of [where.cwd, where.home]) {
    out.push(
      join(root, ".claude", "settings.json"),
      join(root, ".claude", "settings.local.json"),
      join(root, ".codex", "hooks.json"),
      join(root, ".codex", "config.toml"),
      join(root, ".gemini", "settings.json"),
    );
  }
  out.push(
    join(where.home, STATE_DIR, POLICY_FILE),
    join(where.home, LEGACY_STATE_DIR, LEGACY_POLICY_FILE),
  );
  return out;
}
