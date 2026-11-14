import { useMemo, useState } from 'react';
import { Icon } from '../../icons';
import { Switch, cx, toast } from '../../components/ui';
import { AgentAvatar, AVATAR_KEYS, avatarLabel } from '../AgentAvatar';
import { defaultAutomations } from '../util';
import type { SectorFunction } from '../types';
import { Block, Lbl, type StepProps } from './common';

const LANGS: [string, string][] = [
  ['pt-BR', 'Português do Brasil'], ['pt-PT', 'Português de Portugal'], ['en-US', 'Inglês'], ['es', 'Espanhol'], ['fr', 'Francês'], ['it', 'Italiano'], ['de', 'Alemão'],
];

export function StepProfile({ draft, set, patch, opt, sectors, isNew }: StepProps) {
  const [sectorId, setSectorId] = useState(draft.sector || '');
  const [picked, setPicked] = useState<string | null>(null);
  const sector = useMemo(() => sectors.find((s) => s.id === sectorId) ?? null, [sectors, sectorId]);
  const modelOptions = useMemo(() => {
    const list = opt.models ?? [];
    return !list.some((m) => m.id === draft.model) ? [...list, { id: draft.model, label: draft.model }] : list;
  }, [opt, draft.model]);

  function apply(f: SectorFunction) {
    const system = draft.automations.filter((a) => a.trigger !== 'intent');
    patch({
      sector: sectorId, role: f.role, systemPrompt: f.systemPrompt, stages: structuredClone(f.stages), handoffWhen: f.handoffWhen,
      description: f.description,
      automations: [...(system.length ? system : defaultAutomations()), ...f.automations.map((a) => ({ ...a, key: `${a.key}_${Date.now().toString(36)}` }))],
    });
    setPicked(f.id);
    if (!isNew) toast(`Modelo “${f.name}” aplicado: instruções, etapas e automações foram trocadas`);
  }

  return (
    <div className="wz-stack">
      <Block title="Comece com um modelo" desc="Escolha o setor e a função: preenchemos as instruções, as etapas da conversa e as automações. Dá para mudar tudo depois." testId="wz-template">
        <div className="wz-sector">
          <Lbl>Setor da sua empresa</Lbl>
          <select className="select" value={sectorId} onChange={(e) => { setSectorId(e.target.value); setPicked(null); set('sector', e.target.value); }} data-testid="wz-sector">
            <option value="">Escolha o setor…</option>
            {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {sector && <>
          <Lbl>Função do agente</Lbl>
          <div className="wz-fns" data-testid="wz-functions">
            {sector.functions.map((f) => (
              <button type="button" key={f.id} className={cx('wz-fn', picked === f.id && 'on')} onClick={() => apply(f)} data-testid="wz-fn">
                <span className="wz-fn-top"><b>{f.name}</b>{f.popular && <span className="wz-pill">Mais usado</span>}{picked === f.id && <Icon name="checkCircle" size={16} />}</span>
                <span className="wz-fn-desc">{f.description}</span>
                <span className="wz-fn-ideal"><Icon name="target" size={12} />{f.idealFor}</span>
              </button>
            ))}
          </div>
        </>}
        {!sector && <small className="faint">Sem modelo? Pule e configure do zero nas próximas etapas.</small>}
      </Block>

      <Block title="Identidade do agente" desc="Como ele aparece para o cliente" testId="sec-profile">
        <div className="wz-ident">
          <div className="wz-ident-fields">
            <div className="wz-row">
              <div className="wz-grow">
                <Lbl req hint={`${draft.name.length}/40`}>Nome do agente</Lbl>
                <input className="input" maxLength={40} value={draft.name} placeholder="Ex.: Bia" onChange={(e) => set('name', e.target.value)} data-testid="ed-name" autoFocus={isNew} />
              </div>
              <div className="wz-grow">
                <Lbl>Idioma das respostas</Lbl>
                <select className="select" value={draft.language} onChange={(e) => set('language', e.target.value)} data-testid="ed-language">
                  {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
            <label className="wz-toggle" data-testid="ed-sign">
              <Switch on={draft.signMessages} onClick={() => set('signMessages', !draft.signMessages)} />
              <span><b>Assinar as mensagens</b><small>Coloca <code>*{draft.name.trim() || 'Nome'}:*</code> no começo de cada mensagem, para o cliente saber quem está falando.</small></span>
            </label>
            <div><Lbl hint="aparece na lista de agentes">Descrição</Lbl>
              <input className="input" maxLength={240} value={draft.description} onChange={(e) => set('description', e.target.value)} placeholder="Ex.: Atende quem chega do anúncio e agenda a aula experimental" data-testid="ed-description" />
            </div>
            <div><Lbl>Modelo de IA</Lbl>
              <select className="select" value={draft.model} onChange={(e) => set('model', e.target.value)} data-testid="ed-model">
                {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div className="wz-avatar">
            <AgentAvatar avatar={draft.avatar} size={84} />
            <Lbl>Avatar</Lbl>
            <div className="ag-avatars">
              {AVATAR_KEYS.map((k) => (
                <button type="button" key={k} className={cx(draft.avatar === k && 'on')} onClick={() => set('avatar', k)} title={avatarLabel(k)} aria-label={`Avatar ${avatarLabel(k)}`}>
                  <AgentAvatar avatar={k} size={30} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </Block>
    </div>
  );
}
