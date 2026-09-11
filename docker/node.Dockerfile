# Multi-target image for the TypeScript workspace (backend services + Next.js frontend).
# Build context is the repo root so workspace packages (shared, simulator) resolve.
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY simulator/package.json simulator/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile

FROM deps AS source
COPY shared shared
COPY simulator simulator
COPY backend backend
COPY frontend frontend

# ---- backend: API + indexer + keeper (and the one-shot history seeder) ----
FROM source AS backend
WORKDIR /app/backend
ENV NODE_ENV=production
EXPOSE 4010
CMD ["pnpm", "exec", "tsx", "src/index.ts", "all"]

# ---- frontend: Next.js production build ----
FROM source AS frontend-build
ARG NEXT_PUBLIC_API_URL=http://localhost:4010
ARG NEXT_PUBLIC_RPC_URL=http://localhost:8555
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_PUBLIC_RPC_URL=${NEXT_PUBLIC_RPC_URL} NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/frontend
RUN pnpm build

FROM frontend-build AS frontend
ENV NODE_ENV=production
EXPOSE 3010
CMD ["pnpm", "start"]
