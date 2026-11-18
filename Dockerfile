FROM mcr.microsoft.com/playwright:v1.64.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
EXPOSE 3001
CMD ["sh", "-c", "npm start & node deep-visit.js & wait"]
