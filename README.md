# okgate

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/agentwares/agentguard)

**60 seconds to a safe first run.** Your agent already has an MCP config. Put okgate in front of it, run the agent once in dry-run, and read what it _would_ have done:

```sh
npx -p @agentwares/agentguard okgate init    # finds your MCP config, writes okgate.yaml (dry-run), routes every server through the proxy
# restart your MCP client, run your agent as usual — writes are faked, nothing executes upstream
npx -p @agentwares/agentguard okgate report  # "would have deleted 12 records, sent 5 emails, spent $140 — halted a loop at call 31"
npx -p @agentwares/agentguard okgate diff    # the record-by-record mutation diff
# set `mode: enforce` in okgate.yaml when it looks right
```

```
# okgate report — run `run_20260902_a1b2`

61 tool calls between 10:02:11 and 10:02:19 across crm.

## What this run would have done (dry-run, nothing was executed)

It would have **deleted 1 record**, updated 1, created 1, sent 1 message, **spent $12.00**.

## Where okgate stepped in

| #  | code            | tool               | why                                                          |
|----|-----------------|--------------------|--------------------------------------------------------------|
| 10 | `LOOP_DETECTED` | crm_update_contact | called 3 times with the same arguments in the last 30 calls  |
| 61 | `CAP_EXCEEDED`  | crm_create_contact | writes cap for this run is 50; used 50, this call would make it 51 |
```

**Renamed from agentguard** on 8 October 2026: _nothing irreversible without an OK._ Nothing you
set up breaks. `agentguard.yaml`, an existing `.agentguard/` (its audit chain continues), every
`AGENTGUARD_*` variable (`AGENTGUARD_KILL=1` still halts everything), the `agentguard` bin and the
hook and MCP entries that run it keep working, and the `agentguard_*` tool names still run until
2027-01-15.

<!-- npm-interim: removed by apps/agentguard-cli/scripts/flip-npm-names.mjs -->

Until `@agentwares/okgate` is on npm, npm serves okgate as the `okgate` bin of
`@agentwares/agentguard`, hence `npx -p @agentwares/agentguard okgate`.

<!-- /npm-interim -->

okgate is an MCP policy proxy for agents that touch production. It sits between the agent and its MCP servers, sees every tool call, and enforces one YAML file:

- **Hard spend limits** — per-run and per-day `spend_usd` across every provider, from tool arguments (`stripe_create_charge.amount`), tool results (`cost_usd`), and — with the SDK's guarded `fetch` — LLM token usage from OpenAI, Anthropic and Gemini responses. The call that would exceed the cap gets `CAP_EXCEEDED` with the remaining budget.
- **Destructive-action gating with approvals** — `approval.tools: [crm_delete_*]` makes the agent get `APPROVAL_REQUIRED` + an id; a human runs `okgate approve <id>` (or clicks the button in Slack) and the agent's identical retry goes through once.
- **Kill switch** — `okgate kill` (a file), `OKGATE_KILL=1` (env; `AGENTGUARD_KILL=1` too), or `POST /kill` (HTTP): every run halts instantly with `KILLED` until `okgate resume`.
- **Per-agent scoped credentials** — the proxy holds the upstream tokens; each agent gets an `agk_…` key with its own allowlist, denylist and caps. Only the key's hash lives in the policy.
- **Dry-run writes with mutation diffs** — classified writes return a plausible success shaped by the tool's output schema so the agent keeps going; `okgate diff` shows what would have changed.
- **Semantic loop breaker** — the same `(tool, normalized args)` 3× in the last 30 calls, or an A→B→A→B cycle, returns `LOOP_DETECTED`. Timestamps, ids, whitespace and key order are ignored.
- **Blast-radius caps** — `tool_calls`, `writes`, `deletes`, `emails`, `spend_usd` and custom counters, per run and per day.
- **Hash-chained audit log** — every call is a JSONL line with `prev_hash` and `hash`; `okgate verify` proves no entry was edited, removed from the middle, or reordered (see Limits for what a local chain cannot prove on its own).
- **Hook mode for coding agents** — `okgate hooks install` puts the same policy in front of Claude Code's, Codex's and Gemini CLI's own shell commands and file edits; irreversible commands (push, merge, publish, send, `rm` outside the repo) run only on a recent turn a person typed that names them, never on text the model wrote. [Details](#hook-mode-a-coding-agents-own-commands).
- **Rule adherence audit** — `okgate audit` reads CLAUDE.md, AGENTS.md, GEMINI.md and `.cursor/rules` and this machine's Claude Code and Codex sessions, and prints which rules the agents broke ("broken in 9 of 31 sessions"), locally; `--enforce` turns the checkable ones into hook rules in dry-run. [Details](#audit-which-written-rules-your-coding-agents-broke).

