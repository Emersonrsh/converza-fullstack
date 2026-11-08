/** IA aplicada aos fluxos: gerar a partir de descrição, traduzir e limpar na importação. */
import { BLOCK_TYPES, STAGES, outputsOf, type Dict, type FlowEdge, type FlowGraph, type FlowNode } from './types';
import { sanitizeVar } from './interpreter';

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
export type AiFn = (messages: Msg[], maxTokens: number) => Promise<string>;

export function extractJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Resposta da IA sem JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const rid = () => Math.random().toString(36).slice(2, 7);
const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const safeId = (v: unknown) => String(v ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30);

/* ------------------------------------------------------------ gerar fluxo */

export const GENERATE_SYSTEM = `Você é especialista em automação de atendimento e vendas pelo WhatsApp.
Crie um fluxo para o Converza e responda SOMENTE com JSON no formato:
{"nodes":[{"id":"trigger","type":"trigger","data":{...}}, ...],"edges":[{"source":"id","target":"id","sourceHandle":null}]}

Blocos disponíveis (campo "type") e seus "data":
- trigger: {"type":"any_message"|"keyword"|"first_message","keywords":"preço, valor"} — sempre exatamente um, com id "trigger".
- message: {"items":[{"id":"i1","type":"text","text":"..."},{"id":"i2","type":"interval","amount":3,"unit":"seconds"}]} — mensagens em sequência; "interval" é uma pausa entre elas.
- menu: {"text":"...","style":"buttons"|"list","options":[{"id":"o1","title":"até 20 caracteres"}],"expireAmount":0,"expireUnit":"days"} — saídas: o id de cada opção e "fallback" (respondeu outra coisa).
- ask: {"text":"pergunta","saveAs":"nome_variavel","timeoutAmount":1,"timeoutUnit":"days"} — espera a resposta; saídas: null (respondeu) e "timeout" (não respondeu).
- condition: {"logic":"all"|"any","rules":[{"id":"r1","field":"lastMessage"|"var","varName":"...","op":"contains"|"equals"|"not_empty"|"greater_than","value":"sim, quero"}]} — saídas "true" e "false".
- delay: {"mode":"interval","amount":5,"unit":"minutes"|"hours"|"days"}
- tags: {"mode":"add"|"remove","tags":["Lead quente"]}
- chat_status: {"status":"pending"} — passa a conversa para um atendente humano (fica em Aguardando).
- ai: {"prompt":"comportamento da IA","send":true,"conditions":[{"id":"c1","label":"Quer comprar","description":"pergunta preço"}]} — a IA responde o cliente; saídas: id de cada condição, null (resposta normal) e "error".
- distributor: {"mode":"sticky","outputs":[{"id":"s1","label":"Vendedor 1"},{"id":"s2","label":"Vendedor 2"}]} — divide os contatos igualmente entre as saídas.
- set_var: {"name":"pontos","op":"set"|"add"|"subtract"|"append","value":"1"}

Regras: use "sourceHandle": null para a saída padrão. Use variáveis como {{nome}}, {{primeiro_nome}} e as salvas por "ask" (ex.: {{email}}).
Mensagens em português do Brasil, curtas, amigáveis, com emojis com moderação. Não invente preços ou links.`;

