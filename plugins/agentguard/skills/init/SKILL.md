---
name: init
description: Put okgate in front of this project's MCP servers in dry-run mode, so the next agent run records what it would have deleted, sent or spent without doing it. Runs `npx -y -p @agentwares/agentguard okgate init`, which writes okgate.yaml and rewrites the project's MCP config, keeping a backup.
argument-hint: "[--client <config path>] [--all] [--mode enforce] [--undo]"
disable-model-invocation: true
---

> **agentguard is now okgate.** This skill is the deprecated `agentguard@agentwares` plugin's copy of
> `okgate@agentwares`'s; it is kept until at least 2027-01-15. Tell the user once: `/plugin install okgate@agentwares`.

# Set up okgate in this project

okgate is an open-source MCP policy proxy (`@agentwares/agentguard` on npm, MIT). It sits
between the agent and its MCP servers and enforces one file, `okgate.yaml`: dry-run writes,
spend caps, approvals for destructive tools, a loop breaker, a kill switch and a hash-chained
audit log. It runs on this machine, needs no account and makes no LLM calls.

## 1. Say what will change, then run it

Before running anything, tell the user in two or three sentences what `init` does:

- writes `okgate.yaml` in the current directory, in **dry-run** mode: reads pass through,
  writes and spends are faked and recorded, nothing destructive executes upstream;
- backs up the **first project-level** MCP config it finds (`.mcp.json`, `.cursor/mcp.json`,
  `.vscode/mcp.json`, `mcp.json`, `.gemini/settings.json`) to `*.okgate-backup`, and replaces
  its servers with one entry that starts `npx -y -p @agentwares/agentguard okgate proxy`;
- leaves user-level configs (`~/.claude.json`, Claude Desktop, `~/.cursor/mcp.json`) alone unless
  one is passed with `--client <path>`, because those affect every project on the machine;
- `npx -y -p @agentwares/agentguard okgate init --undo` restores the backup.

Then run, from the project root:

```sh
npx -y -p @agentwares/agentguard@latest okgate init $ARGUMENTS
```

## 2. Read the result back to the user

- If it printed `found no MCP config`, this project has no project-level MCP config. Claude Code
  may keep this project's servers in `~/.claude.json`. Do not pass `--client ~/.claude.json` on
  your own: ask first, and say it rewrites a user-level file (a backup is kept).
- If it printed `already initialized`, say so and go to step 3.
- Otherwise open the `okgate.yaml` it wrote and summarise it in a few lines: the mode, each
  upstream and how many tools it has, the tools under `approval.tools` (destructive ones that will
  need a human), the tools under `classify.write` that could not be classified (they count as
  writes), and the caps under `caps.per_run`. Quote any `could not connect` line: that server
  will not work through the proxy until its entry in `okgate.yaml` is fixed.

Do not change `mode: dry-run` to `enforce`, and do not edit caps or approvals, unless the user
asks.

## 3. Next steps to give the user

1. Restart Claude Code (or the MCP client whose config was rewritten) so it starts the proxy.
2. Run the agent once as usual. In dry-run, writes are faked; nothing executes upstream.
3. Run `/agentguard:report` to see what the run did and would have done.
4. When the report looks right, set `mode: enforce` in `okgate.yaml`.

Emergency stop at any time: `npx -y -p @agentwares/agentguard okgate kill` (every call returns `KILLED`
until `npx -y -p @agentwares/agentguard okgate resume`).
