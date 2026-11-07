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
- message: {"text":"..."}
- media: {"mediaType":"image"|"video"|"audio"|"document","url":"","caption":"..."}
- menu: {"text":"...","options":[{"id":"o1","title":"até 20 caracteres"}]} — saídas: o id de cada opção e "fallback".
- ask: {"text":"pergunta","saveAs":"nome_variavel","validation":"any"|"email"|"number"|"phone"} — saída padrão null.
- condition: {"field":"lastMessage"|"var","varName":"...","op":"contains"|"equals"|"not_empty"|"greater_than","value":"sim, quero"} — saídas "true" e "false".
- delay: {"amount":5,"unit":"minutes"|"hours"|"days"}
- action: {"setStage":"new"|"in_service"|"negotiating"|"won"|"lost","addTags":["Lead quente"]}
- handoff: {"message":"Vou te passar para um atendente!"}
- ai_reply: {"prompt":"instruções para a IA responder o cliente"}
- ai_classify: {"categories":[{"id":"c1","label":"Comprar","description":"quer comprar"}]} — saídas: id de cada categoria e "none".
- payment: {"text":"Segue o link: {{link}}","url":"","wait":true,"timeoutMinutes":60} — com wait=true as saídas são "paid" e "unpaid".

Regras: use "sourceHandle": null para a saída padrão. Use variáveis como {{nome}} e as salvas por "ask" (ex.: {{email}}).
Mensagens em português do Brasil, curtas, amigáveis, com emojis com moderação. Não invente preços ou links.`;

function sanitizeData(type: string, raw: unknown): Dict {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Dict;
  switch (type) {
    case 'trigger': {
      const t = ['any_message', 'keyword', 'first_message'].includes(d.type) ? d.type : 'any_message';
      return { type: t, keywords: str(d.keywords, 300), match: 'contains', reentry: 'always' };
    }
    case 'message': return { text: str(d.text, 4000) };
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
      return { text: str(d.text, 1000), options, style: 'auto', buttonLabel: 'Ver opções' };
    }
    case 'ask': return {
      text: str(d.text, 1000), saveAs: sanitizeVar(d.saveAs),
      validation: ['any', 'email', 'number', 'phone', 'text'].includes(d.validation) ? d.validation : 'any',
    };
    case 'condition': return {
      field: ['lastMessage', 'var', 'name', 'stage', 'tags'].includes(d.field) ? d.field : 'lastMessage',
      varName: sanitizeVar(d.varName), op: str(d.op, 20) || 'contains', value: str(d.value, 300),
    };
    case 'delay': return {
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

export function sanitizeGeneratedGraph(raw: unknown): FlowGraph {
  const g = (raw ?? {}) as Dict;
  const nodes: FlowNode[] = [];
  const idMap = new Map<string, string>();
  for (const n of (Array.isArray(g.nodes) ? g.nodes : []).slice(0, 60)) {
    if (!n || typeof n !== 'object') continue;
    const type = String(n.type);
    if (!(BLOCK_TYPES as readonly string[]).includes(type) || type === 'goto_flow') continue;
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
  field('title');
  switch (n.type) {
    case 'trigger': field('keywords'); break;
    case 'message': field('text'); break;
    case 'media': field('caption'); break;
    case 'menu': field('text'); field('buttonLabel'); field('invalidText'); listField('options', 'title'); break;
    case 'ask': field('text'); field('invalidText'); break;
    case 'condition': field('value'); break;
    case 'handoff': field('message'); break;
    case 'payment': field('text'); break;
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
  }
  return copy;
}
