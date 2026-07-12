# Base image can be overridden to pull from an internal Docker proxy.
ARG BASE_IMAGE=node:20-alpine

# Build stage
FROM ${BASE_IMAGE} AS builder

RUN corepack enable

WORKDIR /app

# Optional internal npm registry (e.g. JFrog Artifactory). When unset, the
# official registry is used and behavior is unchanged.
ARG NPM_REGISTRY=
ARG NPM_AUTH_TOKEN=

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies (using node-modules linker for Docker compatibility).
# When NPM_REGISTRY is set, point Yarn Berry at it before installing.
RUN yarn config set nodeLinker node-modules && \
    if [ -n "$NPM_REGISTRY" ]; then \
      yarn config set npmRegistryServer "$NPM_REGISTRY" && \
      yarn config set unsafeHttpWhitelist --json "[\"$(echo "$NPM_REGISTRY" | sed -E 's|^https?://([^/:]+).*|\1|')\"]"; \
    fi && \
    if [ -n "$NPM_AUTH_TOKEN" ]; then yarn config set npmAuthToken "$NPM_AUTH_TOKEN"; fi && \
    yarn install --immutable

# Copy source code
COPY . .

# Set API_URL for build time (Docker internal network)
# Must include the full path pattern for Next.js rewrites
ARG API_URL=http://api:8080/api/:path*
ENV API_URL=${API_URL}

# Build the application
RUN yarn build

# Production stage
FROM ${BASE_IMAGE} AS runner

WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Copy built assets
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
