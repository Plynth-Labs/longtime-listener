# The public deployment. Only the API gateway binds a routable address; the app
# itself stays on loopback inside the container, exactly as it does on a laptop.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Durable state — saved shows, listener profiles, archived episodes and the
# permanent speech cache — lives on the mounted volume, never in the image.
ENV NODE_ENV=production \
    NEWSCAST_DATA_DIR=/data \
    HOST=127.0.0.1 \
    PORT=4310 \
    NEWSCAST_PUBLIC_HOST=0.0.0.0 \
    NEWSCAST_PUBLIC_PORT=8080 \
    NEWSCAST_PUBLIC_UPSTREAM=http://127.0.0.1:4310/api/

EXPOSE 8080
CMD ["node", "scripts/serve-public.mjs"]
