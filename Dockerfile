# ---- Build Stage ----
FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN bun run build

# ---- Production Stage ----
FROM oven/bun:1

# Install fonts and dependencies required by @napi-rs/canvas
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    fonts-noto-color-emoji \
    fontconfig \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

CMD ["bun", "run", "dist/index"]
