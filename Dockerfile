# ---- Production Stage (Bun) ----
FROM oven/bun:1.3-slim

# Install system dependencies: fonts, ffmpeg for animated stickers, sharp deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-noto-core \
    fonts-noto-color-emoji \
    fonts-noto-mono \
    fonts-noto-cjk \
    ffmpeg \
    libvips42 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install deps
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Copy source
COPY src/ ./src/
COPY templates/ ./templates/
COPY fonts/ ./fonts/
COPY tsconfig.json ./

# Create tmp directories
RUN mkdir -p tmp tmp/image_cache test/assets

# Environment
ENV NODE_ENV=production

CMD ["bun", "run", "src/index.ts"]