function sanitizeData(type: string, raw: unknown): Dict {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Dict;
  switch (type) {
    case 'trigger': {
      const t = ['any_message', 'keyword', 'first_message'].includes(d.type) ? d.type : 'any_message';
      return { type: t, keywords: str(d.keywords, 300), match: 'contains', reentry: 'always' };
    }
    case 'message': {
      const raw = Array.isArray(d.items) ? d.items : [{ type: 'text', text: d.text }];
      const items = raw.slice(0, 15).map((it: Dict) => (it?.type === 'interval'
        ? { id: `it_${rid()}`, type: 'interval', amount: Math.min(60, Math.max(1, Math.round(Number(it.amount ?? 3)) || 3)), unit: 'seconds' }
        : { id: `it_${rid()}`, type: 'text', text: str(it?.text, 4000) }))
        .filter((it: Dict) => it.type !== 'text' || it.text.trim());
      return { items: items.length ? items : [{ id: `it_${rid()}`, type: 'text', text: 'Olá! 👋' }] };
    }
    case 'media': return {
      mediaType: ['image', 'video', 'audio', 'document'].includes(d.mediaType) ? d.mediaType : 'image',
      url: str(d.url, 1000), caption: str(d.caption, 1000),
    };
    case 'menu': {
      const used = new Set<string>();
      const options = (Array.isArray(d.options) ? d.options : []).slice(0, 10).map((o: Dict) => {
        let id = safeId(o?.id) || `opt_${rid()}`;
        if (used.has(id)) id = `opt_${rid()}`;
        used.add(id);
        return { id, title: str(o?.title, 24) || 'Opção' };
      });
      return {
        text: str(d.text, 1000), options, style: d.style === 'list' || options.length > 3 ? 'list' : 'buttons', buttonLabel: 'Ver opções',
        expireAmount: Math.max(0, Math.round(Number(d.expireAmount ?? 0)) || 0), expireUnit: ['minutes', 'hours', 'days'].includes(d.expireUnit) ? d.expireUnit : 'days', saveAs: '',
      };
    }
    case 'ask': return {
      text: str(d.text, 1000), saveAs: sanitizeVar(d.saveAs),
      validation: ['any', 'email', 'number', 'phone', 'text'].includes(d.validation) ? d.validation : 'any',
      waitForever: false, timeoutAmount: Math.max(1, Math.round(Number(d.timeoutAmount ?? 1)) || 1),
      timeoutUnit: ['minutes', 'hours', 'days'].includes(d.timeoutUnit) ? d.timeoutUnit : 'days',
      buffer: false, bufferSeconds: 5, quote: false, react: false, reactEmoji: '👍',
    };
    case 'condition': {
      const rawRules = Array.isArray(d.rules) ? d.rules : [d];
      const rules = rawRules.slice(0, 10).map((r: Dict) => ({
        id: `r_${rid()}`,
        field: ['lastMessage', 'var', 'name', 'stage', 'tags', 'email', 'phone'].includes(r?.field) ? r.field : 'lastMessage',
        varName: sanitizeVar(r?.varName), op: str(r?.op, 20) || 'contains', value: str(r?.value, 300),
      }));
      return { logic: d.logic === 'any' ? 'any' : 'all', rules };
    }
    case 'delay': return {
      mode: 'interval',
      amount: Math.max(1, Math.round(Number(d.amount ?? 5)) || 5),
      unit: ['seconds', 'minutes', 'hours', 'days'].includes(d.unit) ? d.unit : 'minutes',
    };
    case 'action': return {
      setStage: (STAGES as readonly string[]).includes(d.setStage) ? d.setStage : '',
      addTags: (Array.isArray(d.addTags) ? d.addTags : []).map((t: unknown) => str(t, 40)).filter(Boolean).slice(0, 10),
      removeTags: [],
      kanbanBoardId: '', kanbanColumnId: '', setFields: [],
    };
    case 'handoff': return { message: str(d.message, 1000), assignUserId: '' };
    case 'ai_reply': return { prompt: str(d.prompt, 3000), useHistory: true, send: true };
    case 'ai_classify': {
      const used = new Set<string>();
      const cats = (Array.isArray(d.categories) ? d.categories : []).slice(0, 10).map((c: Dict) => {
        let id = safeId(c?.id) || `cat_${rid()}`;
        if (used.has(id)) id = `cat_${rid()}`;
        used.add(id);
        return { id, label: str(c?.label, 60) || 'Categoria', description: str(c?.description, 200) };
      });
      return { categories: cats, instructions: '' };
    }
    case 'payment': return {
      text: str(d.text, 1000) || 'Segue o link para pagamento: {{link}}', url: str(d.url, 1000),
      productId: '', wait: !!d.wait, timeoutMinutes: Math.max(5, Math.round(Number(d.timeoutMinutes ?? 60)) || 60),
    };
    case 'tags': return {
      mode: d.mode === 'remove' ? 'remove' : 'add',
      tags: (Array.isArray(d.tags) ? d.tags : []).map((t: unknown) => str(t, 40)).filter(Boolean).slice(0, 10),
    };
    case 'chat_status': return { status: ['pending', 'open', 'resolved'].includes(d.status) ? (d.status === 'open' ? 'pending' : d.status) : 'pending', pause: true, assignUserId: '' };
    case 'ai': {
      const used = new Set<string>();
      const conditions = (Array.isArray(d.conditions) ? d.conditions : []).slice(0, 10).map((c: Dict) => {
        let id = safeId(c?.id) || `cond_${rid()}`;
        if (used.has(id)) id = `cond_${rid()}`;
        used.add(id);
        return { id, label: str(c?.label, 60) || 'Condição', description: str(c?.description, 200) };
      });
      return {
        provider: 'converza', model: '', apiKey: '', input: '{{resposta}}', saveAs: '', send: d.send !== false,
        prompt: str(d.prompt, 3000), audio: false, image: false, pdf: false, detectReceipt: false, conditions, keepContext: true, contextSize: 5,
      };
    }
    case 'distributor': {
      const used = new Set<string>();
      const outputs = (Array.isArray(d.outputs) ? d.outputs : []).slice(0, 10).map((o: Dict, i: number) => {
        let id = safeId(o?.id) || `out_${rid()}`;
        if (used.has(id)) id = `out_${rid()}`;
        used.add(id);
        return { id, label: str(o?.label, 40) || `Saída ${i + 1}` };
      });
      return { mode: d.mode === 'next' ? 'next' : 'sticky', outputs: outputs.length >= 2 ? outputs : [{ id: `out_${rid()}`, label: 'Saída 1' }, { id: `out_${rid()}`, label: 'Saída 2' }] };
    }
    case 'set_var': return {
      name: sanitizeVar(d.name), op: ['set', 'add', 'subtract', 'multiply', 'divide', 'append', 'clear'].includes(d.op) ? d.op : 'set', value: str(d.value, 500),
    };
    default: return {};
  }
}

