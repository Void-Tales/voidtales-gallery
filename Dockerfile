# Stage 1: Base image for all subsequent stages, using a minimal Node.js environment
FROM node:22-alpine AS base

# Optional build arguments for remote downloads (handled in CI workflow)
ARG EXT_DL_URL_MARKDOWN
ARG EXT_DL_URL_ORIGINAL
ARG EXT_DL_URL_MARKDOWN_EXTERNAL
ARG EXT_DL_URL_ORIGINAL_EXTERNAL

# Set build arguments as environment variables (if needed)
ENV EXT_DL_URL_MARKDOWN=$EXT_DL_URL_MARKDOWN
ENV EXT_DL_URL_ORIGINAL=$EXT_DL_URL_ORIGINAL
ENV EXT_DL_URL_MARKDOWN_EXTERNAL=$EXT_DL_URL_MARKDOWN_EXTERNAL
ENV EXT_DL_URL_ORIGINAL_EXTERNAL=$EXT_DL_URL_ORIGINAL_EXTERNAL

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Enable corepack to manage package managers like pnpm
RUN corepack enable

# ------------------------------------------------------------

# Stage 2: Build stage - install dependencies and build the application
FROM base AS build
WORKDIR /app
# Copy all project files to the container (node_modules is excluded via .dockerignore)
COPY . .
# Copy lock files to leverage caching
COPY package.json pnpm-lock.yaml ./
# Set CI environment to enable non-interactive mode
ENV CI=true
# Install pnpm dependencies
RUN pnpm install --frozen-lockfile
# Set environment to production to optimize the build
ENV NODE_ENV=production
# Build the application for production
RUN pnpm run build

# ------------------------------------------------------------

# Stage 3: Node.js server image (not used in final deployment, but available for Dokploy if needed)
FROM base AS dokploy
WORKDIR /app
ENV NODE_ENV=production
# Copy only the necessary production files from the 'build' stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

# ------------------------------------------------------------

# Stage 4: Final production image for serving static files with Nginx
FROM nginx:alpine
# Copy built static files from the build stage to the Nginx web server directory
COPY --from=build /app/dist /usr/share/nginx/html
# Copy thumbnail images from the build stage to the Nginx serving directory
COPY --from=build /app/public/images/thumbs /usr/share/nginx/html/images/thumbs
# Copy custom nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Expose port 80 for web traffic
EXPOSE 80
# Nginx uses its default command, so no CMD is required here