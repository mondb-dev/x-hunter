FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY index.js ./

ENV NODE_ENV=production
EXPOSE 8081

CMD ["node", "index.js"]
