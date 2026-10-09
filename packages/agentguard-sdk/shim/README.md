# @agentwares/agentguard-sdk → @agentwares/okgate-sdk

agentguard was renamed **okgate** on 8 October 2026. From 0.2.0 this package re-exports
`@agentwares/okgate-sdk`, so code that imports the old name keeps working (`AgentGuard`,
`createGuard` and the adapters are the same). It prints one line on stderr when first imported.

```sh
npm install @agentwares/okgate-sdk
```

Source: https://github.com/agentwares/okgate
