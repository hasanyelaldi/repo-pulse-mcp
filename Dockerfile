# Builds a small image for running repo-pulse-mcp over stdio.
# Works with both Podman and Docker: no BuildKit-only syntax, and fully
# qualified image names (Podman does not assume docker.io for short names).
#
#   podman build -t repo-pulse-mcp .
#   podman run -i --rm -v "$PWD:/repos/project:ro" -e REPO_PULSE_REPOS=/repos/project repo-pulse-mcp

# ---- build stage ----
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM docker.io/library/node:22-alpine
# git is the only runtime dependency besides Node.
RUN apk add --no-cache git \
  # Mounted repositories are owned by a host user; tell git to trust them.
  # Safe here because the server only runs read-only subcommands.
  && git config --system --add safe.directory '*'
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "build/index.js"]
