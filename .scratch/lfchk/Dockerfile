FROM node:24-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY tsdown.config.ts ./
COPY src ./src

RUN pnpm build

FROM gcr.io/distroless/nodejs24-debian13 AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/resources ./src/resources

EXPOSE 3000

CMD ["dist/index.cjs"]
