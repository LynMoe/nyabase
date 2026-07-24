FROM node:22-alpine

WORKDIR /opt/nyabase-e2e-target
COPY e2e/images/proxy-target/server.mjs ./server.mjs

EXPOSE 8080
CMD ["node", "/opt/nyabase-e2e-target/server.mjs"]
