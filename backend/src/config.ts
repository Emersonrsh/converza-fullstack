import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Variável de ambiente ausente: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  env: process.env.NODE_ENV ?? 'development',
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: required('DATABASE_URL', 'postgres://converza:converza@localhost:5432/converza'),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: required('JWT_SECRET', 'dev-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
  whatsapp: {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? 'converza-verify',
    graphVersion: process.env.GRAPH_API_VERSION ?? 'v21.0',
    // Credenciais do operador (Tech Provider) para o Embedded Signup
    appId: process.env.META_APP_ID ?? '',
    appSecret: process.env.META_APP_SECRET ?? '',
    configId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID ?? '',
  },
  ai: {
    // Chave do operador para a execução dos agentes (OpenAI-compatível).
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  },
} as const;
