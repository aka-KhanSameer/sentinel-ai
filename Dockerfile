FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY backend ./backend
COPY frontend ./frontend
COPY docs ./docs
COPY datasets ./datasets
COPY scripts ./scripts
COPY tests ./tests
COPY README.md SECURITY.md TASKS.md .env.example ./
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
USER node
CMD ["node", "backend/server.js"]
