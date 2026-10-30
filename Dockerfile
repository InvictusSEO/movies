# Използваме официален Playwright образ, който поддържа ARM64
FROM mcr.microsoft.com/playwright:v1.64.1-jammy

# Създаваме папка за приложението
WORKDIR /app

# Копираме package.json и инсталираме зависимостите
COPY package*.json ./
RUN npm install

# Копираме останалите файлове
COPY . .

# Отваряме порт 3000
EXPOSE 3000

# Стартираме сървъра
CMD ["npm", "start"]
