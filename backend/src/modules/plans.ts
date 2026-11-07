/**
 * Cobrança por instância: cada instância é um número de WhatsApp. O que cada instância libera e os
 * preços ficam aqui (os preços podem ser trocados por variáveis de ambiente, sem mexer no código).
 */

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const PRICING = {
  /** mensalidade por instância */
  instanceBRL: num(process.env.INSTANCE_PRICE_BRL, 127),
  instanceUSD: num(process.env.INSTANCE_PRICE_USD, 25),
  /** tokens de IA: preço de 1.000 tokens (compra avulsa, não vencem) */
  tokensPer1000BRL: num(process.env.TOKEN_PRICE_BRL_PER_1000, 1),
  tokensPer1000USD: num(process.env.TOKEN_PRICE_USD_PER_1000, 0.2),
};

/** O que cada instância contratada libera. */
export const PER_INSTANCE = {
  agents: 2,
  /** contatos em disparos em massa por ciclo */
  dispatches: 1_000,
  /** eventos de webhook de entrada por mês */
  webhookEvents: 10_000,
};

/** Cada conexão (instância) libera esta quantidade de agentes de IA. */
export const AGENTS_PER_CONNECTION = PER_INSTANCE.agents;

export const MAX_INSTANCES = 100;
/** compra de tokens: mínimo (a Asaas não cobra menos de R$ 5,00) e máximo por compra */
export const TOKENS_MIN = 5_000;
export const TOKENS_MAX = 5_000_000;
export const TOKENS_STEP = 1_000;

/** Pacotes de disparos extras (entram no saldo extra; o que sobra continua no próximo ciclo). */
export const DISPATCH_PACKS = [
  { id: 'extra_1k', quantity: 1_000, price: 29.9, priceUSD: 6 },
  { id: 'extra_10k', quantity: 10_000, price: 90, priceUSD: 18 },
] as const;

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Valor de uma compra de tokens. */
export function tokensPrice(tokens: number, currency: 'BRL' | 'USD') {
  return r2((tokens / 1000) * (currency === 'BRL' ? PRICING.tokensPer1000BRL : PRICING.tokensPer1000USD));
}

/** Mensalidade de N instâncias. */
export function monthlyPrice(instances: number, currency: 'BRL' | 'USD' = 'BRL') {
  return r2(instances * (currency === 'BRL' ? PRICING.instanceBRL : PRICING.instanceUSD));
}

/** Contatos em disparos por ciclo (0 = sem assinatura ativa). */
export function dispatchQuotaFor(instances: number | null | undefined, active: boolean): number {
  return active ? Math.max(0, instances ?? 0) * PER_INSTANCE.dispatches : 0;
}

/** Eventos de webhook de entrada por mês (0 = sem assinatura ativa). */
export function webhookQuotaFor(instances: number | null | undefined, active: boolean): number {
  return active ? Math.max(0, instances ?? 0) * PER_INSTANCE.webhookEvents : 0;
}

/** Números de WhatsApp liberados (0 = sem assinatura ativa). */
export function connectionLimitFor(instances: number | null | undefined, active: boolean): number {
  return active ? Math.max(0, instances ?? 0) : 0;
}

/** Agentes de IA liberados (0 = sem assinatura ativa). */
export function agentLimitFor(instances: number | null | undefined, active: boolean): number {
  return active ? Math.max(0, instances ?? 0) * PER_INSTANCE.agents : 0;
}
