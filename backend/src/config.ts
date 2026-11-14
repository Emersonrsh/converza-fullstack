import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Variável de ambiente ausente: ${name}`);
  return v;
}

/** Segredos de exemplo (do .env.example e do código): em produção, não servem. */
const WEAK_SECRETS = new Set(['dev-secret-change-me', 'troque-isto-por-um-segredo-forte', 'secret', 'changeme', 'converza']);

/**
 * Chave que assina os logins. Em produção a API não sobe sem uma chave forte: com a chave padrão (que está no
 * código), qualquer pessoa conseguiria criar um login falso e entrar em qualquer conta.
 */
function jwtSecret(): string {
  const v = process.env.JWT_SECRET?.trim();
  if (process.env.NODE_ENV === 'production' && (!v || WEAK_SECRETS.has(v) || v.length < 24)) {
    throw new Error('JWT_SECRET ausente ou fraco. No Render, abra converza-api › Environment e crie a variável JWT_SECRET '
      + 'com pelo menos 32 letras e números aleatórios. Ao trocar, todo mundo precisa entrar de novo.');
  }
  return v || 'dev-secret-change-me';
}

const list = (raw: string | undefined) => (raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const num = (raw: string | undefined, def: number, min: number, max: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw !== '' ? Math.min(max, Math.max(min, n)) : def;
};

export const config = {
  port: Number(process.env.PORT ?? 4000),
  env: process.env.NODE_ENV ?? 'development',
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: required('DATABASE_URL', 'postgres://converza:converza@localhost:5432/converza'),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: jwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
  whatsapp: {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? 'converza-verify',
    // a Meta desliga cada versão ~2 anos depois do lançamento (v24.0 vale até 18/02/2028)
    graphVersion: process.env.GRAPH_API_VERSION ?? 'v24.0',
    graphBase: (process.env.GRAPH_API_BASE ?? 'https://graph.facebook.com').replace(/\/+$/, ''),
    // Credenciais do operador (Tech Provider) para o Embedded Signup
    appId: process.env.META_APP_ID ?? '',
    appSecret: process.env.META_APP_SECRET ?? '',
    configId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID ?? '',
    // true = não confere a assinatura dos webhooks (só para testes; o padrão é conferir quando há META_APP_SECRET)
    skipSignature: process.env.WHATSAPP_SKIP_SIGNATURE === 'true',
  },
  // Facebook: anúncios (Marketing API), login dos perfis e API de Conversões. Usa o mesmo META_APP_ID/SECRET
  // e o mesmo GRAPH_API_BASE do WhatsApp; a versão é própria porque a Marketing API vence mais rápido.
  meta: {
    adsApiVersion: process.env.META_ADS_API_VERSION ?? 'v26.0',
    // Facebook Login for Business (app do tipo Empresa): configuração com ads_read + business_management
    adsLoginConfigId: process.env.META_ADS_CONFIG_ID ?? '',
  },
  // Cobrança: Asaas (Pix e cartão no Brasil) e Paddle (internacional). Sem as chaves, os botões de pagar ficam desligados.
  billing: {
    asaas: {
      apiKey: process.env.ASAAS_API_KEY ?? '',
      // ASAAS_ENV=production usa a conta de verdade; o padrão é o sandbox (testes)
      apiBase: (process.env.ASAAS_API_BASE
        ?? (process.env.ASAAS_ENV === 'production' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3')).replace(/\/+$/, ''),
      // token que você define no webhook da Asaas (vem no header asaas-access-token)
      webhookToken: process.env.ASAAS_WEBHOOK_TOKEN ?? '',
    },
    paddle: {
      apiKey: process.env.PADDLE_API_KEY ?? '',
      environment: process.env.PADDLE_ENV === 'production' ? 'production' : 'sandbox',
      apiBase: (process.env.PADDLE_API_BASE
        ?? (process.env.PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com')).replace(/\/+$/, ''),
      // token do lado do navegador (público por natureza) para abrir o checkout
      clientToken: process.env.PADDLE_CLIENT_TOKEN ?? '',
      webhookSecret: process.env.PADDLE_WEBHOOK_SECRET ?? '',
      // preço mensal da instância cadastrado no catálogo da Paddle (pri_…)
      priceInstance: process.env.PADDLE_PRICE_INSTANCE ?? '',
    },
    // link do suporte (ex.: https://wa.me/5511999999999)
    supportUrl: process.env.SUPPORT_URL ?? process.env.PARTNER_CONTACT_URL ?? '',
  },
  // E-mail (convites e avisos) por SMTP: Resend, Brevo, SendGrid, Gmail, Amazon SES… Sem SMTP_HOST, o app
  // mostra o link do convite para copiar e mandar por outro canal.
  email: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587) || 587,
    // true = conexão TLS direta (porta 465); com false, usa STARTTLS quando o servidor oferece
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.EMAIL_FROM ?? '',
  },
  // equipe de suporte do Converza: e-mails (com conta no app) que podem entrar numa empresa quando ela libera o acesso
  supportEmails: list(process.env.SUPPORT_EMAILS),
  /** donos da plataforma: veem o Painel da plataforma (todas as empresas, receita, suspender, cortesia) */
  platformAdmins: list(process.env.PLATFORM_ADMIN_EMAILS),
  // conta da casa: empresas cujo dono tem um destes e-mails usam tudo sem pagar (e sem descontar tokens de IA)
  house: {
    emails: list(process.env.HOUSE_EMAILS),
    instances: num(process.env.HOUSE_INSTANCES, 10, 1, 500),
  },
  // dados da empresa nas páginas públicas de Termos de Uso, Privacidade e Exclusão de dados
  legal: {
    tradeName: process.env.LEGAL_TRADE_NAME?.trim() || 'Converza',
    companyName: process.env.LEGAL_COMPANY_NAME?.trim() ?? '',
    cnpj: process.env.LEGAL_CNPJ?.trim() ?? '',
    address: process.env.LEGAL_ADDRESS?.trim() ?? '',
    email: process.env.LEGAL_EMAIL?.trim() ?? '',
    dpoName: process.env.LEGAL_DPO_NAME?.trim() ?? '',
    dpoEmail: process.env.LEGAL_DPO_EMAIL?.trim() ?? '',
    city: process.env.LEGAL_CITY?.trim() ?? '',
  },
  // WhatsApp por QR Code (API não oficial: sessão do WhatsApp Web dentro da API)
  waWeb: {
    enabled: process.env.WA_WEB_ENABLED !== 'false',
    // baileys = WhatsApp de verdade | mock = simulador para testes (nunca em produção)
    driver: process.env.WA_WEB_DRIVER === 'mock' && process.env.NODE_ENV !== 'production' ? 'mock' as const : 'baileys' as const,
    // disparos em massa por QR Code: intervalo aleatório entre contatos (segundos) e limite diário por número
    dispatchMinGapSec: num(process.env.WA_WEB_DISPATCH_MIN_GAP, 15, 3, 600),
    dispatchMaxGapSec: num(process.env.WA_WEB_DISPATCH_MAX_GAP, 45, 5, 900),
    dailyLimit: num(process.env.WA_WEB_DAILY_LIMIT, 250, 1, 5000),
    // arquivos recebidos maiores que isso não são baixados (ficam guardados no banco por 31 dias)
    mediaMaxMb: num(process.env.WA_WEB_MEDIA_MAX_MB, 16, 1, 100),
    // nome que aparece em "Aparelhos conectados" no celular
    deviceName: (process.env.WA_WEB_DEVICE_NAME ?? process.env.LEGAL_TRADE_NAME ?? 'Converza').trim().slice(0, 30) || 'Converza',
  },
  // API de Eventos do TikTok (pixel)
  tiktok: {
    apiBase: (process.env.TIKTOK_API_BASE ?? 'https://business-api.tiktok.com').replace(/\/+$/, ''),
  },
  // endereço público da API (ex.: https://converza-api.onrender.com) — usado nas URLs de webhook
  publicApiUrl: (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, ''),
  /** Notificações no celular (Web Push). Gere o par com `npx web-push generate-vapid-keys`. */
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    // contato do remetente exigido pelos serviços de push (mailto: ou https:)
    subject: process.env.VAPID_SUBJECT ?? '',
  },
  // programa de parceiros (banner do dashboard)
  partners: {
    enabled: process.env.PARTNER_PROGRAM_ENABLED !== 'false',
    commissionPercent: Math.min(100, Math.max(0, Number(process.env.PARTNER_COMMISSION_PERCENT ?? 40) || 40)),
    contactUrl: process.env.PARTNER_CONTACT_URL ?? '',
  },
  ai: {
    // Chave do operador para a execução dos agentes (OpenAI-compatível).
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseUrl: (process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    // modelo usado pelos recursos de IA dos fluxos (gerar, traduzir, blocos sem modelo definido)
    defaultModel: process.env.AI_DEFAULT_MODEL ?? 'openai/gpt-4o-mini',
  },
  // Voz (ElevenLabs, chave do operador): clonar vozes, agente responder em áudio e transcrever áudios
  voice: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? '',
    baseUrl: (process.env.ELEVENLABS_API_BASE ?? 'https://api.elevenlabs.io').replace(/\/+$/, ''),
    ttsModel: process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_multilingual_v2',
    sttModel: process.env.ELEVENLABS_STT_MODEL ?? 'scribe_v2',
    // voz "Padrão da plataforma" (uma das vozes prontas da ElevenLabs)
    defaultVoiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb',
    // quanto o áudio gasta do saldo de tokens de IA da conta
    tokensPerChar: Math.max(0, Number(process.env.VOICE_TOKENS_PER_CHAR ?? 2) || 0),
    tokensPerMinute: Math.max(0, Number(process.env.TRANSCRIBE_TOKENS_PER_MINUTE ?? 600) || 0),
  },
} as const;
