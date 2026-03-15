# Stage 1: Build TypeScript
# Build context: project root (not server/)
FROM node:22-alpine AS builder

WORKDIR /build
COPY server/package.json server/package-lock.json* ./
RUN npm install

COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine

WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY server/package.json ./
COPY migrations ./migrations

EXPOSE 3000

CMD ["node", "dist/index.js"]
