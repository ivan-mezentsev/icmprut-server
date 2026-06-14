# Multi-stage build for icmprut-server (React SPA + Node API).
#
# Stage 1 installs dependencies and builds the SPA into dist/.
# Stage 2 ships only what the runtime needs: node_modules, dist/ and server/.

FROM node:26-slim AS build

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html ./
COPY vite.config.js ./
COPY public ./public
COPY src ./src

RUN npm run build

FROM node:26-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server

EXPOSE 3089
CMD ["npm", "run", "start"]
