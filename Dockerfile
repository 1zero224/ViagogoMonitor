FROM node:20-bullseye-slim

# Inštalácia Chromium, Xvfb, xauth, procps a potrebných závislostí
# - xvfb: virtuálny framebuffer pre puppeteer-real-browser na Linuxe
# - xauth: vyžaduje ho wrapper xvfb-run pri štarte
# - procps: poskytuje príkaz "ps", ktorý knižnica potrebuje na správu procesov
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    ca-certificates \
    xvfb \
    xauth \
    procps \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Nastavenie environment premenných pre Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Vytvorenie pracovného adresára
WORKDIR /app

# Kopírovanie package files
COPY package*.json ./

# Inštalácia Node.js závislostí
RUN npm ci --only=production && npm cache clean --force

# Kopírovanie zdrojového kódu
COPY . .

# Vytvorenie non-root usera pre bezpečnosť
RUN groupadd -r botuser && useradd -r -g botuser -G audio,video botuser \
    && mkdir -p /home/botuser/Downloads \
    && chown -R botuser:botuser /home/botuser \
    && chown -R botuser:botuser /app

# Prepnutie na non-root usera
USER botuser

# Spustenie aplikácie s Xvfb (virtuálny displej pre headless browser)
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1920x1080x24", "node", "index.js"]
