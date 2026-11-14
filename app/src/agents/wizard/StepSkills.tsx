import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../icons';
import { cx } from '../../components/ui';
import type { AutoAction, Automation, AutoTrigger } from '../types';
import { Block, Lbl, type StepProps } from './common';

const MAX_CUSTOM = 10;

const TRIGGER: Record<Exclude<AutoTrigger, 'intent'>, { title: string; icon: string; hint: string }> = {
  invalid_media: { title: 'Quando o cliente mandar vídeo, figurinha ou GIF', icon: 'sticker', hint: 'O agente não entende esses formatos. Acontece sem gastar IA.' },
  reply_limit: { title: 'Quando chegar ao limite de respostas do dia', icon: 'timer', hint: 'O limite por conversa fica na última etapa.' },
  finish: { title: 'Quando o atendimento terminar', icon: 'checkCircle', hint: 'O cliente agradeceu ou se despediu e não ficou nada pendente.' },
  handoff: { title: 'Quando precisar passar para uma pessoa', icon: 'headset', hint: 'Pedido do cliente, irritação ou pergunta que ele não sabe responder.' },
};

const ACTION_LABEL: Record<AutoAction, string> = {
  handoff: 'Passar para a equipe', flow: 'Disparar um fluxo', close: 'Encerrar o atendimento', reply: 'Responder com mensagem pronta', tag: 'Marcar uma etiqueta',
};
const ACTIONS_FOR: Record<AutoTrigger, AutoAction[]> = {
  invalid_media: ['reply', 'handoff', 'flow', 'tag'],
  reply_limit: ['handoff', 'flow', 'close', 'reply'],
  finish: ['close', 'tag', 'flow', 'handoff'],
  handoff: ['handoff', 'flow'],
  intent: ['flow', 'handoff', 'tag', 'reply', 'close'],
};

