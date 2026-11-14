import type { ComponentType } from 'react';

export type Role = 'owner' | 'admin' | 'agent';
export interface SettingsPage {
  slug: string; icon: string; label: string; title: string; desc: string;
  /** só o dono e os administradores veem */
  managers?: boolean;
  load: () => Promise<{ default: ComponentType }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const page = (loader: () => Promise<any>, name: string) => () => loader().then((m) => ({ default: m[name] as ComponentType }));

export const SETTINGS_GROUPS: { label: string; items: SettingsPage[] }[] = [
  {
    label: 'Conta',
    items: [
      { slug: 'empresa', icon: 'building', label: 'Empresa', title: 'Empresa', desc: 'Dados da empresa, setores de atendimento e horários de trabalho.', load: page(() => import('./Company'), 'CompanyPage') },
      { slug: 'equipe', icon: 'users', label: 'Equipe', title: 'Equipe', desc: 'Quem atende na sua empresa: função, setor e convites pendentes.', load: page(() => import('./Team'), 'TeamPage') },
      { slug: 'convites', icon: 'mail', label: 'Convites para Plataforma', title: 'Convites para Plataforma', desc: 'Convide pessoas para criarem uma conta no Converza.', load: page(() => import('./Invites'), 'InvitesPage') },
      { slug: 'notificacoes', icon: 'bell', label: 'Notificações no celular', title: 'Notificações no celular', desc: 'Receba “Venda aprovada” no celular e no computador, como num aplicativo.', load: page(() => import('./Notifications'), 'NotificationsPage') },
      { slug: 'suporte', icon: 'headset', label: 'Acesso de suporte', title: 'Acesso de suporte', desc: 'Libere a equipe de suporte do Converza para entrar na sua conta por um tempo.', managers: true, load: page(() => import('./Support'), 'SupportPage') },
      { slug: 'traducoes', icon: 'translate', label: 'Traduções de fluxo', title: 'Traduções de fluxo', desc: 'Traduza fluxos com IA e veja o histórico (o que foi reservado, gasto e devolvido).', load: page(() => import('./Translations'), 'TranslationsPage') },
      { slug: 'uso-ia', icon: 'sparkles', label: 'Uso da IA', title: 'Uso da IA', desc: 'Onde os tokens de IA foram gastos — conversa por conversa.', managers: true, load: page(() => import('./AiUsage'), 'AiUsagePage') },
    ],
  },
  {
    label: 'Automação',
    items: [
      { slug: 'fluxos-padroes', icon: 'flow', label: 'Fluxos Padrões', title: 'Fluxos Padrões', desc: 'Boas-vindas, fora do horário e resposta padrão de cada número.', load: page(() => import('./DefaultFlows'), 'DefaultFlowsPage') },
      { slug: 'disparos', icon: 'send', label: 'Disparos em massa', title: 'Disparos em massa', desc: 'Cota do ciclo, disparos extras e as regras que valem para todo disparo.', load: page(() => import('./DispatchSettings'), 'DispatchSettingsPage') },
      { slug: 'respostas-rapidas', icon: 'bolt', label: 'Respostas Rápidas', title: 'Respostas Rápidas', desc: 'Atalhos com texto e anexos para responder rápido no Chats ao vivo.', load: page(() => import('./QuickReplies'), 'QuickRepliesPage') },
      { slug: 'templates', icon: 'file', label: 'Templates WhatsApp', title: 'Templates WhatsApp', desc: 'Modelos de mensagem da Meta: para falar com o cliente fora da janela de 24 horas.', load: page(() => import('./Templates'), 'TemplatesPage') },
      { slug: 'variaveis', icon: 'braces', label: 'Variáveis Globais', title: 'Variáveis Globais', desc: 'Valores da empresa para usar em qualquer fluxo como {{g_nome}} — e que os fluxos também podem mudar.', load: page(() => import('./Globals'), 'GlobalsPage') },
      { slug: 'campos', icon: 'list', label: 'Campos Personalizados', title: 'Campos Personalizados', desc: 'Informações extras dos contatos e as variáveis que o sistema já preenche.', load: page(() => import('./Fields'), 'FieldsPage') },
      { slug: 'etiquetas', icon: 'tag', label: 'Etiquetas', title: 'Etiquetas', desc: 'Organize contatos e conversas com etiquetas coloridas.', load: page(() => import('./Tags'), 'TagsPage') },
    ],
  },
  {
    label: 'Integrações',
    items: [
      { slug: 'integracoes', icon: 'plug', label: 'Integrações', title: 'Integrações', desc: 'Tudo o que está conectado à sua conta, num lugar só.', load: page(() => import('./Integrations'), 'IntegrationsPage') },
      { slug: 'trackeamento', icon: 'target', label: 'Trackeamento', title: 'Trackeamento', desc: 'Links rastreáveis para o WhatsApp: cliques, contatos que chegaram e vendas de cada origem.', load: page(() => import('./Tracking'), 'TrackingPage') },
      { slug: 'produtos', icon: 'bag', label: 'Produtos', title: 'Produtos', desc: 'Produtos e links de pagamento usados nos fluxos (blocos Venda aprovada e Pagamento).', load: page(() => import('./Products'), 'ProductsPage') },
      { slug: 'mcp', icon: 'key', label: 'Ferramentas MCP', title: 'Ferramentas MCP', desc: 'Deixe assistentes de IA (Claude, ChatGPT, Cursor, n8n) consultarem e agirem na sua conta com uma chave.', managers: true, load: page(() => import('./Mcp'), 'McpPage') },
    ],
  },
];

export const ALL_PAGES = SETTINGS_GROUPS.flatMap((g) => g.items);
export const LEGACY: Record<string, string> = { conta: 'empresa', equipe: 'equipe', etiquetas: 'etiquetas', produtos: 'produtos', campos: 'campos' };

export function canSee(p: SettingsPage, role: Role | undefined) {
  return !p.managers || role === 'owner' || role === 'admin';
}

/** Título e descrição de uma página (cada página mostra o próprio cabeçalho). */
export function pageInfo(slug: string) {
  return ALL_PAGES.find((p) => p.slug === slug);
}
