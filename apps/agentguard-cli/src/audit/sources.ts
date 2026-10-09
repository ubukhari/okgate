/**
 * Where coding agents keep their transcripts, and which of them are about one repository.
 *
 * The layout is the one seatledger reads (apps/seatledger-cli/src/paths.ts, PROD-1A), kept in
 * step with it rather than imported: seatledger is not on npm yet, and the public okgate repo
 * is generated without it (see docs/reports/AG-AUDIT.md).
 *
 * - Claude Code: `$CLAUDE_CONFIG_DIR/projects` (comma-separated for several), else
 *   `~/.claude/projects` and `~/.config/claude/projects`. One directory per working directory,
 *   named after its path with every character that is not a letter or digit turned into `-`;
 *   a session is `<session>.jsonl` there, its subagents under `<session>/subagents/`.
 * - Codex: `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`, `CODEX_HOME` defaulting
 *   to `~/.codex`. One rollout per thread, by date; its first line names the working directory.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AuditClient } from "@agentwares/agentguard-core";

export interface SourceDirs {
  "claude-code": string[];
  codex: string[];
}

export function sourceDirs(
  env: NodeJS.ProcessEnv,
  home: string,
  overrides: { claudeDir?: string; codexDir?: string } = {},
): SourceDirs {
  const claude = overrides.claudeDir
    ? [resolve(overrides.claudeDir)]
    : env.CLAUDE_CONFIG_DIR
      ? env.CLAUDE_CONFIG_DIR.split(",")
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => join(resolve(d), "projects"))
      : [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, ".codex");
  const codex = overrides.codexDir
    ? [resolve(overrides.codexDir)]
    : [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
  return { "claude-code": claude, codex };
}

export interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** What is read, cached and evaluated together: a session and its subagents, or a rollout. */
export interface TranscriptGroup {
  client: AuditClient;
  /** the main transcript's path (the session directory for subagents with no main file) */
  key: string;
  files: TranscriptFile[];
  /** the latest write to any of its files */
  lastWrite: number;
}

/** Spilled tool output and memory notes live beside transcripts; neither is a transcript. */
const SKIP_DIRS = new Set(["tool-results", "memory", "node_modules", ".git"]);

function stat(path: string): TranscriptFile | undefined {
  try {
    const s = statSync(path);
    return s.isFile() ? { path, size: s.size, mtimeMs: s.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

function jsonlUnder(dir: string, out: TranscriptFile[], depth = 0): void {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) jsonlUnder(p, out, depth + 1);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      const f = stat(p);
      if (f) out.push(f);
    }
  }
}

/** Claude Code's directory name for a working directory. */
export function claudeProjectName(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The forms a path can take in a transcript: as given, and with symlinks resolved (/var → /private/var). */
export function pathForms(dir: string): string[] {
  const forms = new Set([resolve(dir)]);
  try {
    forms.add(realpathSync(dir));
  } catch {
    // not on disk (a deleted checkout): the given form only
  }
  return [...forms];
}

/**
 * Claude Code project directories that can hold sessions for `repoRoot`: its own, and any whose
 * name starts with it (subdirectories, worktrees under it). The name is lossy, so the
 * transcripts' own `cwd` decides in the end.
 */
export function claudeProjectDirs(roots: readonly string[], repoRoot: string): string[] {
  const names = pathForms(repoRoot).map(claudeProjectName);
  const out: string[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (names.some((n) => e.name === n || e.name.startsWith(`${n}-`)))
        out.push(join(root, e.name));
    }
  }
  return out;
}

/** Sessions in Claude Code project directories, each with its subagents. */
export function claudeGroups(projectDirs: readonly string[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (const dir of projectDirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const mains = new Map<string, TranscriptFile>();
    const subdirs: string[] = [];
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        const f = stat(p);
        if (f) mains.set(basename(e.name, ".jsonl"), f);
      } else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) subdirs.push(e.name);
    }
    for (const [id, main] of mains) {
      const files = [main];
      if (subdirs.includes(id)) jsonlUnder(join(dir, id), files);
      groups.push(group("claude-code", main.path, files));
    }
    for (const id of subdirs) {
      if (mains.has(id)) continue;
      const files: TranscriptFile[] = [];
      jsonlUnder(join(dir, id), files);
      if (files.length > 0) groups.push(group("claude-code", join(dir, id), files));
    }
  }
  return groups;
}

/** Codex rollouts, one group each. */
export function codexGroups(roots: readonly string[]): TranscriptGroup[] {
  const files: TranscriptFile[] = [];
  for (const root of roots) if (existsSync(root)) jsonlUnder(root, files);
  return files.map((f) => group("codex", f.path, [f]));
}

function group(client: AuditClient, key: string, files: TranscriptFile[]): TranscriptGroup {
  files.sort((a, b) => (a.path === key ? -1 : b.path === key ? 1 : a.path.localeCompare(b.path)));
  return { client, key, files, lastWrite: Math.max(...files.map((f) => f.mtimeMs)) };
}
