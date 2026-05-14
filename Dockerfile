FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
# Run as the unprivileged 'node' user that ships with the base image
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
