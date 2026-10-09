# @agentwares/agentguard-core → @agentwares/okgate-core

agentguard was renamed **okgate** on 8 October 2026. From 0.2.0 this package re-exports
`@agentwares/okgate-core` (and `./node` re-exports `@agentwares/okgate-core/node`), so code that
imports the old name keeps working. It prints one line on stderr when first imported.

```sh
npm install @agentwares/okgate-core
```

Source: https://github.com/agentwares/okgate