/** Posiciona os blocos em colunas por profundidade a partir do Início. */
export function autoLayout(graph: FlowGraph): void {
  const depth = new Map<string, number>();
  const start = graph.nodes.find((n) => n.type === 'trigger') ?? graph.nodes[0];
  if (!start) return;
  depth.set(start.id, 0);
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of graph.edges.filter((x) => x.source === id)) {
      if (!depth.has(e.target)) {
        depth.set(e.target, (depth.get(id) ?? 0) + 1);
        queue.push(e.target);
      }
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const rows = new Map<number, number>();
  for (const n of graph.nodes) {
    const dpt = depth.get(n.id) ?? maxDepth + 1;
    const row = rows.get(dpt) ?? 0;
    rows.set(dpt, row + 1);
    n.position = { x: 80 + dpt * 320, y: 80 + row * 190 };
  }
}

/** Blocos que a IA pode criar sozinha (os outros precisam de algo da conta: template, pixel, chave Pix…). */
const GENERATABLE = new Set([
  'trigger', 'message', 'menu', 'ask', 'condition', 'delay', 'tags', 'chat_status', 'ai', 'distributor', 'set_var',
  'media', 'action', 'handoff', 'ai_reply', 'ai_classify', 'payment',
]);

export function sanitizeGeneratedGraph(raw: unknown): FlowGraph {
  const g = (raw ?? {}) as Dict;
  const nodes: FlowNode[] = [];
  const idMap = new Map<string, string>();
  for (const n of (Array.isArray(g.nodes) ? g.nodes : []).slice(0, 60)) {
    if (!n || typeof n !== 'object') continue;
    const type = String(n.type);
    if (!(BLOCK_TYPES as readonly string[]).includes(type) || !GENERATABLE.has(type)) continue;
    if (type === 'trigger' && nodes.some((x) => x.type === 'trigger')) continue;
    const id = type === 'trigger' ? 'trigger' : `${type}_${rid()}`;
    idMap.set(String(n.id ?? id), id);
    nodes.push({ id, type, position: { x: 0, y: 0 }, data: sanitizeData(type, n.data) });
  }
  if (!nodes.some((n) => n.type === 'trigger')) {
    nodes.unshift({ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: sanitizeData('trigger', {}) });
  }
  const edges: FlowEdge[] = [];
  for (const e of Array.isArray(g.edges) ? g.edges : []) {
    const s = idMap.get(String(e?.source));
    const t = idMap.get(String(e?.target));
    if (!s || !t || s === t || t === 'trigger') continue;
    const src = nodes.find((n) => n.id === s)!;
    const handles = outputsOf(src);
    let h: string | null = e.sourceHandle ?? e.branch ?? null;
    if (h === 'out' || h === '') h = null;
    if (!handles.includes(h)) {
      if (handles.length === 1) h = handles[0];
      else if (h === null && handles.includes(null)) h = null;
      else continue;
    }
    if (edges.some((x) => x.source === s && x.sourceHandle === h)) continue;
    edges.push({ id: `e_${s}_${h ?? 'out'}_${t}`, source: s, target: t, sourceHandle: h });
  }
  const graph = { nodes, edges };
  autoLayout(graph);
  return graph;
}

