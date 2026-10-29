# Home Assistant passa BUILD_FROM, ma usiamo direttamente l'immagine Node ufficiale (multi-architettura).
# Nessuna dipendenza a runtime: il server usa solo moduli integrati di Node (http, sqlite, WebSocket).
FROM node:22-alpine AS build
WORKDIR /build
COPY app/package.json app/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY app/src ./src
RUN npx tsc

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY app/package.json ./
COPY --from=build /build/dist ./dist
COPY app/public ./public
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]

LABEL io.hass.type="addon" io.hass.version="0.5.3"
