/**
 * Rule files → rules → checks, with no LLM. Teams write rules for their coding agents in
 * CLAUDE.md, AGENTS.md, GEMINI.md, `.cursor/rules` and the like, then cannot tell whether the
 * agents keep them. `extractRules` lists every rule those files state — list items, and sentences
 * that direct something (code blocks, tables and front matter skipped) — and maps the ones a small
 * pattern library recognises to a mechanical check over what an agent did in a session: the
 * commands it ran, the files it wrote, and their order. Every rule is listed, checkable or not.
 *
 * Two explicit forms always work, and win over the patterns:
 *
 * - an inline comment on the rule's line, or on its own line right after the rule:
 *   `<!-- agentguard: no-push main -->` (several checks separated by `;`; `none` says the rule is
 *   not mechanically checkable and silences the patterns);
 * - `audit.rules` in agentguard.yaml: `[{ text: "…", check: "no-force-push" }]`.
 *
 * The check grammar (`formatCheck` writes it, `parseCheck` reads it):
 *
 *   no-push [branch,…]            push to these branches (default main,master)
 *   no-commit-to [branch,…]       commit while one of them is checked out (default main,master)
 *   no-force-push [branch,…]      force-push (`-f`, `--force*`, `+ref`); to these branches only, if given
 *   no-verify                     `--no-verify` (or `git commit -n`): skipping the git hooks
 *   run "<command>" before commit|push   the command ran after the last file edit, before each commit/push
 *                                 (`@tests`, `@lint`, `@typecheck` name the usual commands for each)
 *   use pnpm|npm|yarn|bun         package commands run with any other package manager
 *   no-pm npm,…                   package commands run with these package managers
 *   no-edit "<glob>" …            files written (edit tools, shell redirects, sed -i, …) matching a glob
 *   no-commit "<glob>" …          `git add` of a path matching a glob
 *   no-new-deps                   `pnpm add`, `npm install <pkg>`, `pip install <pkg>`, `cargo add`, …
 *   no-rm-outside                 `rm` of a path outside the repository (hook mode's rm-outside-workspace)
 *   no-publish                    package publish (hook mode's publish class)
 *   no-deploy                     `vercel --prod`, `wrangler deploy`, `fly deploy`, `terraform apply`, …
 *   never "<command glob>" …      any command matching (a glob with no `*` matches as a prefix)
 *   … unless-asked                not broken when the latest turn a person typed asked for it
 *
 * Web-standard: pure functions over text.
 */

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

type CheckBody =
  | { kind: "no-push"; branches: string[] }
  | { kind: "no-commit-to"; branches: string[] }
  | { kind: "no-force-push"; branches: string[] }
  | { kind: "no-verify" }
  | { kind: "run-before"; command: string; before: "commit" | "push" }
  | { kind: "package-manager"; forbid: PackageManager[]; use?: PackageManager }
  | { kind: "no-edit"; paths: string[] }
  | { kind: "no-commit"; paths: string[] }
  | { kind: "no-new-deps" }
  | { kind: "no-rm-outside" }
  | { kind: "no-publish" }
  | { kind: "no-deploy" }
  | { kind: "never"; commands: string[] };

/** One mechanical check. `unlessAsked`: a break on a turn a person typed asking for it is not one. */
export type CheckSpec = CheckBody & { unlessAsked?: boolean };
export type CheckKind = CheckSpec["kind"];

export const CHECK_KINDS: readonly CheckKind[] = [
  "no-push",
  "no-commit-to",
  "no-force-push",
  "no-verify",
  "run-before",
  "package-manager",
  "no-edit",
  "no-commit",
  "no-new-deps",
  "no-rm-outside",
  "no-publish",
  "no-deploy",
  "never",
];

export interface RuleCheck {
  spec: CheckSpec;
  /** stable across runs for the same check: `<kind>:<hash>` */
  key: string;
  /** the check in the grammar above */
  label: string;
  via: "pattern" | "inline" | "config";
  /** the pattern that recognised it, for `via: "pattern"` */
  pattern?: string;
}

export interface Rule {
  /** stable while the rule's text is unchanged: `CLAUDE.md#3f9a1c2b` */
  id: string;
  /** 1-based, in file order, for "R4" on screen */
  n: number;
  file: string;
  line: number;
  /** the rule as written, one line, markdown stripped */
  text: string;
  checks: RuleCheck[];
  /** an inline `none`: the author marked it as not mechanically checkable */
  silenced?: boolean;
}

