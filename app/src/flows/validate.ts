import { BLOCKS, outputsFor, type BlockType, type Lookups } from './blocks';

export type IssueLevel = 'error' | 'warn';
export interface Issue { nodeId: string; level: IssueLevel; text: string; }

interface N { id: string; type?: string; data: Record<string, any>; }
interface E { source: string; target: string; sourceHandle?: string | null; }

const URL_RE = /^https?:\/\/\S+$/i;
const NO_VALUE_OPS = new Set(['not_empty', 'is_empty', 'is_number']);
const hasTemplate = (s: string) => /\{\{\s*[\w.]+\s*\}\}/.test(s);

/**
 * Procura problemas que fariam o fluxo falhar ou se comportar diferente do
 * esperado com um cliente de verdade. "error" = vai quebrar; "warn" = provável engano.
 */
export function validateFlow(nodes: N[], edges: E[], lk: Lookups): Issue[] {
  const issues: Issue[] = [];
  const add = (nodeId: string, level: IssueLevel, text: string) => issues.push({ nodeId, level, text });
  const incoming = new Set(edges.map((e) => e.target));
  const outKey = new Set(edges.map((e) => `${e.source}|${e.sourceHandle ?? ''}`));
  const name = (n: N) => n.data?.title || BLOCKS[n.type as BlockType]?.label || 'Bloco';

  for (const n of nodes) {
    const d = n.data ?? {};
    const t = n.type as BlockType;
    const nm = `“${name(n)}”`;

    if (t === 'trigger') {
      if (!edges.some((e) => e.source === n.id)) add(n.id, 'warn', 'O Início não está ligado a nenhum bloco — o fluxo não faz nada.');
      if (d.type === 'keyword' && !String(d.keywords ?? '').trim()) add(n.id, 'error', 'Gatilho por palavra-chave sem nenhuma palavra definida.');
      if (d.reentry === 'cooldown' && !(Number(d.cooldownHours) > 0)) add(n.id, 'error', 'Defina o intervalo (em horas) para o contato poder entrar de novo.');
      continue;
    }

    if (!incoming.has(n.id)) add(n.id, 'warn', `${nm} está solto: nenhum bloco leva até ele.`);

    switch (t) {
      case 'message':
        if (!String(d.text ?? '').trim()) add(n.id, 'error', `${nm} está sem texto.`);
        else if (String(d.text).length > 4096) add(n.id, 'error', `${nm} passa de 4.096 caracteres (limite do WhatsApp).`);
        break;
      case 'media': {
        const url = String(d.url ?? '').trim();
        if (!url) add(n.id, 'error', `${nm}: falta o link do arquivo.`);
        else if (!URL_RE.test(url) && !hasTemplate(url)) add(n.id, 'error', `${nm}: o link precisa começar com https://`);
        break;
      }
      case 'menu': {
        const opts: any[] = Array.isArray(d.options) ? d.options : [];
        if (!String(d.text ?? '').trim()) add(n.id, 'error', `${nm} está sem o texto da pergunta.`);
        if (!opts.length) add(n.id, 'error', `${nm} não tem opções.`);
        if (opts.length > 10) add(n.id, 'error', `${nm} tem mais de 10 opções (limite do WhatsApp).`);
        if (opts.some((o) => !String(o.title ?? '').trim())) add(n.id, 'error', `${nm} tem uma opção sem texto.`);
        const titles = opts.map((o) => String(o.title ?? '').trim().toLowerCase()).filter(Boolean);
        if (new Set(titles).size !== titles.length) add(n.id, 'warn', `${nm} tem opções repetidas.`);
        const loose = opts.filter((o) => !outKey.has(`${n.id}|${o.id}`)).length;
        if (opts.length && loose) add(n.id, 'warn', `${nm}: ${loose === 1 ? '1 opção não leva' : `${loose} opções não levam`} a nenhum bloco (o fluxo termina ali).`);
        break;
      }
      case 'ask':
        if (!String(d.text ?? '').trim()) add(n.id, 'error', `${nm} está sem a pergunta.`);
        break;
      case 'condition':
        if (d.field === 'var' && !String(d.varName ?? '').trim()) add(n.id, 'error', `${nm}: escolha qual variável verificar.`);
        if (!NO_VALUE_OPS.has(d.op) && !String(d.value ?? '').trim()) add(n.id, 'warn', `${nm}: o valor para comparar está vazio.`);
        break;
      case 'delay':
        if (!(Number(d.amount) > 0)) add(n.id, 'error', `${nm}: o tempo de espera precisa ser maior que zero.`);
        else if (d.unit === 'days' && Number(d.amount) >= 1) add(n.id, 'warn', `${nm}: depois de 24h sem resposta do cliente, o WhatsApp só aceita mensagens de modelo aprovadas — mensagens livres podem não ser entregues.`);
        else if (d.unit === 'hours' && Number(d.amount) >= 24) add(n.id, 'warn', `${nm}: esperas de 24h ou mais podem cair fora da janela de atendimento do WhatsApp.`);
        break;
      case 'action': {
        const nothing = !d.setStage && !(d.addTags ?? []).length && !(d.removeTags ?? []).length && !String(d.setName ?? '').trim();
        if (nothing) add(n.id, 'warn', `${nm} não faz nenhuma ação.`);
        break;
      }
      case 'http': {
        const url = String(d.url ?? '').trim();
        if (!url) add(n.id, 'error', `${nm}: falta a URL da API.`);
        else if (!URL_RE.test(url) && !hasTemplate(url)) add(n.id, 'error', `${nm}: a URL precisa começar com http:// ou https://`);
        if (d.method !== 'GET' && String(d.body ?? '').trim() && !hasTemplate(String(d.body))) {
          try { JSON.parse(String(d.body)); } catch { add(n.id, 'error', `${nm}: o corpo não é um JSON válido.`); }
        }
        break;
      }
      case 'payment': {
        const p = lk.products.find((x) => x.id === d.productId);
        if (d.productId && !p) add(n.id, 'error', `${nm}: o produto escolhido não existe mais.`);
        else if (p && !p.checkoutUrl && !String(d.url ?? '').trim()) add(n.id, 'error', `${nm}: o produto “${p.name}” não tem link de pagamento cadastrado.`);
        else if (!d.productId && !String(d.url ?? '').trim()) add(n.id, 'error', `${nm}: escolha um produto ou informe o link de pagamento.`);
        break;
      }
      case 'ai_reply':
        if (!String(d.prompt ?? '').trim()) add(n.id, 'error', `${nm}: escreva as instruções para a IA.`);
        break;
      case 'ai_classify': {
        const cats: any[] = Array.isArray(d.categories) ? d.categories : [];
        if (cats.length < 2) add(n.id, 'error', `${nm}: crie pelo menos 2 categorias.`);
        if (cats.some((c) => !String(c.label ?? '').trim())) add(n.id, 'error', `${nm} tem uma categoria sem nome.`);
        break;
      }
      case 'goto_flow': {
        const f = lk.flows.find((x) => x.id === d.flowId);
        if (!d.flowId) add(n.id, 'error', `${nm}: escolha o fluxo de destino.`);
        else if (!f) add(n.id, 'error', `${nm}: o fluxo de destino foi excluído.`);
        else if (f.archived || f.status !== 'active') add(n.id, 'warn', `${nm}: o fluxo “${f.name}” não está ativo — o contato não vai entrar nele.`);
        break;
      }
    }

    // saídas obrigatórias que não fazem sentido soltas
    const outs = outputsFor(t, d);
    if (t === 'payment' && d.wait && !outKey.has(`${n.id}|paid`)) add(n.id, 'warn', `${nm}: a saída “Pago” não leva a nenhum bloco.`);
    if (t === 'condition' && !outs.some((o) => outKey.has(`${n.id}|${o.id ?? ''}`))) add(n.id, 'warn', `${nm}: nenhuma das saídas (Sim/Não) está conectada.`);
  }

  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

/** Nível mais grave por bloco, para marcar no canvas. */
export function levelsByNode(issues: Issue[]): Record<string, IssueLevel> {
  const m: Record<string, IssueLevel> = {};
  for (const i of issues) if (m[i.nodeId] !== 'error') m[i.nodeId] = i.level;
  return m;
}
