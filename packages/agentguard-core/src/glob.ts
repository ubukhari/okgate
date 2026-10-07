/**
 * Tool-name patterns used throughout the policy file: `crm_delete_*`, `*_send`, `stripe_*`,
 * `crm.contacts.delete`, `crm/*`. `*` matches any run of characters (including `_`, `.`, `/`),
 * `?` one character. Matching is case-insensitive. A leading `!` negates.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const source = pattern
    .split("")
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return ch.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
    })
    .join("");
  const re = new RegExp(`^${source}$`, "i");
  cache.set(pattern, re);
  return re;
}

export function matchesGlob(name: string, pattern: string): boolean {
  if (pattern.startsWith("!")) return !globToRegExp(pattern.slice(1)).test(name);
  return globToRegExp(pattern).test(name);
}

/** True when `name` matches any pattern in the list (negations exclude). */
export function matchesAny(name: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (globToRegExp(pattern.slice(1)).test(name)) return false;
    } else if (globToRegExp(pattern).test(name)) {
      matched = true;
    }
  }
  return matched;
}

/** The first pattern that matches, for "why was this classified as X" explanations. */
export function firstMatch(
  name: string,
  patterns: readonly string[] | undefined,
): string | undefined {
  if (!patterns) return undefined;
  return patterns.find((p) => !p.startsWith("!") && globToRegExp(p).test(name));
}

const pathCache = new Map<string, RegExp>();

/**
 * File-path patterns for hook mode, gitignore-style: `*` stays inside one path segment, `**`
 * crosses segments, `?` is one character. Case-insensitive (macOS and Windows file systems are).
 */
export function pathGlobToRegExp(pattern: string): RegExp {
  const cached = pathCache.get(pattern);
  if (cached) return cached;
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const re = new RegExp(`^${source}$`, "i");
  pathCache.set(pattern, re);
  return re;
}

/**
 * Does an absolute path match a pattern? A pattern starting with `/` is absolute; `~/` is under
 * `home`; one with no `/` (`.env`, `*.pem`, `node_modules`) matches any segment of the path; any
 * other pattern (`src/**`, `**` + `/migrations/**`) is relative to the workspace.
 */
export function matchesPath(
  path: string,
  pattern: string,
  ctx: { workspace?: string; home?: string },
): boolean {
  if (!path || !pattern) return false;
  const p = path.replace(/\\/g, "/");
  let pat = pattern.replace(/\\/g, "/");
  if (pat.endsWith("/")) pat = `${pat}**`;
  if (pat.startsWith("~/")) {
    if (!ctx.home) return false;
    pat = `${ctx.home.replace(/\/+$/, "")}${pat.slice(1)}`;
  }
  if (pat.startsWith("/")) return pathGlobToRegExp(pat).test(p);
  if (!pat.includes("/")) {
    const re = pathGlobToRegExp(pat);
    return p.split("/").some((seg) => seg !== "" && re.test(seg));
  }
  const ws = ctx.workspace?.replace(/\/+$/, "");
  if (!ws) return false;
  const lowerP = p.toLowerCase();
  const lowerWs = ws.toLowerCase();
  if (lowerP !== lowerWs && !lowerP.startsWith(`${lowerWs}/`)) return false;
  const rel = p.slice(ws.length + 1);
  return pathGlobToRegExp(pat.replace(/^\.\//, "")).test(rel);
}

/** The first pattern a path matches, for "why was this denied" explanations. */
export function firstPathMatch(
  path: string,
  patterns: readonly string[] | undefined,
  ctx: { workspace?: string; home?: string },
): string | undefined {
  return patterns?.find((pattern) => matchesPath(path, pattern, ctx));
}
