# Build from the monorepo root:
#   docker build -f packages/facilitator/Dockerfile -t x402kit/facilitator .
# Run:
#   docker run -v ./facilitator.config.json:/config.json -e PRIVATE_KEY=0x... -p 4021:4021 x402kit/facilitator

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/facilitator/package.json packages/facilitator/
COPY packages/seller/package.json packages/seller/
COPY packages/buyer/package.json packages/buyer/
COPY e2e/package.json e2e/
RUN npm ci --no-fund --no-audit
COPY packages/core packages/core
COPY packages/facilitator packages/facilitator
RUN npm run build -w @x402kit/core -w @x402kit/facilitator \
  && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production FACILITATOR_CONFIG=/config.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/facilitator/package.json packages/facilitator/package.json
COPY --from=build /app/packages/facilitator/dist packages/facilitator/dist
# Drop root — the process needs nothing but a port and a read-only config mount
USER node
EXPOSE 4021
CMD ["node", "packages/facilitator/dist/server.js"]
