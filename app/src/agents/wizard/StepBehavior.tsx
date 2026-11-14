import { useState } from 'react';
import { Icon } from '../../icons';
import { cx } from '../../components/ui';
import type { AgentDraft, EmojiUse, Formality, Pace } from '../types';
import { Block, Choice, Lbl, type StepProps } from './common';

/** Barrinhas que mostram o tamanho das mensagens de cada ritmo. */
const Bars = ({ n, w }: { n: number; w: number[] }) => (
  <span className="wz-bars" aria-hidden>{Array.from({ length: n }, (_, i) => <i key={i} style={{ width: `${w[i] ?? 60}%` }} />)}</span>
);

const PACES: { v: Pace; label: string; desc: string; art: JSX.Element }[] = [
  { v: 'dynamic', label: 'Rápido', desc: 'Uma ideia por mensagem, bem curtinha', art: <Bars n={1} w={[35]} /> },
  { v: 'natural', label: 'Natural', desc: 'Como uma pessoa digitando no WhatsApp', art: <Bars n={2} w={[55, 35]} /> },
  { v: 'balanced', label: 'Equilibrado', desc: 'Responde a dúvida inteira, sem textão', art: <Bars n={2} w={[80, 55]} /> },
  { v: 'detailed', label: 'Detalhado', desc: 'Explica mais quando o assunto pede', art: <Bars n={3} w={[90, 80, 50]} /> },
  { v: 'analytic', label: 'Analítico', desc: 'Compara opções e organiza em tópicos', art: <Bars n={4} w={[90, 70, 70, 70]} /> },
];
const TONES: { v: Formality; label: string; desc: string; icon: string }[] = [
  { v: 'formal', label: 'Formal', desc: 'Cortês, sem gírias', icon: 'bookmark' },
  { v: 'professional', label: 'Profissional', desc: 'Direto e gentil', icon: 'bag' },
  { v: 'casual', label: 'Casual', desc: 'Leve e próximo', icon: 'smile' },
  { v: 'relaxed', label: 'Descontraído', desc: 'Bem-humorado', icon: 'sparkles' },
];
const EMOJIS: { v: EmojiUse; label: string; desc: string; icon: string }[] = [
  { v: 'none', label: 'Nenhum', desc: 'Só texto', icon: 'minus' },
  { v: 'discreet', label: 'Pouco', desc: 'De vez em quando', icon: 'smile' },
  { v: 'natural', label: 'Natural', desc: 'Um por mensagem', icon: 'chat' },
  { v: 'expressive', label: 'Bastante', desc: 'Conversa animada', icon: 'gift' },
];

/** Conversa de exemplo montada com as escolhas (sem gastar IA). */
function sample(d: AgentDraft): { from: 'c' | 'a'; text: string }[] {
  const name = d.name.trim() || 'Bia';
  const e = (s: string) => (d.emoji === 'none' ? '' : d.emoji === 'discreet' ? '' : ` ${s}`);
  const e2 = (s: string) => (d.emoji === 'expressive' ? ` ${s}` : '');
  const hi = { formal: 'Bom dia!', professional: 'Olá!', casual: 'Oi, tudo bem?', relaxed: 'Opa, tudo certo?' }[d.formality];
  const me = d.identity === 'ai' ? `Sou ${name}, assistente virtual da empresa` : `Aqui é ${name}, da equipe`;
  const help = { formal: 'Em que posso ajudá-lo(a)?', professional: 'Como posso te ajudar?', casual: 'Me conta, como posso te ajudar?', relaxed: 'Bora resolver o que você precisa?' }[d.formality];
  const greet = d.pace === 'dynamic' ? [`${hi}${e('😊')}`, `${help}`] : [`${hi} ${me}.${e('😊')} ${help}${e2('✨')}`];
  const answer: Record<Pace, string[]> = {
    dynamic: [`É bem simples!${e2('🙌')}`, 'Você escolhe o horário e eu já reservo.'],
    natural: [`É bem simples${e('🙂')}`, `Você me diz o melhor dia e horário e eu deixo tudo encaminhado por aqui.${e2('📅')}`],
    balanced: [`Funciona assim: você escolhe o serviço e o melhor dia e horário, e eu deixo tudo encaminhado por aqui mesmo. A confirmação chega nesta conversa.${e('🙂')}`],
    detailed: [`Funciona assim:${e('🙂')}`, 'Primeiro você me conta qual serviço procura. Depois eu vejo os horários disponíveis e te passo as opções. Assim que você escolher, a confirmação chega aqui mesmo, com todos os detalhes.'],
    analytic: [`Ótima pergunta${e('👍')} Temos dois caminhos:`, '• Agendar agora: você escolhe dia e horário e recebe a confirmação aqui.\n• Tirar dúvidas antes: te explico valores e preparo, e agendamos depois.'],
  };
  const ask = { formal: 'Poderia me informar o seu nome completo?', professional: 'Pode me passar seu nome completo?', casual: 'Qual é o seu nome completo?', relaxed: 'Me passa seu nome completo?' }[d.formality];
  return [
    { from: 'c', text: 'Oi, quero agendar um horário' },
    ...greet.map((t) => ({ from: 'a' as const, text: t })),
    { from: 'c', text: 'Como funciona?' },
    ...answer[d.pace].map((t) => ({ from: 'a' as const, text: t })),
    { from: 'a', text: `${ask}${e2('😉')}` },
  ];
}

