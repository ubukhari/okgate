/**
 * A small reader for the shell command lines coding agents run, for hook mode. It splits a line
 * into simple commands (across `&&`, `||`, `;`, `|`, `&`, newlines, subshells and groups),
 * descends into `$(…)`, backticks, `<(…)`, `bash -c '…'`, `eval` and `find -exec`, skips heredoc
 * bodies and comments, drops leading `VAR=value` assignments and wrappers (`sudo`, `env`,
 * `nohup`, `timeout`, `xargs`, `npx`, …), removes git's global options, and follows `cd` so a
 * relative path resolves where it will run.
 *
 * It is not a shell. It reads what the line says, not what a variable holds when it runs: a word
 * that depends on one is marked `dynamic`, and the rules decide what to do with it. Web-standard
 * (no `node:path`): paths are POSIX strings, Windows backslashes are turned into slashes.
 */

export interface ShellWord {
  text: string;
  /** depends on `$VAR`, `$(…)`, backticks or an unresolved `~user` */
  dynamic: boolean;
  quoted: boolean;
}

export interface ShellRedirect {
  op: string;
  target: ShellWord;
}

export interface SimpleCommand {
  /** the command's words after assignments, reserved words and wrappers are removed */
  argv: string[];
  words: ShellWord[];
  redirects: ShellRedirect[];
  /** absolute directory the command runs in, after any preceding `cd`; "" when unknown */
  cwd: string;
  /** how it was reached when not written directly: `$()`, `bash -c`, `eval`, `xargs`, `find -exec`, `find -delete` */
  via?: string;
}

export interface ParseShellOptions {
  cwd?: string;
  home?: string;
}

type Token =
  { kind: "word"; word: ShellWord } | { kind: "op"; op: string } | { kind: "redir"; op: string };

const MAX_DEPTH = 6;

/** Split a command line into simple commands. Never throws: malformed input yields what it can. */
export function parseShell(command: string, opts: ParseShellOptions = {}): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const state = { cwd: normalizePath(opts.cwd ?? ""), home: opts.home };
  parseInto(command, state, out, 0, undefined);
  return out;
}

/** The command as one normalized line: its argv joined by single spaces. */
export function commandText(cmd: SimpleCommand): string {
  return cmd.argv.join(" ");
}

interface ParseState {
  cwd: string;
  home?: string;
}

function parseInto(
  src: string,
  state: ParseState,
  out: SimpleCommand[],
  depth: number,
  via: string | undefined,
): void {
  if (depth > MAX_DEPTH) return;
  const nested: string[] = [];
  const tokens = lex(src, nested);
  // Substitutions run before the command that contains them, in the same directory.
  for (const inner of nested) parseInto(inner, { ...state }, out, depth + 1, "$()");
  let words: ShellWord[] = [];
  let redirects: ShellRedirect[] = [];
  const flush = (): void => {
    if (words.length > 0 || redirects.length > 0) finish(words, redirects, state, out, depth, via);
    words = [];
    redirects = [];
  };
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k]!;
    if (t.kind === "op") {
      flush();
      continue;
    }
    if (t.kind === "redir") {
      const next = tokens[k + 1];
      if (next?.kind === "word") {
        redirects.push({ op: t.op, target: next.word });
        k += 1;
      }
      continue;
    }
    words.push(t.word);
  }
  flush();
}

