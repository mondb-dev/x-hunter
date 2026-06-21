FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --production=false

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# prebuild expects ../state, ../journals etc. — create empty stubs so it doesn't fail,
# then the real data comes from GCS FUSE mount at runtime
RUN mkdir -p ../state ../journals ../checkpoints ../articles ../daily ../ponders ../landmarks
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# standalone output includes server.js + minimal node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# data directory — GCS FUSE mount overlays this at runtime
# Create empty structure as fallback
RUN mkdir -p data/state data/journals data/checkpoints data/articles data/daily data/ponders data/landmarks
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
