import { defineConfig } from "tsup";

/**
 * `@agentwares/mcp-kit` and `@agentwares/notify` are private workspace packages, so they are
 * bundled into the published CLI; everything else stays an npm dependency.
 */
export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
    "fixtures/crm-server": "src/fixtures/crm-server.ts",
    "fixtures/demo-agent": "src/fixtures/demo-agent.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "es2022",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  // chunks keep the MCP SDK out of `agentguard hook pre-tool-use`'s startup (see cli.ts)
  splitting: true,
  noExternal: [/^@agentwares\/(mcp-kit|notify|x402)$/],
  banner: { js: "" },
});
