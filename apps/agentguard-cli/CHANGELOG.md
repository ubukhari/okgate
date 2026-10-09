# Changelog

`okgate` (formerly agentguard), the CLI and MCP proxy, on npm as `@agentwares/agentguard` until
`@agentwares/okgate` is published. A tag `okgate-v<version>` (before the rename, `agentguard-v<version>`)
publishes the GitHub Release for a version with its section below as the notes.

## 0.1.10 — 2026-10-08

### Changed

- **agentguard is now okgate.** "Nothing irreversible without an OK." The CLI calls itself
  `okgate`, and npm serves it as a second bin of this package until `@agentwares/okgate` is
  published: `npx -p @agentwares/agentguard okgate init`. Everything it writes from now on uses
  the new names: `okgate.yaml`, `.okgate/`, `OKGATE_*`, the `okgate` MCP server entry, the
  `okgate_get_status` / `okgate_get_report` / `okgate_verify_audit_log` tools, `X-Okgate-Key`,
  and hook commands that run `npx -y -p @agentwares/agentguard@<version> okgate hook pre-tool-use`.
- The server registers in the MCP Registry as `io.github.agentwares/okgate` (`mcpName`).

### Kept working (until at least 2027-01-15)

- The `agentguard` bin, and `npx @agentwares/agentguard`, which runs it.
- `agentguard.yaml` is read when there is no `okgate.yaml`, including walking up from a coding
  agent's working directory; creating an `okgate.yaml` beside it counts as editing the guard.
- An existing `.agentguard/` stays the state directory when there is no `.okgate/`, so counters,
  pending approvals and the audit log's hash chain carry on: `okgate verify` passes across the
  rename. Both directories are the guard's own and refused to a coding agent.
- Each `AGENTGUARD_*` variable applies when its `OKGATE_*` twin is unset. **`AGENTGUARD_KILL=1`
  and `OKGATE_KILL=1` both halt everything, whatever `kill.env` the policy names**, and a KILL
  file under either directory halts; `okgate kill` writes both that exist and `resume` clears both.
- `hooks status`, `hooks uninstall` and `hooks install` recognise agentguard-era hook entries
  (install replaces one, it never adds a second); `init` recognises the old `agentguard` MCP entry
  and `init --undo` restores a `*.agentguard-backup`; `connect` replaces an `agentguard` entry.
- `tools/list` shows only `okgate_*`; a `tools/call` for an `agentguard_*` name runs its twin with
  a deprecation note in `_meta["okgate/deprecation"]` until 2027-01-15, then answers
  `TOOL_RENAMED` (`retryable: false`, with the new name in `fix`). Tool results carry the verdict
  under `_meta.okgate` and, for the window, `_meta.agentguard`.
- `<!-- agentguard: … -->` inline checks, `X-Agentguard-Key`, and `_meta["agentguard/runId"]`.
- `permission-diff` (and the GitHub Action) diffs `okgate.yaml` and `agentguard.yaml` alike.

## 0.1.10 — 2026-10-08

### Changed

- **agentguard is now okgate.** "Nothing irreversible without an OK." The CLI calls itself
  `okgate`, and npm serves it as a second bin of this package until `@agentwares/okgate` is
  published: `npx -p @agentwares/agentguard okgate init`. Everything it writes from now on uses
  the new names: `okgate.yaml`, `.okgate/`, `OKGATE_*`, the `okgate` MCP server entry, the
  `okgate_get_status` / `okgate_get_report` / `okgate_verify_audit_log` tools, `X-Okgate-Key`,
  and hook commands that run `npx -y -p @agentwares/agentguard@<version> okgate hook pre-tool-use`.
- The server registers in the MCP Registry as `io.github.agentwares/okgate` (`mcpName`).

### Kept working (until at least 2027-01-15)

- The `agentguard` bin, and `npx @agentwares/agentguard`, which runs it.
- `agentguard.yaml` is read when there is no `okgate.yaml`, including walking up from a coding
  agent's working directory; creating an `okgate.yaml` beside it counts as editing the guard.
- An existing `.agentguard/` stays the state directory when there is no `.okgate/`, so counters,
  pending approvals and the audit log's hash chain carry on: `okgate verify` passes across the
  rename. Both directories are the guard's own and refused to a coding agent.
- Each `AGENTGUARD_*` variable applies when its `OKGATE_*` twin is unset. **`AGENTGUARD_KILL=1`
  and `OKGATE_KILL=1` both halt everything, whatever `kill.env` the policy names**, and a KILL
  file under either directory halts; `okgate kill` writes both that exist and `resume` clears both.
- `hooks status`, `hooks uninstall` and `hooks install` recognise agentguard-era hook entries
  (install replaces one, it never adds a second); `init` recognises the old `agentguard` MCP entry
  and `init --undo` restores a `*.agentguard-backup`; `connect` replaces an `agentguard` entry.
