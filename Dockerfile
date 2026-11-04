FROM node:24.15.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsup && pnpm exec tsx scripts/release/build-runtime.ts /runtime --server-only

FROM node:24.15.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production CONTEXTMESH_HOST=0.0.0.0
COPY --from=build --chown=node:node /runtime/ ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
