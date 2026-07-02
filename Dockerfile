FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY db.js index.js ./

ENV NODE_ENV=production
ENV PORT=3847
ENV DATA_DIR=/data

RUN mkdir -p /data
VOLUME /data

EXPOSE 3847

CMD ["node", "index.js"]
