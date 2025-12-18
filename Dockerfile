# Imagem oficial do Playwright já inclui Chromium + deps do sistema
# https://playwright.dev/docs/docker
FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm","start"]
