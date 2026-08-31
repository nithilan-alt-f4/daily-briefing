FROM node:20-slim

# Install Playwright system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN npx playwright install chromium

COPY . .
RUN mkdir -p downloads

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "server.js"]
