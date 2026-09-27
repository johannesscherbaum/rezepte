FROM node:20-alpine

RUN apk add --no-cache vips-dev python3 make g++

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --production

COPY backend/ ./
COPY frontend/ ./frontend/

RUN mkdir -p /data/images /tmp/uploads

EXPOSE 3000

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV IMAGE_DIR=/data/images

CMD ["node", "server.js"]