function lex(src: string, nested: string[]): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  let cur: ShellWord | null = null;
  let heredocNext: { strip: boolean } | null = null;
  const heredocs: { delim: string; strip: boolean }[] = [];

  const word = (): ShellWord => {
    if (!cur) cur = { text: "", dynamic: false, quoted: false };
    return cur;
  };
  const endWord = (): void => {
    if (!cur) return;
    tokens.push({ kind: "word", word: cur });
    if (heredocNext) {
      heredocs.push({ delim: cur.text, strip: heredocNext.strip });
      heredocNext = null;
    }
    cur = null;
  };
  const op = (value: string): void => {
    endWord();
    tokens.push({ kind: "op", op: value });
  };
  const substitution = (start: number, end: number, display: string): void => {
    nested.push(src.slice(start, end));
    const w = word();
    w.text += display;
    w.dynamic = true;
  };

  while (i < n) {
    const c = src[i]!;
    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 < n) word().text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      const w = word();
      w.quoted = true;
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? n : end;
      w.text += src.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      const w = word();
      w.quoted = true;
      i = readDoubleQuoted(src, i + 1, w, nested);
      continue;
    }
    if (c === "`") {
      const end = findBacktick(src, i + 1);
      substitution(i + 1, end, "`…`");
      i = end + 1;
      continue;
    }
    if (c === "$") {
      const next = src[i + 1];
      if (next === "(" && src[i + 2] === "(") {
        const end = matchClose(src, i + 1, "(", ")");
        const w = word();
        w.text += src.slice(i, end + 1);
        w.dynamic = true;
        i = end + 1;
        continue;
      }
      if (next === "(") {
        const end = matchClose(src, i + 1, "(", ")");
        substitution(i + 2, end, "$(…)");
        i = end + 1;
        continue;
      }
      if (next === "{") {
        const end = matchClose(src, i + 1, "{", "}");
        const w = word();
        w.text += src.slice(i, end + 1);
        w.dynamic = true;
        i = end + 1;
        continue;
      }
      if (next === "'") {
        // $'…' ANSI-C quoting: literal enough for our purposes
        const w = word();
        w.quoted = true;
        let j = i + 2;
        while (j < n && src[j] !== "'") {
          if (src[j] === "\\" && j + 1 < n) {
            w.text += src[j + 1];
            j += 2;
          } else {
            w.text += src[j];
            j += 1;
          }
        }
        i = j + 1;
        continue;
      }
      if (next !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(next)) {
        let j = i + 1;
        if (/[A-Za-z_]/.test(next)) while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
        else j += 1;
        const w = word();
        w.text += src.slice(i, j);
        w.dynamic = true;
        i = j;
        continue;
      }
      word().text += "$";
      i += 1;
      continue;
    }
    if (c === "#" && cur === null) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i += 1;
      continue;
    }
    if (c === "\n") {
      op("\n");
      i += 1;
      if (heredocs.length > 0) {
        i = skipHeredocs(src, i, heredocs);
        heredocs.length = 0;
      }
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const end = matchClose(src, i + 1, "(", ")");
      substitution(i + 2, end, `${c}(…)`);
      i = end + 1;
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) {
      // `2>` / `10<`: a word made only of digits right before the operator is a file descriptor
      const fd = cur as ShellWord | null;
      if (fd && !fd.quoted && !fd.dynamic && /^\d+$/.test(fd.text)) cur = null;
      else endWord();
      let operator = c;
      let j = i + 1;
      if (c === "&") {
        operator = "&>";
        j = i + 2;
        if (src[j] === ">") {
          operator = "&>>";
          j += 1;
        }
      } else if (c === ">") {
        if (src[j] === ">") {
          operator = ">>";
          j += 1;
        } else if (src[j] === "|") {
          operator = ">|";
          j += 1;
        } else if (src[j] === "&") {
          operator = ">&";
          j += 1;
        }
      } else {
        if (src[j] === "<") {
          operator = "<<";
          j += 1;
          if (src[j] === "<") {
            operator = "<<<";
            j += 1;
          } else if (src[j] === "-") {
            operator = "<<-";
            j += 1;
          }
        } else if (src[j] === ">") {
          operator = "<>";
          j += 1;
        } else if (src[j] === "&") {
          operator = "<&";
          j += 1;
        }
      }
      tokens.push({ kind: "redir", op: operator });
      if (operator === "<<" || operator === "<<-") heredocNext = { strip: operator === "<<-" };
      i = j;
      continue;
    }
    if (c === "|") {
      if (src[i + 1] === "|") {
        op("||");
        i += 2;
      } else if (src[i + 1] === "&") {
        op("|&");
        i += 2;
      } else {
        op("|");
        i += 1;
      }
      continue;
    }
    if (c === "&") {
      if (src[i + 1] === "&") {
        op("&&");
        i += 2;
      } else {
        op("&");
        i += 1;
      }
      continue;
    }
    if (c === ";") {
      op(";");
      i += src[i + 1] === ";" ? 2 : 1;
      continue;
    }
    if (c === "(" || c === ")") {
      op(c);
      i += 1;
      continue;
    }
    word().text += c;
    i += 1;
  }
  endWord();
  return tokens;
}