No LLM calls. No phone-home. No account. MIT.

Two install paths, one policy engine: the **MCP proxy** (`npx -p @agentwares/agentguard okgate`, stdio + Streamable HTTP, multiple upstreams) and the **SDK/middleware** ([`@agentwares/agentguard-sdk`](https://github.com/agentwares/agentguard/tree/main/packages/agentguard-sdk#readme)) for OpenAI Agents SDK, LangChain or plain-function tools that never go through MCP.

## Install

```sh
npx -p @agentwares/agentguard okgate init                          # rewrites the first project-level config it finds
npx -p @agentwares/agentguard okgate init --all                    # ...or every config: .mcp.json, .cursor/mcp.json, .vscode/mcp.json
npx -p @agentwares/agentguard okgate init --client ~/.claude.json  # a user-level config, which --all still leaves alone
npx -p @agentwares/agentguard okgate init --client ~/Library/Application\ Support/Claude/claude_desktop_config.json  # user-level configs only with --client
npx -p @agentwares/agentguard okgate init --undo                   # restore the backup
```

`init` finds `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `mcp.json` and `.gemini/settings.json` in the project (user-level files only with `--client`), writes `okgate.yaml` next to them, backs the config up (`*.okgate-backup`), and replaces its servers with one entry:

```json
{
  "mcpServers": {
    "okgate": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@agentwares/agentguard",
        "okgate",
        "proxy",
        "--config",
        "/abs/path/okgate.yaml"
      ]
    }
  }
}
```

Tools keep their names (prefixed `<upstream>__` only on collision). Your MCP client sees one server; okgate connects to all of them and holds their credentials.

### From your agent or editor

The same `init`, from where you already work:

- **Claude Code** (and Copilot CLI, which reads the same marketplace file):
  `/plugin marketplace add agentwares/okgate`, then `/plugin install okgate@agentwares`
  (installed as `agentguard@agentwares`? That plugin keeps the same skills until at least 2027-01-15).
  `/okgate:init` runs `init` and explains the policy it wrote; `/okgate:report` explains
  what a run did or would have done.
- **Gemini CLI**: `gemini extensions install https://github.com/agentwares/okgate`, then
  `/okgate:init` and `/okgate:report`. `init` reads `.gemini/settings.json`; Gemini's
  `httpUrl` servers are proxied as Streamable HTTP (SSE-only `url` servers are not supported).
