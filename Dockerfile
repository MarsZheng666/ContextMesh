FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/adapter-deepseek/package.json packages/adapter-deepseek/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm exec tsup

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production CONTEXTMESH_HOST=0.0.0.0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
