# okgate, the MCP policy proxy, as an MCP server over stdio, built from this repository.
#
#   docker build -t okgate .
#
#   docker run -i --rm okgate
#     No okgate.yaml: serves okgate's own read-only tools (okgate_get_status,
#     okgate_get_report, okgate_verify_audit_log). This is what an MCP registry that builds
#     the repo, such as Glama, inspects.
#
#   docker run -i --rm okgate proxy --config /app/demo/okgate.yaml
#     The bundled demo: a fake CRM behind the proxy in dry-run, so proxied tools are visible.
#
#   docker run -i --rm -v "$PWD:/work" -w /work okgate
#     Your own ./okgate.yaml. Its upstreams must be reachable from inside the container.

FROM node:22-slim AS build
ENV CI=1
RUN npm install -g pnpm@9.15.9
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@agentwares/agentguard..." run build
RUN pnpm --filter @agentwares/agentguard deploy --prod /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
COPY docker/demo.okgate.yaml /app/demo/okgate.yaml
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["proxy"]
