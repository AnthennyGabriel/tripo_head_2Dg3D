ARG BASE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${BASE_IMAGE}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY web ./web
COPY assets ./assets
COPY config.example.yaml ./config.example.yaml

ENV TRIPO_HEAD_HOST=0.0.0.0 \
    TRIPO_HEAD_PORT=8771 \
    TRIPO_HEAD_JOBS=/data/jobs \
    TRIPO_HEAD_CONFIG=/app/config.example.yaml
RUN mkdir -p /data/jobs && chown -R node:node /data
USER node
EXPOSE 8771
CMD ["node", "src/server.js"]
