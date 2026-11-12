# Two stages: the first needs the dev toolchain to bundle, the second ships only
# what runs. ffmpeg comes from apt because a container has no PATH to inherit.
FROM node:22-slim AS build
WORKDIR /app
# the app is only bundled here — don't download Electron's binary for it
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app

# yt-dlp needs ffmpeg for merging streams and extracting mp3
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# not root: this process runs yt-dlp and writes files. The state and yt-dlp
# folders must exist and be owned here, or a mounted volume arrives root-owned
# and cookies/settings silently fail to save.
RUN mkdir -p /home/node/.config/yoinks /home/node/.yoinks \
  && chown -R node:node /home/node/.config /home/node/.yoinks
USER node

EXPOSE 8080

# /healthz answers without credentials, by design
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# YOINKS_PASSWORD is required — the server refuses to start without it:
#   docker run -p 8080:8080 -e YOINKS_PASSWORD=choose-one yoinks
CMD ["node", "dist/server.js"]
