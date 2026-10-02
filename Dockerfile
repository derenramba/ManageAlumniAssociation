# Container image for hosts such as Railway, Fly.io or any VPS.
# Mount a persistent volume at /data — the election database and photos are stored there.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 TRUST_PROXY=true SECURE_COOKIES=true
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
