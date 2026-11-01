# Node per l'app, go2rtc per il video HomeKit, ffmpeg per audio, foto e registrazioni.
FROM node:22-alpine AS build
WORKDIR /build
COPY app/package.json app/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY app/src ./src
RUN npx tsc

FROM node:22-alpine
ARG BUILD_ARCH=amd64
ARG GO2RTC_VERSION=1.9.9
RUN apk add --no-cache ffmpeg tzdata \
 && case "$BUILD_ARCH" in aarch64) A=arm64 ;; armv7) A=arm ;; amd64) A=amd64 ;; *) A="$BUILD_ARCH" ;; esac \
 && wget -q -O /usr/local/bin/go2rtc "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_${A}" \
 && chmod +x /usr/local/bin/go2rtc
ENV NODE_ENV=production PORT=18099
WORKDIR /app
COPY app/package.json ./
COPY --from=build /build/dist ./dist
COPY app/public ./public
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]

LABEL io.hass.type="addon" io.hass.version="0.1.1"
