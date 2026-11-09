# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- run ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg: converte os áudios gravados no Chats ao vivo para mensagem de voz do WhatsApp (Ogg/Opus)
RUN apk add --no-cache ffmpeg
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
EXPOSE 4000
# Aplica as migrations e sobe a API (o worker de disparo roda no mesmo processo).
# `exec`: o Node vira o processo principal e recebe o SIGTERM do deploy — assim ele fecha as sessões do
# WhatsApp por QR Code com calma e a versão nova assume na hora (sem isso, o sh engolia o sinal).
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]
