# @agentwares/agentguard → @agentwares/okgate

agentguard was renamed **okgate** on 8 October 2026. This package is what the old name
installs from 0.2.0 on: it depends on `@agentwares/okgate` and runs it, so a hook, an MCP
config or a script that names `@agentwares/agentguard` keeps working. It prints one line on
stderr and nothing else differs.

```sh
npx @agentwares/okgate init     # instead of npx @agentwares/agentguard init
```

Pinned versions (`@agentwares/agentguard@0.1.9` in a committed hook) stay on npm and keep
running the code they always ran. `okgate` reads `agentguard.yaml`, an existing `.agentguard/`
and every `AGENTGUARD_*` variable, and `AGENTGUARD_KILL=1` halts it.

Source: https://github.com/agentwares/okgate
