import { Icon } from '../../icons';
import type { Stage } from '../types';
import { Block, EmptyBox, Lbl, type StepProps } from './common';

const SUGGESTED: Stage[] = [
  { name: 'Boas-vindas', goal: 'Cumprimente, apresente-se e pergunte como pode ajudar.' },
  { name: 'Entender a necessidade', goal: 'Descubra o que a pessoa procura, uma pergunta por vez.' },
  { name: 'Apresentar a solução', goal: 'Indique a opção certa usando só o que você sabe.' },
  { name: 'Próximo passo', goal: 'Leve a pessoa para a compra, o agendamento ou a equipe.' },
];

export function StepStages({ draft, set, ro }: StepProps) {
  const stages = draft.stages;
  const put = (i: number, p: Partial<Stage>) => set('stages', stages.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= stages.length) return;
    const next = [...stages]; [next[i], next[j]] = [next[j], next[i]]; set('stages', next);
  };
  const add = () => set('stages', [...stages, { name: '', goal: '' }]);

  return (
    <div className="wz-stack">
      <Block title="Etapas da conversa" desc="O roteiro que o agente segue em cada atendimento, na ordem. Ele percebe em que etapa a conversa está e não pula etapas sem motivo." testId="sec-stages">
        {stages.length === 0 ? (
          <EmptyBox icon="flow" title="Sem etapas, ele conversa livremente" text="Com etapas, o atendimento fica previsível: por exemplo, dar boas-vindas, entender a necessidade e encaminhar para a venda.">
            {!ro && <div className="wz-empty-acts">
              <button type="button" className="btn primary sm" onClick={add} data-testid="stage-add"><Icon name="plus" size={14} />Nova etapa</button>
              <button type="button" className="btn sm" onClick={() => set('stages', structuredClone(SUGGESTED))} data-testid="stage-suggest"><Icon name="sparkles" size={14} />Usar um roteiro básico</button>
            </div>}
          </EmptyBox>
        ) : (
          <ol className="wz-stages" data-testid="stage-list">
            {stages.map((s, i) => (
              <li key={i} className="wz-stage" data-testid="stage-row">
                <span className="wz-stage-n">{i + 1}</span>
                <div className="wz-stage-body">
                  <div className="wz-row">
                    <div className="wz-grow"><Lbl req>Nome da etapa</Lbl><input className="input" maxLength={60} value={s.name} onChange={(e) => put(i, { name: e.target.value })} placeholder="Ex.: Entender a necessidade" data-testid="stage-name" /></div>
                  </div>
                  <div><Lbl>O que o agente faz nesta etapa</Lbl><textarea className="input" rows={2} maxLength={600} value={s.goal} onChange={(e) => put(i, { goal: e.target.value })} placeholder="Ex.: Pergunte qual é o objetivo da pessoa e se ela já treina." data-testid="stage-goal" /></div>
                  <div><Lbl hint="opcional">Avança para a próxima quando…</Lbl><input className="input" maxLength={300} value={s.advanceWhen ?? ''} onChange={(e) => put(i, { advanceWhen: e.target.value })} placeholder="Ex.: souber o objetivo e a disponibilidade de horário" data-testid="stage-advance" /></div>
                </div>
                {!ro && <div className="wz-stage-acts">
                  <button type="button" className="btn icon sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir etapa"><Icon name="chevronUp" size={14} /></button>
                  <button type="button" className="btn icon sm ghost" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label="Descer etapa"><Icon name="chevron" size={14} /></button>
                  <button type="button" className="btn icon sm ghost" onClick={() => set('stages', stages.filter((_, j) => j !== i))} aria-label="Remover etapa" data-testid="stage-remove"><Icon name="trash" size={14} /></button>
                </div>}
              </li>
            ))}
          </ol>
        )}
        {!ro && stages.length > 0 && stages.length < 12 && <button type="button" className="btn sm wz-add" onClick={add} data-testid="stage-add"><Icon name="plus" size={14} />Nova etapa</button>}
      </Block>
    </div>
  );
}
