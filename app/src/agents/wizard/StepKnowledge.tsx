import { useState } from 'react';
import { api } from '../../api';
import { Icon } from '../../icons';
import { cx, toast } from '../../components/ui';
import type { KbSummary } from '../types';
import { Block, EmptyBox, Lbl, type StepProps } from './common';
import { KnowledgeDrawer } from './KnowledgeDrawer';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function StepKnowledge(p: StepProps) {
  const { draft, set, bases, setBases, ro } = p;
  const [drawer, setDrawer] = useState<null | { id: string | null }>(null);
  const [free, setFree] = useState(!!(draft.knowledge.trim() || draft.faq.length));
  const linked = draft.knowledgeBaseIds.map((id) => bases.find((b) => b.id === id)).filter((b): b is KbSummary => !!b);

  async function refresh() {
    try { const r = await api.get<{ bases: KbSummary[] }>('/knowledge-bases'); setBases(r.bases); } catch { /* fica a lista atual */ }
  }

  return (
    <div className="wz-stack">
      <Block title="O que ele sabe sobre o seu negócio" desc="Ele responde preços, prazos e condições só com o que estiver aqui — e diz que vai confirmar com a equipe quando não souber."
        right={linked.length > 0 && !ro ? <button type="button" className="btn sm" onClick={() => setDrawer({ id: null })} data-testid="kb-add"><Icon name="plus" size={14} />Adicionar base</button> : undefined} testId="sec-knowledge">
        {linked.length === 0 ? (
          <EmptyBox icon="book" title="Nenhuma base ligada ainda" text="Uma base reúne páginas do seu site, documentos (PDF, Word, TXT) e perguntas e respostas. Você pode usar a mesma base em vários agentes.">
            {!ro && <button type="button" className="btn primary sm" onClick={() => setDrawer({ id: null })} data-testid="kb-add"><Icon name="plus" size={14} />Adicionar base</button>}
          </EmptyBox>
        ) : (
          <div className="wz-list" data-testid="kb-linked">
            {linked.map((b) => (
              <div key={b.id} className="wz-item" data-testid="kb-linked-row">
                <span className="wz-item-ic"><Icon name="book" size={16} /></span>
                <div className="wz-item-main">
                  <b>{b.name}</b>
                  <small>{plural(b.sites, 'site', 'sites')} · {plural(b.documents, 'documento', 'documentos')} · {plural(b.faq, 'pergunta', 'perguntas')}{(b.agents ?? 0) > 1 ? ` · usada em ${b.agents} agentes` : ''}</small>
                </div>
                {!ro && <>
                  <button type="button" className="btn icon sm ghost" title="Editar base" aria-label={`Editar base ${b.name}`} onClick={() => setDrawer({ id: b.id })} data-testid="kb-edit"><Icon name="edit" size={14} /></button>
                  <button type="button" className="btn icon sm ghost" title="Tirar deste agente" aria-label={`Tirar ${b.name} deste agente`}
                    onClick={() => set('knowledgeBaseIds', draft.knowledgeBaseIds.filter((x) => x !== b.id))} data-testid="kb-unlink"><Icon name="close" size={14} /></button>
                </>}
              </div>
            ))}
          </div>
        )}
        {linked.reduce((n, b) => n + b.chars, 0) > 40000 && <div className="hint"><Icon name="info" size={14} />As bases passam de 40 mil letras: o agente lê as primeiras 40 mil a cada resposta. Coloque o mais importante em perguntas e respostas.</div>}
      </Block>

      <div className={cx('wz-more', free && 'open')}>
        <button type="button" className="wz-more-hd" onClick={() => setFree(!free)} aria-expanded={free} data-testid="kb-free-toggle">
          <Icon name={free ? 'chevronUp' : 'chevron'} size={15} /><b>Anotações só deste agente</b><small>texto livre e perguntas que não precisam virar base</small>
        </button>
        {free && <div className="wz-more-body">
          <div>
            <Lbl hint={`${draft.knowledge.length.toLocaleString('pt-BR')} / 30.000`}>Texto livre</Lbl>
            <textarea className="input" rows={6} maxLength={30000} value={draft.knowledge} onChange={(e) => set('knowledge', e.target.value)}
              placeholder={'Produto, o que inclui e para quem é\nPreço e formas de pagamento\nHorário de atendimento, endereço'} data-testid="ed-knowledge" />
          </div>
          <div>
            <Lbl>Perguntas frequentes</Lbl>
            <div className="ag-faq">
              {draft.faq.map((f, i) => (
                <div key={i} className="ag-faq-row" data-testid="faq-row">
                  <input className="input" value={f.q} placeholder="Pergunta" onChange={(e) => set('faq', draft.faq.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} data-testid="faq-q" />
                  <textarea className="input" rows={2} value={f.a} placeholder="Resposta" onChange={(e) => set('faq', draft.faq.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))} data-testid="faq-a" />
                  <button type="button" className="btn icon sm ghost" onClick={() => set('faq', draft.faq.filter((_, j) => j !== i))} aria-label="Remover pergunta"><Icon name="trash" size={14} /></button>
                </div>
              ))}
              {draft.faq.length < 40 && <button type="button" className="btn sm" onClick={() => set('faq', [...draft.faq, { q: '', a: '' }])} data-testid="faq-add"><Icon name="plus" size={14} />Adicionar pergunta</button>}
            </div>
          </div>
        </div>}
      </div>

      {drawer && <KnowledgeDrawer baseId={drawer.id} bases={bases} linkedIds={draft.knowledgeBaseIds}
        onClose={() => { setDrawer(null); void refresh(); }}
        onLink={(id) => {
          if (!draft.knowledgeBaseIds.includes(id)) {
            if (draft.knowledgeBaseIds.length >= 10) { toast('No máximo 10 bases por agente'); return; }
            set('knowledgeBaseIds', [...draft.knowledgeBaseIds, id]);
          }
          setDrawer(null); void refresh();
        }}
        onDeleted={(id) => { set('knowledgeBaseIds', draft.knowledgeBaseIds.filter((x) => x !== id)); setDrawer(null); void refresh(); }} />}
    </div>
  );
}
