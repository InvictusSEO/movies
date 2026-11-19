FROM mcr.microsoft.com/playwright:v1.64.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
EXPOSE 3001

CMD ["sh", "-c", "npm start & (if [ \"$DEEP_VISIT_HEADFUL\" = \"1\" ]; then exec xvfb-run -a --server-args='-screen 0 1366x768x24' node deep-visit.js; else exec node deep-visit.js; fi) & wait"]
