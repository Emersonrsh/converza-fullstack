import { useRef, type ReactNode } from 'react';
import { Icon } from '../icons';
import { cx } from '../components/ui';
import { money } from '../api';
import {
  AI_MODELS, BLOCKS, OP_LABELS, STAGES, rid, sanitizeVarName, type BlockType, type Lookups,
} from './blocks';
import type { BlockFlowNode } from './canvas';

type D = Record<string, any>;

interface Props {
  node: BlockFlowNode;
  currentFlowId: string;
  lookups: Lookups;
  variables: string[];
  onChange: (patch: D) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onClose: () => void;
  onManagePayments: () => void;
}

/* ------------------------------------------------------------- campos */

function F({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="cf">
      <label className="label">{label}</label>
      {children}
      {hint && <div className="cf-hint">{hint}</div>}
    </div>
  );
}

function Template({ label, value, onChange, vars, rows = 4, placeholder, hint, extra = [] }: {
  label: string; value: string; onChange: (v: string) => void; vars: string[]; rows?: number;
  placeholder?: string; hint?: ReactNode; extra?: string[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (v: string) => {
    const token = `{{${v}}}`;
    const el = ref.current;
    const cur = value ?? '';
    if (!el) { onChange(cur + token); return; }
    const s = el.selectionStart ?? cur.length;
    const e = el.selectionEnd ?? cur.length;
    onChange(cur.slice(0, s) + token + cur.slice(e));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length); });
  };
  const all = [...new Set([...extra, ...vars])];
  return (
    <F label={label} hint={hint}>
      <textarea ref={ref} className="input" rows={rows} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <div className="vchips">
        {all.map((v) => <button type="button" key={v} className="vchip" onClick={() => insert(v)}>{`{{${v}}}`}</button>)}
      </div>
    </F>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="cf">
      <label className="tgl">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className={cx('switch', checked && 'on')} aria-hidden="true"><i /></span>
        <span>{label}</span>
      </label>
      {hint && <div className="cf-hint">{hint}</div>}
    </div>
  );
}

function ListEditor({ items, onChange, max, prefix, titleKey, titlePlaceholder, titleMax, withDescription, addLabel }: {
  items: D[]; onChange: (v: D[]) => void; max: number; prefix: string; titleKey: string;
  titlePlaceholder: string; titleMax?: number; withDescription?: boolean; addLabel: string;
}) {
  const set = (i: number, patch: D) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const copy = [...items];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  };
  return (
    <div className="le">
      {items.map((it, i) => (
        <div className="le-row" key={it.id}>
          <span className="le-n">{i + 1}</span>
          <div className="le-fields">
            <input className="input" value={it[titleKey] ?? ''} maxLength={titleMax} placeholder={titlePlaceholder}
              onChange={(e) => set(i, { [titleKey]: e.target.value })} />
            {withDescription && (
              <input className="input sm" value={it.description ?? ''} placeholder="Descrição (ajuda a IA a entender)"
                onChange={(e) => set(i, { description: e.target.value })} />
            )}
          </div>
          <div className="le-act">
            <button type="button" className="btn icon sm ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Subir">↑</button>
            <button type="button" className="btn icon sm ghost" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remover"><Icon name="trash" size={14} /></button>
          </div>
        </div>
      ))}
      {items.length < max && (
        <button type="button" className="btn sm ghost le-add" onClick={() => onChange([...items, { id: rid(prefix), [titleKey]: '' }])}>
          <Icon name="plus" size={14} />{addLabel}
        </button>
      )}
    </div>
  );
}

const csv = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
const fromCsv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/* ------------------------------------------------------------- painel */

