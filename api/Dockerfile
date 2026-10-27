# gallery-api: likes and comments, served by Traefik under gallery.voidtales.win/api/.
# No npm install - the service only uses Node built-ins.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
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
