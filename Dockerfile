FROM node:22-slim

# tesseract.js needs no system packages, but PDFs and images are memory-hungry,
# so keep the image lean and let the platform set the memory cap.
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Sessions live here. Mount a volume if you want them to survive a redeploy.
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
