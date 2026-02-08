# meta-dup standalone Docker image
# Includes: Redis (via meta-core), nginx, Node.js backend, React UI
#
# Build standalone:
#   docker build -t meta-dup .
#
# Build with custom meta-core (for development):
#   docker build --build-arg META_CORE_IMAGE=meta-core:local -t meta-dup .

# Stage 0: Get meta-core binary from published image
ARG META_CORE_IMAGE=ghcr.io/worph/meta-core:latest
FROM ${META_CORE_IMAGE} AS meta-core

# Stage 1: Build UI
FROM node:21-alpine AS ui-builder

WORKDIR /build

# Copy UI package and install
COPY packages/meta-dup-ui/package.json ./
RUN npm install

# Copy UI source and build
COPY packages/meta-dup-ui/ ./
RUN npm run build

# Stage 2: Build Backend
FROM node:21-alpine AS backend-builder

WORKDIR /build

# Copy backend package and install
COPY packages/meta-dup-core/package.json ./
RUN npm install

# Copy backend source and build
COPY packages/meta-dup-core/tsconfig.json ./
COPY packages/meta-dup-core/src/ ./src/
RUN npm run build

# Stage 3: Runtime
FROM ubuntu:22.04

# Container registry metadata
LABEL org.opencontainers.image.source=https://github.com/worph/meta-dup
LABEL org.opencontainers.image.description="MetaMesh duplicate detection service"
LABEL org.opencontainers.image.licenses=MIT

# Avoid prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    ca-certificates \
    nginx \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 21
RUN curl -fsSL https://deb.nodesource.com/setup_21.x | bash - \
    && apt-get install -y nodejs

# Create directories
RUN mkdir -p \
    /app/backend \
    /app/ui \
    /var/log/supervisor \
    /var/log/nginx

# Copy built UI
COPY --from=ui-builder /build/dist /app/ui
RUN chmod -R 755 /app/ui

# Copy built backend
COPY --from=backend-builder /build/dist /app/backend/dist
COPY --from=backend-builder /build/node_modules /app/backend/node_modules
COPY --from=backend-builder /build/package.json /app/backend/

# Copy meta-core sidecar binary
COPY --from=meta-core /usr/local/bin/meta-core /usr/local/bin/meta-core
RUN chmod +x /usr/local/bin/meta-core

# Copy configuration files
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Environment variables
ENV NODE_ENV=production \
    REDIS_PREFIX="" \
    API_HOST=0.0.0.0 \
    API_PORT=3000

# Expose port 80 (nginx)
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost/health || exit 1

# Start supervisord (manages meta-core, backend, nginx)
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
