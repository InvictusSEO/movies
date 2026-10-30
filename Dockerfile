# Използваме официален Node.js образ
FROM node:20-slim

# Инсталираме Playwright и му казваме сам да свали браузърите и зависимостите
RUN apt-get update && apt-get install -y \
    && npx playwright install --with-deps chromium

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
