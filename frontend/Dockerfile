# Build stage
FROM node:20-alpine AS builder

RUN corepack enable

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies (using node-modules linker for Docker compatibility)
RUN yarn config set nodeLinker node-modules && yarn install --immutable

# Copy source code
COPY . .

# Set API_URL for build time (Docker internal network)
# Must include the full path pattern for Next.js rewrites
ARG API_URL=http://api:8080/api/:path*
ENV API_URL=${API_URL}

# Build the application
RUN yarn build

# Production stage
FROM node:20-alpine AS runner

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