- `tools/list` shows only `okgate_*`; a `tools/call` for an `agentguard_*` name runs its twin with
  a deprecation note in `_meta["okgate/deprecation"]` until 2027-01-15, then answers
  `TOOL_RENAMED` (`retryable: false`, with the new name in `fix`). Tool results carry the verdict
  under `_meta.okgate` and, for the window, `_meta.agentguard`.
- `<!-- agentguard: … -->` inline checks, `X-Agentguard-Key`, and `_meta["agentguard/runId"]`.
- `permission-diff` (and the GitHub Action) diffs `okgate.yaml` and `agentguard.yaml` alike.

## 0.1.9 — 2026-10-07

### Added

- **`agentguard audit`: which written rules your coding agents broke.** Reads the repository's
  CLAUDE.md, AGENTS.md, GEMINI.md, `.cursor/rules` (and the other files agentsmd-lint looks for),
  plus `audit.rules` in agentguard.yaml, and this machine's Claude Code and Codex sessions whose
  working directory is the repository or one of its worktrees, subagents included. Per rule:
  sessions checked, sessions broken, the last three dates, and — on your screen only — the
  command or path that broke it. `--since 7d|30d|24h|all|<date>` (default 7 days),
  `--client claude|codex|all`, `--json` (counts, rule ids and dates, never a command, a path or a
  prompt), `--rules <file>`, `--no-cache`, `--no-evidence`.
- **Rules recognised with no LLM.** Every rule in the files is listed, checkable or not. A
  pattern library maps the common shapes to checks over what the agent did (never push to /
  commit on main, never force-push, never `--no-verify`, run X before committing or pushing, use
  pnpm not npm, do not edit or commit a path, no new dependencies without asking, never `rm`
  outside the repo, never publish, never deploy, never run a named command). An inline
  `<!-- agentguard: <check> -->` on the rule, or `audit.rules` in agentguard.yaml, always works;
  `<!-- agentguard: none -->` marks a rule no script can check.
