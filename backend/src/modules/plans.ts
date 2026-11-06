export interface Plan { id: string; name: string; price: number; aiTokens: number; features: string[]; }

export const PLANS: Plan[] = [
  { id: 'starter', name: 'Starter', price: 97, aiTokens: 1000, features: ['1 conexão', '2 atendentes', 'Fluxos ilimitados', '1.000 tokens de IA/mês'] },
  { id: 'growth', name: 'Growth', price: 297, aiTokens: 10000, features: ['3 conexões', '8 atendentes', 'Agentes de IA', 'Disparos em massa', '10.000 tokens de IA/mês'] },
  { id: 'scale', name: 'Scale', price: 697, aiTokens: 50000, features: ['Conexões ilimitadas', 'Atendentes ilimitados', 'API e webhooks', 'Gerente dedicado', '50.000 tokens de IA/mês'] },
];

export const tokensForPlan = (plan: string | null | undefined): number =>
  PLANS.find((p) => p.id === plan)?.aiTokens ?? 0;