function readDoubleQuoted(src: string, start: number, w: ShellWord, nested: string[]): number {
  let i = start;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '"') return i + 1;
    if (c === "\\" && i + 1 < n && '"\\$`\n'.includes(src[i + 1]!)) {
      if (src[i + 1] !== "\n") w.text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = findBacktick(src, i + 1);
      nested.push(src.slice(i + 1, end));
      w.text += "`…`";
      w.dynamic = true;
      i = end + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
      const end = matchClose(src, i + 1, "(", ")");
      nested.push(src.slice(i + 2, end));
      w.text += "$(…)";
      w.dynamic = true;
      i = end + 1;
      continue;
    }
    if (c === "$" && src[i + 1] !== undefined && /[A-Za-z0-9_@*#?$!{(-]/.test(src[i + 1]!)) {
      w.dynamic = true;
    }
    w.text += c;
    i += 1;
  }
  return n;
}

function findBacktick(src: string, start: number): number {
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (src[i] === "`") return i;
  }
  return src.length;
}

/** Index of the bracket closing the one at `open`, skipping quotes and nested pairs. */
function matchClose(src: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return src.length;
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === o) depth += 1;
    else if (ch === c) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

function skipHeredocs(
  src: string,
  start: number,
  heredocs: { delim: string; strip: boolean }[],
): number {
  let i = start;
  for (const h of heredocs) {
    while (i < src.length) {
      const end = src.indexOf("\n", i);
      const line = src.slice(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 1;
      const compare = h.strip ? line.replace(/^\t+/, "") : line;
      if (compare === h.delim) break;
    }
  }
  return i;
}

const RESERVED_SKIP_HEAD = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
  "fi",
  "done",
  "esac",
  "time",
]);
const RESERVED_HEADER = new Set(["for", "select", "case", "function"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

function finish(
  rawWords: ShellWord[],
  redirects: ShellRedirect[],
  state: ParseState,
  out: SimpleCommand[],
  depth: number,
  via: string | undefined,
): void {
  let words = rawWords.map((w) => expandTilde(w, state.home));
  // reserved words and assignments in front of the command
  for (;;) {
    const head = words[0];
    if (!head) break;
    if (!head.quoted && RESERVED_HEADER.has(head.text)) return;
    if (!head.quoted && RESERVED_SKIP_HEAD.has(head.text)) {
      words = words.slice(1);
      continue;
    }
    if (!head.quoted && ASSIGNMENT.test(head.text)) {
      words = words.slice(1);
      continue;
    }
    break;
  }
  if (words.length === 0) {
    if (redirects.length > 0) out.push({ argv: [], words: [], redirects, cwd: state.cwd, via });
    return;
  }
  const unwrapped = unwrap(words, state, out, depth);
  if (!unwrapped) return;
  words = unwrapped.words;
  const cmdVia = unwrapped.via ?? via;
  if (words.length === 0) return;
  const argv0 = basename(words[0]!.text);

  // `cd` changes where the rest of the line runs
  if (argv0 === "cd" || argv0 === "pushd") {
    const target = words.slice(1).find((w) => !w.text.startsWith("-") || w.text === "-");
    if (!target) state.cwd = state.home ? normalizePath(state.home) : "";
    else if (target.dynamic || target.text === "-") state.cwd = "";
    else if (state.cwd || target.text.startsWith("/"))
      state.cwd = resolvePath(state.cwd, target.text);
    else state.cwd = "";
    return;
  }

  let cmdCwd = state.cwd;
  if (argv0 === "git") {
    const normalized = normalizeGit(words, state.cwd);
    words = normalized.words;
    cmdCwd = normalized.cwd;
  }

  out.push({
    argv: words.map((w) => w.text),
    words,
    redirects,
    cwd: cmdCwd,
    via: cmdVia,
  });

  if (argv0 === "find") extractFind(words, cmdCwd, out);
}

interface Unwrapped {
  words: ShellWord[];
  via?: string;
}

/** Strip wrappers until the real command is first. Returns undefined when the words were a nested script. */
function unwrap(
  input: ShellWord[],
  state: ParseState,
  out: SimpleCommand[],
  depth: number,
): Unwrapped | undefined {
  let words = input;
  let via: string | undefined;
  for (let guard = 0; guard < 12 && words.length > 0; guard += 1) {
    const name = basename(words[0]!.text);
    const rest = words.slice(1);
    if (name === "sudo" || name === "doas") {
      words = skipOptions(rest, new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"]));
      continue;
    }
    if (name === "env") {
      let r = skipOptions(rest, new Set(["-u", "-C", "-S", "--unset", "--chdir"]));
      while (r[0] && ASSIGNMENT.test(r[0].text)) r = r.slice(1);
      words = r;
      continue;
    }
    if (name === "command") {
      if (rest[0] && (rest[0].text === "-v" || rest[0].text === "-V")) return { words: [] };
      words = skipOptions(rest, new Set());
      continue;
    }
    if (name === "builtin" || name === "exec" || name === "nohup" || name === "caffeinate") {
      words = skipOptions(rest, new Set(["-a"]));
      continue;
    }
    if (name === "time") {
      words = skipOptions(rest, new Set(["-f", "-o"]));
      continue;
    }
    if (name === "nice" || name === "ionice" || name === "chrt" || name === "taskset") {
      words = skipOptions(rest, new Set(["-n", "-c", "-p"]));
      continue;
    }
    if (name === "stdbuf") {
      words = skipOptions(rest, new Set(["-i", "-o", "-e"]));
      continue;
    }
    if (name === "timeout" || name === "gtimeout") {
      const r = skipOptions(rest, new Set(["-s", "-k", "--signal", "--kill-after"]));
      words = r.slice(1); // the duration
      continue;
    }
    if (name === "xargs") {
      words = skipOptions(
        rest,
        new Set([
          "-I",
          "-i",
          "-n",
          "-P",
          "-L",
          "-l",
          "-d",
          "-E",
          "-e",
          "-s",
          "-a",
          "--delimiter",
          "--max-args",
          "--max-procs",
          "--arg-file",
          "--replace",
        ]),
      );
      via = "xargs";
      continue;
    }
    if (name === "npx" || name === "pnpx" || name === "bunx") {
      words = skipOptions(rest, new Set(["-p", "--package", "-c", "--call"]));
      words = stripPackageRunnerTarget(words);
      continue;
    }
    if (
      (name === "pnpm" || name === "yarn" || name === "npm" || name === "bun") &&
      rest[0] &&
      ["dlx", "exec", "x"].includes(rest[0].text)
    ) {
      words = skipOptions(rest.slice(1), new Set(["-p", "--package", "-c", "--call"]));
      if (rest[0].text !== "exec") words = stripPackageRunnerTarget(words);
      continue;
    }
    if (SHELLS.has(name)) {
      const idx = rest.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text));
      if (idx >= 0 && rest[idx + 1]) {
        parseInto(rest[idx + 1]!.text, state, out, depth + 1, "bash -c");
        return undefined;
      }
      return { words, via };
    }
    if (name === "eval") {
      parseInto(rest.map((w) => w.text).join(" "), state, out, depth + 1, "eval");
      return undefined;
    }
    break;
  }
  return { words, via };
}

/** `npx -y @scope/pkg@1.2 args` → keep the package's bin name and its arguments. */
function stripPackageRunnerTarget(words: ShellWord[]): ShellWord[] {
  if (words.length === 0) return words;
  const first = words[0]!;
  // drop a version suffix (`pkg@1.2`, `@scope/pkg@latest`), never the scope's leading `@`
  return [{ ...first, text: first.text.replace(/(.)@[^/@]*$/, "$1") }, ...words.slice(1)];
}

function skipOptions(words: ShellWord[], withValue: Set<string>): ShellWord[] {
  let i = 0;
  while (i < words.length) {
    const t = words[i]!.text;
    if (t === "--") return words.slice(i + 1);
    if (!t.startsWith("-") || t === "-") break;
    if (withValue.has(t)) i += 2;
    else i += 1;
  }
  return words.slice(i);
}

const GIT_GLOBAL_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

function normalizeGit(words: ShellWord[], cwd: string): { words: ShellWord[]; cwd: string } {
  let i = 1;
  let dir = cwd;
  while (i < words.length) {
    const t = words[i]!.text;
    if (!t.startsWith("-")) break;
    if (t === "-C" && words[i + 1]) {
      const target = words[i + 1]!;
      if (target.dynamic) dir = "";
      else if (dir || target.text.startsWith("/")) dir = resolvePath(dir, target.text);
      else dir = "";
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_WITH_VALUE.has(t)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return { words: [words[0]!, ...words.slice(i)], cwd: dir };
}

/** `find roots… -exec cmd {} \;` runs `cmd`; `find roots… -delete` removes what it finds. */
function extractFind(words: ShellWord[], cwd: string, out: SimpleCommand[]): void {
  const roots: ShellWord[] = [];
  let k = 1;
  while (
    k < words.length &&
    !words[k]!.text.startsWith("-") &&
    words[k]!.text !== "!" &&
    words[k]!.text !== "("
  ) {
    roots.push(words[k]!);
    k += 1;
  }
  if (roots.length === 0) roots.push({ text: ".", dynamic: false, quoted: false });
  for (let i = k; i < words.length; i += 1) {
    const t = words[i]!.text;
    if (t === "-delete") {
      out.push({
        argv: ["rm", "-r", ...roots.map((r) => r.text)],
        words: [
          { text: "rm", dynamic: false, quoted: false },
          { text: "-r", dynamic: false, quoted: false },
          ...roots,
        ],
        redirects: [],
        cwd,
        via: "find -delete",
      });
    }
    if (t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir") {
      const inner: ShellWord[] = [];
      let j = i + 1;
      while (j < words.length && words[j]!.text !== ";" && words[j]!.text !== "+") {
        const w = words[j]!;
        inner.push(w.text === "{}" ? { text: "{}", dynamic: true, quoted: false } : w);
        j += 1;
      }
      if (inner.length > 0)
        out.push({
          argv: inner.map((w) => w.text),
          words: inner,
          redirects: [],
          cwd,
          via: "find -exec",
        });
      i = j;
    }
  }
}

function expandTilde(w: ShellWord, home: string | undefined): ShellWord {
  if (w.quoted || !w.text.startsWith("~")) return w;
  if (w.text === "~" || w.text.startsWith("~/")) {
    if (!home) return { ...w, dynamic: true };
    return { ...w, text: normalizePath(home) + w.text.slice(1) };
  }
  return { ...w, dynamic: true }; // ~user
}

export function basename(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** POSIX-normalize: slashes, no `.`/`..` segments, no trailing slash (except root). */
export function normalizePath(path: string): string {
  if (!path) return "";
  const p = path.replace(/\\/g, "/");
  const absolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
  const drive = /^[A-Za-z]:\//.test(p) ? p.slice(0, 2) : "";
  const parts: string[] = [];
  for (const seg of (drive ? p.slice(2) : p).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  const body = parts.join("/");
  if (absolute) return `${drive}/${body}`;
  return body || ".";
}

/** Resolve `target` against `base` (both POSIX). An absolute target ignores the base. */
export function resolvePath(base: string, target: string): string {
  const t = target.replace(/\\/g, "/");
  if (t.startsWith("/") || /^[A-Za-z]:\//.test(t)) return normalizePath(t);
  return normalizePath(`${base || "."}/${t}`);
}

/** Is `path` the same as `dir` or inside it? Both absolute, normalized. Case-insensitive. */
export function isWithin(path: string, dir: string): boolean {
  if (!path || !dir) return false;
  const p = path.toLowerCase();
  const d = dir.toLowerCase();
  if (p === d) return true;
  return p.startsWith(d.endsWith("/") ? d : `${d}/`);
}

/** Mask credentials in a command line before it is written to the audit log. */
export function redactCommandLine(command: string): string {
  return command
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>")
    .replace(
      /(--?(?:token|password|passwd|secret|api[-_]?key|auth|key)(?:=|\s+))(["']?)[^\s"']+\2/gi,
      "$1<redacted>",
    )
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*=)(["']?)[^\s"']+\2/g,
      "$1<redacted>",
    )
    .replace(
      /\b(sk|rk|pk|ghp|gho|ghs|github_pat|xox[abp]|AKIA)[-_]?[A-Za-z0-9_-]{8,}/g,
      "<redacted>",
    )
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1<redacted>@");
}
