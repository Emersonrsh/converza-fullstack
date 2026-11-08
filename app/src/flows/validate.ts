import { BLOCKS, carouselReplyButtons, durationSeconds, outputsFor, type BlockType, type Lookups } from './blocks';

export type IssueLevel = 'error' | 'warn';
export interface Issue { nodeId: string; level: IssueLevel; text: string; }

interface N { id: string; type?: string; data: Record<string, any>; }
interface E { source: string; target: string; sourceHandle?: string | null; }

const URL_RE = /^https?:\/\/\S+$/i;
const VAR_RE = /\{\{\s*[\w.]+\s*\}\}/g;
/** 31 dias: limite das esperas */
const MAX_WAIT = 31 * 86400;
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
      case 'message': {
        const items: any[] = Array.isArray(d.items) ? d.items : d.text !== undefined ? [{ type: 'text', text: d.text }] : [];
        if (!items.length) { add(n.id, 'error', `${nm} está sem conteúdo.`); break; }
        items.forEach((it, i) => {
          const pos = items.length > 1 ? ` (conteúdo ${i + 1})` : '';
          if (it.type === 'text') {
            if (!String(it.text ?? '').trim()) add(n.id, 'warn', `${nm}${pos}: texto vazio (não é enviado).`);
            else if (String(it.text).length > 4096) add(n.id, 'error', `${nm}${pos} passa de 4.096 caracteres (limite do WhatsApp).`);
          } else if (it.type === 'contact') {
            if (!String(it.name ?? '').trim() || !String(it.phone ?? '').trim()) add(n.id, 'error', `${nm}${pos}: o contato precisa de nome e telefone.`);
          } else if (it.type === 'interval') {
            if (i === items.length - 1) add(n.id, 'warn', `${nm}: o intervalo no fim do bloco não faz nada (use o Intervalo Inteligente para esperar antes do próximo bloco).`);
          } else {
            const url = String(it.url ?? '').trim();
            if (!url && !it.fileId) add(n.id, 'error', `${nm}${pos}: falta o arquivo ou o link.`);
            else if (url && !it.fileId && !URL_RE.test(url) && !hasTemplate(url)) add(n.id, 'error', `${nm}${pos}: o link precisa começar com https://`);
            if (String(it.caption ?? '').length > 1024) add(n.id, 'error', `${nm}${pos}: a legenda passa de 1.024 caracteres.`);
          }
        });
        break;
      }
      case 'template': {
        if (!d.name) { add(n.id, 'error', `${nm}: escolha um template aprovado.`); break; }
        if (d.connectionId && lk.wabas.length && !lk.wabas.some((w) => w.id === d.connectionId)) add(n.id, 'error', `${nm}: a conexão do template não existe mais.`);
        if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(d.headerFormat)) && !String(d.headerMediaUrl ?? '').trim()) add(n.id, 'error', `${nm}: falta o link da mídia do cabeçalho (a Meta exige).`);
        const vals = d.vars && typeof d.vars === 'object' ? d.vars : {};
        const empty = (Array.isArray(d.bodyVars) ? d.bodyVars : []).filter((v: string) => !String(vals[v] ?? '').trim());
        if (empty.length) add(n.id, 'warn', `${nm}: ${empty.length === 1 ? 'uma variável do template está vazia' : `${empty.length} variáveis do template estão vazias`} (vai “-”).`);
        if (durationSeconds(d.timeoutAmount, d.timeoutUnit) > MAX_WAIT) add(n.id, 'error', `${nm}: a espera passa de 31 dias.`);
        break;
      }
      case 'tags':
        if (!(Array.isArray(d.tags) ? d.tags : []).length) add(n.id, 'error', `${nm}: escolha pelo menos uma etiqueta.`);
        break;
      case 'pix': {
        const key = String(d.key ?? '').trim();
        if (!key) add(n.id, 'error', `${nm}: falta a chave Pix.`);
        else if (!hasTemplate(key)) {
          const digits = key.replace(/\D/g, '');
          const bad = d.keyType === 'cpf' ? digits.length !== 11 : d.keyType === 'cnpj' ? digits.length !== 14
            : d.keyType === 'email' ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key) : d.keyType === 'phone' ? digits.length < 10 || digits.length > 13
            : !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
          if (bad) add(n.id, 'error', `${nm}: a chave Pix não parece ${({ cpf: 'um CPF', cnpj: 'um CNPJ', email: 'um e-mail', phone: 'um telefone' } as Record<string, string>)[d.keyType] ?? 'uma chave aleatória'} válido(a).`);
        }
        if (!String(d.merchantName ?? '').trim()) add(n.id, 'error', `${nm}: falta o nome de quem recebe.`);
        const amount = String(d.amount ?? '').trim();
        if (!amount) add(n.id, 'error', `${nm}: falta o valor (obrigatório no WhatsApp oficial).`);
        else if (!hasTemplate(amount) && !(Number(amount.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) > 0)) add(n.id, 'error', `${nm}: o valor precisa ser maior que zero.`);
        break;
      }
      case 'carousel': {
        const cards: any[] = Array.isArray(d.cards) ? d.cards : [];
        if (cards.length < 2) add(n.id, 'error', `${nm}: o WhatsApp exige pelo menos 2 cartões.`);
        if (cards.length > 10) add(n.id, 'error', `${nm}: no máximo 10 cartões.`);
        if (cards.some((c) => !String(c.imageUrl ?? '').trim() && !c.imageFileId)) add(n.id, 'error', `${nm}: todo cartão precisa de imagem.`);
        if (cards.some((c) => String(c.text ?? '').length > 160)) add(n.id, 'error', `${nm}: o texto de um cartão passa de 160 caracteres.`);
        const shapes = new Set(cards.map((c) => (c.buttons ?? []).map((b: any) => b.type ?? 'reply').join(',')));
        if (shapes.size > 1) add(n.id, 'error', `${nm}: todos os cartões precisam ter os mesmos botões (tipo e quantidade).`);
        if (cards.some((c) => (c.buttons ?? []).some((b: any) => !String(b.title ?? '').trim()))) add(n.id, 'error', `${nm}: há botão sem texto.`);
        if (cards.some((c) => (c.buttons ?? []).some((b: any) => b.type === 'url' && !String(b.url ?? '').trim()))) add(n.id, 'error', `${nm}: há botão de link sem endereço.`);
        if (durationSeconds(d.expireAmount, d.expireUnit) > MAX_WAIT) add(n.id, 'error', `${nm}: a expiração passa de 31 dias.`);
        const btns = carouselReplyButtons(d);
        const loose = btns.filter((b) => !outKey.has(`${n.id}|${b.id}`)).length;
        if (btns.length && loose === btns.length) add(n.id, 'warn', `${nm}: nenhum botão leva a outro bloco (o fluxo termina ali).`);
        break;
      }
      case 'chat_status':
        if (d.status === 'open') {
          if (!d.assignUserId) add(n.id, 'error', `${nm}: escolha o atendente.`);
          else if (lk.team.length && !lk.team.some((m) => m.userId === d.assignUserId)) add(n.id, 'error', `${nm}: o atendente escolhido não está mais na equipe.`);
        }
        break;
      case 'notify':
        if (!String(d.phone ?? '').trim()) add(n.id, 'error', `${nm}: falta o número que recebe.`);
        if (!String(d.text ?? '').trim()) add(n.id, 'error', `${nm}: falta a mensagem.`);
        if (String(d.phone ?? '').trim() && !d.templateName) add(n.id, 'warn', `${nm}: sem template reserva, a notificação só chega se a pessoa tiver falado com o número nas últimas 24 h.`);
        break;
      case 'distributor':
        if ((Array.isArray(d.outputs) ? d.outputs : []).length < 2) add(n.id, 'error', `${nm}: crie pelo menos 2 saídas.`);
        break;
      case 'pixel': {
        const px = lk.pixels.find((x) => x.id === d.pixelId);
        if (!d.pixelId) add(n.id, 'error', `${nm}: escolha o pixel.`);
        else if (lk.pixels.length && !px) add(n.id, 'error', `${nm}: o pixel escolhido não existe mais.`);
        else if (px) {
          const events = lk.platforms.find((p) => p.id === px.platform)?.events ?? [];
          if (events.length && !events.includes(d.event)) add(n.id, 'error', `${nm}: o evento “${d.event || '?'}” não é aceito por esse pixel.`);
          if (px.status !== 'active') add(n.id, 'warn', `${nm}: o pixel “${px.name}” não está ativo — os eventos não chegam na plataforma.`);
        }
        break;
      }
      case 'department':
        if (d.action !== 'clear') {
          if (!d.departmentId) add(n.id, 'error', `${nm}: escolha o departamento.`);
          else if (lk.departments.length && !lk.departments.some((x) => x.id === d.departmentId)) add(n.id, 'error', `${nm}: o departamento escolhido não existe mais.`);
        }
        break;
      case 'ai': {
        if (d.provider && d.provider !== 'converza') {
          if (!String(d.apiKey ?? '').trim()) add(n.id, 'error', `${nm}: falta a chave da API do provedor.`);
          else {
            const g = /^\{\{\s*(g_[a-z0-9_]+)\s*\}\}$/i.exec(String(d.apiKey).trim());
            if (g && !lk.globals.some((x) => x.key === g[1].toLowerCase())) add(n.id, 'error', `${nm}: a variável global ${g[1]} não existe.`);
          }
          if (!String(d.model ?? '').trim()) add(n.id, 'error', `${nm}: escolha o modelo do provedor.`);
        }
        if (!String(d.prompt ?? '').trim()) add(n.id, 'warn', `${nm}: escreva o prompt (as instruções da IA).`);
        const conds: any[] = Array.isArray(d.conditions) ? d.conditions : [];
        if (conds.some((c) => !String(c.label ?? '').trim())) add(n.id, 'error', `${nm}: há condição inteligente sem nome.`);
        if (conds.length > 10) add(n.id, 'error', `${nm}: no máximo 10 condições inteligentes.`);
        if (d.detectReceipt && !outKey.has(`${n.id}|receipt`)) add(n.id, 'warn', `${nm}: a saída “Comprovante válido” não leva a nenhum bloco.`);
        break;
      }
      case 'ai_agent':
        if (d.action !== 'remove') {
          const a = lk.agents.find((x) => x.id === d.agentId);
          if (!d.agentId) add(n.id, 'error', `${nm}: escolha o agente.`);
          else if (lk.agents.length && !a) add(n.id, 'error', `${nm}: o agente escolhido não existe mais.`);
          else if (a && !a.enabled) add(n.id, 'warn', `${nm}: o agente “${a.name}” está desligado — ele não vai responder.`);
        }
        break;
      case 'kanban': {
        const b = lk.kanban.find((x) => x.id === d.boardId);
        if (!d.boardId) add(n.id, 'error', `${nm}: escolha o Kanban.`);
        else if (lk.kanban.length && !b) add(n.id, 'error', `${nm}: o Kanban escolhido não existe mais.`);
        else if (b && d.action !== 'remove' && d.columnId && !b.columns.some((c) => c.id === d.columnId)) add(n.id, 'error', `${nm}: a coluna escolhida não existe mais.`);
        break;
      }
      case 'set_var': {
        const name = String(d.name ?? '').trim();
        if (!name) add(n.id, 'error', `${nm}: informe o nome da variável.`);
        else if (/^g_/i.test(name) && !lk.globals.some((g) => g.key === name.toLowerCase())) add(n.id, 'error', `${nm}: a variável global ${name} não existe (crie em Configurações › Variáveis Globais).`);
        if (['add', 'subtract', 'multiply', 'divide'].includes(d.op) && String(d.value ?? '').trim() && !hasTemplate(String(d.value)) && !/^-?[\d.,\s]+$/.test(String(d.value))) add(n.id, 'warn', `${nm}: “${d.value}” não é um número.`);
        break;
      }
      case 'sale': {
        if (d.productId && lk.products.length && !lk.products.some((p) => p.id === d.productId)) add(n.id, 'error', `${nm}: o produto escolhido não existe mais.`);
        if (!d.productId && !String(d.amount ?? '').trim()) add(n.id, 'warn', `${nm}: sem produto e sem valor, a venda é registrada com R$ 0,00.`);
        break;
      }
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
        const maxTitle = d.style === 'buttons' && opts.length <= 3 ? 20 : 24;
        if (opts.some((o) => String(o.title ?? '').length > maxTitle)) add(n.id, 'error', `${nm}: o texto de cada opção pode ter no máximo ${maxTitle} caracteres.`);
        if (d.style !== 'buttons' && String(d.buttonLabel ?? '').length > 20) add(n.id, 'error', `${nm}: o texto do botão da lista passa de 20 caracteres.`);
        if (durationSeconds(d.expireAmount, d.expireUnit) > MAX_WAIT) add(n.id, 'error', `${nm}: a expiração passa de 31 dias.`);
        const titles = opts.map((o) => String(o.title ?? '').trim().toLowerCase()).filter(Boolean);
        if (new Set(titles).size !== titles.length) add(n.id, 'warn', `${nm} tem opções repetidas.`);
        const loose = opts.filter((o) => !outKey.has(`${n.id}|${o.id}`)).length;
        if (opts.length && loose) add(n.id, 'warn', `${nm}: ${loose === 1 ? '1 opção não leva' : `${loose} opções não levam`} a nenhum bloco (o fluxo termina ali).`);
        break;
      }
      case 'ask':
        if (!d.waitForever && d.timeoutAmount !== undefined && durationSeconds(d.timeoutAmount, d.timeoutUnit) > MAX_WAIT) add(n.id, 'error', `${nm}: o tempo máximo de espera passa de 31 dias.`);
        if (!d.waitForever && d.timeoutAmount !== undefined && !(durationSeconds(d.timeoutAmount, d.timeoutUnit) > 0)) add(n.id, 'error', `${nm}: o tempo máximo de espera precisa ser maior que zero.`);
        break;
      case 'condition': {
        const rules: any[] = Array.isArray(d.rules) ? d.rules : d.field !== undefined ? [d] : [];
        if (!rules.length) add(n.id, 'warn', `${nm}: sem condições, sempre segue por “Sim”.`);
        for (const r of rules) {
          if (r.field === 'business_hours') continue;
          if (r.field === 'var' && !String(r.varName ?? '').trim()) add(n.id, 'error', `${nm}: escolha qual variável verificar.`);
          if (r.field === 'field' && !r.fieldKey) add(n.id, 'error', `${nm}: escolha o campo personalizado.`);
          else if (r.field === 'field' && lk.fields.length && !lk.fields.some((f) => f.key === r.fieldKey)) add(n.id, 'error', `${nm}: o campo “${r.fieldKey}” não existe mais.`);
          if (r.field === 'global') {
            if (!r.globalKey) add(n.id, 'error', `${nm}: escolha a variável global.`);
            else if (!lk.globals.some((g) => g.key === r.globalKey)) add(n.id, 'error', `${nm}: a variável global {{${r.globalKey}}} não existe mais.`);
          }
          if (!NO_VALUE_OPS.has(r.op) && !String(r.value ?? '').trim()) add(n.id, 'warn', `${nm}: o valor para comparar está vazio.`);
        }
        break;
      }
      case 'delay': {
        const mode = d.mode ?? 'interval';
        if (mode === 'date') {
          const raw = String(d.date ?? '').trim();
          if (!raw) add(n.id, 'error', `${nm}: escolha a data.`);
          else if (!hasTemplate(raw)) {
            const at = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
            if (!Number.isNaN(at.getTime())) {
              if (at.getTime() < Date.now()) add(n.id, 'warn', `${nm}: essa data já passou — o fluxo segue sem esperar.`);
              else if (at.getTime() - Date.now() > MAX_WAIT * 1000) add(n.id, 'error', `${nm}: a data passa de 31 dias a partir de hoje.`);
            }
          }
        } else if (mode === 'hours') {
          if (!d.useBusinessHours && !(Array.isArray(d.days) && d.days.length)) add(n.id, 'error', `${nm}: escolha pelo menos um dia.`);
          if (!d.useBusinessHours && d.from && d.from === d.to) add(n.id, 'error', `${nm}: o horário de início e de fim são iguais.`);
        } else if (!hasTemplate(String(d.amount ?? ''))) {
          const secs = d.mode === undefined && d.amount === undefined ? Number(d.seconds ?? 60) : durationSeconds(d.amount, d.unit);
          if (!(secs > 0)) add(n.id, 'error', `${nm}: o tempo de espera precisa ser maior que zero.`);
          else if (secs > MAX_WAIT) add(n.id, 'error', `${nm}: a espera passa de 31 dias.`);
          else if (secs >= 86400) add(n.id, 'warn', `${nm}: depois de 24 h sem resposta do cliente, o WhatsApp só aceita templates aprovados — mensagens livres podem não ser entregues.`);
        }
        break;
      }
      case 'action': {
        const sf = (Array.isArray(d.setFields) ? d.setFields : []) as { key?: string; value?: string }[];
        const sg = (Array.isArray(d.setGlobals) ? d.setGlobals : []) as { key?: string; op?: string; value?: string }[];
        const nothing = !d.setStage && !(d.addTags ?? []).length && !(d.removeTags ?? []).length && !String(d.setName ?? '').trim() && !d.kanbanBoardId && !sf.length && !sg.length;
        for (const g of sg) {
          if (!g.key) add(n.id, 'error', `${nm}: escolha a variável global.`);
          else if (!lk.globals.some((x) => x.key === g.key)) add(n.id, 'error', `${nm}: a variável global {{${g.key}}} não existe mais.`);
          else if ((g.op === 'add' || g.op === 'subtract') && lk.globals.find((x) => x.key === g.key)?.type !== 'number') add(n.id, 'error', `${nm}: só dá para somar ou subtrair numa variável do tipo número ({{${g.key}}} é texto).`);
        }
        for (const f of sf) {
          if (!f.key) add(n.id, 'error', `${nm}: escolha o campo do contato a salvar.`);
          else if (!lk.fields.some((x) => x.key === f.key)) add(n.id, 'error', `${nm}: o campo “${f.key}” não existe mais.`);
          else if (!String(f.value ?? '').trim()) add(n.id, 'warn', `${nm}: o valor do campo “${lk.fields.find((x) => x.key === f.key)?.label}” está vazio (vai apagar o campo).`);
        }
        if (nothing) add(n.id, 'warn', `${nm} não faz nenhuma ação.`);
        if (d.kanbanBoardId) {
          const b = lk.kanban.find((x) => x.id === d.kanbanBoardId);
          if (!b) add(n.id, 'error', `${nm}: o quadro do Kanban escolhido não existe mais.`);
          else if (!d.kanbanColumnId) add(n.id, 'error', `${nm}: escolha a coluna do Kanban.`);
          else if (!b.columns.some((c) => c.id === d.kanbanColumnId)) add(n.id, 'error', `${nm}: a coluna do Kanban escolhida não existe mais.`);
        }
        break;
      }
      case 'handoff':
        if (!d.assignUserId && d.departmentId && lk.departments.length && !lk.departments.some((x) => x.id === d.departmentId)) add(n.id, 'error', `${nm}: o setor escolhido não existe mais.`);
        break;
      case 'http': {
        const url = String(d.url ?? '').trim();
        if (!url) add(n.id, 'error', `${nm}: falta a URL da API.`);
        else if (!URL_RE.test(url) && !hasTemplate(url)) add(n.id, 'error', `${nm}: a URL precisa começar com http:// ou https://`);
        if (typeof d.headersJson === 'string' && d.headersJson.trim()) {
          try {
            const h = JSON.parse(d.headersJson.replace(VAR_RE, '0'));
            if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error('x');
          } catch { add(n.id, 'error', `${nm}: os cabeçalhos não são um objeto JSON válido.`); }
        }
        const ctype = (() => { try { return String(Object.entries(JSON.parse(String(d.headersJson ?? '{}').replace(VAR_RE, '0')) ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''); } catch { return ''; } })();
        if (d.method !== 'GET' && String(d.body ?? '').trim() && (!ctype || /json/i.test(ctype))) {
          try { JSON.parse(String(d.body).replace(VAR_RE, '0')); } catch { add(n.id, 'error', `${nm}: o corpo não é um JSON válido.`); }
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
    if (t === 'distributor' && outs.length >= 2) {
      const loose = outs.filter((o) => !outKey.has(`${n.id}|${o.id ?? ''}`)).length;
      if (loose) add(n.id, 'warn', `${nm}: ${loose === 1 ? '1 saída não leva' : `${loose} saídas não levam`} a nenhum bloco (quem cair nela termina o fluxo).`);
    }
  }

  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

/** Nível mais grave por bloco, para marcar no canvas. */
export function levelsByNode(issues: Issue[]): Record<string, IssueLevel> {
  const m: Record<string, IssueLevel> = {};
  for (const i of issues) if (m[i.nodeId] !== 'error') m[i.nodeId] = i.level;
  return m;
}
