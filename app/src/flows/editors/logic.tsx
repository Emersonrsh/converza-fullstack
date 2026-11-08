import { useState } from 'react';
import { Icon } from '../../icons';
import { cx } from '../../components/ui';
import { OP_LABELS, STAGES, rid, sanitizeVarName } from '../blocks';
import {
  Duration, Field, HowItWorks, Picker, Section, SideSwitch, Tabs, ToggleCard, VarInput, moveItem,
} from './fields';
import type { D, EditorProps } from './types';

/* ------------------------------------------------------------------ Início */

export function TriggerEditor({ d, set, lookups }: EditorProps) {
  const type = d.type ?? 'any_message';
  return (
    <>
      <Field label="Quando iniciar o fluxo">
        <select className="select" value={type} onChange={(e) => set({ type: e.target.value })} data-testid="trigger-type">
          <option value="any_message">Qualquer mensagem recebida</option>
          <option value="keyword">Mensagem com palavra-chave</option>
          <option value="first_message">Primeira mensagem do contato</option>
          <option value="webhook">Evento de webhook (venda, checkout…)</option>
          <option value="manual">Somente quando outro fluxo, agente ou disparo chamar</option>
        </select>
      </Field>
      {type === 'keyword' && (
        <div className="bm-row2">
          <Field label="Palavras-chave" required hint="Separe por vírgula. Vale a palavra inteira (“oi” não dispara com “boi”); acentos e maiúsculas não importam.">
            <input className="input" value={d.keywords ?? ''} placeholder="preço, valor, quanto custa" onChange={(e) => set({ keywords: e.target.value })} data-testid="trigger-keywords" />
          </Field>
          <Field label="Como comparar">
            <select className="select" value={d.match ?? 'contains'} onChange={(e) => set({ match: e.target.value })}>
              <option value="contains">A mensagem contém a palavra</option>
              <option value="exact">A mensagem é exatamente a palavra</option>
            </select>
          </Field>
        </div>
      )}
      {['any_message', 'keyword', 'first_message'].includes(type) && (
        <Field label="Conexão de WhatsApp">
          <select className="select" value={d.connectionId ?? ''} onChange={(e) => set({ connectionId: e.target.value })} data-testid="trigger-connection">
            <option value="">Todas as conexões</option>
            {lookups.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      )}
      {type === 'webhook' && (
        <Field label="Webhook" hint={<>Os dados do evento ficam em {'{{produto}}'}, {'{{valor}}'} e {'{{evento}}'}.</>}>
          <select className="select" value={d.webhookId ?? ''} onChange={(e) => set({ webhookId: e.target.value })}>
            <option value="">Qualquer webhook</option>
            {lookups.webhooks.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
      )}
      {type !== 'manual' && (
        <div className="bm-row2">
          <Field label="Repetição" hint="Enquanto o contato estiver dentro do fluxo, ele não começa de novo.">
            <select className="select" value={d.reentry ?? 'always'} onChange={(e) => set({ reentry: e.target.value })}>
              <option value="always">Sempre que o gatilho acontecer</option>
              <option value="once">Apenas uma vez por contato</option>
              <option value="cooldown">De novo só depois de um intervalo</option>
            </select>
          </Field>
          {d.reentry === 'cooldown' && (
            <Field label="Intervalo (horas)">
              <input className="input" type="number" min={1} value={d.cooldownHours ?? 24} onChange={(e) => set({ cooldownHours: Number(e.target.value) })} />
            </Field>
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Condicional */

const COND_FIELDS: [string, string][] = [
  ['lastMessage', 'Resposta do cliente'], ['var', 'Variável do fluxo'], ['name', 'Nome do contato'], ['phone', 'Telefone'],
  ['email', 'E-mail'], ['stage', 'Etapa do funil'], ['tags', 'Etiqueta do contato'], ['field', 'Campo personalizado'],
  ['global', 'Variável global'], ['business_hours', 'Horário de atendimento'],
];
const TEXT_OPS = ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'not_empty', 'is_empty', 'is_number', 'greater_than', 'less_than'];
export const opsFor = (field: string) => (field === 'tags' ? ['has_tag', 'not_has_tag']
  : field === 'stage' ? ['equals', 'not_equals'] : field === 'business_hours' ? ['open', 'closed'] : TEXT_OPS);
export const NO_VALUE = new Set(['not_empty', 'is_empty', 'is_number', 'open', 'closed']);
/** Caminho de variável: aceita pontos ({{http.status}}, {{comprovante.valido}}). */
export const cleanPath = (s: string) => s.replace(/^\s*\{\{|\}\}\s*$/g, '').trim().replace(/[^\w.]/g, '').slice(0, 60);

function newRule(field = 'lastMessage'): D {
  return { id: rid('r'), field, op: opsFor(field)[0], value: field === 'stage' ? 'new' : '', varName: '', globalKey: '', fieldKey: '' };
}

export function ConditionEditor({ d, set, vars, lookups }: EditorProps) {
  const rules: D[] = Array.isArray(d.rules) ? d.rules : [];
  const upd = (i: number, patch: D) => set({ rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const any = d.logic === 'any';
  const plainVars = vars.filter((v) => !v.startsWith('g_'));
  return (
    <>
      <Field label="O caminho “Sim” acontece quando">
        <div className="bm-radio" data-testid="cond-logic">
          <label className={cx(!any && 'on')}><input type="radio" checked={!any} onChange={() => set({ logic: 'all' })} />Todas as condições são verdadeiras <small>(E)</small></label>
          <label className={cx(any && 'on')}><input type="radio" checked={any} onChange={() => set({ logic: 'any' })} />Qualquer condição é verdadeira <small>(OU)</small></label>
        </div>
      </Field>
      <datalist id="cond-vars">{plainVars.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="cond-tags">{lookups.tags.map((t) => <option key={t.name} value={t.name} />)}</datalist>
      {rules.map((r, i) => (
        <div key={r.id ?? i}>
          {i > 0 && <div className="bm-join">{any ? 'OU' : 'E'}</div>}
          <div className="bm-rule" data-testid={`rule-${i}`}>
            <div className="bm-rule-row">
              <select className="select" value={r.field ?? 'lastMessage'} data-testid={`rule-${i}-field`}
                onChange={(e) => upd(i, { ...newRule(e.target.value), id: r.id, ...(e.target.value === 'global' ? { globalKey: lookups.globals[0]?.key ?? '' } : {}), ...(e.target.value === 'field' ? { fieldKey: lookups.fields[0]?.key ?? '' } : {}) })}>
                {COND_FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {r.field === 'var' && (
                <input className="input" list="cond-vars" value={r.varName ?? ''} placeholder="email ou http.status" onChange={(e) => upd(i, { varName: cleanPath(e.target.value) })} data-testid={`rule-${i}-var`} />
              )}
              {r.field === 'global' && (
                <select className="select" value={r.globalKey ?? ''} onChange={(e) => upd(i, { globalKey: e.target.value })} data-testid={`rule-${i}-global`}>
                  <option value="">Escolha…</option>
                  {lookups.globals.map((g) => <option key={g.key} value={g.key}>{g.key}</option>)}
                </select>
              )}
              {r.field === 'field' && (
                <select className="select" value={r.fieldKey ?? ''} onChange={(e) => upd(i, { fieldKey: e.target.value })} data-testid={`rule-${i}-cfield`}>
                  <option value="">Escolha…</option>
                  {lookups.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              )}
              <button type="button" className="btn icon sm ghost" onClick={() => set({ rules: rules.filter((_, j) => j !== i) })} aria-label="Remover condição"><Icon name="trash" size={14} /></button>
            </div>
            <div className="bm-rule-row">
              <select className="select" value={r.op ?? opsFor(r.field)[0]} onChange={(e) => upd(i, { op: e.target.value })} data-testid={`rule-${i}-op`}>
                {opsFor(r.field ?? 'lastMessage').map((op) => <option key={op} value={op}>{OP_LABELS[op] ?? op}</option>)}
              </select>
              {!NO_VALUE.has(r.op) && (r.field === 'stage' ? (
                <select className="select" value={r.value || 'new'} onChange={(e) => upd(i, { value: e.target.value })}>
                  {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              ) : r.field === 'tags' ? (
                <input className="input" list="cond-tags" value={r.value ?? ''} placeholder="Nome da etiqueta" onChange={(e) => upd(i, { value: e.target.value })} data-testid={`rule-${i}-value`} />
              ) : (
                <VarInput value={r.value ?? ''} onChange={(value) => upd(i, { value })} vars={vars} placeholder="sim, quero, ok" testId={`rule-${i}-value`} />
              ))}
            </div>
            {r.field === 'business_hours' && <div className="bm-hint">Usa os horários do número da conversa (Configurações › Empresa › Horários). Desligados contam como “dentro do horário”.</div>}
          </div>
        </div>
      ))}
      <button type="button" className="bm-addline" onClick={() => set({ rules: [...rules, newRule()] })} data-testid="cond-add"><Icon name="plus" size={14} />Adicionar condição</button>
      <HowItWorks>
        Compara sem diferenciar maiúsculas e acentos. Em “contém” e “é igual a”, separe alternativas por vírgula (<i>sim, quero, ok</i>).
        “É maior/menor que” comparam números (R$ 1.234,50 vira 1234,50).
      </HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Distribuidor */

export function DistributorEditor({ d, set }: EditorProps) {
  const outs: D[] = Array.isArray(d.outputs) ? d.outputs : [];
  const upd = (i: number, patch: D) => set({ outputs: outs.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  return (
    <>
      <SideSwitch left="Distribuir sempre para o próximo" right="Prevenir repetição" value={d.mode !== 'next'}
        onChange={(v) => set({ mode: v ? 'sticky' : 'next' })} testId="dist-mode" />
      <Section title={`Saídas (${outs.length})`} sub="Cada saída é um caminho. Dê nomes para achar fácil (ex.: Vendedor Ana, Vendedor Bruno).">
        {outs.map((o, i) => (
          <div className="bm-opt" key={o.id ?? i}>
            <span className="bm-opt-n">{i + 1}</span>
            <div className="bm-opt-f"><input className="input" value={o.label ?? ''} maxLength={40} placeholder={`Saída ${i + 1}`} onChange={(e) => upd(i, { label: e.target.value })} data-testid={`dist-out-${i}`} /></div>
            <button type="button" className="btn icon sm ghost" disabled={i === 0} onClick={() => set({ outputs: moveItem(outs, i, -1) })} aria-label="Subir">↑</button>
            <button type="button" className="btn icon sm ghost" disabled={outs.length <= 2} onClick={() => set({ outputs: outs.filter((_, j) => j !== i) })} aria-label="Remover saída"><Icon name="trash" size={14} /></button>
          </div>
        ))}
        {outs.length < 20 && <button type="button" className="bm-addline" onClick={() => set({ outputs: [...outs, { id: rid('out'), label: '' }] })} data-testid="dist-add"><Icon name="plus" size={14} />Adicionar saída</button>}
      </Section>
      <HowItWorks>
        Os contatos são divididos em rodízio: o 1º vai para a saída 1, o 2º para a saída 2 e assim por diante.
        Com <b>Prevenir repetição</b>, quem passar de novo por aqui volta sempre para a mesma saída (o mesmo vendedor, por exemplo).
      </HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Conexão de Fluxo */

const FLOW_STATUS: Record<string, string> = { active: 'ativo', paused: 'pausado', draft: 'rascunho' };

export function GotoFlowEditor({ d, set, lookups, flowId }: EditorProps) {
  const opts = lookups.flows.filter((f) => f.id !== flowId && (!f.archived || f.id === d.flowId))
    .map((f) => ({ value: f.id, label: f.name, hint: f.archived ? 'arquivado' : FLOW_STATUS[f.status] ?? f.status }));
  const target = lookups.flows.find((f) => f.id === d.flowId);
  return (
    <>
      <Field label="Fluxo de destino" required warn={target && (target.archived || target.status !== 'active') ? `“${target.name}” não está ativo: o contato não entra nele até você ativar.` : undefined}>
        <Picker value={d.flowId ?? ''} options={opts} onChange={(flowId) => set({ flowId })} placeholder="Buscar fluxo…" testId="goto-flow" empty="Nenhum outro fluxo" />
      </Field>
      <HowItWorks>O contato sai deste fluxo e começa o escolhido, a partir do primeiro bloco depois do Início (as variáveis salvas vão junto).</HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Intervalo Inteligente */

const WEEK = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

export function DelayEditor({ d, set, vars }: EditorProps) {
  const mode = ['date', 'hours'].includes(d.mode) ? d.mode : 'interval';
  const [dateMode, setDateMode] = useState<'fixed' | 'var'>(/\{\{/.test(String(d.date ?? '')) ? 'var' : 'fixed');
  const days: number[] = Array.isArray(d.days) ? d.days.map(Number) : [1, 2, 3, 4, 5];
  return (
    <>
      <Tabs value={mode} options={[['interval', 'Intervalo', 'clock'], ['date', 'Data', 'calendar'], ['hours', 'Horários', 'timer']]} onChange={(m) => set({ mode: m })} testId="delay-mode" />
      {mode === 'interval' && (
        <Field label="Aguardar" hint="Pode usar uma variável com o número (ex.: {{dias_teste}}).">
          <Duration amount={d.amount ?? 1} unit={d.unit ?? 'minutes'} onAmount={(amount) => set({ amount })} onUnit={(unit) => set({ unit })} amountVars={vars} testId="delay" />
        </Field>
      )}
      {mode === 'date' && (<>
        <Tabs value={dateMode} options={[['fixed', 'Data fixa'], ['var', 'Variável']]} onChange={(m) => { setDateMode(m); set({ date: '' }); }} testId="delay-datemode" />
        <Field label="Esperar até" hint="No fuso da empresa (Configurações › Empresa). Se a data já tiver passado, o fluxo segue na hora. Aceita 2026-11-20 14:30 ou 20/11/2026 14:30.">
          {dateMode === 'fixed'
            ? <input className="input" type="datetime-local" value={String(d.date ?? '').replace(' ', 'T').slice(0, 16)} onChange={(e) => set({ date: e.target.value })} data-testid="delay-date" />
            : <VarInput value={d.date ?? ''} onChange={(date) => set({ date })} vars={vars} placeholder="{{data_consulta}}" testId="delay-date-var" />}
        </Field>
      </>)}
      {mode === 'hours' && (<>
        <ToggleCard title="Usar o horário de atendimento" desc="O do número da conversa, em Configurações › Empresa › Horários." checked={!!d.useBusinessHours}
          onChange={(useBusinessHours) => set({ useBusinessHours })} testId="delay-business" />
        {!d.useBusinessHours && (<>
          <Field label="Dias">
            <div className="bm-days" data-testid="delay-days">
              {WEEK.map((w, i) => (
                <button type="button" key={w} className={cx(days.includes(i) && 'on')}
                  onClick={() => set({ days: days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort() })}>{w}</button>
              ))}
            </div>
          </Field>
          <div className="bm-row2">
            <Field label="Das"><input className="input" type="time" value={d.from ?? '09:00'} onChange={(e) => set({ from: e.target.value })} data-testid="delay-from" /></Field>
            <Field label="Até"><input className="input" type="time" value={d.to ?? '18:00'} onChange={(e) => set({ to: e.target.value })} data-testid="delay-to" /></Field>
          </div>
        </>)}
      </>)}
      <HowItWorks>
        {mode === 'interval' && 'O contato espera aqui e depois segue para o próximo bloco.'}
        {mode === 'date' && 'Agenda a continuação para uma data e hora (ex.: lembrete na véspera da consulta). Máximo: 31 dias.'}
        {mode === 'hours' && 'Se o contato chegar dentro do horário, segue na hora; fora dele, espera até abrir (ex.: só mandar a proposta em horário comercial).'}
        {' '}Atenção: depois de 24 h sem mensagem do cliente, o WhatsApp só entrega <b>templates</b>.
      </HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Manipulador */

const VAR_OPS: [string, string][] = [
  ['set', 'Definir valor'], ['add', 'Somar'], ['subtract', 'Subtrair'], ['multiply', 'Multiplicar'], ['divide', 'Dividir'],
  ['append', 'Juntar texto (no fim)'], ['clear', 'Limpar'],
];

export function SetVarEditor({ d, set, vars, lookups }: EditorProps) {
  const name = String(d.name ?? '');
  const isGlobal = /^g_/i.test(name);
  const global = isGlobal ? lookups.globals.find((g) => g.key === name.toLowerCase()) : undefined;
  const numeric = ['add', 'subtract', 'multiply', 'divide'].includes(d.op);
  return (
    <>
      <datalist id="setvar-names">
        {[...new Set([...vars.filter((v) => !v.includes('.')), ...lookups.globals.map((g) => g.key)])].map((v) => <option key={v} value={v} />)}
      </datalist>
      <Field label="Variável" required
        warn={isGlobal && !global ? `A variável global ${name} não existe: crie em Configurações › Variáveis Globais.` : undefined}
        hint={isGlobal ? 'Variável global: o novo valor vale para a empresa toda.' : 'Nova ou já existente (ex.: total, pontos, cupom). Comece com g_ para usar uma variável global.'}>
        <input className="input" list="setvar-names" value={name} placeholder="total" onChange={(e) => set({ name: sanitizeVarName(e.target.value) })} data-testid="setvar-name" />
      </Field>
      <Field label="Operação">
        <select className="select" value={d.op ?? 'set'} onChange={(e) => set({ op: e.target.value })} data-testid="setvar-op">
          {VAR_OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      {d.op !== 'clear' && (
        <Field label="Valor" hint={numeric ? 'Número ou variável com número (aceita 1.234,50).' : d.op === 'append' ? 'Junta este texto no fim do valor atual.' : 'Texto, número ou variáveis.'}>
          <VarInput value={String(d.value ?? '')} onChange={(value) => set({ value })} vars={vars} placeholder={numeric ? '1' : '{{resposta}}'} testId="setvar-value" />
        </Field>
      )}
      <HowItWorks>
        Use depois como <code>{`{{${name || 'variavel'}}}`}</code> nos textos e no Condicional.
        {isGlobal ? ' Somar e subtrair numa global numérica é atômico (vários contatos ao mesmo tempo não se atrapalham).' : ' Se existir um campo do contato com o mesmo nome, ele também é atualizado.'}
      </HowItWorks>
    </>
  );
}