/* --------------------------------------------------------------- traduzir */

export const LANGUAGES: Record<string, string> = {
  en: 'inglês', es: 'espanhol', pt: 'português do Brasil', fr: 'francês', it: 'italiano', de: 'alemão',
};

type TextRef = { key: string; get: (n: FlowNode) => string | undefined; set: (n: FlowNode, v: string) => void };

function textRefs(n: FlowNode): TextRef[] {
  const refs: TextRef[] = [];
  const field = (name: string) => refs.push({
    key: `${n.id}::${name}`,
    get: (x) => (typeof x.data[name] === 'string' ? x.data[name] : undefined),
    set: (x, v) => { x.data[name] = v; },
  });
  const listField = (list: string, prop: string) => {
    for (const item of Array.isArray(n.data[list]) ? n.data[list] : []) {
      if (!item?.id) continue;
      refs.push({
        key: `${n.id}::${list}:${item.id}:${prop}`,
        get: (x) => {
          const it = (x.data[list] ?? []).find((i: Dict) => i?.id === item.id);
          return typeof it?.[prop] === 'string' ? it[prop] : undefined;
        },
        set: (x, v) => {
          const it = (x.data[list] ?? []).find((i: Dict) => i?.id === item.id);
          if (it) it[prop] = v;
        },
      });
    }
  };
  /** botões dentro dos cartões do carrossel (lista dentro de lista) */
  const cardButtons = () => {
    for (const card of Array.isArray(n.data.cards) ? n.data.cards : []) {
      for (const b of Array.isArray(card?.buttons) ? card.buttons : []) {
        if (!card?.id || !b?.id) continue;
        const find = (x: FlowNode) => (x.data.cards ?? []).find((c: Dict) => c?.id === card.id)?.buttons?.find((y: Dict) => y?.id === b.id);
        refs.push({
          key: `${n.id}::cards:${card.id}:buttons:${b.id}:title`,
          get: (x) => (typeof find(x)?.title === 'string' ? find(x).title : undefined),
          set: (x, v) => { const it = find(x); if (it) it.title = v; },
        });
      }
    }
  };
  field('title');
  switch (n.type) {
    case 'trigger': field('keywords'); break;
    case 'message': field('text'); listField('items', 'text'); listField('items', 'caption'); break;
    case 'media': field('caption'); break;
    case 'menu': field('text'); field('buttonLabel'); field('invalidText'); listField('options', 'title'); listField('options', 'description'); break;
    case 'carousel': field('text'); listField('cards', 'text'); cardButtons(); break;
    case 'ask': field('text'); field('invalidText'); break;
    case 'condition': field('value'); listField('rules', 'value'); break;
    case 'pix': field('text'); break;
    case 'notify': field('text'); break;
    case 'handoff': field('message'); break;
    case 'payment': field('text'); break;
    case 'ai': field('prompt'); listField('conditions', 'label'); listField('conditions', 'description'); break;
    case 'sale': field('notifyTitle'); field('notifySubtitle'); break;
    case 'ai_reply': field('prompt'); field('fallbackText'); break;
    case 'ai_classify': field('instructions'); listField('categories', 'label'); listField('categories', 'description'); break;
    default: break;
  }
  return refs;
}

const TRANSLATE_BATCH = 40;
const translatePrompt = (languageName: string) =>
  `Traduza os VALORES do JSON para ${languageName}. Mantenha as chaves iguais. Não traduza variáveis entre chaves duplas (ex.: {{nome}}, {{link}}). Preserve emojis, quebras de linha e o tom. Em listas separadas por vírgula, traduza cada item e mantenha as vírgulas. Responda SOMENTE com o JSON.`;

function collectTexts(graph: FlowGraph) {
  const all: { node: FlowNode; ref: TextRef; value: string }[] = [];
  for (const n of graph.nodes) {
    for (const ref of textRefs(n)) {
      const v = ref.get(n);
      if (v && v.trim()) all.push({ node: n, ref, value: v });
    }
  }
  return all;
}

function batchInput(batch: { value: string }[]): Dict {
  const input: Dict = {};
  batch.forEach((b, j) => { input[`t${j}`] = b.value; });
  return input;
}

/**
 * Quanto a tradução deve gastar, antes de começar (para reservar o saldo).
 * Conta o pedido (instrução + textos) e a resposta (os textos traduzidos, que costumam
 * crescer até ~30% em outras línguas), com uma folga. O que sobrar volta para o saldo.
 */
