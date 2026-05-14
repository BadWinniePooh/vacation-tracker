FROM node:22-alpine
# Upgrade all Alpine packages to their latest patched versions to eliminate
# known OS-level CVEs that have available fixes (keeps trivy --ignore-unfixed clean).
RUN apk upgrade --no-cache
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
# Run as the unprivileged 'node' user that ships with the base image
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
