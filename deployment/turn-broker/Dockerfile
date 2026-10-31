FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app
COPY server.js access-manager.js ./
COPY login.html production-access.html ./

ENV NODE_ENV=production PORT=8080
USER 10001:10001
EXPOSE 8080
CMD ["node", "server.js"]
