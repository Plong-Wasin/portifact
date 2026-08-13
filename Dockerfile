FROM oven/bun:1.3.14-slim

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

ENV NODE_ENV=production

# Run the app as a non-root user. The oven/bun image ships a `bun` user (uid 1000).
RUN chown -R bun:bun /app
USER bun

CMD ["bun", "src/app.ts"]