export function StepSkills({ draft, set, opt, ro }: StepProps) {
  const [open, setOpen] = useState<string | null>(null);
  const list = draft.automations;
  const intents = list.filter((a) => a.trigger === 'intent');
  const update = (key: string, p: Partial<Automation>) => set('automations', list.map((a) => (a.key === key ? { ...a, ...p } : a)));
  const flowName = (id?: string | null) => opt.flows.find((f) => f.id === id)?.name;
  const deptName = (id?: string | null) => opt.departments.find((d) => d.id === id)?.name;

  function summary(a: Automation): string {
    if (a.action === 'flow') return a.flowId ? `Dispara o fluxo “${flowName(a.flowId) ?? 'removido'}”` : 'Escolha o fluxo';
    if (a.action === 'handoff') return `Passa para a equipe${a.departmentId ? ` (setor ${deptName(a.departmentId) ?? ''})` : ''}${a.tag ? ` e marca “${a.tag}”` : ''}`;
    if (a.action === 'tag') return a.tag ? `Marca a etiqueta “${a.tag}” e segue a conversa` : 'Escolha a etiqueta';
    if (a.action === 'close') return 'Encerra o atendimento (vai para Resolvidos)';
    return a.message?.trim() ? `Responde: “${a.message.trim().slice(0, 60)}${a.message.trim().length > 60 ? '…' : ''}”` : 'Escreva a mensagem';
  }
  function addIntent() {
    const key = `auto_${Date.now().toString(36)}`;
    set('automations', [...list, { key, trigger: 'intent', when: '', action: opt.flows.length ? 'flow' : 'tag', flowId: null, tag: null, message: '' }]);
    setOpen(key);
  }

  const row = (a: Automation) => {
    const sys = a.trigger !== 'intent';
    const meta = sys ? TRIGGER[a.trigger as Exclude<AutoTrigger, 'intent'>] : null;
    const isOpen = open === a.key;
    const pausedFlow = a.action === 'flow' && a.flowId && opt.flows.find((f) => f.id === a.flowId)?.status !== 'active';
    return (
      <div key={a.key} className={cx('wz-auto', isOpen && 'open')} data-testid={sys ? `auto-${a.trigger}` : 'auto-intent'}>
        <button type="button" className="wz-auto-hd" onClick={() => setOpen(isOpen ? null : a.key)} aria-expanded={isOpen}>
          <span className="wz-item-ic"><Icon name={meta?.icon ?? 'bolt'} size={16} /></span>
          <span className="wz-auto-main">
            <b>{meta?.title ?? (a.when?.trim() ? `Quando ${a.when.trim()}` : 'Nova automação')}{sys && <span className="wz-pill soft">Obrigatória</span>}</b>
            <small><Icon name="arrowRight" size={11} />{summary(a)}{pausedFlow ? ' — fluxo pausado' : ''}</small>
          </span>
          <Icon name={isOpen ? 'chevronUp' : 'edit'} size={14} />
        </button>
        {isOpen && (
          <div className="wz-auto-body">
            {meta && <small className="faint">{meta.hint}</small>}
            {a.trigger === 'intent' && (
              <div><Lbl req>Quando o cliente…</Lbl>
                <input className="input" maxLength={400} value={a.when ?? ''} onChange={(e) => update(a.key, { when: e.target.value })} placeholder="Ex.: pedir o link de pagamento ou perguntar como pagar" data-testid="auto-when" autoFocus={!a.when} />
                <small className="faint">Descreva a intenção com as palavras do cliente. A IA decide quando ela aparece na conversa.</small>
              </div>
            )}
            {a.trigger === 'handoff' && (
              <div><Lbl hint="opcional">Quando exatamente</Lbl>
                <input className="input" maxLength={500} value={draft.handoffWhen} onChange={(e) => set('handoffWhen', e.target.value)} placeholder="quando a pessoa pedir para falar com alguém, estiver irritada ou perguntar algo que ele não sabe" data-testid="ed-handoff-when" />
              </div>
            )}
            <div><Lbl>O que fazer</Lbl>
              <select className="select" value={a.action} onChange={(e) => update(a.key, { action: e.target.value as AutoAction })} data-testid="auto-action">
                {ACTIONS_FOR[a.trigger].map((v) => <option key={v} value={v}>{ACTION_LABEL[v]}</option>)}
              </select>
            </div>
            {a.action === 'flow' && (
              <div><Lbl req>Fluxo</Lbl>
                <select className="select" value={a.flowId ?? ''} onChange={(e) => update(a.key, { flowId: e.target.value || null })} data-testid="auto-flow">
                  <option value="">Escolha um fluxo…</option>
                  {opt.flows.map((f) => <option key={f.id} value={f.id}>{f.name}{f.status === 'active' ? '' : ' (pausado)'}</option>)}
                </select>
                {pausedFlow && <div className="hint"><Icon name="alert" size={14} />Esse fluxo está pausado: ative em <Link to={`/flows/${a.flowId}`}>Fluxos</Link> para o agente conseguir disparar.</div>}
                {!opt.flows.length && <small className="faint">Nenhum fluxo ainda — crie um em <Link to="/flows">Fluxos</Link>.</small>}
              </div>
            )}
            {a.action === 'handoff' && opt.departments.length > 0 && (
              <div><Lbl hint="opcional">Mandar para o setor</Lbl>
                <select className="select" value={a.departmentId ?? ''} onChange={(e) => update(a.key, { departmentId: e.target.value || null })} data-testid="auto-dept">
                  <option value="">Fila geral (qualquer pessoa da equipe)</option>
                  {opt.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            )}
            {(a.action === 'tag' || a.action === 'handoff' || a.action === 'flow' || a.action === 'close') && (
              <div><Lbl req={a.action === 'tag'} hint={a.action === 'tag' ? undefined : 'opcional'}>Etiqueta</Lbl>
                <input className="input" list="wz-tags" maxLength={40} value={a.tag ?? ''} onChange={(e) => update(a.key, { tag: e.target.value || null })} placeholder="Ex.: quer comprar" data-testid="auto-tag" />
              </div>
            )}
            {(a.action === 'reply' || a.action === 'handoff' || a.action === 'close') && (
              <div><Lbl req={a.action === 'reply'} hint={a.action === 'reply' ? 'enviada exatamente assim' : 'opcional, se a IA não escrever nada'}>Mensagem</Lbl>
                <textarea className="input" rows={2} maxLength={1000} value={a.message ?? ''} onChange={(e) => update(a.key, { message: e.target.value })}
                  placeholder={a.action === 'reply' ? 'Ex.: Nosso endereço é Rua das Flores, 120 — Centro.' : 'Ex.: Vou chamar alguém da equipe, só um instante!'} data-testid="auto-message" />
              </div>
            )}
            <div className="wz-auto-acts">
              {!sys && !ro && <button type="button" className="btn ghost danger sm" onClick={() => { set('automations', list.filter((x) => x.key !== a.key)); setOpen(null); }} data-testid="auto-remove"><Icon name="trash" size={14} />Remover</button>}
              <span className="spacer" />
              <button type="button" className="btn sm" onClick={() => setOpen(null)}>Pronto</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="wz-stack">
      <Block title="Automações" desc="O que o agente faz quando percebe certas situações na conversa. As obrigatórias sempre existem; ajuste o que cada uma faz." testId="sec-actions">
        <div className="wz-list">{list.filter((a) => a.trigger !== 'intent').map(row)}</div>
      </Block>
      <Block title="Automações personalizadas" desc="Ações para intenções do seu negócio: disparar o checkout, marcar quem quer agendar, mandar o endereço…"
        right={<small className="faint" data-testid="auto-count">{MAX_CUSTOM - intents.length} restantes</small>}>
        {intents.length > 0 && <div className="wz-list">{intents.map(row)}</div>}
        {!ro && intents.length < MAX_CUSTOM && <button type="button" className="btn sm wz-add" onClick={addIntent} data-testid="auto-add"><Icon name="plus" size={14} />Adicionar automação</button>}
      </Block>
      <datalist id="wz-tags">{opt.tags.map((t) => <option key={t.name} value={t.name} />)}</datalist>
    </div>
  );
}
