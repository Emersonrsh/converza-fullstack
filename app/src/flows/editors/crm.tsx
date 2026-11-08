import { useState } from 'react';
import { Icon } from '../../icons';
import { cx, toast } from '../../components/ui';
import { api, money } from '../../api';
import { Field, HowItWorks, Picker, Section, SideSwitch, Tabs, TagInput, ToggleCard, VarInput } from './fields';
import type { EditorProps } from './types';

/* ------------------------------------------------------------------ Etiquetas */

export function TagsEditor({ d, set, lookups, setLookups }: EditorProps) {
  const tags: string[] = Array.isArray(d.tags) ? d.tags : [];
  const add = d.mode !== 'remove';
  return (
    <>
      <SideSwitch left="Remover etiquetas" right="Adicionar etiquetas" value={add} onChange={(v) => set({ mode: v ? 'add' : 'remove' })} testId="tags-mode" />
      <Field label={add ? 'Etiquetas para adicionar' : 'Etiquetas para remover'} required hint="Digite para buscar; Enter cria uma etiqueta nova. Pode usar variáveis, ex.: {{interesse}}.">
        <TagInput tags={tags} onChange={(t) => set({ tags: t })} catalog={lookups.tags} testId="tags-input"
          onCreated={(t) => setLookups((l) => ({ ...l, tags: l.tags.some((x) => x.name.toLowerCase() === t.name.toLowerCase()) ? l.tags : [...l.tags, t] }))} />
      </Field>
      <HowItWorks>As etiquetas aparecem na ficha do contato, no Chats ao vivo e servem de filtro em Contatos, Disparos e no Condicional.</HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Controlador de Chat */

const STATUSES: [string, string, string, string][] = [
  ['pending', 'Aguardando', 'clock', 'Vai para a fila “Aguardando” do Chats ao vivo.'],
  ['open', 'Atendimento', 'headset', 'Fica com um atendente da equipe.'],
  ['resolved', 'Resolvidos', 'checkCircle', 'Encerra a conversa (volta a abrir se o cliente escrever).'],
];

export function ChatStatusEditor({ d, set, lookups }: EditorProps) {
  const status = STATUSES.some((s) => s[0] === d.status) ? d.status : 'pending';
  return (
    <>
      <Field label="Status da conversa">
        <div className="bm-cardsel" data-testid="chat-status">
          {STATUSES.map(([v, l, icon, desc]) => (
            <button type="button" key={v} className={cx(status === v && 'on')} onClick={() => set({ status: v })} data-testid={`chat-status-${v}`}>
              <Icon name={icon} size={18} /><b>{l}</b><small>{desc}</small>
            </button>
          ))}
        </div>
      </Field>
      {status === 'open' && (
        <Field label="Atendente" required>
          <Picker value={d.assignUserId ?? ''} options={lookups.team.map((t) => ({ value: t.userId, label: t.name }))} onChange={(assignUserId) => set({ assignUserId })}
            placeholder="Escolha quem vai atender" testId="chat-assignee" empty="Ninguém na equipe" />
        </Field>
      )}
      {status !== 'resolved' && (
        <ToggleCard title="Pausar a automação nesta conversa" desc="Fluxos e agentes de IA param de responder até alguém retomar no Chats ao vivo." checked={d.pause !== false}
          onChange={(pause) => set({ pause })} testId="chat-pause" />
      )}
      <HowItWorks>Muda a conversa de aba no Chats ao vivo. O fluxo continua no próximo bloco normalmente.</HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Departamento */

export function DepartmentEditor({ d, set, lookups, setLookups }: EditorProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const clear = d.action === 'clear';
  async function create() {
    const n = name.trim();
    if (n.length < 2) return;
    setBusy(true);
    try {
      const r = await api.post<{ department: { id: string; name: string; color: string } }>('/departments', { name: n });
      setLookups((l) => ({ ...l, departments: [...l.departments, { id: r.department.id, name: r.department.name, color: r.department.color }] }));
      set({ departmentId: r.department.id });
      setCreating(false); setName('');
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <>
      <Tabs value={clear ? 'clear' : 'set'} options={[['set', 'Colocar no setor'], ['clear', 'Tirar do setor']]} onChange={(v) => set({ action: v })} testId="dept-action" />
      {!clear && (lookups.departments.length || creating ? (
        <Field label="Departamento" required
          right={!creating ? <button type="button" className="linkbtn" onClick={() => setCreating(true)}><Icon name="plus" size={12} />Novo departamento</button> : undefined}>
          {creating ? (
            <div className="bm-inline">
              <input className="input" autoFocus value={name} maxLength={40} placeholder="Ex.: Financeiro" onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }} data-testid="dept-new" />
              <button type="button" className="btn primary" disabled={busy || name.trim().length < 2} onClick={() => void create()}>Criar</button>
              <button type="button" className="btn ghost" onClick={() => setCreating(false)}>Cancelar</button>
            </div>
          ) : (
            <Picker value={d.departmentId ?? ''} options={lookups.departments.map((x) => ({ value: x.id, label: x.name }))} onChange={(departmentId) => set({ departmentId })}
              placeholder="Escolha o departamento" testId="dept-picker" />
          )}
        </Field>
      ) : (
        <div className="bm-emptybox">
          <span className="bm-empty-ic"><Icon name="building" size={22} /></span>
          <b>Nenhum departamento ainda</b>
          <small>Departamentos (setores) separam as conversas por equipe: Vendas, Suporte, Financeiro…</small>
          <button type="button" className="btn sm primary" onClick={() => setCreating(true)} data-testid="dept-create"><Icon name="plus" size={14} />Adicionar departamento</button>
        </div>
      ))}
      <HowItWorks>
        Com a conversa num setor, ela aparece em “Aguardando” só para quem é daquele setor, e quem pegar primeiro atende.
        Gerencie quem faz parte de cada setor em Configurações › Empresa › Departamentos.
      </HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Agente de IA */

export function AiAgentEditor({ d, set, lookups }: EditorProps) {
  const remove = d.action === 'remove';
  const agent = lookups.agents.find((a) => a.id === d.agentId);
  return (
    <>
      <div className="bm-cardsel two" data-testid="agent-action">
        <button type="button" className={cx(!remove && 'on')} onClick={() => set({ action: 'assign' })} data-testid="agent-assign">
          <Icon name="bot" size={18} /><b>Entregar para um agente</b><small>O agente de IA passa a responder o cliente nesta conversa.</small>
        </button>
        <button type="button" className={cx(remove && 'on')} onClick={() => set({ action: 'remove' })} data-testid="agent-remove">
          <Icon name="userArrow" size={18} /><b>Remover agente</b><small>Tira o agente da conversa: ela volta para os fluxos.</small>
        </button>
      </div>
      {!remove && (
        <Field label="Agente" required warn={agent && !agent.enabled ? `“${agent.name}” está desligado em Agentes de IA: ligue para ele responder.` : undefined}
          hint={lookups.agents.length ? undefined : 'Crie um agente em Agentes de IA.'}>
          <Picker value={d.agentId ?? ''} options={lookups.agents.map((a) => ({ value: a.id, label: a.name, hint: a.enabled ? 'ativo' : 'desligado' }))}
            onChange={(agentId) => set({ agentId })} placeholder="Escolha o agente" testId="agent-picker" empty="Nenhum agente criado" />
        </Field>
      )}
      <HowItWorks>
        {remove ? 'Use depois de um atendimento do agente (por exemplo, quando ele dispara este fluxo) para devolver a conversa à automação normal.'
          : 'A partir daqui, as próximas mensagens do cliente vão para o agente (as respostas consomem tokens de IA). Esperas que já estavam abertas neste fluxo continuam valendo.'}
      </HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Kanban */

export function KanbanEditor({ d, set, lookups }: EditorProps) {
  const action = ['add', 'move', 'remove'].includes(d.action) ? d.action : 'add';
  const board = lookups.kanban.find((b) => b.id === d.boardId);
  return (
    <>
      <Field label="Ação">
        <Tabs value={action} options={[['add', 'Adicionar', 'plus'], ['move', 'Mover', 'arrowRight'], ['remove', 'Remover', 'trash']]} onChange={(a) => set({ action: a })} testId="kanban-action" />
      </Field>
      <div className="bm-row2">
        <Field label="Kanban" required hint={lookups.kanban.length ? undefined : 'Crie um quadro em Kanban.'}>
          <Picker value={d.boardId ?? ''} options={lookups.kanban.map((b) => ({ value: b.id, label: b.name, hint: `${b.columns.length} colunas` }))}
            onChange={(boardId) => set({ boardId, columnId: lookups.kanban.find((b) => b.id === boardId)?.columns[0]?.id ?? '' })} placeholder="Escolha o quadro" testId="kanban-board" />
        </Field>
        {action !== 'remove' && (
          <Field label="Coluna" required>
            <select className="select" value={d.columnId ?? ''} disabled={!board} onChange={(e) => set({ columnId: e.target.value })} data-testid="kanban-column">
              <option value="">{board ? 'Escolha a coluna' : 'Escolha o quadro primeiro'}</option>
              {board?.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
      </div>
      <HowItWorks>
        {action === 'add' && 'Coloca o contato no quadro (na coluna escolhida). Se ele já estiver no quadro, é movido para ela.'}
        {action === 'move' && 'Move o card do contato para a coluna escolhida — só se ele já estiver no quadro.'}
        {action === 'remove' && 'Tira o card do contato deste quadro (o contato continua em Contatos).'}
      </HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Pixel */

const CURRENCIES = ['BRL', 'USD', 'EUR', 'GBP', 'ARS', 'MXN', 'COP', 'CLP', 'PEN', 'PYG', 'UYU'];

export function PixelEditor({ d, set, vars, lookups }: EditorProps) {
  const platform = lookups.platforms.find((p) => p.id === d.platform)?.id ?? lookups.pixels.find((p) => p.id === d.pixelId)?.platform ?? lookups.platforms[0]?.id ?? 'meta';
  const events = lookups.platforms.find((p) => p.id === platform)?.events ?? [];
  const pixels = lookups.pixels.filter((p) => p.platform === platform);
  const pixel = lookups.pixels.find((p) => p.id === d.pixelId);
  return (
    <>
      <Field label="Plataforma">
        <select className="select" value={platform} data-testid="pixel-platform"
          onChange={(e) => {
            const ev = lookups.platforms.find((p) => p.id === e.target.value)?.events ?? [];
            set({ platform: e.target.value, pixelId: '', event: ev.includes(d.event) ? d.event : ev.includes('Purchase') ? 'Purchase' : ev[0] ?? '' });
          }}>
          {lookups.platforms.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </Field>
      <Field label="Pixel configurado" required warn={pixel && pixel.status !== 'active' ? `O pixel “${pixel.name}” está ${pixel.status === 'paused' ? 'pausado' : 'com problema'}: os eventos ficam na fila sem ir para a plataforma.` : undefined}
        hint={pixels.length ? undefined : 'Nenhum pixel desta plataforma. Configure em Facebook › Pixel.'}>
        <Picker value={d.pixelId ?? ''} options={pixels.map((p) => ({ value: p.id, label: p.name }))} onChange={(pixelId) => set({ pixelId, platform })}
          placeholder="Escolha o pixel" testId="pixel-picker" empty="Nenhum pixel desta plataforma" />
      </Field>
      <Field label="Tipo do evento" required>
        <select className="select" value={events.includes(d.event) ? d.event : ''} onChange={(e) => set({ event: e.target.value })} data-testid="pixel-event">
          <option value="">Escolha o evento</option>
          {events.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
        </select>
      </Field>
      <div className="bm-row2">
        <Field label="Valor do item (opcional)" hint="Ex.: 197,00 ou {{venda.valor_numero}}.">
          <VarInput value={String(d.value ?? '')} onChange={(value) => set({ value })} vars={vars} placeholder="197,00" testId="pixel-value" />
        </Field>
        <Field label="Moeda">
          <select className="select" value={CURRENCIES.includes(d.currency) ? d.currency : 'BRL'} onChange={(e) => set({ currency: e.target.value })}>
            {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
      </div>
      <HowItWorks>
        Envia o evento pela API de Conversões (servidor para servidor), com o telefone e os dados do contato criptografados.
        Cada contato manda o evento uma vez por passagem neste bloco. Acompanhe em Facebook › Pixel › Eventos.
      </HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Venda aprovada */

export function SaleEditor({ d, set, vars, lookups, openProducts }: EditorProps) {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const product = lookups.products.find((p) => p.id === d.productId);
  const saleVars = [...vars, 'venda.cliente', 'venda.valor', 'venda.produto'];
  return (
    <>
      <Field label="Produto" right={<button type="button" className="linkbtn" onClick={openProducts}><Icon name="dollar" size={12} />Gerenciar produtos</button>}
        hint={product ? `Preço cadastrado: ${money(Number(product.price))} (usado se o valor abaixo vier vazio ou inválido).` : 'Opcional, mas ajuda nos relatórios de vendas por produto.'}>
        <Picker value={d.productId ?? ''} options={lookups.products.map((p) => ({ value: p.id, label: p.name, hint: money(Number(p.price)) }))}
          onChange={(productId) => set({ productId })} placeholder="Escolha o produto" testId="sale-product" empty="Nenhum produto cadastrado" />
      </Field>
      <Field label="Nome do cliente" hint="Vazio: usa o nome do contato.">
        <VarInput value={d.customerName ?? ''} onChange={(customerName) => set({ customerName })} vars={vars} placeholder="{{comprovante.nome_pagador}}" testId="sale-customer" />
      </Field>
      <div className="bm-row2">
        <Field label="Valor" hint="Lê R$ 1.234,56, 1234.56…">
          <VarInput value={String(d.amount ?? '')} onChange={(amount) => set({ amount })} vars={vars} placeholder="{{comprovante.valor}}" testId="sale-amount" />
        </Field>
        <Field label="Moeda" hint="Código de 3 letras. Vazio: BRL.">
          <VarInput value={d.currency ?? ''} onChange={(currency) => set({ currency })} vars={vars} placeholder="{{comprovante.currency}}" />
        </Field>
      </div>
      <Section title="Notificação no app" sub="Aparece para a equipe que estiver com o Converza aberto (e como aviso do navegador, se permitido).">
        <Field label="Título">
          <VarInput value={d.notifyTitle ?? ''} onChange={(notifyTitle) => set({ notifyTitle })} vars={saleVars} placeholder="💰 Nova venda de {{venda.produto}}!" testId="sale-title" />
        </Field>
        <Field label="Subtítulo">
          <VarInput value={d.notifySubtitle ?? ''} onChange={(notifySubtitle) => set({ notifySubtitle })} vars={saleVars} placeholder="{{venda.cliente}} pagou {{venda.valor}}" testId="sale-subtitle" />
        </Field>
        {perm === 'default' && (
          <button type="button" className="btn sm" onClick={() => { void Notification.requestPermission().then((p) => setPerm(p)); }} data-testid="sale-notify-perm">
            <Icon name="bell" size={14} />Ativar avisos no navegador
          </button>
        )}
        {perm === 'granted' && <div className="bm-hint"><Icon name="check" size={12} /> Avisos do navegador ativados neste computador.</div>}
        {perm === 'denied' && <div className="bm-hint">Os avisos do navegador estão bloqueados para este site (libere no cadeado da barra de endereço).</div>}
      </Section>
      <HowItWorks>
        Registra a venda como aprovada (origem <b>Fluxo</b>) no Dashboard e no Trackeamento, e dispara as regras de pixel de “Venda aprovada”.
        Use depois do Bloco de IA com <b>Identificar comprovante</b>: os valores padrão já leem o comprovante. Os dados ficam em <code>{'{{venda.valor}}'}</code>, <code>{'{{venda.cliente}}'}</code> e <code>{'{{venda.produto}}'}</code>.
      </HowItWorks>
    </>
  );
}
