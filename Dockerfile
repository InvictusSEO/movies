# Използваме официалния образ, в който вече има Chrome и всички библиотеки
FROM mcr.microsoft.com/playwright:latest

WORKDIR /app

# Копираме файловете и инсталираме Node.js зависимостите
COPY package*.json ./
RUN npm install

# Копираме останалия код
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
