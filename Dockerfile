# Minimal production image for the load balancer.
FROM node:22-alpine

WORKDIR /app

# Install only production dependencies for a smaller image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY mock_servers ./mock_servers
COPY public ./public
COPY routes.json routes.docker.json ./

# Dashboard :3000 (default), proxy data plane :8080, control plane :8090.
EXPOSE 3000 8080 8090

# Drop root.
USER node

# Default to the self-contained live dashboard (binds to $PORT). It's the thing
# you host. The bare proxy is `node src/server.js`; docker-compose overrides this
# command per service.
CMD ["node", "src/dashboard.js"]