export function StepBehavior({ draft, set }: StepProps) {
  const [more, setMore] = useState(!!(draft.tone || draft.rules));
  const conv = sample(draft);
  const signed = (t: string) => (draft.signMessages ? `*${draft.name.trim() || 'Bia'}:*\n${t}` : t);
  return (
    <div className="wz-split">
      <div className="wz-stack">
        <Block title="Como ele se apresenta" testId="sec-style">
          <Choice value={draft.identity} onChange={(v) => set('identity', v)} cols={2} testId="ed-identity" options={[
            { v: 'human', label: 'Como pessoa da equipe', desc: 'Conversa como um atendente; se perguntarem, é honesto', icon: 'user' },
            { v: 'ai', label: 'Como assistente virtual', desc: 'Já se apresenta como assistente da empresa', icon: 'bot' },
          ]} />
        </Block>
        <Block title="Ritmo da conversa" desc={PACES.find((p) => p.v === draft.pace)?.desc}>
          <Choice value={draft.pace} onChange={(v) => set('pace', v)} testId="ed-pace" options={PACES} />
        </Block>
        <Block title="Tom" desc={TONES.find((p) => p.v === draft.formality)?.desc}>
          <Choice value={draft.formality} onChange={(v) => set('formality', v)} testId="ed-formality" options={TONES} />
        </Block>
        <Block title="Emojis" desc={EMOJIS.find((p) => p.v === draft.emoji)?.desc}>
          <Choice value={draft.emoji} onChange={(v) => set('emoji', v)} testId="ed-emoji" options={EMOJIS} />
        </Block>
        <div className={cx('wz-more', more && 'open')}>
          <button type="button" className="wz-more-hd" onClick={() => setMore(!more)} aria-expanded={more} data-testid="ed-more">
            <Icon name={more ? 'chevronUp' : 'chevron'} size={15} /><b>Ajustes finos</b><small>instruções, jeito de falar e o que ele nunca deve fazer</small>
          </button>
          {more && <div className="wz-more-body">
            <div><Lbl hint="um passo por linha">Instruções de atendimento</Lbl><textarea className="input" rows={5} value={draft.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} placeholder={'Ex.: Sempre pergunte o objetivo do cliente antes de indicar um plano.'} data-testid="ed-instructions" /></div>
            <div><Lbl hint="opcional">Jeito de falar (detalhes)</Lbl><textarea className="input" rows={2} value={draft.tone} onChange={(e) => set('tone', e.target.value)} placeholder="Ex.: Chame o cliente pelo primeiro nome. Evite a palavra “promoção”." data-testid="ed-tone" /></div>
            <div><Lbl hint="uma por linha">O que ele nunca deve fazer</Lbl><textarea className="input" rows={3} value={draft.rules} onChange={(e) => set('rules', e.target.value)} placeholder={'Não ofereça desconto\nNão prometa prazo de entrega'} data-testid="ed-rules" /></div>
            <small className="faint">Ele já nunca inventa preço, link ou prazo, e nunca pede senha ou dados de cartão.</small>
          </div>}
        </div>
      </div>
      <aside className="wz-preview" data-testid="wz-preview">
        <div className="wz-preview-hd"><Icon name="eye" size={14} />Exemplo de conversa<small>muda conforme suas escolhas</small></div>
        <div className="wz-preview-body">
          {conv.map((m, i) => (
            <div key={i} className={cx('wz-bubble', m.from === 'a' ? 'out' : 'in')}>{(m.from === 'a' ? signed(m.text) : m.text).split('\n').map((l, j) => <span key={j}>{l.replace(/^\*(.+):\*$/, '$1:')}</span>)}</div>
          ))}
        </div>
        <small className="faint">É só uma ilustração do estilo: as respostas de verdade usam o que o agente sabe. Teste na última etapa.</small>
      </aside>
    </div>
  );
}
