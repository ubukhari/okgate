/**
 * The repository being audited: where its rule files are, and which working directories count
 * as "in it" when matching sessions.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import {
  AuditRulesSchema,
  isWithin,
  normalizePath,
  type ConfigRule,
  type RuleFileInput,
} from "@agentwares/agentguard-core";
import { pathForms } from "./sources.js";

export interface AuditRepo {
  /** where the rule files are read from: the checkout the command ran in */
  checkout: string;
  /**
   * the repository sessions are matched against: the main checkout when `checkout` is a git
   * worktree, so sessions in its other worktrees (`.claude/worktrees/*`) count too
   */
  root: string;
}

/** The git checkout holding `cwd` (or `cwd` itself outside git), and its main checkout. */
export function findRepo(cwd: string): AuditRepo {
  let dir = resolve(cwd);
  for (let i = 0; i < 64; i += 1) {
    const dotgit = join(dir, ".git");
    if (existsSync(dotgit)) {
      let root = dir;
      try {
        if (statSync(dotgit).isFile()) {
          // a worktree: `gitdir: <main>/.git/worktrees/<name>`
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
          const gitdir = m ? resolve(dir, m[1]!.trim()) : "";
          const at = gitdir.lastIndexOf(`${sep}.git${sep}worktrees${sep}`);
          if (at > 0) root = gitdir.slice(0, at);
        }
      } catch {
        // unreadable .git file: audit this checkout alone
      }
      return { checkout: dir, root };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { checkout: resolve(cwd), root: resolve(cwd) };
}

/** Is a session's working directory inside the repository (in any form its path can take)? */
export function repoMatcher(root: string): (cwd: string) => boolean {
  const forms = pathForms(root).map(normalizePath);
  return (cwd: string) => forms.some((f) => isWithin(normalizePath(cwd), f));
}

/** Rule files at the root of a checkout, as agentsmd-lint looks for them, plus Cursor's rules. */
export const RULE_FILES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".claude/CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  ".windsurfrules",
  ".clinerules",
] as const;

const MAX_CURSOR_RULES = 20;
const MAX_BYTES = 512 * 1024;

function cursorRules(dir: string, out: string[], depth = 0): void {
  if (depth > 3 || out.length >= MAX_CURSOR_RULES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) cursorRules(p, out, depth + 1);
    else if (e.isFile() && /\.(mdc|md)$/.test(e.name) && out.length < MAX_CURSOR_RULES) out.push(p);
  }
}

/** The rule files this checkout has, repo-relative, plus any named with `--rules`. */
export function readRuleFiles(checkout: string, extra: readonly string[] = []): RuleFileInput[] {
  const paths: string[] = RULE_FILES.map((f) => join(checkout, f));
  cursorRules(join(checkout, ".cursor", "rules"), paths);
  for (const e of extra) paths.push(isAbsolute(e) ? e : resolve(checkout, e));
  const out: RuleFileInput[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      if (!statSync(p).isFile()) continue;
      const text = readFileSync(p, "utf8").slice(0, MAX_BYTES);
      const rel = relative(checkout, p);
      out.push({ path: rel.startsWith("..") ? p : rel.split(sep).join("/"), text });
    } catch {
      // absent
    }
  }
  return out;
}

/**
 * `audit.rules` from agentguard.yaml, read on its own so a policy that fails for another reason
 * (an unset `${VAR}`, say) does not hide them. Returns a warning instead of throwing.
 */
export function readConfigRules(policyPath: string): { rules: ConfigRule[]; warning?: string } {
  if (!existsSync(policyPath)) return { rules: [] };
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(policyPath, "utf8"));
  } catch (err) {
    return {
      rules: [],
      warning: `${policyPath} is not valid YAML (${err instanceof Error ? err.message : String(err)}); its audit.rules were skipped`,
    };
  }
  const audit = raw && typeof raw === "object" ? (raw as Record<string, unknown>).audit : undefined;
  const rules =
    audit && typeof audit === "object" ? (audit as Record<string, unknown>).rules : undefined;
  if (rules === undefined) return { rules: [] };
  const parsed = AuditRulesSchema.safeParse(rules);
  if (!parsed.success)
    return {
      rules: [],
      warning: `audit.rules in ${policyPath} is invalid (${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}); skipped`,
    };
  return { rules: parsed.data };
}