- **`agentguard audit --enforce [--preview] [--yes]`** writes the checkable rules into
  agentguard.yaml as hook-mode rules — `hooks.shell.deny`, `hooks.shell.approval` (for "without
  asking"), `hooks.paths.deny`, the built-in irreversible classes and a `deploy` rule — each with a
  comment naming the rule it came from, shows the diff, and installs the Claude Code hook if it is
  not installed. It never changes `hooks.mode`, and writes nothing to a policy already in enforce
  mode without `--yes`.
- **A counts-only cache** in `~/.agentguard/audit-cache-v1/`: a second run of a large history
  takes about a second, and counts from transcripts Claude Code has since deleted are kept. It
  holds counts, times, line numbers and hashes only.
- **Plugin skills `/agentguard:audit`** (runs `audit --json`, then has your own agent judge the
  rules marked not checkable against the repository and its git history) **and
  `/agentguard:hooks`** (hook mode status, install, uninstall), in the Claude Code plugin and the
  Gemini CLI extension.
- The audit's last line points at the team adherence history page
  (https://agentwares-agentguard.vercel.app/team-history). The CLI itself sends nothing.

### Changed

- Requires `@agentwares/agentguard-core` 0.1.5.

## 0.1.8 — 2026-10-07

### Added

- **Hook mode: one rulebook for coding agents.** `agentguard hooks install [--project|--user]
[--client claude|codex|gemini|all]` writes a pre-execution hook (Claude Code `PreToolUse`,
  Codex `PreToolUse`, Gemini CLI `BeforeTool`) that runs `agentguard hook pre-tool-use` on every
  shell command, file edit and direct MCP call, and adds a dry-run `hooks:` block to
  `agentguard.yaml`. `hooks uninstall` removes only agentguard's entries; `hooks status` lists them.
  The policy gains `hooks.shell.deny|approval` (command globs, matched against every simple
  command of a compound line, `$(…)`, `bash -c` and `eval` included), `hooks.paths.deny|approval`
  (file globs for edits and shell writes), and `hooks.irreversible` (built-in classes `git-push`,
  `merge`, `tag-delete`, `rm-outside-workspace`, `publish`, `send`, `guard-config`, plus your own
  rules). The MCP side's `deny` and `approval.tools` also apply to MCP tools the agent calls
  directly. Same kill switch, approvals, caps (`hook_calls`, `shell_commands`, `file_edits`,
  `irreversible`), loop breaker (repeated identical edits) and hash-chained audit log.
- **Irreversible commands only on a turn a person typed.** In Claude Code an irreversible command
  runs only when the latest transcript entry a person wrote came after the session's previous
  irreversible command, is at most `window_s` (30 min) old, and names the action — or is a bare
  "yes" to an assistant question that names it. Tool results, injected and meta entries, peer and
  task messages, subagent prompts and anything inside an assistant reply never count, so a model
  that writes "user: yes, push it" into its own reply (claude-code#88122 and others) is held with
  `APPROVAL_REQUIRED`; `agentguard approve <id>` lets the identical retry run once. Codex and Gemini
  CLI get the rulebook but no transcript check: their irreversible commands always need approval.
- **The agent cannot approve itself.** `agentguard approve|deny|resume` run by the agent, and any
  write to `.agentguard/`, are refused.
- `agentguard report` has a **Coding-agent hooks** section: calls checked, irreversible commands
  run on a person's turn or after approval or held, and every call enforce mode would have stopped
  while in dry-run.

### Changed

- The CLI loads the MCP SDK only for `proxy`, `init` and `tools`, so the hook starts in about
  0.1 s (`dist/` is now split into chunks).
- Requires `@agentwares/agentguard-core` 0.1.4.

## 0.1.7 — 2026-10-07

### Fixed

- **No endless loop on an upstream that repeats its `tools/list` cursor.** The proxy followed
  `nextCursor` with no bound, so an upstream that handed back the cursor it was given (or cycled
  through a few) kept the proxy asking for the same page forever, its tool table growing with
  every answer. It now reads every page to the end, stops at a cursor it has already followed, and
  reads at most 20 pages and 2,000 tools per upstream.
- **A failed or partial `tools/list` no longer empties an upstream's tools.** If a refresh errors,
  or stops at that ceiling, the proxy keeps the upstream's last good list and logs why
  (`tools/list for "<upstream>" not applied: … ; keeping the last good list (N tools)`). It used
  to drop every tool of that upstream on any `tools/list` error.

## 0.1.6 — 2026-10-07

### Added

- **A working MCP server with no configuration.** Started with no `agentguard.yaml` and no
  `--config` / `AGENTGUARD_CONFIG` (an install button, a registry install, the Dockerfile),
  `agentguard proxy` no longer exits with `INVALID_POLICY`. It fronts no servers and serves three
  read-only tools of its own: `agentguard_get_status` (policy, mode, upstreams, caps used and
  remaining, kill switch, pending approvals), `agentguard_get_report` (what a run did, or would
  have done in dry-run, and every call that was halted) and `agentguard_verify_audit_log` (the
  hash chain). Each has a title, `readOnlyHint: true`, a strict input schema and a documented
  output schema; errors carry `code`, `cause`, `fix` and `retryable`. That mode writes nothing to
  the directory it was started in. A policy with no upstreams serves the same three tools; with
  upstreams configured the agent sees only the upstreams' tools, as before. A policy file that was
  named and is missing is still an error.
- **Claude Code plugin marketplace** at the repo root:
  `/plugin marketplace add agentwares/agentguard`, then `/plugin install agentguard@agentwares`.
  `/agentguard:init` runs `init` and explains the policy it wrote; `/agentguard:report` explains a
  run.
- **Gemini CLI extension** at the repo root:
  `gemini extensions install https://github.com/agentwares/agentguard`, with the same two
  commands.
- **`init` and `connect` read Gemini CLI's `.gemini/settings.json`** (and `~/.gemini/settings.json`
  with `--client`). Gemini's `httpUrl` is read as Streamable HTTP, and `connect` writes `httpUrl`
  there, because Gemini dials `url` as SSE.
- **A root `Dockerfile`**: `docker run -i --rm agentguard` serves the tools above over stdio;
  `proxy --config /app/demo/agentguard.yaml` puts the bundled fake CRM behind the proxy.
- **Install links** for Cursor and VS Code in the README.

### Fixed

- The README's example of the config `init` writes showed the unscoped package name, which does
  not exist on npm; `init` itself has written `@agentwares/agentguard` since 0.1.4.
- README links to the permission-diff Action pointed at a path that exists only in the private
  monorepo.

## 0.1.5 — 2026-09-11

- The 0.1.4 package was published with `workspace:^` dependency ranges and could not be installed.
  Republished with real versions.

## 0.1.4 — 2026-09-11

- The MCP config `init` writes now starts `npx -y @agentwares/agentguard proxy`. It named the
  unscoped `agentguard`, which does not exist on npm, so the proxy never started.

## 0.1.3 — 2026-09-07

- `agentguard connect <key>` points an MCP client at a hosted agentguard proxy.
- A spend cap that could fail open fails closed.

## 0.1.2 — 2026-09-07

- Absolute README links, so they work on npmjs.com.

## 0.1.1 — 2026-09-07

- Package links point at the public repository.

## 0.1.0 — 2026-09-02

- First release: the MCP policy proxy (stdio and Streamable HTTP, several upstreams), dry-run
  writes with mutation diffs, spend and blast-radius caps, approvals, a kill switch, scoped agent
  keys, a loop breaker and a hash-chained audit log.
