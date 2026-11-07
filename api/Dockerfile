# gallery-api: likes and comments, served by Traefik under gallery.voidtales.win/api/.
# No npm install - the service only uses Node built-ins.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
WORKDIR /app
COPY server.js schema.sql ./
# /data holds gallery.db and the nightly VACUUM INTO copy under backup/.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
ENV NODE_ENV=production PORT=3000 NODE_NO_WARNINGS=1
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
