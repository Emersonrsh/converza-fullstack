import { Link } from 'react-router-dom';
import { Icon } from '../../icons';
import { Switch, cx } from '../../components/ui';
import { TagPicker } from '../../components/TagPicker';
import { TestChat } from '../TestChat';
import { OUTCOME_LABEL, REPLY_AUDIO_LABEL, ago } from '../util';
import type { ReplyAudio } from '../types';
import { Block, Lbl, type StepProps } from './common';

export function StepActivate({ draft, set, opt, ro, isNew, agent, recent }: StepProps) {
  return (
    <div className="wz-split wide">
      <fieldset className="wz-stack wz-fs" disabled={ro}>
        <Block title="Onde ele atende" desc="Números e público" testId="sec-where">
          <div>
            <Lbl>Conexões</Lbl>
            {opt.connections.length ? (
              <div className="ag-checks">
                {opt.connections.map((c) => (
                  <label key={c.id} className="ag-check">
                    <input type="checkbox" checked={draft.connectionIds.includes(c.id)} data-testid="ed-conn"
                      onChange={(e) => set('connectionIds', e.target.checked ? [...draft.connectionIds, c.id] : draft.connectionIds.filter((x) => x !== c.id))} />
                    <span>{c.name}{c.displayPhone ? <span className="lbl-hint"> · {c.displayPhone}</span> : null}</span>
                  </label>
                ))}
              </div>
            ) : <small className="faint">Nenhuma conexão ainda — conecte um número em <Link to="/connections">Conexões</Link>.</small>}
            <small className="faint">{draft.connectionIds.length ? 'Responde só nesses números.' : 'Nenhuma marcada = responde em todos os números.'}</small>
          </div>
          <div>
            <Lbl>Quem ele atende</Lbl>
            <div className="ag-radios">
              {([['all', 'Todos os contatos'], ['ads', 'Só quem chegou por anúncio'], ['tags', 'Só contatos com etiqueta']] as const).map(([v, l]) => (
                <label key={v} className={cx('ag-radio', draft.audience === v && 'on')}>
                  <input type="radio" name="audience" checked={draft.audience === v} onChange={() => set('audience', v)} data-testid={`ed-audience-${v}`} />{l}
                </label>
              ))}
            </div>
            {draft.audience === 'tags' && <div style={{ marginTop: 8 }}><TagPicker value={draft.audienceTags} onChange={(v) => set('audienceTags', v)} allowCreate={false} placeholder="Escolha as etiquetas…" testId="ed-audience-picker" /></div>}
          </div>
          <small className="faint">Fluxos com gatilho têm prioridade: o agente responde quando nenhum fluxo tratou a mensagem. Quando alguém da equipe responde, a automação pausa naquela conversa.</small>
        </Block>

        <Block title="Áudio" desc="Responder em mensagem de voz e entender os áudios do cliente" testId="sec-audio">
          {!opt.voiceEnabled && <div className="hint"><Icon name="info" size={14} />Áudio ainda não está disponível no servidor. Por enquanto ele responde em texto.</div>}
          <div className="ag-radios col">
            {(Object.keys(REPLY_AUDIO_LABEL) as ReplyAudio[]).map((v) => (
              <label key={v} className={cx('ag-radio', draft.replyAudio === v && 'on')}>
                <input type="radio" name="replyAudio" checked={draft.replyAudio === v} onChange={() => set('replyAudio', v)} data-testid={`ed-audio-${v}`} />{REPLY_AUDIO_LABEL[v]}
              </label>
            ))}
          </div>
          {draft.replyAudio !== 'never' && (
            <div><Lbl>Voz</Lbl>
              <select className="select" value={draft.voiceId ?? ''} onChange={(e) => set('voiceId', e.target.value || null)} data-testid="ed-voice">
                <option value="">Padrão da plataforma</option>
                {opt.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <small className="faint">Quer a sua voz? <Link to="/agents?aba=vozes">Crie uma voz</Link> com 1 a 3 áudios.</small>
            </div>
          )}
          <label className="wz-toggle">
            <Switch on={draft.transcribeAudio} onClick={() => !ro && set('transcribeAudio', !draft.transcribeAudio)} />
            <span><b>Entender os áudios do cliente</b><small>Transcreve as mensagens de voz para o agente ler — e a equipe também vê o texto no Chats.</small></span>
          </label>
          <small className="faint">Custo: cerca de {opt.voiceCost.perChar} token{opt.voiceCost.perChar === 1 ? '' : 's'} por letra falada e {opt.voiceCost.perMinute.toLocaleString('pt-BR')} tokens por minuto de áudio transcrito.</small>
        </Block>

        <Block title="Ritmo de resposta" testId="sec-advanced">
          <div className="ag-two">
            <div><Lbl hint="0 a 60 s">Esperar o cliente terminar de escrever</Lbl>
              <input className="input" type="number" min={0} max={60} value={draft.waitSeconds} onChange={(e) => set('waitSeconds', Math.max(0, Math.min(60, Number(e.target.value) || 0)))} data-testid="ed-wait" />
              <small className="faint">Junta as mensagens seguidas antes de responder.</small>
            </div>
            <div><Lbl hint="por conversa">Respostas por dia</Lbl>
              <input className="input" type="number" min={1} max={500} value={draft.maxRepliesPerDay} onChange={(e) => set('maxRepliesPerDay', Math.max(1, Math.min(500, Number(e.target.value) || 1)))} data-testid="ed-max" />
              <small className="faint">Ao chegar no limite, segue a automação “limite de respostas”.</small>
            </div>
          </div>
        </Block>

        <Block title="Ativação" testId="sec-activate">
          <label className={cx('wz-toggle big', draft.enabled && 'on')}>
            <Switch on={draft.enabled} onClick={() => !ro && set('enabled', !draft.enabled)} />
            <span><b data-testid="ed-enabled-state">{draft.enabled ? 'Ativo: responde no WhatsApp' : 'Pausado: só no teste'}</b>
              <small>{draft.enabled ? 'Assim que salvar, ele começa a atender as novas mensagens.' : 'Teste à vontade ao lado e ative quando estiver pronto.'}</small></span>
          </label>
        </Block>

        {!isNew && (
          <Block title="Atividade recente" testId="sec-activity">
            {recent.length ? (
              <div className="ag-runs">
                {recent.map((r, i) => (
                  <Link key={i} to={`/inbox?c=${r.conversationId}`} className={cx('ag-run', r.outcome)} data-testid="agent-run">
                    <b>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</b><span>{r.contactName}{r.detail ? ` · ${r.detail}` : ''}</span><small className="faint">{ago(r.createdAt)}</small>
                  </Link>
                ))}
              </div>
            ) : <small className="faint">Quando ele atender alguém, aparece aqui.</small>}
          </Block>
        )}
      </fieldset>
      <aside className="wz-test">
        <TestChat agentId={agent?.id ?? null} draft={draft} aiEnabled={opt.aiEnabled} voiceEnabled={opt.voiceEnabled} />
      </aside>
    </div>
  );
}