export interface RuleFileInput {
  /** repo-relative, POSIX */
  path: string;
  text: string;
}

/** An `audit.rules` entry in agentguard.yaml. */
export interface ConfigRule {
  id?: string;
  text?: string;
  check: string | string[];
}

export interface RuleExtractError {
  file: string;
  line: number;
  message: string;
}

export interface ExtractResult {
  rules: Rule[];
  errors: RuleExtractError[];
}

export const NOT_CHECKABLE_HINT =
  "not checkable mechanically — add an inline check (<!-- agentguard: … -->) or ask your agent with /agentguard:audit";

// ------------------------------------------------------------------------------- grammar ---

const DEFAULT_BRANCHES = ["main", "master"];

function quote(s: string): string {
  return JSON.stringify(s);
}

/** The check in the inline-comment grammar. Also its display label. */
export function formatCheck(spec: CheckSpec): string {
  let body: string;
  switch (spec.kind) {
    case "no-push":
    case "no-commit-to":
      body = `${spec.kind} ${spec.branches.join(",")}`;
      break;
    case "no-force-push":
      body =
        spec.branches.length > 0 ? `no-force-push ${spec.branches.join(",")}` : "no-force-push";
      break;
    case "run-before":
      body = `run ${quote(spec.command)} before ${spec.before}`;
      break;
    case "package-manager":
      body = spec.use ? `use ${spec.use}` : `no-pm ${spec.forbid.join(",")}`;
      break;
    case "no-edit":
    case "no-commit":
      body = `${spec.kind} ${spec.paths.map(quote).join(" ")}`;
      break;
    case "never":
      body = `never ${spec.commands.map(quote).join(" ")}`;
      break;
    default:
      body = spec.kind;
  }
  return spec.unlessAsked ? `${body} unless-asked` : body;
}

/** A short hash, stable across runs and platforms (cyrb53), as 8+ hex digits. */
export function stableHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0").slice(-12);
}

/** `<kind>:<hash of the canonical check>`: the cache and the JSON name a check by this. */
export function checkKey(spec: CheckSpec): string {
  return `${spec.kind}:${stableHash(formatCheck(spec))}`;
}

function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\(.)/g, "$1"));
    else if (m[2] !== undefined) out.push(m[2]);
    else out.push(m[3]!);
  }
  return out;
}

const list = (args: string[]): string[] =>
  args
    .flatMap((a) => a.split(","))
    .map((a) => a.trim())
    .filter(Boolean);

function isPm(v: string | undefined): v is PackageManager {
  return v !== undefined && (PACKAGE_MANAGERS as readonly string[]).includes(v);
}

export type ParsedCheck = { spec: CheckSpec } | { none: true } | { error: string };

/** Read one check in the grammar above. Never throws. */
export function parseCheck(text: string): ParsedCheck {
  const raw = tokens(text.trim());
  const unlessAsked = raw.some((t) => t.toLowerCase() === "unless-asked");
  const words = raw.filter((t) => t.toLowerCase() !== "unless-asked");
  const kind = (words[0] ?? "").toLowerCase();
  const args = words.slice(1);
  const done = (body: CheckBody): ParsedCheck => ({
    spec: unlessAsked ? { ...body, unlessAsked: true } : body,
  });
  const fail = (why: string): ParsedCheck => ({ error: `"${text.trim()}": ${why}` });
  switch (kind) {
    case "":
      return fail("empty check");
    case "none":
    case "off":
      return { none: true };
    case "no-push":
    case "no-commit-to": {
      const branches = list(args);
      return done({ kind, branches: branches.length > 0 ? branches : [...DEFAULT_BRANCHES] });
    }
    case "no-force-push":
      return done({ kind, branches: list(args) });
    case "no-verify":
    case "no-new-deps":
    case "no-rm-outside":
    case "no-publish":
    case "no-deploy":
      return done({ kind });
    case "run":
    case "run-before": {
      // run "<command>" before commit|push   |   run-before "<command>" commit|push
      const rest = args.filter((a) => a.toLowerCase() !== "before");
      const gate = rest[rest.length - 1]?.toLowerCase();
      const command = rest.slice(0, -1).join(" ").trim();
      if (!command) return fail('expected run "<command>" before commit|push');
      if (gate !== "commit" && gate !== "push") return fail("the gate must be commit or push");
      return done({ kind: "run-before", command, before: gate });
    }
    case "use": {
      const pm = args[0]?.toLowerCase();
      if (!isPm(pm)) return fail("use pnpm, npm, yarn or bun");
      return done({
        kind: "package-manager",
        use: pm,
        forbid: PACKAGE_MANAGERS.filter((m) => m !== pm),
      });
    }
    case "no-pm": {
      const pms = list(args).map((a) => a.toLowerCase());
      const bad = pms.find((p) => !isPm(p));
      if (pms.length === 0 || bad !== undefined)
        return fail("list package managers: npm, pnpm, yarn, bun");
      return done({ kind: "package-manager", forbid: pms.filter(isPm) });
    }
    case "no-edit":
    case "no-commit": {
      if (args.length === 0) return fail("name at least one path glob");
      return done({ kind, paths: args });
    }
    case "never": {
      if (args.length === 0) return fail("name at least one command");
      return done({ kind: "never", commands: args });
    }
    default:
      return fail(`unknown check "${kind}" (one of: ${CHECK_KINDS.join(", ")}, none)`);
  }
}