- **Cursor and VS Code**: one click adds okgate as an MCP server
  (`npx -y -p @agentwares/agentguard okgate proxy`):

  [![Add okgate to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/link/mcp/install?name=okgate&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi1wIiwiQGFnZW50d2FyZXMvYWdlbnRndWFyZCIsIm9rZ2F0ZSIsInByb3h5Il19)
  [![Install okgate in VS Code](https://img.shields.io/badge/VS_Code-Install_okgate-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=okgate&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22-p%22%2C%22%40agentwares%2Fagentguard%22%2C%22okgate%22%2C%22proxy%22%5D%7D)

  The buttons open `cursor://anysphere.cursor-deeplink/mcp/install?name=okgate&config=…` and
  `vscode:mcp/install?{…}`; GitHub does not render those schemes as links, so the buttons go
  through `cursor.com/link` and `vscode.dev/redirect`. Where the editor starts it next to an
  `okgate.yaml`, that server guards what the policy lists. Anywhere else it fronts nothing
  and serves the three read-only tools below, the first of which tells you to run `init` in the
  project. `init` then writes the project-level entry that does the guarding.

### Started with no policy file

Spawned with no arguments at all (what an install from the MCP registry does), `okgate`
serves the stdio proxy and reads `OKGATE_CONFIG` or `./okgate.yaml`; in a terminal it
prints the help instead. If neither names a file that exists, it does not exit: it fronts no
servers, writes nothing, and serves three read-only tools of its own, each with a title,
`readOnlyHint: true` and a strict schema:

| Tool                      | Answers                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `okgate_get_status`       | which policy file it loaded or looked for, mode, upstreams, caps used and remaining, kill switch, pending approvals, and the next step |
| `okgate_get_report`       | what a run did, or would have done in dry-run, and every call that was halted (`run_id` optional)                                      |
| `okgate_verify_audit_log` | whether the hash-chained audit log verifies, its entry count and head hash                                                             |

A policy with no `upstreams:` serves the same three. Once upstreams are configured the agent sees
only their tools, exactly as before. A file named with `--config` or `OKGATE_CONFIG` that does
not exist is still an error.

### Docker

The repo's `Dockerfile` builds the CLI from source and serves it over stdio:

```sh
docker build -t okgate .
docker run -i --rm okgate                                       # no policy: the three tools above
docker run -i --rm okgate proxy --config /app/demo/okgate.yaml  # a fake CRM behind the proxy, dry-run
```

Prefer HTTP (several agents, scoped keys, Slack approve buttons)? `okgate proxy --http --port 8788` and point clients at `http://127.0.0.1:8788/mcp` with an `X-Run-Id` header per run and `Authorization: Bearer agk_…` per agent.

## Hook mode: a coding agent's own commands

The proxy sees MCP calls. A coding agent also acts through its own shell and file tools, which no
MCP proxy sees. Hook mode puts the same `okgate.yaml` in front of those, through the agent's
pre-execution hook, and adds one check nothing else makes: an irreversible command runs only on a
turn a **person** typed.

```sh
npx -y -p @agentwares/agentguard okgate hooks install               # Claude Code, this project (.claude/settings.json)
npx -y -p @agentwares/agentguard okgate hooks install --client all  # + Codex (.codex/hooks.json) and Gemini CLI (.gemini/settings.json)
npx -y -p @agentwares/agentguard okgate hooks install --user        # every project (~/.claude/settings.json, policy in ~/.okgate/)
npx -y -p @agentwares/agentguard okgate hooks status | uninstall
```

`install` adds one hook entry (other settings and hooks are kept; the first change leaves a
`*.okgate-backup`), adds a commented `hooks:` block in **dry-run** to `okgate.yaml` (or
writes a policy with only that block), and adds `.okgate/` to `.gitignore`. Commit
`okgate.yaml` and `.claude/settings.json` and the whole team runs the same rulebook. The hook
command is `npx -y -p @agentwares/agentguard@<version> okgate hook pre-tool-use` (about half a second per
guarded call); with the package installed globally, `--command okgate` makes it about 0.1 s.

| Agent       | Hook (verified 7 Oct 2026)                                                                                                                           | Rules, approvals, caps, audit                 | Human-turn gate                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| Claude Code | [`PreToolUse`](https://code.claude.com/docs/en/hooks): `Bash`, `Write`, `Edit`, `mcp__*` …                                                           | yes                                           | yes, from the session transcript                                          |
| Codex CLI   | [`PreToolUse`](https://developers.openai.com/codex/hooks): `Bash`, `apply_patch`, `mcp__*`                                                           | yes (trust the hook once in Codex's `/hooks`) | no: Codex calls its transcript format unstable, so irreversible = approve |
| Gemini CLI  | [`BeforeTool`](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md): `run_shell_command`, `write_file`, `replace`, `mcp_*` | yes                                           | no: not verified against a local install, so irreversible = approve       |

Cursor has its own hooks (`beforeShellExecution`) and can load Claude Code's
([cursor.com/docs/hooks](https://cursor.com/docs/hooks)); hook mode has not been tested there.

**What is checked.** Each shell command is split into simple commands the way a shell would
(`&&`, `;`, pipes, `$(…)`, backticks, `bash -c '…'`, `eval`, `find -exec`, heredoc bodies skipped,
`sudo`/`env`/`timeout`/`npx` wrappers and git's `-C` removed, `cd` followed). Then:

```yaml
hooks:
  mode: dry-run # dry-run: log what enforce would stop, block nothing | enforce
  shell:
    deny: ["terraform destroy*", "curl * | sh"] # refused whatever anyone says
    approval: ["kubectl delete *"] # held for `okgate approve`
  paths: # file edits and shell writes (>, tee, cp, mv, rm, sed -i)
    deny: [".env", "*.pem"] # no slash: any file with that name; `src/**`: from the project root
    approval: ["**/migrations/**"]
  irreversible:
    builtins: true # or a list: [git-push, merge, tag-delete, rm-outside-workspace, publish, send, guard-config]
    window_s: 1800 # the authorizing turn is at most 30 minutes old
    require_mention: true # ...and names the action
    require_origin: false # true: only entries labelled as typed by a person (see below)
    mentions: { git-push: [deploy] } # extra words per class
    rules: # your own irreversible classes
      - { name: deploy, shell: ["vercel --prod*", "fly deploy*"], mentions: [deploy] }
```

The MCP side's `deny` and `approval.tools` patterns also apply to MCP tools the coding agent calls
directly (`mcp__crm__crm_delete_contact` matches `crm_delete_*`). The kill switch stops every
guarded call in both modes.

**Irreversible classes.** `git-push` (`git push`, not `--dry-run`); `merge` (`gh pr merge`,
`glab mr merge`, `gh api -X PUT …/merge`); `tag-delete` (`git tag -d`, `gh release delete`);
`rm-outside-workspace` (`rm`/`rmdir`/`unlink`/`shred`/`find -delete` on anything outside the
project, the project itself, or — recursive only — a target that depends on a variable; temp
directories are free); `publish` (`npm`/`pnpm`/`yarn`/`bun publish`, `cargo publish`,
`twine upload`, `gem push`, `poetry`/`uv publish`, `docker push`, `gh release create`,
`changeset`/`lerna publish`, `semantic-release`, …); `send` (`mail`/`sendmail`/`mutt`/…,
`gh pr|issue create/comment/edit/…`, `gh api` writes, `curl` to Slack/Discord/Telegram/mail-API
hosts, MCP tools named `send`/`reply`/`forward`/`post`); `guard-config` (edits to `okgate.yaml`
or a hook settings file, `okgate hooks …`).

**The human-turn gate.** An irreversible command runs when the latest entry a person wrote in the
transcript (1) came after this session's previous irreversible command — one turn authorizes one
— (2) is at most `window_s` old, and (3) names the action ("push it"), or is a bare "yes" / "go
ahead" answering an assistant question that names it ("Want me to push to main?"). Otherwise the
agent gets `APPROVAL_REQUIRED` with an id, and either the person says so in their own words or runs
`okgate approve <id>` (in Claude Code, `! npx -p @agentwares/agentguard okgate approve <id>` runs it
without going through the model); the identical retry then runs once.

**How "a person wrote it" is decided** (Claude Code transcripts, checked against versions 2.1.170
to 2.1.286). An entry counts only if: `type` is `user` and `message.role` is `user`; it is not
`isSidechain` (a subagent's "user" turn is the parent model's prompt); not `isMeta` (skill bodies,
reminders, peer messages); not a compaction summary; carries no `tool_result` and no
`toolUseResult` (tool output rides in user entries); if it has an `origin`, `origin.kind` is
`human` (`task-notification`, `peer`, `coordinator` are not); otherwise, if it has a `turnOrigin`,
that is `human`; with neither label (older versions, queued prompts, `claude -p`), its text does
not start with a harness wrapper (`<command-name>`, `<local-command-stdout>`, `<task-notification>`,
`<bash-input>`, `[Request interrupted`, …), and `require_origin: true` refuses it outright. Text
inside an assistant entry never counts — that is where a fabricated "user: yes, push it" lives.

**What the agent sees.** A denial is Claude Code's / Codex's `permissionDecision: "deny"` (Gemini:
`decision: "deny"`) whose reason is the usual okgate body:

```json
{
  "code": "APPROVAL_REQUIRED",
  "cause": "\"git push origin main\" is irreversible (git-push (git push origin main)) and the latest message typed by a person (08:29:16) does not name this action (expected one of: push, ship). It needs a person's approval (approval apr_7c62fbad56).",
  "fix": "stop and tell the user: this needs their approval. They can run `npx -p @agentwares/agentguard okgate approve apr_7c62fbad56` in a terminal in this project (or type `! npx -p @agentwares/agentguard okgate approve apr_7c62fbad56` in Claude Code), or say in their own words that you should do it; then retry this exact command once. Do not change it, work around it, or run the approval yourself: okgate refuses an approval from the agent.",
  "retryable": true,
  "details": { "approvalId": "apr_7c62fbad56", "command": "okgate approve apr_7c62fbad56" }
}
```

and the person gets a one-line `systemMessage` with the approve command. okgate never answers
"allow": an allowed call goes through the agent's own permission prompts as before. The agent may
not approve, deny or resume its own held actions, or write `.okgate/` (refused in enforce).
In dry-run the person sees "would have stopped …" and the call runs; `okgate report` lists every
such decision under **Coding-agent hooks**. Hook calls count against `caps` under `hook_calls`,
`shell_commands`, `file_edits` and `irreversible` (per run = per agent session, and per day); the
loop breaker stops the same file edit repeated.

## Audit: which written rules your coding agents broke

Teams write rules for their agents in CLAUDE.md, AGENTS.md, GEMINI.md and `.cursor/rules`, then
cannot tell whether the agents keep them. `okgate audit` reads the repository's rule files and
this machine's past Claude Code and Codex sessions in it, and prints, per rule, how many sessions
broke it and when. Measure first, then enforce what can be enforced.

```sh
npx -y -p @agentwares/agentguard okgate audit                      # this repository, the last 7 days
npx -y -p @agentwares/agentguard okgate audit --since 30d          # or all, 24h, 2026-09-01; --client claude|codex
npx -y -p @agentwares/agentguard okgate audit --json               # counts, rule ids and dates (what /okgate:audit reads)
npx -y -p @agentwares/agentguard okgate audit --enforce --preview  # the hook rules that would enforce them
```

```
okgate audit — /home/dev/acme · since 2026-09-30
6 sessions in this repository (Claude Code 5, Codex 1). Read on this machine; nothing was sent anywhere.
13 rules found (6 in CLAUDE.md, 3 in AGENTS.md, 1 in GEMINI.md, 2 in .cursor/rules/release.mdc, 1 in okgate.yaml); 11 checkable.

BROKEN
  R1   Never push to `main`.   (CLAUDE.md:5)
       no-push main — broken in 3 of 6 sessions (4 pushed); 1 refused by the harness
         2026-10-06 10:40  git push origin main  · session 3f9a1c2b
  R4   Run `pnpm check` before pushing.   (CLAUDE.md:8)
       run "pnpm check" before push — broken in 3 of 6 sessions (4 pushed or opened a PR); 4 times
…
NOT CHECKABLE MECHANICALLY (2) — add an inline check (<!-- okgate: … -->) or ask your agent with /okgate:audit
  R6   Write tests for new code.   (CLAUDE.md:13)
```

**The rules.** Every list item and every sentence that directs something (code blocks, tables and
front matter skipped) is a rule, numbered across the files, checkable or not. A small pattern
library, with no LLM, recognises the common checkable shapes: never push to / commit on / touch
main directly; never force-push (or "rewrite history"); never `--no-verify` / skip the hooks; run
`X` before committing or pushing (also tests, lint, typecheck); use pnpm, not npm; do not edit or
commit `<path>` (`.env`, lockfiles, generated directories); do not add dependencies (without
asking); never `rm -rf` outside the repo; never publish; never deploy; never use / run `<command>`.
"unless asked" / "without asking" makes a break on a turn a person typed asking for it not count.
Two explicit forms always work and win over the patterns:

```markdown
- Release notes go in CHANGELOG.md. <!-- okgate: never "git tag*" -->
- Keep functions small. <!-- okgate: none -->
```

```yaml
# okgate.yaml
audit:
  rules:
    - id: deploys
      text: Only CI deploys
      check: no-deploy # several: check: [no-verify, 'never "git reset --hard*"']
```

The check grammar: `no-push [branch,…]`, `no-commit-to [branch,…]`, `no-force-push [branch,…]`,
`no-verify`, `run "<command>" before commit|push` (`@tests`, `@lint`, `@typecheck` for the usual
commands), `use pnpm|npm|yarn|bun`, `no-pm npm,…`, `no-edit "<glob>" …`, `no-commit "<glob>" …`,
`no-new-deps`, `no-rm-outside`, `no-publish`, `no-deploy`, `never "<command glob>" …`, each with an
optional `unless-asked`; `none` marks a rule no script can check.

**The sessions.** Claude Code transcripts (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR`) and
Codex rollouts (`~/.codex/sessions`, or `$CODEX_HOME`) whose working directory is this repository
or one of its worktrees, subagents included. The tool calls are read the way hook mode reads them
(the same shell parser, the same edit targets, the same rm-outside-workspace and publish classes),
and "asked for it" is hook mode's human-turn reading of the transcript. A push's branch is the one
on the command line; for a bare `git push`, the one Claude Code recorded the push went to, else
the branch checked out.

**What leaves the screen: nothing.** No network, no telemetry, no LLM. The command or path that
broke a rule is shown on your terminal only. `--json` and the cache
(`~/.okgate/audit-cache-v1/`, counts per transcript so a second run takes about a second and
history survives Claude Code's 30-day transcript cleanup) hold counts, rule ids, dates, line
numbers and hashes — never a command, a path or a prompt; a test plants marker strings in every
part of a synthetic transcript and checks that none reaches either.

**`--enforce`.** Writes the checkable rules into okgate.yaml as hook-mode rules
(`hooks.shell.deny`, `hooks.shell.approval` for "without asking", `hooks.paths.deny`, the
built-in irreversible classes, a `deploy` rule), each with a comment naming the rule it came
from; shows the diff; installs the hook if it is not installed. It never switches `hooks.mode`:
a new hooks block starts in dry-run, and if yours is already `enforce` it writes nothing without
`--yes`. "Run X before pushing" and "never commit on main" stay audit-only (a pre-execution hook
sees one command, not the order or the checked-out branch).

**In your agent.** `/okgate:audit` (Claude Code plugin, Gemini CLI extension) runs
`audit --json` and has your own agent judge the rules marked not checkable against the
repository and its git history — no tokens of ours. `/okgate:hooks` installs or checks hook
mode.

## Policy

`okgate init` generates this file with every knob explained inline. The short form:

```yaml
version: 1
mode: dry-run                     # dry-run | enforce
upstreams:
  - name: crm
    url: https://mcp.example.com/mcp
    auth: ${CRM_TOKEN}            # the agent never sees this
  - name: files
    command: npx
    args: [-y, "@modelcontextprotocol/server-filesystem", "."]
classify:                         # patterns win over annotations win over verb heuristics
  write: [crm_update_*, crm_delete_*, email_send]
  spend: [stripe_*, x402_*]
  unknown: write                  # unclassifiable tools count as writes (or: read | block)
caps:
  per_run: { writes: 50, deletes: 10, emails: 5, spend_usd: 25, tool_calls: 400 }
  per_day: { spend_usd: 200 }
spend:
  tools:
    stripe_create_charge: { amount_arg: amount, divisor: 100, currency_arg: currency }
loop: { window: 30, max_repeats: 3, max_cycle_len: 4, max_read_repeats: 10 }
dry_run: { tools: [crm_delete_*], synthesize: true }      # always fake these, even in enforce
approval:
  tools: [crm_delete_*, db_drop_*]
  wait_s: 0                       # >0 holds the call open waiting for the decision
  notify: { slack: ${SLACK_WEBHOOK_URL} }
kill: { file: .okgate/KILL, env: OKGATE_KILL }
agents:                           # okgate key create deployer --allow 'crm_get_*' --writes 5
  - name: deployer
    key_hash: sha256:…
    allow: [crm_get_*, crm_update_contact]
    caps: { per_run: { writes: 5 } }
alerts: { slack: ${SLACK_WEBHOOK_URL}, on: [LOOP_DETECTED, CAP_EXCEEDED, KILLED, APPROVAL_REQUIRED] }
audit: { path: .okgate/audit.jsonl, redact: true }
```

Classification order: `classify.*` patterns → MCP `annotations.readOnlyHint` / `destructiveHint` → verb heuristics (`get/list/search…` read, `create/update/delete/send/execute…` write, `pay/charge/refund…` + `stripe_*`/`x402_*` spend). `okgate tools` prints every tool with its class and why.

## What the agent sees

Every block is an in-band tool result with `isError: true` and a JSON body the model can act on:

```json
{
  "code": "CAP_EXCEEDED",
  "cause": "writes cap for this run is 50; used 50, this call would make it 51",
  "fix": "stop and report to the user what is done and what remains; a human can raise caps.per_run in okgate.yaml or start a new run",
  "retryable": false,
  "details": {
    "scope": "per_run",
    "counter": "writes",
    "limit": 50,
    "used": 50,
    "remaining": { "writes": { "per_run": 0 } }
  }
}
```

Codes: `KILLED`, `APPROVAL_REQUIRED` (retryable once approved), `APPROVAL_DENIED`, `LOOP_DETECTED`, `CAP_EXCEEDED`, `TOOL_DENIED`, `UNKNOWN_TOOL`, `UPSTREAM_ERROR`. Successful and faked results carry `_meta.okgate = { class, verb, mode, outcome, dryRun, seq, run_id }`.

Run identity: `X-Run-Id` header (HTTP) → `_meta.runId` on the call → session → one id per proxy process. Per-run caps and the loop window are per run; per-day caps are per policy (and per agent).

## Commands

| Command                                                                                                                               | What it does                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `okgate init [--client path] [--all] [--no-probe] [--mode enforce] [--undo]`                                                          | generate the policy, rewrite the client config (project-level by default)                                                                          |
| `okgate proxy [--http --port 8788] [--agent name] [--run-id id] [--mode m]`                                                           | run the proxy (stdio default)                                                                                                                      |
| `okgate report [--run id \| --all] [--json]`                                                                                          | what this run did / would have destroyed / spent; where it was halted; chain status                                                                |
| `okgate diff [--run id]`                                                                                                              | mutation diff of faked writes                                                                                                                      |
| `okgate verify [audit.jsonl]`                                                                                                         | recompute the hash chain; exit 1 on the first break                                                                                                |
| `okgate status [--run id]`                                                                                                            | counters vs caps, kill state, pending approvals, running HTTP proxy                                                                                |
| `okgate tools [--json]`                                                                                                               | every exposed tool with class, verb, upstream and the reason                                                                                       |
| `okgate kill [reason]` / `okgate resume`                                                                                              | halt everything now / clear it                                                                                                                     |
| `okgate approvals [--all]` / `approve <id>` / `deny <id> [--note …]`                                                                  | the approval queue                                                                                                                                 |
| `okgate key create <agent> [--allow p]… [--deny p] [--writes n] [--spend n] [--mode m]` / `key list` / `key revoke <agent>`           | scoped credentials                                                                                                                                 |
| `okgate connect <key> [--write] [--client path] [--all] [--url base]`                                                                 | point this machine's MCP client at a hosted proxy (paid tiers); prints the config, `--write` merges it in                                          |
| `okgate permission-diff [--base ref] [--head ref] [--fail-on-widen]`                                                                  | which config changes widen agent permissions (also a [GitHub Action](https://github.com/agentwares/agentguard/tree/main/permission-diff))          |
| `okgate hooks install [--project\|--user] [--client claude\|codex\|gemini\|all] [--command cmd]` / `hooks uninstall` / `hooks status` | put the policy in front of a coding agent's shell commands and file edits ([hook mode](#hook-mode-a-coding-agents-own-commands))                   |
| `okgate hook pre-tool-use [--client c]`                                                                                               | what the installed hook runs: reads the harness's JSON on stdin, answers in its format                                                             |
| `okgate audit [--since 7d\|30d\|all] [--client claude\|codex\|all] [--json] [--rules file] [--no-cache] [--no-evidence]`              | which written rules the coding agents broke, per rule, from this machine's sessions ([audit](#audit-which-written-rules-your-coding-agents-broke)) |
| `okgate audit --enforce [--preview] [--yes]`                                                                                          | write the checkable rules into okgate.yaml as hook rules (dry-run), show the diff, install the hook                                                |

### Hosted tiers

The CLI enforces policy on your machine and needs no account. The paid tiers move enforcement
server-side — shared state across machines, retained audit, alerting — and `connect` is how you
point a client at yours:

```sh
npx -p @agentwares/agentguard okgate connect agk_...          # print the MCP server block
npx -p @agentwares/agentguard okgate connect agk_... --write  # merge it into your MCP config (existing servers are kept)
```

Unlike `init`, `connect` adds one remote server and leaves the rest of your config alone. The key
comes from your dashboard; everything else — proxy URL, mode, band — is answered by the server.

HTTP control endpoints (token in `.okgate/http.json`): `GET /health`, `GET /status?run=`, `POST /kill`, `POST /resume`, `GET|POST /approve/:id`, `/deny/:id`, `GET /approvals`.

## Try it with the fixtures

```sh
git clone https://github.com/agentwares/agentguard && cd agentguard && pnpm install && pnpm build
cd apps/agentguard-cli
cat > okgate.yaml <<'YAML'
mode: dry-run
upstreams:
  - name: crm
    command: node
    args: [dist/fixtures/crm-server.js]
caps: { per_run: { writes: 50 } }
YAML
node dist/fixtures/demo-agent.js --config okgate.yaml  # a scripted agent: reads, writes, a deliberate loop, a 60-write burst
node dist/cli.js report && node dist/cli.js diff && node dist/cli.js verify
```

## Conformance and tests

`pnpm test` runs the CLI suite (85 tests; 191 more in `agentguard-core`, 11 in the SDK): the audit end to end on a synthetic history (rule files in every format, Claude Code and Codex sessions with known kept and broken rules, marker strings that must never reach the cache or `--json`, `--enforce`), hook mode end to end (install for three clients, each client's answer format, the approve flow, synthetic transcripts reproducing a model-written "user: yes, push it"), the engine over InMemoryTransport, the spawned stdio proxy (with and without a policy file), the Streamable HTTP proxy with `X-Run-Id`, scoped keys and control endpoints, `init` against real configs, and a recorded-fixture replay (`fixtures/recorded/crm-session.json`; re-record with `RECORD_FIXTURES=1`). `pnpm conformance` runs the official `@modelcontextprotocol/conformance` server suite against the proxy with a sample server behind it (tools, resources, prompts, completions, logging, progress, sampling and elicitation are relayed).

## Limits (honest)

- The proxy sees MCP tool calls; hook mode sees a coding agent's shell commands, file edits and direct MCP calls. Token spend on the model API is only visible through the SDK's guarded `fetch` (or `spend.tools` rules for MCP tools that call models).
- Hook mode is a guardrail against an agent acting without a person's say-so, not a sandbox against a hostile one. It reads command lines, not what runs: a script (`./release.sh`, `make deploy`) that pushes inside is only caught by a `shell` rule naming it; `xargs rm` targets come from stdin and are not checked; a variable's value is unknown (a recursive `rm` of one counts as outside the workspace). "Names the action" is a word match: "don't push yet" names push. Each class's words are in the policy block; add your language's with `irreversible.mentions`.
- Claude Code writes the transcript asynchronously; if the turn that authorizes a command is not on disk yet when the hook runs, the command is held (fail closed) and the retry passes. A `claude -p` prompt has no `origin` label, so it counts as the person's turn unless `require_origin: true`. Codex and Gemini CLI get no human-turn gate (their irreversible commands always need `okgate approve` in enforce). If the hook itself fails (a broken `okgate.yaml`), the call runs and the person sees "this call was NOT checked".
- The audit counts what the transcripts show. Rules are recognised by patterns, not understood: a rule worded unusually is listed as not checkable (add an inline check), and one worded like a pattern it does not mean can be mis-read (mark it `<!-- agentguard: none -->`). A bare `git push` counts as a push to the checked-out branch only on the main thread (a subagent's `gitBranch` can be the session's, not its worktree's); an attempt the harness refused still counts, marked as refused. Sessions are matched by working directory: a worktree outside the repository is not included. Codex rollouts do not say which turns a person typed, so an `unless-asked` break there is reported as undetermined; Codex's JavaScript `exec` tool is counted, not read.
- Dry-run synthesizes results from the tool's `outputSchema`; agents that depend on real ids from a create → update chain will see plausible but fake ids. `dry_run.tools` lets you fake only the dangerous tools in enforce mode.
- Per-day counters are a JSON file under a directory lock; fine for a workstation or one box, not a fleet. The hosted tier (coming) is the shared-state version.
- Slack "Approve" buttons are links to the local HTTP proxy; they work for people who can reach it. Without HTTP mode the message carries the `okgate approve <id>` command.
- A local hash chain is tamper-**evident**, not tamper-proof, and it has one blind spot: entries deleted from the **end** of the file leave a shorter chain that still verifies. Editing, deleting from the middle, and reordering are all caught. `okgate verify` prints the head hash and the entry count — record them (CI log, ticket, chat) to close the gap, or use the hosted tier, which publishes a daily Merkle root you can check the run against.

## Related

- [`@agentwares/agentguard-sdk`](https://github.com/agentwares/agentguard/tree/main/packages/agentguard-sdk#readme) — the same engine for OpenAI Agents SDK / LangChain / plain functions, plus the guarded `fetch` for LLM spend.
- [`@agentwares/agentguard-core`](https://github.com/agentwares/agentguard/tree/main/packages/agentguard-core#readme) — the Web-standard policy engine (bring your own stores).
- [permission-diff GitHub Action](https://github.com/agentwares/agentguard/tree/main/permission-diff) — comments on PRs that widen `okgate.yaml`, `.claude/settings.json` or `mcp.json`.

## This repository

| Path                       | What                                                                          |
| -------------------------- | ----------------------------------------------------------------------------- |
| `apps/agentguard-cli`      | the `okgate` CLI and MCP proxy — published as `@agentwares/agentguard`        |
| `packages/agentguard-core` | the policy engine, Web-standard — published as `@agentwares/agentguard-core`  |
| `packages/agentguard-sdk`  | middleware for non-MCP tool calls — published as `@agentwares/agentguard-sdk` |
| `permission-diff`          | the GitHub Action, `uses: agentwares/okgate/permission-diff@main`             |

```sh
git clone https://github.com/agentwares/okgate && cd okgate
pnpm install && pnpm test && pnpm build
```

This repo is generated from the agentwares monorepo, which stays private because it also holds the
paid products. Issues and pull requests here are read and applied upstream.