export function ConfigPanel({ node, currentFlowId, lookups, variables, onChange, onDelete, onDuplicate, onClose, onManagePayments }: Props) {
  const type = node.type as BlockType;
  const d: D = node.data ?? {};
  const meta = BLOCKS[type] ?? BLOCKS.message;
  const set = (patch: D) => onChange(patch);

  return (
    <aside className="fb-config fade" onKeyDown={(e) => e.stopPropagation()}>
      <div className="fbc-hd" style={{ borderTopColor: meta.color }}>
        <span className="blk-ic" style={{ background: meta.color }}><Icon name={meta.icon} size={14} stroke={2.2} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{meta.label}</b>
          <div className="faint" style={{ fontSize: 11.5 }}>{meta.desc}</div>
        </div>
        <button type="button" className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" size={16} /></button>
      </div>

      <div className="fbc-bd">
        {type !== 'trigger' && (
          <F label="Nome do bloco (opcional)">
            <input className="input" value={d.title ?? ''} placeholder={meta.label} onChange={(e) => set({ title: e.target.value })} />
          </F>
        )}

        {type === 'trigger' && (<>
          <F label="Quando iniciar o fluxo">
            <select className="select" value={d.type ?? 'any_message'} onChange={(e) => set({ type: e.target.value })}>
              <option value="any_message">Qualquer mensagem recebida</option>
              <option value="keyword">Mensagem com palavra-chave</option>
              <option value="first_message">Primeira mensagem do contato</option>
              <option value="webhook">Evento de webhook (venda, checkout…)</option>
              <option value="manual">Somente quando outro fluxo chamar</option>
            </select>
          </F>
          {d.type === 'keyword' && (<>
            <F label="Palavras-chave" hint="Separe por vírgula. Vale a palavra inteira (“oi” não dispara com “boi”); acentos e maiúsculas não importam.">
              <input className="input" value={d.keywords ?? ''} placeholder="preço, valor, quanto custa" onChange={(e) => set({ keywords: e.target.value })} />
            </F>
            <F label="Como comparar">
              <select className="select" value={d.match ?? 'contains'} onChange={(e) => set({ match: e.target.value })}>
                <option value="contains">A mensagem contém a palavra</option>
                <option value="exact">A mensagem é exatamente a palavra</option>
              </select>
            </F>
          </>)}
          {['any_message', 'keyword', 'first_message'].includes(d.type ?? 'any_message') && (
            <F label="Conexão de WhatsApp">
              <select className="select" value={d.connectionId ?? ''} onChange={(e) => set({ connectionId: e.target.value })}>
                <option value="">Todas as conexões</option>
                {lookups.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </F>
          )}
          {d.type === 'webhook' && (
            <F label="Webhook" hint={<>Os dados do evento ficam em {'{{produto}}'}, {'{{valor}}'} e {'{{evento}}'}.</>}>
              <select className="select" value={d.webhookId ?? ''} onChange={(e) => set({ webhookId: e.target.value })}>
                <option value="">Qualquer webhook</option>
                {lookups.webhooks.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </F>
          )}
          {d.type !== 'manual' && (
            <F label="Repetição" hint="Enquanto o contato estiver dentro do fluxo, ele não começa de novo.">
              <select className="select" value={d.reentry ?? 'always'} onChange={(e) => set({ reentry: e.target.value })}>
                <option value="always">Sempre que o gatilho acontecer</option>
                <option value="once">Apenas uma vez por contato</option>
                <option value="cooldown">De novo só depois de um intervalo</option>
              </select>
            </F>
          )}
          {d.reentry === 'cooldown' && (
            <F label="Intervalo (horas)">
              <input className="input" type="number" min={1} value={d.cooldownHours ?? 24} onChange={(e) => set({ cooldownHours: Number(e.target.value) })} />
            </F>
          )}
        </>)}

        {type === 'message' && (
          <Template label="Mensagem" value={d.text} onChange={(v) => set({ text: v })} vars={variables} rows={6}
            hint="Clique numa variável para inserir no texto." />
        )}

        {type === 'media' && (<>
          <F label="Tipo">
            <select className="select" value={d.mediaType ?? 'image'} onChange={(e) => set({ mediaType: e.target.value })}>
              <option value="image">Imagem</option>
              <option value="video">Vídeo</option>
              <option value="audio">Áudio</option>
              <option value="document">Documento / PDF</option>
            </select>
          </F>
          <F label="Link do arquivo" hint="Precisa ser um link público (https://…) que abra direto o arquivo.">
            <input className="input" value={d.url ?? ''} placeholder="https://meusite.com/catalogo.pdf" onChange={(e) => set({ url: e.target.value })} />
          </F>
          {d.mediaType !== 'audio' && (
            <Template label="Legenda (opcional)" value={d.caption} onChange={(v) => set({ caption: v })} vars={variables} rows={3} />
          )}
          {d.mediaType === 'document' && (
            <F label="Nome do arquivo">
              <input className="input" value={d.filename ?? ''} placeholder="catalogo.pdf" onChange={(e) => set({ filename: e.target.value })} />
            </F>
          )}
        </>)}

        {type === 'menu' && (<>
          <Template label="Texto do menu" value={d.text} onChange={(v) => set({ text: v })} vars={variables} rows={3} />
          <F label="Opções" hint="Cada opção vira uma saída do bloco. O cliente pode tocar no botão, digitar o número ou o texto.">
            <ListEditor items={d.options ?? []} onChange={(options) => set({ options })} max={10} prefix="opt"
              titleKey="title" titlePlaceholder="Texto da opção" titleMax={24} addLabel="Adicionar opção" />
          </F>
          <F label="Formato no WhatsApp" hint={(d.options ?? []).length > 3 && d.style === 'buttons' ? 'Botões aceitam no máximo 3 opções — será usada a lista.' : undefined}>
            <select className="select" value={d.style ?? 'auto'} onChange={(e) => set({ style: e.target.value })}>
              <option value="auto">Automático (botões até 3, lista até 10)</option>
              <option value="buttons">Botões</option>
              <option value="list">Lista</option>
              <option value="text">Texto numerado</option>
            </select>
          </F>
          {(d.style === 'list' || (d.style ?? 'auto') === 'auto') && (
            <F label="Texto do botão da lista">
              <input className="input" value={d.buttonLabel ?? ''} maxLength={20} placeholder="Ver opções" onChange={(e) => set({ buttonLabel: e.target.value })} />
            </F>
          )}
          <F label="Se não reconhecer a resposta" hint='Se a saída "Outro" estiver conectada, o fluxo segue por ela; senão, o menu é reenviado.'>
            <input className="input" value={d.invalidText ?? ''} placeholder="Não entendi 🤔 Escolha uma das opções:" onChange={(e) => set({ invalidText: e.target.value })} />
          </F>
          <F label="Salvar a escolha na variável (opcional)">
            <input className="input" value={d.saveAs ?? ''} placeholder="interesse" onChange={(e) => set({ saveAs: sanitizeVarName(e.target.value) })} />
          </F>
        </>)}

        {type === 'ask' && (<>
          <Template label="Pergunta" value={d.text} onChange={(v) => set({ text: v })} vars={variables} rows={3} />
          <F label="Salvar resposta na variável" hint={d.saveAs ? <>Use depois como <code>{`{{${d.saveAs}}}`}</code>.</> : 'Ex.: email, cidade, nome_cliente'}>
            <input className="input" value={d.saveAs ?? ''} placeholder="email" onChange={(e) => set({ saveAs: sanitizeVarName(e.target.value) })} />
          </F>
          <F label="Tipo de resposta esperada">
            <select className="select" value={d.validation ?? 'any'} onChange={(e) => set({ validation: e.target.value })}>
              <option value="any">Qualquer resposta</option>
              <option value="text">Texto (não vazio)</option>
              <option value="email">E-mail</option>
              <option value="number">Número</option>
              <option value="phone">Telefone</option>
            </select>
          </F>
          {(d.validation ?? 'any') !== 'any' && (<>
            <F label="Mensagem quando a resposta for inválida">
              <input className="input" value={d.invalidText ?? ''} placeholder="Deixe vazio para usar a mensagem padrão" onChange={(e) => set({ invalidText: e.target.value })} />
            </F>
            <F label="Tentativas extras" hint='Depois disso o fluxo segue pela saída "Inválida" (se conectada).'>
              <input className="input" type="number" min={0} max={5} value={d.maxRetries ?? 2} onChange={(e) => set({ maxRetries: Number(e.target.value) })} />
            </F>
          </>)}
        </>)}

        {type === 'condition' && (<>
          <F label="Verificar">
            <select className="select" value={d.field ?? 'lastMessage'} onChange={(e) => {
              const field = e.target.value;
              const op = field === 'tags' ? 'has_tag' : field === 'stage' ? 'equals' : field === 'business_hours' ? 'open' : 'contains';
              set({ field, op, value: field === 'stage' ? 'new' : '', ...(field === 'global' ? { globalKey: lookups.globals[0]?.key ?? '' } : {}) });
            }} data-testid="cond-field">
              <option value="lastMessage">Última resposta do cliente</option>
              <option value="var">Uma variável</option>
              <option value="name">Nome do contato</option>
              <option value="stage">Etapa do funil</option>
              <option value="tags">Etiquetas do contato</option>
              <option value="business_hours">Horário de atendimento</option>
              <option value="global">Uma variável global</option>
            </select>
          </F>
          {d.field === 'business_hours' && (
            <div className="cf-info">Usa os horários de trabalho do número da conversa (Configurações › Empresa › Horários). Se os horários estiverem desligados, conta como <b>dentro do horário</b>.</div>
          )}
          {d.field === 'global' && (
            <F label="Variável global" hint={lookups.globals.length ? undefined : 'Crie em Configurações › Variáveis Globais.'}>
              <select className="select" value={d.globalKey ?? ''} onChange={(e) => set({ globalKey: e.target.value })} data-testid="cond-global">
                <option value="">Escolha…</option>
                {lookups.globals.map((g) => <option key={g.key} value={g.key}>{`{{${g.key}}}`} {g.value ? `(agora: ${g.value.slice(0, 20)})` : ''}</option>)}
              </select>
            </F>
          )}
          {d.field === 'var' && (
            <F label="Variável">
              <input className="input" list="flow-vars" value={d.varName ?? ''} placeholder="email" onChange={(e) => set({ varName: sanitizeVarName(e.target.value) })} />
              <datalist id="flow-vars">{variables.filter((v) => !v.includes('.')).map((v) => <option key={v} value={v} />)}</datalist>
            </F>
          )}
          <F label="Condição">
            <select className="select" value={d.op ?? 'contains'} onChange={(e) => set({ op: e.target.value })} data-testid="cond-op">
              {(d.field === 'tags' ? ['has_tag', 'not_has_tag']
                : d.field === 'stage' ? ['equals', 'not_equals']
                : d.field === 'business_hours' ? ['open', 'closed']
                : ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'not_empty', 'is_empty', 'is_number', 'greater_than', 'less_than'])
                .map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
            </select>
          </F>
          {d.field !== 'business_hours' && !['not_empty', 'is_empty', 'is_number'].includes(d.op) && (
            d.field === 'stage' ? (
              <F label="Etapa">
                <select className="select" value={d.value ?? 'new'} onChange={(e) => set({ value: e.target.value })}>
                  {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </F>
            ) : (
              <F label={d.field === 'tags' ? 'Etiqueta' : 'Valor'} hint={d.field === 'tags' ? undefined : 'Separe alternativas por vírgula: sim, quero, ok'}>
                <input className="input" value={d.value ?? ''} onChange={(e) => set({ value: e.target.value })} />
              </F>
            )
          )}
        </>)}

        {type === 'delay' && (<>
          <F label="Aguardar">
            <div className="row">
              <input className="input" type="number" min={1} style={{ maxWidth: 100 }} value={d.amount ?? 5} onChange={(e) => set({ amount: Number(e.target.value) })} />
              <select className="select" value={d.unit ?? 'minutes'} onChange={(e) => set({ unit: e.target.value })}>
                <option value="seconds">segundos</option>
                <option value="minutes">minutos</option>
                <option value="hours">horas</option>
                <option value="days">dias</option>
              </select>
            </div>
          </F>
          <div className="cf-warn"><Icon name="alert" size={14} />O WhatsApp só permite mensagens livres até 24h depois da última mensagem do cliente.</div>
        </>)}

        {type === 'random' && (
          <F label={`Caminho A: ${d.percentA ?? 50}% · Caminho B: ${100 - Number(d.percentA ?? 50)}%`} hint="Útil para testar duas mensagens e ver qual converte mais nas estatísticas.">
            <input type="range" min={0} max={100} step={5} value={d.percentA ?? 50} onChange={(e) => set({ percentA: Number(e.target.value) })} style={{ width: '100%' }} />
          </F>
        )}

        {type === 'action' && (<>
          <F label="Mover no funil para">
            <select className="select" value={d.setStage ?? ''} onChange={(e) => set({ setStage: e.target.value })}>
              <option value="">(não mudar)</option>
              {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </F>
          <F label="Adicionar etiquetas" hint="Separe por vírgula.">
            <input className="input" value={csv(d.addTags)} placeholder="Lead quente, Instagram" onChange={(e) => set({ addTags: fromCsv(e.target.value) })} />
          </F>
          <F label="Remover etiquetas">
            <input className="input" value={csv(d.removeTags)} placeholder="Lead frio" onChange={(e) => set({ removeTags: fromCsv(e.target.value) })} />
          </F>
          <Template label="Atualizar nome do contato (opcional)" value={d.setName} onChange={(v) => set({ setName: v })} vars={variables} rows={1}
            hint="Ex.: depois de perguntar o nome e salvar em {{nome_cliente}}." />
          <F label="Salvar em campos do contato" hint={lookups.fields.length ? 'Ex.: depois de perguntar o CPF (salvo em {{cpf}}), guarde no campo CPF do contato.' : 'Crie campos em Configurações › Campos personalizados.'}>
            <div className="le">
              {(Array.isArray(d.setFields) ? d.setFields : []).map((f: D, i: number) => (
                <div className="row" key={i} style={{ gap: 6, marginBottom: 6 }} data-testid="action-field-row">
                  <select className="select sm" style={{ maxWidth: 140 }} value={f.key ?? ''} onChange={(e) => set({ setFields: (d.setFields ?? []).map((x: D, j: number) => (j === i ? { ...x, key: e.target.value } : x)) })} data-testid="action-field-key">
                    <option value="">Campo…</option>
                    {lookups.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                  <input className="input sm" placeholder="{{resposta}}" value={f.value ?? ''} onChange={(e) => set({ setFields: (d.setFields ?? []).map((x: D, j: number) => (j === i ? { ...x, value: e.target.value } : x)) })} data-testid="action-field-value" />
                  <button type="button" className="btn icon sm ghost" onClick={() => set({ setFields: (d.setFields ?? []).filter((_: D, j: number) => j !== i) })} aria-label="Remover campo"><Icon name="close" size={14} /></button>
                </div>
              ))}
              {lookups.fields.length > 0 && (
                <button type="button" className="btn sm ghost" onClick={() => set({ setFields: [...(Array.isArray(d.setFields) ? d.setFields : []), { key: lookups.fields[0].key, value: '' }] })} data-testid="action-add-field">
                  <Icon name="plus" size={13} />Adicionar campo
                </button>
              )}
            </div>
          </F>
          <F label="Variáveis globais" hint={lookups.globals.length ? 'Vale para a empresa toda (todos os fluxos veem o valor novo). Somar e subtrair só para números.' : 'Crie em Configurações › Variáveis Globais (ex.: vagas restantes, cupom do mês).'}>
            <div className="le">
              {(Array.isArray(d.setGlobals) ? d.setGlobals : []).map((g: D, i: number) => {
                const upd = (patch: D) => set({ setGlobals: (d.setGlobals ?? []).map((x: D, j: number) => (j === i ? { ...x, ...patch } : x)) });
                const isNum = lookups.globals.find((x) => x.key === g.key)?.type === 'number';
                return (
                  <div className="row" key={i} style={{ gap: 6, marginBottom: 6 }} data-testid="action-global-row">
                    <select className="select sm" style={{ maxWidth: 130 }} value={g.key ?? ''} onChange={(e) => upd({ key: e.target.value })} data-testid="action-global-key">
                      <option value="">Variável…</option>
                      {lookups.globals.map((x) => <option key={x.key} value={x.key}>{x.key}</option>)}
                    </select>
                    <select className="select sm" style={{ maxWidth: 104 }} value={g.op ?? 'set'} onChange={(e) => upd({ op: e.target.value })} data-testid="action-global-op">
                      <option value="set">definir</option>
                      {isNum && <option value="add">somar</option>}
                      {isNum && <option value="subtract">subtrair</option>}
                    </select>
                    <input className="input sm" placeholder={isNum ? '1' : '{{resposta}}'} value={g.value ?? ''} onChange={(e) => upd({ value: e.target.value })} data-testid="action-global-value" />
                    <button type="button" className="btn icon sm ghost" onClick={() => set({ setGlobals: (d.setGlobals ?? []).filter((_: D, j: number) => j !== i) })} aria-label="Remover"><Icon name="close" size={14} /></button>
                  </div>
                );
              })}
              {lookups.globals.length > 0 && (
                <button type="button" className="btn sm ghost" onClick={() => set({ setGlobals: [...(Array.isArray(d.setGlobals) ? d.setGlobals : []), { key: lookups.globals[0].key, op: 'set', value: '' }] })} data-testid="action-add-global">
                  <Icon name="plus" size={13} />Adicionar variável global
                </button>
              )}
            </div>
          </F>
          <F label="Colocar no Kanban" hint={lookups.kanban.length ? 'O contato entra no topo da coluna; se já estiver no quadro, é movido para ela.' : 'Crie um quadro em Kanban para usar esta ação.'}>
            <select className="select" value={d.kanbanBoardId ?? ''} data-testid="action-kanban-board"
              onChange={(e) => { const b = lookups.kanban.find((x) => x.id === e.target.value); set({ kanbanBoardId: e.target.value, kanbanColumnId: b?.columns[0]?.id ?? '' }); }}>
              <option value="">(não mexer no Kanban)</option>
              {lookups.kanban.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            {d.kanbanBoardId && (
              <select className="select" style={{ marginTop: 6 }} value={d.kanbanColumnId ?? ''} onChange={(e) => set({ kanbanColumnId: e.target.value })} data-testid="action-kanban-column">
                <option value="">Escolha a coluna…</option>
                {lookups.kanban.find((b) => b.id === d.kanbanBoardId)?.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </F>
        </>)}

        {type === 'handoff' && (<>
          <Template label="Mensagem antes de transferir (opcional)" value={d.message} onChange={(v) => set({ message: v })} vars={variables} rows={3} />
          <F label="Atribuir a">
            <select className="select" value={d.assignUserId ?? ''} onChange={(e) => set({ assignUserId: e.target.value, ...(e.target.value ? { departmentId: '' } : {}) })} data-testid="handoff-user">
              <option value="">Equipe (sem responsável)</option>
              {lookups.team.map((t) => <option key={t.userId} value={t.userId}>{t.name}</option>)}
            </select>
          </F>
          {!d.assignUserId && (
            <F label="Fila do setor" hint={lookups.departments.length ? 'A conversa fica em “Aguardando” só para quem é do setor; quem pegar primeiro, atende.' : 'Crie setores em Configurações › Empresa › Departamentos.'}>
              <select className="select" value={d.departmentId ?? ''} onChange={(e) => set({ departmentId: e.target.value })} data-testid="handoff-dept">
                <option value="">Fila geral (qualquer pessoa)</option>
                {lookups.departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </F>
          )}
          <div className="cf-info">A conversa fica marcada como <b>atendimento humano</b>: fluxos e IA param de responder até alguém retomar a automação no inbox.</div>
        </>)}

        {type === 'http' && (<>
          <F label="Requisição">
            <div className="row">
              <select className="select" style={{ maxWidth: 100 }} value={d.method ?? 'POST'} onChange={(e) => set({ method: e.target.value })}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
              </select>
              <input className="input" value={d.url ?? ''} placeholder="https://api.exemplo.com/leads" onChange={(e) => set({ url: e.target.value })} />
            </div>
          </F>
          <F label="Cabeçalhos" hint="Ex.: Authorization → Bearer SUA_CHAVE. Por segurança, valores de cabeçalho não são copiados ao compartilhar o fluxo.">
            <div className="le">
              {(d.headers ?? []).map((h: D, i: number) => (
                <div className="row" key={i} style={{ gap: 6, marginBottom: 6 }}>
                  <input className="input sm" placeholder="Nome" value={h.key ?? ''} onChange={(e) => set({ headers: (d.headers ?? []).map((x: D, j: number) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                  <input className="input sm" placeholder="Valor" value={h.value ?? ''} onChange={(e) => set({ headers: (d.headers ?? []).map((x: D, j: number) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                  <button type="button" className="btn icon sm ghost" aria-label="Remover cabeçalho" onClick={() => set({ headers: (d.headers ?? []).filter((_: D, j: number) => j !== i) })}><Icon name="trash" size={14} /></button>
                </div>
              ))}
              <button type="button" className="btn sm ghost le-add" onClick={() => set({ headers: [...(d.headers ?? []), { key: '', value: '' }] })}><Icon name="plus" size={14} />Adicionar cabeçalho</button>
            </div>
          </F>
          {(d.method ?? 'POST') !== 'GET' && (
            <Template label="Corpo (JSON)" value={d.body} onChange={(v) => set({ body: v })} vars={variables} rows={5} />
          )}
          <F label="Salvar a resposta em" hint={<>Acesse os campos como <code>{`{{${d.saveAs || 'http'}.campo}}`}</code>. A saída “Erro” é usada se a API falhar ou demorar mais de 10s.</>}>
            <input className="input" value={d.saveAs ?? 'http'} onChange={(e) => set({ saveAs: sanitizeVarName(e.target.value) })} />
          </F>
        </>)}

        {type === 'payment' && (<>
          <F label="Produto" hint={lookups.products.length ? undefined : 'Nenhum produto cadastrado ainda.'}>
            <select className="select" value={d.productId ?? ''} onChange={(e) => set({ productId: e.target.value })}>
              <option value="">Link personalizado</option>
              {lookups.products.map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {money(Number(p.price))}{p.checkoutUrl ? '' : ' (sem link!)'}</option>
              ))}
            </select>
            <button type="button" className="btn sm ghost" style={{ marginTop: 6 }} onClick={onManagePayments}><Icon name="dollar" size={14} />Gerenciar produtos e links</button>
          </F>
          {!d.productId && (
            <F label="Link de pagamento">
              <input className="input" value={d.url ?? ''} placeholder="https://pay.hotmart.com/..." onChange={(e) => set({ url: e.target.value })} />
            </F>
          )}
          <Template label="Mensagem" value={d.text} onChange={(v) => set({ text: v })} vars={variables} rows={3} extra={['link', 'produto', 'preco']} />
          <Toggle label="Aguardar a confirmação do pagamento" checked={!!d.wait} onChange={(v) => set({ wait: v })}
            hint='Cria as saídas "Pago" e "Não pago". A confirmação chega pelo webhook de vendas (Hotmart, Kiwify, etc. em Webhooks).' />
          {d.wait && (
            <F label="Tempo limite (minutos)" hint='Passado esse tempo sem pagamento, segue por "Não pago".'>
              <input className="input" type="number" min={5} value={d.timeoutMinutes ?? 60} onChange={(e) => set({ timeoutMinutes: Number(e.target.value) })} />
            </F>
          )}
        </>)}

        {type === 'ai_reply' && (<>
          <F label="Instruções para a IA" hint="Diga quem ela é, o que vende, preços e regras. Ela responde usando a conversa como contexto.">
            <textarea className="input" rows={6} value={d.prompt ?? ''} onChange={(e) => set({ prompt: e.target.value })} />
          </F>
          <F label="Modelo">
            <select className="select" value={d.model ?? ''} onChange={(e) => set({ model: e.target.value })}>
              {AI_MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </F>
          <Toggle label="Usar o histórico da conversa" checked={d.useHistory !== false} onChange={(v) => set({ useHistory: v })} />
          <Toggle label="Enviar a resposta ao cliente" checked={d.send !== false} onChange={(v) => set({ send: v })}
            hint="Desligado: só salva o texto na variável, para usar depois." />
          <F label="Salvar resposta na variável">
            <input className="input" value={d.saveAs ?? ''} placeholder="ia" onChange={(e) => set({ saveAs: sanitizeVarName(e.target.value) })} />
          </F>
          <F label="Mensagem se a IA falhar ou estiver sem saldo">
            <input className="input" value={d.fallbackText ?? ''} placeholder="Já te respondo! 😊" onChange={(e) => set({ fallbackText: e.target.value })} />
          </F>
          <div className="cf-info"><Icon name="bolt" size={13} /> Consome tokens de IA da conta a cada resposta.</div>
        </>)}

        {type === 'ai_classify' && (<>
          <F label="Categorias" hint="A IA lê a última mensagem e escolhe uma categoria. Cada uma vira uma saída.">
            <ListEditor items={d.categories ?? []} onChange={(categories) => set({ categories })} max={10} prefix="cat"
              titleKey="label" titlePlaceholder="Nome da categoria" withDescription addLabel="Adicionar categoria" />
          </F>
          <F label="Instruções extras (opcional)">
            <textarea className="input" rows={3} value={d.instructions ?? ''} placeholder="Ex.: perguntas sobre entrega contam como Dúvida." onChange={(e) => set({ instructions: e.target.value })} />
          </F>
          <div className="cf-info">A categoria escolhida fica em <code>{'{{categoria}}'}</code>. Consome poucos tokens.</div>
        </>)}

        {type === 'goto_flow' && (
          <F label="Continuar no fluxo" hint="O contato sai deste fluxo e entra no escolhido (que precisa estar ativo).">
            <select className="select" value={d.flowId ?? ''} onChange={(e) => set({ flowId: e.target.value })}>
              <option value="">Selecione…</option>
              {lookups.flows.filter((f) => f.id !== currentFlowId).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </F>
        )}
      </div>

      {type !== 'trigger' && (
        <div className="fbc-ft">
          <button type="button" className="btn sm" onClick={onDuplicate}><Icon name="copy" size={14} />Duplicar</button>
          <div className="spacer" />
          <button type="button" className="btn sm danger" onClick={onDelete}><Icon name="trash" size={14} />Excluir bloco</button>
        </div>
      )}
    </aside>
  );
}
