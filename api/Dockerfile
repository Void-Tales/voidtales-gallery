# gallery-api: likes and comments, served by Traefik under gallery.voidtales.win/api/.
# No npm install - the service only uses Node built-ins.
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
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
