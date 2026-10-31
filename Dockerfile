# Manufact builds a committed Dockerfile "as-is" (docs.manufact.com/dashboard/build-runtimes).
# Debian's `chromium` package brings the shared libraries Chromium needs; Puppeteer's own download is skipped.
FROM node:22-bookworm-slim

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Chromium runs as an unprivileged user with its sandbox ENABLED. If the host forbids user namespaces,
# the boot-time self-check logs "ok:false" and submissions return errorCode=browser_launch_failed;
# BRAVE_SUBMITTER_NO_SANDBOX=1 is a deliberate opt-in (see README), never a default.
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
