FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY vdoninja_advanced.js ./

ENV NODE_ENV=production PORT=8080
USER 10001:10001
EXPOSE 8080
CMD ["node", "vdoninja_advanced.js"]