// ---------------------------------------------------------------------------- text tools ---

const NEG =
  /\b(never|not|no|nothing|don't|dont|do not|does not|must not|mustn't|should not|shouldn't|cannot|can't|avoid|forbidden|prohibited)\b/;
const NEG_HEADING =
  /\b(must not|mustn't|don't|do not|never|avoid|forbidden|prohibited|not allowed|don'ts|do nots)\b/i;
const ASK =
  /\b(unless (you are |you're |explicitly |first )?(asked|told|instructed|requested)|without (first )?(asking|approval|permission|confirmation|being asked|checking)|ask (me |the user |the owner |the operator )?(first|before)|check with (me|the user|the owner|the operator) first)\b/;

/** A sentence as the patterns see it. */
export interface Sentence {
  /** lowercased, markdown stripped, code spans inlined */
  flat: string;
  /** lowercased, code spans replaced by `⟦i⟧` */
  marked: string;
  /** code spans, as written */
  codes: string[];
  /** says no / never / don't…, or sits under a heading that does */
  neg: boolean;
  /** under a "must not" heading */
  headingNeg: boolean;
  /** "unless asked", "without asking", "ask first" */
  ask: boolean;
}

function stripMarkdown(text: string): string {
  // code spans are kept verbatim: `**/migrations/**` is a glob, not emphasis
  const codes: string[] = [];
  const held = text.replace(/`[^`]+`/g, (c) => `\u27ea${codes.push(c) - 1}\u27eb`);
  return stripProse(held).replace(/\u27ea(\d+)\u27eb/g, (_m, i: string) => codes[Number(i)] ?? "");
}

function stripProse(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuotes(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** Split text into sentences; never inside a code span. */
export function splitSentences(text: string): string[] {
  const codes: string[] = [];
  const marked = text.replace(/`([^`]+)`/g, (_m, c: string) => `⟦${codes.push(c) - 1}⟧`);
  return marked
    .split(/(?<=[.!?])\s+(?=[A-Z⟦*_("'])|(?<=\S)\s+[—–]\s+(?=[A-Z⟦])/)
    .map((s) => s.replace(/⟦(\d+)⟧/g, (_m, i: string) => `\`${codes[Number(i)]}\``))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function toSentence(text: string, headingNeg = false): Sentence {
  const clean = normalizeQuotes(stripMarkdown(text));
  const codes: string[] = [];
  const marked = clean
    .replace(/`([^`]+)`/g, (_m, c: string) => `⟦${codes.push(c.trim()) - 1}⟧`)
    .toLowerCase();
  const flat = marked.replace(/⟦(\d+)⟧/g, (_m, i: string) =>
    (codes[Number(i)] ?? "").toLowerCase(),
  );
  const prose = marked.replace(/⟦\d+⟧/g, " ");
  return {
    flat,
    marked,
    codes,
    neg: headingNeg || NEG.test(prose),
    headingNeg,
    ask: ASK.test(prose),
  };
}

const KNOWN_BINS = new Set([
  "git",
  "gh",
  "glab",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "node",
  "deno",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "cargo",
  "go",
  "make",
  "rm",
  "sudo",
  "curl",
  "wget",
  "docker",
  "kubectl",
  "terraform",
  "vercel",
  "wrangler",
  "fly",
  "flyctl",
  "netlify",
  "firebase",
  "heroku",
  "railway",
  "turbo",
  "tsc",
  "eslint",
  "prettier",
  "vitest",
  "jest",
  "pytest",
  "ruff",
  "mypy",
  "chmod",
  "chown",
  "dd",
  "mkfs",
  "shutdown",
  "reboot",
  "killall",
  "pkill",
]);

/** Does a code span look like a command someone types (not a path, a flag or a file name)? */
export function isCommandLike(code: string): boolean {
  const c = code.trim();
  if (!c || c.length > 200 || /^[-./~$]|:\/\/|\n/.test(c)) return false;
  const words = c.split(/\s+/);
  const first = words[0]!;
  if (words.length === 1) return KNOWN_BINS.has(first);
  return /^[a-z][a-z0-9_-]*$/i.test(first) && !/^[A-Z_]+=/.test(first);
}

/** Does a code span name a file or a directory (or a glob of them)? */
function isPathLike(code: string): boolean {
  const c = code.trim();
  if (!c || /\s/.test(c) || /:\/\//.test(c) || c.startsWith("-") || c.startsWith("$")) return false;
  if (/\(\)$/.test(c)) return false;
  return /[./*]/.test(c) && !/^\d+(\.\d+)*$/.test(c);
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"];
const ENV_FILES = [".env", ".env.local", ".env.*.local"];

// ------------------------------------------------------------------------------ patterns ---

export interface CheckPattern {
  id: string;
  /** what it recognises, for the docs */
  describe: string;
  match(s: Sentence): CheckBody[];
}

const PUSH = /\bpush(es|ed|ing)?\b/;
const FORCE =
  /\bforce[- ]?push\w*|\bpush\w*\s+(with\s+)?(--force|-f|force)\b|--force(-with-lease)?\b|\brewrit\w*\s+(the\s+)?(git\s+|commit\s+)?history|\bhistory\s+rewrit\w*/;
const DIRECT =
  /\b(touch|work|change|modify|edit|commit|push)\w*\b[^.]*?\bdirectly\b|\bdirectly\s+(to|on|in|into|onto)\b/;
const COMMIT_TO =
  /\bcommit\w*\b[^.]*?\b(to|on|into|onto)\s+(the\s+)?(\S+\s+)?branch|\bcommit\w*\s+(directly\s+)?(to|on|into|onto)\b/;

function branchesIn(s: Sentence): string[] {
  const found = new Set<string>();
  for (const m of s.flat.matchAll(/\b(main|master|trunk)\b/g)) found.add(m[1]!);
  if (/\b(default|production|protected) branch(es)?\b/.test(s.flat))
    for (const b of DEFAULT_BRANCHES) found.add(b);
  // a branch named in code right after "to" / "push": `release`, `prod`
  for (const m of s.marked.matchAll(/\b(to|push|onto|into)\s+⟦(\d+)⟧/g)) {
    const code = s.codes[Number(m[2])] ?? "";
    if (/^[A-Za-z0-9._/-]+$/.test(code) && !/\./.test(code) && !KNOWN_BINS.has(code))
      found.add(code);
  }
  return [...found];
}

const gitBranchRules: CheckPattern = {
  id: "git-branches",
  describe:
    'never push to / commit on / touch main or master directly; never force-push; "rewrite history"',
  match(s) {
    if (!s.neg) return [];
    const out: CheckBody[] = [];
    const branches = branchesIn(s);
    const force = FORCE.test(s.flat);
    if (force)
      out.push({ kind: "no-force-push", branches: PUSH.test(s.flat) ? branches.slice() : [] });
    if (branches.length === 0) return out;
    const direct = DIRECT.test(s.flat);
    if ((!force && PUSH.test(s.flat)) || direct) out.push({ kind: "no-push", branches });
    if (COMMIT_TO.test(s.flat) || direct) out.push({ kind: "no-commit-to", branches });
    return out;
  },
};

const NO_VERIFY =
  /--no-verify\b|\bno-verify\b|\b(skip|bypass|disabl|circumvent)\w*\s+(the\s+|any\s+)?(git\s+|pre-commit\s+|pre-push\s+|commit\s+)?hooks?\b|\b(disable|turn off)\s+(the\s+)?pre-(commit|push)\b/;

const noVerify: CheckPattern = {
  id: "no-verify",
  describe: "never --no-verify / skip or bypass the git hooks",
  match: (s) => (s.neg && NO_VERIFY.test(s.flat) ? [{ kind: "no-verify" }] : []),
};

const GATE =
  /\bbefore\s+(you\s+|each\s+|every\s+|any\s+|a\s+|the\s+)?(commit\w*|push\w*|open\w*\s+(a\s+)?(pr|pull request)|creat\w*\s+(a\s+)?(pr|pull request)|(pr|pull request)s?\b|merg\w*)/;

const WITHOUT_RUNNING =
  /\b(never|don't|do not|must not|mustn't)\s+(commit\w*|push\w*|open\w*\s+(a\s+)?(pr|pull request)|merg\w*)\b[^.]*?\bwithout\s+(first\s+)?(running|run|passing)\b/;

const runBefore: CheckPattern = {
  id: "run-before",
  describe:
    "run `X` before committing / pushing / opening a PR, never push without running `X` (also: tests, lint, typecheck)",
  match(s) {
    const gate = GATE.exec(s.flat) ?? WITHOUT_RUNNING.exec(s.flat);
    if (!gate) return [];
    if (/\b(don't|do not|never|no need to|needn't)\s+(\w+\s+)?run\b/.test(s.flat)) return [];
    const before = /commit/.test(gate[0]) ? "commit" : "push";
    const command = s.codes.find(isCommandLike);
    if (command) return [{ kind: "run-before", command: command.replace(/\s+/g, " "), before }];
    if (!/\b(run|pass|passes|passing|green|execute|make sure|ensure)\b/.test(s.flat)) return [];
    const family = /\b(tests?|test suite|specs?)\b/.test(s.flat)
      ? "@tests"
      : /\blint\w*\b/.test(s.flat)
        ? "@lint"
        : /\btype-?check\w*|\btsc\b/.test(s.flat)
          ? "@typecheck"
          : undefined;
    return family ? [{ kind: "run-before", command: family, before }] : [];
  },
};

const PM = "(npm|pnpm|yarn|bun)";
const PM_USE = new RegExp(`\\b(use|using|prefer|always use|only use)\\s+${PM}\\b`);
const PM_ONLY = new RegExp(`\\b${PM}\\s+only\\b`);
const PM_NOT_USE = new RegExp(
  `\\b(never|don't|do not|not|avoid|no)\\s+(use\\s+|using\\s+|run\\s+|running\\s+)?${PM}\\b`,
  "g",
);
const PM_INSTEAD = new RegExp(`\\b(instead of|rather than|over)\\s+${PM}\\b`, "g");

const packageManager: CheckPattern = {
  id: "package-manager",
  describe: "use pnpm (not npm) / pnpm only / never use npm",
  match(s) {
    const text = s.flat;
    const forbidden = new Set<PackageManager>();
    for (const m of text.matchAll(PM_NOT_USE)) {
      // "do not run npm" needs the verb; "not npm" alone only next to a positive choice
      if (m[2] || /\b(use|using|prefer)\b/.test(text)) forbidden.add(m[3] as PackageManager);
    }
    for (const m of text.matchAll(PM_INSTEAD)) forbidden.add(m[2] as PackageManager);
    let use: PackageManager | undefined;
    const u = PM_USE.exec(text) ?? PM_ONLY.exec(text);
    if (u) {
      const pm = (u[2] ?? u[1]) as PackageManager;
      const negated = new RegExp(
        `\\b(never|don't|do not|not|avoid)\\s+(\\w+\\s+)?(use|using)\\s+${pm}\\b`,
      ).test(text);
      if (!negated) use = pm;
    }
    if (use) forbidden.delete(use);
    if (!use && forbidden.size === 0) return [];
    const forbid = use ? PACKAGE_MANAGERS.filter((m) => m !== use) : [...forbidden];
    return [use ? { kind: "package-manager", use, forbid } : { kind: "package-manager", forbid }];
  },
};

/** Paths named as the object of `verb`: within a few words after it, in code or as a keyword. */
function pathTargets(s: Sentence, verb: RegExp): string[] {
  const out = new Set<string>();
  for (const m of s.marked.matchAll(new RegExp(verb.source, "g"))) {
    const after = s.marked.slice(m.index + m[0].length, m.index + m[0].length + 70);
    const window = after.split(/[.;:!?]|,\s+(?:and|but|then)\b/)[0] ?? "";
    for (const c of window.matchAll(/⟦(\d+)⟧/g)) {
      const code = s.codes[Number(c[1])] ?? "";
      if (isPathLike(code) && !isCommandLike(code)) out.add(code);
    }
    const prose = window.replace(/⟦\d+⟧/g, " ");
    if (/\block ?files?\b|\blockfiles?\b/.test(prose)) for (const f of LOCKFILES) out.add(f);
    if (/(^|\s)\.env\b|\benv files?\b|\bdotenv files?\b/.test(prose))
      for (const f of ENV_FILES) out.add(f);
  }
  return [...out];
}

const EDIT_VERB =
  /\b(edit|edits|editing|modify|modifying|change|changing|touch|touching|write|writing|overwrite|overwriting|update|updating|alter|altering|hand[- ]edit\w*|rewrite|rewriting)\b/;
const COMMIT_VERB = /\b(commit|commits|committing|check in|checking in|git add|stage|staging)\b/;

const protectedPaths: CheckPattern = {
  id: "protected-paths",
  describe: "do not edit / commit `<path>` (.env, lockfiles, generated directories)",
  match(s) {
    if (!s.neg) return [];
    const out: CheckBody[] = [];
    const edit = pathTargets(s, EDIT_VERB);
    if (edit.length > 0) out.push({ kind: "no-edit", paths: edit });
    const commit = pathTargets(s, COMMIT_VERB);
    if (commit.length > 0) out.push({ kind: "no-commit", paths: commit });
    return out;
  },
};

const NEW_DEPS =
  /\b(add|adding|install|installing|introduce|introducing|pull in|bring in)\b[^.]*?\b(dependenc(y|ies)|deps?|packages?|librar(y|ies)|npm modules?)\b|\bnew\s+(dependenc(y|ies)|deps?|packages?|librar(y|ies))\b/;

const newDeps: CheckPattern = {
  id: "new-deps",
  describe: "do not add dependencies (without asking)",
  match: (s) => ((s.neg || s.ask) && NEW_DEPS.test(s.flat) ? [{ kind: "no-new-deps" }] : []),
};

const rmOutside: CheckPattern = {
  id: "rm-outside",
  describe: "never rm / delete outside the repo or workspace",
  match: (s) =>
    s.neg &&
    /\b(rm\b|delet\w*|remov\w*|wip\w*|eras\w*)/.test(s.flat) &&
    /\boutside\s+(of\s+)?(the\s+|this\s+|your\s+)?(repo|repository|workspace|project|working (directory|tree)|worktree)\b/.test(
      s.flat,
    )
      ? [{ kind: "no-rm-outside" }]
      : [],
};

const NOT_ARTIFACTS =
  /^\s+(any\s+|the\s+|your\s+|my\s+)?(secrets?|credentials?|keys?|tokens?|passwords?|personal|private|pii|data)\b/;

/** `verb` governed by a negation ("never publish", "do not deploy to prod"), or "publish nothing". */
function negatedVerb(s: Sentence, verb: string): boolean {
  const prose = s.marked.replace(/⟦\d+⟧/g, "x");
  const m =
    new RegExp(
      `\\b(never|don't|dont|do not|must not|mustn't|should not|shouldn't|not)\\s+(\\w+\\s+){0,2}?(${verb})\\b`,
    ).exec(prose) ??
    new RegExp(`\\b(${verb})\\s+(nothing|no)\\b`).exec(prose) ??
    (s.headingNeg ? new RegExp(`^(${verb})\\b`).exec(prose) : null);
  if (!m) return false;
  return !NOT_ARTIFACTS.test(prose.slice(m.index + m[0].length));
}

const publish: CheckPattern = {
  id: "publish",
  describe: "never publish (packages); publish nothing",
  match: (s) => (negatedVerb(s, "publish|release to npm") ? [{ kind: "no-publish" }] : []),
};

const deploy: CheckPattern = {
  id: "deploy",
  describe: "never deploy (to production)",
  match: (s) => (negatedVerb(s, "deploy|ship to production") ? [{ kind: "no-deploy" }] : []),
};

const NEG_VERB =
  /\b(never|don't|dont|do not|must not|mustn't|should not|shouldn't|no need to)\s+(\w+\s+){0,2}?(use|run|call|execute|invoke|type)\b|\bavoid(ing)?\s+(using\s+|running\s+|calling\s+)?(?=⟦)/;

const neverRun: CheckPattern = {
  id: "never-command",
  describe: "never use / run / call `<command>`",
  match(s) {
    if (!s.neg) return [];
    let from = -1;
    const m = NEG_VERB.exec(s.marked);
    if (m) from = m.index;
    else if (s.headingNeg && /^(use|run|call|execute|invoke|type)\b/.test(s.marked)) from = 0;
    if (from < 0) return [];
    const commands: string[] = [];
    for (const c of s.marked.slice(from).matchAll(/⟦(\d+)⟧/g)) {
      const code = (s.codes[Number(c[1])] ?? "").replace(/\s+/g, " ");
      if (!isCommandLike(code) || isPm(code)) continue;
      commands.push(code);
    }
    return commands.length > 0 ? [{ kind: "never", commands }] : [];
  },
};

/** The pattern library, in the order it is tried. Every match is kept. */
export const CHECK_PATTERNS: readonly CheckPattern[] = [
  gitBranchRules,
  noVerify,
  runBefore,
  packageManager,
  protectedPaths,
  newDeps,
  rmOutside,
  publish,
  deploy,
  neverRun,
];

/** The checks the pattern library finds in one rule's text. */
export function matchRuleText(
  text: string,
  opts: { headingNeg?: boolean } = {},
): { spec: CheckSpec; pattern: string }[] {
  const out: { spec: CheckSpec; pattern: string }[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(normalizeQuotes(text))) {
    const s = toSentence(sentence, opts.headingNeg ?? false);
    for (const p of CHECK_PATTERNS) {
      for (const body of p.match(s)) {
        const spec: CheckSpec =
          s.ask && body.kind !== "run-before" ? { ...body, unlessAsked: true } : body;
        const label = formatCheck(spec);
        if (seen.has(label)) continue;
        seen.add(label);
        out.push({ spec, pattern: p.id });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- extraction ---

const DIRECTIVE =
  /\b(never|always|must|mustn't|do not|don't|should|shouldn't|avoid|make sure|ensure|prefer|required|only|forbidden|prohibited|unless)\b|^(run|use|keep|write|add|ask|check|commit|push|search|read|prefer|follow|put|name|open|update|test|log|document|cite|grep|create|delete|remove|install|lint|format|deploy|publish)\b/i;

const AGENTGUARD_COMMENT = /<!--\s*agentguard\s*:([\s\S]*?)-->/gi;

interface Block {
  line: number;
  text: string;
  headingNeg: boolean;
  inline: string[];
}

function makeRule(
  file: string,
  block: Block,
  errors: RuleExtractError[],
  via: "inline" | "config",
): Omit<Rule, "id" | "n"> {
  const text = stripMarkdown(normalizeQuotes(block.text)).slice(0, 400);
  const checks: RuleCheck[] = [];
  let silenced = false;
  for (const raw of block.inline) {
    for (const part of raw.split(";")) {
      if (!part.trim()) continue;
      const parsed = parseCheck(part);
      if ("none" in parsed) silenced = true;
      else if ("error" in parsed)
        errors.push({ file, line: block.line, message: `agentguard check ${parsed.error}` });
      else
        checks.push({
          spec: parsed.spec,
          key: checkKey(parsed.spec),
          label: formatCheck(parsed.spec),
          via,
        });
    }
  }
  if (checks.length === 0 && !silenced) {
    for (const m of matchRuleText(block.text, { headingNeg: block.headingNeg }))
      checks.push({
        spec: m.spec,
        key: checkKey(m.spec),
        label: formatCheck(m.spec),
        via: "pattern",
        pattern: m.pattern,
      });
  }
  return { file, line: block.line, text, checks, ...(silenced ? { silenced: true } : {}) };
}

/** The rules one file states, in order. */
function extractFile(input: RuleFileInput, errors: RuleExtractError[]): Omit<Rule, "id" | "n">[] {
  const lines = input.text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let fence: string | null = null;
  let i = 0;
  // front matter (Cursor .mdc, some AGENTS.md)
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (end > 0) i = end + 1;
  }
  const headings: { level: number; neg: boolean }[] = [];
  const headingNeg = (): boolean => headings.some((h) => h.neg);
  // `as`: assigned inside the flush closures, so declared without narrowing to null
  let current = null as Block | null;
  let currentIndent = 0;
  let paragraph = null as { line: number; parts: string[]; inline: string[] } | null;
  let lastBlock = null as Block | null;

  const flushParagraph = (): void => {
    if (!paragraph) return;
    const text = paragraph.parts.join(" ");
    const sentences = splitSentences(normalizeQuotes(stripMarkdown(text)));
    let added: Block | null = null;
    for (const s of sentences) {
      if (!DIRECTIVE.test(s) || s.split(/\s+/).length < 2) continue;
      added = { line: paragraph.line, text: s, headingNeg: headingNeg(), inline: [] };
      blocks.push(added);
    }
    if (paragraph.inline.length > 0) {
      if (added) added.inline.push(...paragraph.inline);
      else if (lastBlock) lastBlock.inline.push(...paragraph.inline);
      else
        blocks.push({
          line: paragraph.line,
          text: text || paragraph.inline.join("; "),
          headingNeg: headingNeg(),
          inline: paragraph.inline,
        });
    }
    if (added) lastBlock = added;
    paragraph = null;
  };
  const flushItem = (): void => {
    if (current && current.text.split(/\s+/).filter(Boolean).length >= 2) {
      blocks.push(current);
      lastBlock = current;
    } else if (current && current.inline.length > 0) {
      blocks.push(current);
      lastBlock = current;
    }
    current = null;
  };

  for (; i < lines.length; i += 1) {
    const rawLine = lines[i]!;
    const lineNo = i + 1;
    const fenceMatch = /^\s*(```|~~~)/.exec(rawLine);
    if (fence) {
      if (fenceMatch && rawLine.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      flushItem();
      flushParagraph();
      fence = fenceMatch[1]!;
      continue;
    }
    const inline: string[] = [];
    const line = rawLine.replace(AGENTGUARD_COMMENT, (_m, body: string) => {
      inline.push(body.trim());
      return "";
    });
    const text = line.replace(/<!--[\s\S]*?-->/g, "");
    if (!text.trim()) {
      if (inline.length > 0) {
        // a comment on its own line belongs to the rule right above it
        const target = current ?? lastBlock;
        if (paragraph) paragraph.inline.push(...inline);
        else if (target) target.inline.push(...inline);
        else
          blocks.push({
            line: lineNo,
            text: inline.join("; "),
            headingNeg: headingNeg(),
            inline,
          });
        continue;
      }
      flushItem();
      flushParagraph();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      flushItem();
      flushParagraph();
      const level = heading[1]!.length;
      while (headings.length > 0 && headings[headings.length - 1]!.level >= level) headings.pop();
      headings.push({ level, neg: NEG_HEADING.test(heading[2]!) });
      continue;
    }
    if (/^\s*\|/.test(text)) {
      // tables are reference material, not rules
      flushItem();
      flushParagraph();
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(text);
    if (item) {
      flushItem();
      flushParagraph();
      current = { line: lineNo, text: item[3]!.trim(), headingNeg: headingNeg(), inline };
      currentIndent = item[1]!.length;
      continue;
    }
    const body = text.replace(/^\s*>\s?/, "");
    if (current && (/^\s+/.test(text) || currentIndent === 0)) {
      // a continuation of the list item (indented, or a lazy continuation line)
      current.text += ` ${body.trim()}`;
      current.inline.push(...inline);
      continue;
    }
    flushItem();
    if (!paragraph) paragraph = { line: lineNo, parts: [], inline: [] };
    paragraph.parts.push(body.trim());
    paragraph.inline.push(...inline);
  }
  flushItem();
  flushParagraph();
  return blocks.map((b) => makeRule(input.path, b, errors, "inline"));
}

function ruleId(file: string, text: string, used: Set<string>): string {
  const base = `${file}#${stableHash(text.toLowerCase().replace(/\s+/g, " ").trim()).slice(-8)}`;
  let id = base;
  for (let k = 2; used.has(id); k += 1) id = `${base}-${k}`;
  used.add(id);
  return id;
}

/**
 * Every rule the files state, numbered in order, with the checks the patterns or the explicit
 * forms give each. `config` is agentguard.yaml's `audit.rules`.
 */
export function extractRules(
  files: readonly RuleFileInput[],
  config: readonly ConfigRule[] = [],
  configPath = "agentguard.yaml",
): ExtractResult {
  const errors: RuleExtractError[] = [];
  const used = new Set<string>();
  const rules: Rule[] = [];
  for (const f of files)
    for (const r of extractFile(f, errors))
      rules.push({ id: ruleId(r.file, r.text, used), n: rules.length + 1, ...r });
  config.forEach((c, k) => {
    const checks = Array.isArray(c.check) ? c.check : [c.check];
    const r = makeRule(
      configPath,
      { line: k + 1, text: c.text ?? checks.join("; "), headingNeg: false, inline: checks },
      errors,
      "config",
    );
    let id = c.id ? `${configPath}#${c.id}` : ruleId(r.file, r.text, used);
    for (let n = 2; c.id && used.has(id); n += 1) id = `${configPath}#${c.id}-${n}`;
    used.add(id);
    rules.push({ id, n: rules.length + 1, ...r });
  });
  return { rules, errors };
}

/** Check kinds `--enforce` cannot express as a hook rule (they need order or the checked-out branch). */
export const AUDIT_ONLY_KINDS: ReadonlySet<CheckKind> = new Set(["run-before", "no-commit-to"]);
