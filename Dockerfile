# Minimal production image for the load balancer.
FROM node:22-alpine

WORKDIR /app

# Install only production dependencies for a smaller image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY mock_servers ./mock_servers
COPY routes.json routes.docker.json ./

# Data plane :8080, control plane :8090 (and :9100 for cluster metrics).
EXPOSE 8080 8090

# Drop root.
USER node

CMD ["node", "src/server.js"]
