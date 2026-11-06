# Converza — Frontend

App web em React + TypeScript + Vite que consome a API do backend. Inclui login/registro, multi-conta, e todas as telas: dashboard, caixa de entrada em tempo real, contatos, funil, fluxos, agentes de IA, disparos, conexões, webhooks, Meta Ads, equipe, assinatura e configurações.

## Rodar

```bash
npm install
cp .env.example .env    # VITE_API_URL e VITE_SOCKET_URL apontando para o backend
npm run dev             # http://localhost:5173
```

O backend precisa estar rodando (veja `../backend`). O tempo real usa Socket.IO; o token e a conta ativa são enviados no handshake.

## Scripts

- `npm run dev` — servidor de desenvolvimento
- `npm run build` — typecheck + build de produção em `dist/`
- `npm run preview` — serve o build
- `npm run typecheck` — só o checador de tipos

## Estrutura

- `src/api.ts` — cliente HTTP (injeta `Authorization` e `x-account-id`)
- `src/auth.tsx` — contexto de autenticação e sessão
- `src/socket.ts` — conexão Socket.IO
- `src/components/` — layout, UI e gráficos
- `src/pages/` — uma tela por módulo