export function estimateTranslation(graph: FlowGraph, languageName = 'inglês'): { texts: number; batches: number; tokens: number } {
  const all = collectTexts(graph);
  let chars = 0;
  for (let i = 0; i < all.length; i += TRANSLATE_BATCH) {
    const json = JSON.stringify(batchInput(all.slice(i, i + TRANSLATE_BATCH))).length;
    chars += translatePrompt(languageName).length + json + json * 1.3 + 40;
  }
  const batches = Math.ceil(all.length / TRANSLATE_BATCH);
  return { texts: all.length, batches, tokens: all.length ? Math.ceil((chars / 3.2) * 1.15) + 30 * batches : 0 };
}

export async function translateGraph(graph: FlowGraph, languageName: string, ai: AiFn): Promise<FlowGraph> {
  const copy: FlowGraph = JSON.parse(JSON.stringify(graph));
  const all = collectTexts(copy);
  for (let i = 0; i < all.length; i += TRANSLATE_BATCH) {
    const batch = all.slice(i, i + TRANSLATE_BATCH);
    const out = await ai([
      { role: 'system', content: translatePrompt(languageName) },
      { role: 'user', content: JSON.stringify(batchInput(batch)) },
    ], 4000);
    let parsed: Dict;
    try { parsed = extractJson(out); } catch { throw new Error('A IA não retornou uma tradução válida. Tente novamente.'); }
    batch.forEach((b, j) => {
      const v = parsed[`t${j}`];
      if (typeof v === 'string' && v.trim()) b.ref.set(b.node, v);
    });
  }
  return copy;
}

/* --------------------------------------------------------------- importar */

/** Remove referências da conta de origem e segredos antes de copiar para outra conta. */
export function stripForImport(graph: FlowGraph): FlowGraph {
  const copy: FlowGraph = JSON.parse(JSON.stringify(graph));
  for (const n of copy.nodes) {
    const d = n.data;
    if (n.type === 'trigger') { d.connectionId = ''; d.webhookId = ''; }
    if (n.type === 'goto_flow') d.flowId = '';
    if (n.type === 'handoff') d.assignUserId = '';
    if (n.type === 'action') { d.kanbanBoardId = ''; d.kanbanColumnId = ''; }
    if (n.type === 'payment') d.productId = '';
    if (n.type === 'http' && Array.isArray(d.headers)) {
      d.headers = d.headers.map((h: Dict) => ({ key: String(h?.key ?? ''), value: '' }));
    }
    // Integração: os valores dos cabeçalhos (tokens) não vão junto
    if (n.type === 'http' && typeof d.headersJson === 'string' && d.headersJson.trim()) {
      try {
        const h = JSON.parse(d.headersJson);
        d.headersJson = JSON.stringify(Object.fromEntries(Object.keys(h && typeof h === 'object' ? h : {}).map((k) => [k, ''])), null, 2);
      } catch { d.headersJson = '{}'; }
    }
    // chave da IA: só fica se for uma variável global (ela não guarda o segredo)
    if (n.type === 'ai' && !/^\s*\{\{\s*g_[\w]+\s*\}\}\s*$/i.test(String(d.apiKey ?? ''))) d.apiKey = '';
    if (n.type === 'template') { d.name = ''; d.connectionId = ''; d.buttons = []; d.bodyVars = []; d.vars = {}; d.bodyText = ''; }
    if (n.type === 'pixel') d.pixelId = '';
    if (n.type === 'department') d.departmentId = '';
    if (n.type === 'ai_agent') d.agentId = '';
    if (n.type === 'kanban') { d.boardId = ''; d.columnId = ''; }
    if (n.type === 'sale') d.productId = '';
    if (n.type === 'chat_status') d.assignUserId = '';
    if (n.type === 'notify') { d.phone = ''; d.templateName = ''; d.templateLanguage = ''; d.templateVarCount = 0; d.templateParam = ''; }
    if (n.type === 'pix') { d.key = ''; d.imageFileId = ''; }
    // arquivos enviados no editor pertencem à conta de origem
    if (n.type === 'message' && Array.isArray(d.items)) d.items = d.items.map((it: Dict) => ({ ...it, fileId: '' }));
    if (n.type === 'carousel' && Array.isArray(d.cards)) d.cards = d.cards.map((c: Dict) => ({ ...c, imageFileId: '' }));
  }
  return copy;
}
