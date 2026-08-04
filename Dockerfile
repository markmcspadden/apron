FROM node:20-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@8

# Copy workspace-level manifests first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy every workspace member's package.json (preserving directory structure)
# so `pnpm install` can resolve the dependency graph without needing the
# rest of the source yet.
COPY packages/agents/advance/package.json packages/agents/advance/package.json
COPY packages/agents/customs/package.json packages/agents/customs/package.json
COPY packages/agents/fixer/package.json packages/agents/fixer/package.json
COPY packages/agents/runner/package.json packages/agents/runner/package.json
COPY packages/agents/spotter/package.json packages/agents/spotter/package.json
COPY packages/agents/steward/package.json packages/agents/steward/package.json
COPY packages/agents/traffic/package.json packages/agents/traffic/package.json
COPY packages/agents/wrangler/package.json packages/agents/wrangler/package.json
COPY packages/credentials/package.json packages/credentials/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/provenance/package.json packages/provenance/package.json
COPY packages/rules/engine/package.json packages/rules/engine/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/types/package.json packages/types/package.json
COPY integrations/clickhouse/package.json integrations/clickhouse/package.json
COPY integrations/firebase/package.json integrations/firebase/package.json
COPY integrations/google-cloud/package.json integrations/google-cloud/package.json
COPY integrations/grafana/package.json integrations/grafana/package.json

# Install dependencies. The lockfile may not always be in sync (fixtures /
# newly added workspace members), so don't hard-fail on a frozen lockfile.
RUN pnpm install --no-frozen-lockfile

# Now copy the rest of the source (including fixtures/, which has no
# package.json of its own) and install again to pick up anything the
# manifest-only pass above missed.
COPY . .
RUN pnpm install --no-frozen-lockfile

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production

CMD ["npx", "tsx", "packages/server/src/demo.ts"]
