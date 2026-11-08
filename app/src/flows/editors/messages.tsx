import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../icons';
import { cx } from '../../components/ui';
import { api } from '../../api';
import { rid, sanitizeVarName } from '../blocks';
import {
  Duration, Field, FileOrUrl, HowItWorks, Picker, RichText, Section, Tabs, ToggleCard, VarInput, moveItem, UNITS,
} from './fields';
import type { D, EditorProps, Tpl } from './types';

const SHORT_UNITS = UNITS.filter(([u]) => u !== 'seconds');

/* ------------------------------------------------------------------ Mensagem */

export const CONTENT_TYPES: [string, string, string][] = [
  ['text', 'Texto', 'chat'], ['image', 'Imagem', 'image'], ['video', 'Vídeo', 'video'], ['audio', 'Áudio', 'mic'],
  ['interval', 'Intervalo', 'clock'], ['contact', 'Contato', 'contact'], ['file', 'Arquivo', 'file'], ['sticker', 'Sticker', 'sticker'],
];
const contentLabel = (t: string) => CONTENT_TYPES.find((c) => c[0] === t)?.[1] ?? t;
const contentIcon = (t: string) => CONTENT_TYPES.find((c) => c[0] === t)?.[2] ?? 'file';

function newItem(type: string): D {
  const id = rid('it');
  switch (type) {
    case 'text': return { id, type, text: '' };
    case 'interval': return { id, type, amount: 3, unit: 'seconds' };
    case 'contact': return { id, type, name: '', phone: '' };
    default: return { id, type, url: '', fileId: '', fileName: '', caption: '', filename: '' };
  }
}

function ContentGrid({ onPick }: { onPick: (type: string) => void }) {
  return (
    <div className="bm-grid" data-testid="content-grid">
      {CONTENT_TYPES.map(([t, label, icon]) => (
        <button type="button" key={t} onClick={() => onPick(t)} data-testid={`add-${t}`}>
          <span><Icon name={icon} size={18} /></span>{label}
        </button>
      ))}
    </div>
  );
}

function ItemBody({ it, upd, vars, i }: { it: D; upd: (p: D) => void; vars: string[]; i: number }) {
  const media = (kind: 'image' | 'video' | 'audio' | 'document' | 'sticker') => (
    <FileOrUrl kind={kind} url={it.url ?? ''} fileId={it.fileId ?? ''} fileName={it.fileName} vars={vars} testId={`item-${i}-file`}
      onChange={(v) => upd(v)} />
  );
  switch (it.type) {
    case 'text':
      return <RichText value={it.text ?? ''} onChange={(text) => upd({ text })} vars={vars} rows={4} maxLength={4096} showCount
        placeholder="Olá {{primeiro_nome}}! Como posso ajudar?" testId={`item-${i}-text`} />;
    case 'image':
    case 'video':
      return (<>
        {media(it.type)}
        <Field label="Legenda (opcional)">
          <RichText value={it.caption ?? ''} onChange={(caption) => upd({ caption })} vars={vars} rows={2} maxLength={1024} />
        </Field>
      </>);
    case 'audio':
      return (<>
        {media('audio')}
        <div className="bm-hint">Em OGG (Opus) o áudio aparece como mensagem de voz; nos outros formatos, como arquivo de áudio.</div>
      </>);
    case 'file':
      return (<>
        {media('document')}
        <Field label="Nome do arquivo para o cliente (opcional)">
          <VarInput value={it.filename ?? ''} onChange={(filename) => upd({ filename })} vars={vars} placeholder={it.fileName || 'catalogo.pdf'} />
        </Field>
        <Field label="Legenda (opcional)">
          <RichText value={it.caption ?? ''} onChange={(caption) => upd({ caption })} vars={vars} rows={2} maxLength={1024} />
        </Field>
      </>);
    case 'sticker':
      return media('sticker');
    case 'interval':
      return (<>
        <Duration amount={it.amount ?? 3} unit={it.unit ?? 'seconds'} min={1} onAmount={(amount) => upd({ amount })} onUnit={(unit) => upd({ unit })}
          units={UNITS.filter(([u]) => u !== 'days')} testId={`item-${i}-wait`} />
        <div className="bm-hint">Espera esse tempo antes do próximo conteúdo deste bloco (no fim do bloco não tem efeito).</div>
      </>);
    case 'contact':
      return (
        <div className="bm-row2">
          <Field label="Nome" required><VarInput value={it.name ?? ''} onChange={(name) => upd({ name })} vars={vars} placeholder="Suporte Clínica Sorriso" testId={`item-${i}-cname`} /></Field>
          <Field label="Telefone (com DDD)" required><VarInput value={it.phone ?? ''} onChange={(phone) => upd({ phone })} vars={vars} placeholder="+55 11 99999-0000" testId={`item-${i}-cphone`} /></Field>
        </div>
      );
    default:
      return null;
  }
}

export function MessageEditor({ d, set, vars }: EditorProps) {
  const items: D[] = Array.isArray(d.items) ? d.items : [];
  const [adding, setAdding] = useState(false);
  const put = (list: D[]) => set({ items: list });
  const upd = (i: number, patch: D) => put(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const add = (type: string) => { put([...items, newItem(type)]); setAdding(false); };

  return (
    <>
      {items.length === 0 ? (
        <div className="bm-emptybox">
          <span className="bm-empty-ic"><Icon name="chat" size={22} /></span>
          <b>Nenhum conteúdo ainda</b>
          <small>Escolha abaixo o que o cliente vai receber. Dá para juntar vários: texto, imagem, um intervalo e outro texto…</small>
        </div>
      ) : (
        <div className="bm-items">
          {items.map((it, i) => (
            <div className="bm-item" key={it.id ?? i} data-testid={`item-${i}`}>
              <div className="bm-item-h">
                <span className="bm-item-ic"><Icon name={contentIcon(it.type)} size={14} /></span>
                <b>{contentLabel(it.type)}</b>
                <span className="spacer" />
                <button type="button" className="btn icon sm ghost" disabled={i === 0} onClick={() => put(moveItem(items, i, -1))} aria-label="Subir">↑</button>
                <button type="button" className="btn icon sm ghost" disabled={i === items.length - 1} onClick={() => put(moveItem(items, i, 1))} aria-label="Descer">↓</button>
                <button type="button" className="btn icon sm ghost" onClick={() => put(items.filter((_, j) => j !== i))} aria-label="Remover conteúdo"><Icon name="trash" size={14} /></button>
              </div>
              <ItemBody it={it} i={i} vars={vars} upd={(p) => upd(i, p)} />
            </div>
          ))}
        </div>
      )}
      {items.length === 0 || adding ? (
        <Section title="Adicionar conteúdo" right={items.length > 0 ? <button type="button" className="btn sm ghost" onClick={() => setAdding(false)}>Fechar</button> : undefined}>
          <ContentGrid onPick={add} />
        </Section>
      ) : (
        <button type="button" className="bm-addline" onClick={() => setAdding(true)} data-testid="add-content"><Icon name="plus" size={14} />Adicionar conteúdo</button>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ templates */

function useTemplates(connectionId: string) {
  const [state, setState] = useState<{ list: Tpl[]; loading: boolean; error: string }>({ list: [], loading: false, error: '' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!connectionId) { setState({ list: [], loading: false, error: '' }); return; }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: '' }));
    api.get<{ templates: Tpl[] }>(`/templates?connectionId=${connectionId}&status=APPROVED${tick ? '&fresh=1' : ''}`)
      .then((r) => alive && setState({ list: r.templates, loading: false, error: '' }))
      .catch((e) => alive && setState({ list: [], loading: false, error: (e as Error).message }));
    return () => { alive = false; };
  }, [connectionId, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

const tplKey = (name: string, language: string) => `${name}|${language}`;

function WabaSelect({ value, onChange, wabas }: { value: string; onChange: (v: string) => void; wabas: EditorProps['lookups']['wabas'] }) {
  if (wabas.length <= 1) return null;
  return (
    <Field label="Conta do WhatsApp (WABA)" hint="O template precisa existir na mesma conta do número que conversa com o cliente.">
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)} data-testid="tpl-waba">
        {wabas.map((w) => <option key={w.id} value={w.id}>{w.name}{w.displayPhone ? ` (${w.displayPhone})` : ''}</option>)}
      </select>
    </Field>
  );
}

function fillPreview(text: string, values: Record<string, string>) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => (values[k]?.trim() ? values[k] : `{{${k}}}`));
}

export function TemplateEditor({ d, set, vars, lookups, triggerConnectionId }: EditorProps) {
  const fallbackConn = lookups.wabas.find((w) => w.id === triggerConnectionId)?.id ?? lookups.wabas[0]?.id ?? '';
  const conn = lookups.wabas.some((w) => w.id === d.connectionId) ? d.connectionId : fallbackConn;
  const tpl = useTemplates(conn);
  const names: string[] = Array.isArray(d.bodyVars) ? d.bodyVars : [];
  const values: Record<string, string> = d.vars && typeof d.vars === 'object' ? d.vars : {};
  const buttons: D[] = Array.isArray(d.buttons) ? d.buttons : [];
  const btnValues: Record<string, string> = d.buttonValues && typeof d.buttonValues === 'object' ? d.buttonValues : {};
  const current = d.name ? tplKey(d.name, d.language) : '';
  const opts = useMemo(() => {
    const list = tpl.list.map((t) => ({ value: tplKey(t.name, t.language), label: t.name, hint: `${t.language} · ${t.category.toLowerCase()}` }));
    if (current && !list.some((o) => o.value === current)) list.unshift({ value: current, label: d.name, hint: `${d.language} · selecionado` });
    return list;
  }, [tpl.list, current, d.name, d.language]);

  function choose(key: string) {
    if (!key) { set({ name: '', language: '', bodyText: '', bodyVars: [], vars: {}, headerFormat: '', headerVar: '', headerText: '', headerMediaUrl: '', buttons: [], buttonValues: {} }); return; }
    const t = tpl.list.find((x) => tplKey(x.name, x.language) === key);
    if (!t) return;
    set({
      connectionId: conn, name: t.name, language: t.language, paramFormat: t.paramFormat,
      bodyText: t.body, bodyVars: t.bodyVars, vars: Object.fromEntries(t.bodyVars.map((v) => [v, values[v] ?? ''])),
      headerFormat: t.header?.format ?? '', headerVar: t.header?.vars[0] ?? '', headerText: '', headerMediaUrl: '',
      buttons: t.buttons.map((b) => ({ type: b.type, text: b.text, url: b.url, hasVar: b.hasVar })), buttonValues: {},
    });
  }

  if (!lookups.wabas.length) {
    return (
      <div className="bm-emptybox">
        <span className="bm-empty-ic"><Icon name="plug" size={22} /></span>
        <b>Nenhum número na API oficial</b>
        <small>Templates vêm da sua conta do WhatsApp Business (Meta). Conecte um número em <b>Conexões</b> e crie os modelos em <b>Configurações › Templates WhatsApp</b>.</small>
      </div>
    );
  }
  const quick = buttons.filter((b) => String(b.type).toUpperCase() === 'QUICK_REPLY');
  const mediaHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(d.headerFormat));
  return (
    <>
      <WabaSelect value={conn} onChange={(v) => set({ connectionId: v })} wabas={lookups.wabas} />
      <Field label="Template aprovado" required
        right={<button type="button" className="linkbtn" onClick={tpl.reload} disabled={tpl.loading}><Icon name="refresh" size={12} />{tpl.loading ? 'Carregando…' : 'Atualizar'}</button>}
        warn={tpl.error || undefined}
        hint={!tpl.loading && !tpl.error && !tpl.list.length ? 'Nenhum template aprovado nesta conta. Crie em Configurações › Templates WhatsApp e espere a Meta aprovar.' : undefined}>
        <Picker value={current} options={opts} onChange={choose} placeholder="Buscar template…" testId="tpl-picker" />
      </Field>

      {d.name && (<>
        {String(d.headerFormat) === 'TEXT' && d.headerVar && (
          <Field label={`Variável do cabeçalho {{${d.headerVar}}}`} required>
            <VarInput value={d.headerText ?? ''} onChange={(headerText) => set({ headerText })} vars={vars} />
          </Field>
        )}
        {mediaHeader && (
          <Field label={`Link ${d.headerFormat === 'IMAGE' ? 'da imagem' : d.headerFormat === 'VIDEO' ? 'do vídeo' : 'do documento'} do cabeçalho`} required
            hint="Link público (https://…) ou variável. A Meta exige a mídia do cabeçalho a cada envio.">
            <VarInput value={d.headerMediaUrl ?? ''} onChange={(headerMediaUrl) => set({ headerMediaUrl })} vars={vars} placeholder="https://…" testId="tpl-header-media" />
          </Field>
        )}
        {names.length > 0 && (
          <Section title="Variáveis do texto" sub="O que vai em cada lugar do modelo. Pode misturar texto fixo e variáveis.">
            {names.map((v, i) => (
              <Field key={v} label={<code>{`{{${v}}}`}</code>}>
                <VarInput value={values[v] ?? ''} onChange={(val) => set({ vars: { ...values, [v]: val } })} vars={vars}
                  placeholder={i === 0 ? '{{primeiro_nome}}' : ''} testId={`tpl-var-${v}`} />
              </Field>
            ))}
          </Section>
        )}
        {buttons.some((b) => b.hasVar) && (
          <Section title="Botões com variável">
            {buttons.map((b, i) => (b.hasVar ? (
              <Field key={i} label={String(b.type).toUpperCase() === 'COPY_CODE' ? `Código do botão “${b.text}”` : `Final do link do botão “${b.text}”`}
                hint={b.url ? <span className="mono">{b.url}</span> : undefined}>
                <VarInput value={btnValues[i] ?? ''} onChange={(val) => set({ buttonValues: { ...btnValues, [i]: val } })} vars={vars} />
              </Field>
            ) : null))}
          </Section>
        )}
        <div className="bm-preview" data-testid="tpl-preview">
          <small>Prévia</small>
          <div className="bm-bubble">
            {d.bodyText ? fillPreview(String(d.bodyText), values) : <i className="faint">(template sem texto)</i>}
            {buttons.length > 0 && (
              <div className="bm-bubble-btns">{buttons.map((b, i) => <span key={i}>{String(b.type).toUpperCase() === 'URL' ? '🔗 ' : ''}{b.text}</span>)}</div>
            )}
          </div>
        </div>
        <Field label="Timeout de resposta" hint={quick.length
          ? `Espera o cliente tocar num botão ou responder. Cada botão de resposta (${quick.map((b) => b.text).join(', ')}) vira uma saída. Se 0, segue direto.`
          : 'Espera o cliente responder (saídas “Outra resposta” e “Sem resposta”). Se 0, o fluxo segue direto. Máximo: 31 dias.'}>
          <Duration amount={d.timeoutAmount ?? 60} unit={d.timeoutUnit ?? 'minutes'} onAmount={(timeoutAmount) => set({ timeoutAmount })} onUnit={(timeoutUnit) => set({ timeoutUnit })} testId="tpl-timeout" />
        </Field>
      </>)}
      <HowItWorks>
        Templates são as únicas mensagens que o WhatsApp entrega <b>fora da janela de 24 h</b> (quando o cliente não escreve há mais de um dia).
        A Meta cobra por template enviado, conforme a categoria (marketing, utilidade ou autenticação).
      </HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Botão PIX */

export const PIX_TYPES: [string, string, string][] = [
  ['evp', 'Chave aleatória', '123e4567-e89b-12d3-a456-426614174000'],
  ['cpf', 'CPF', '000.000.000-00'],
  ['cnpj', 'CNPJ', '00.000.000/0000-00'],
  ['email', 'E-mail', 'pix@suaempresa.com.br'],
  ['phone', 'Telefone', '+55 11 99999-0000'],
];

export function PixEditor({ d, set, vars }: EditorProps) {
  const type = PIX_TYPES.find((t) => t[0] === d.keyType) ?? PIX_TYPES[0];
  return (
    <>
      <div className="bm-row2">
        <Field label="Tipo da chave" required>
          <select className="select" value={type[0]} onChange={(e) => set({ keyType: e.target.value })} data-testid="pix-type">
            {PIX_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Chave Pix" required>
          <VarInput value={d.key ?? ''} onChange={(key) => set({ key })} vars={vars} placeholder={type[2]} testId="pix-key" />
        </Field>
      </div>
      <div className="bm-row2">
        <Field label="Destinatário" required hint="Nome de quem recebe (aparece no app do banco).">
          <VarInput value={d.merchantName ?? ''} onChange={(merchantName) => set({ merchantName })} vars={vars} placeholder="Clínica Sorriso" maxLength={60} testId="pix-merchant" />
        </Field>
        <Field label="Valor (R$)" required hint="Ex.: 49,90 ou {{valor}}.">
          <VarInput value={String(d.amount ?? '')} onChange={(amount) => set({ amount })} vars={vars} placeholder="49,90" testId="pix-amount" />
        </Field>
      </div>
      <Field label="Texto do cartão">
        <RichText value={d.text ?? ''} onChange={(text) => set({ text })} vars={[...vars, 'valor', 'chave']} rows={3} maxLength={1024} showCount
          placeholder="Seu pedido ficou em {{valor}}. Toque em “Copiar código Pix” e pague no app do seu banco 💚" testId="pix-text" />
      </Field>
      <Field label="Imagem do cartão (opcional)">
        <FileOrUrl kind="image" url={d.imageUrl ?? ''} fileId={d.imageFileId ?? ''} fileName={d.imageName} vars={vars} testId="pix-image"
          onChange={(v) => set({ imageUrl: v.url, imageFileId: v.fileId, imageName: v.fileName })} />
      </Field>
      <HowItWorks>
        O cliente recebe um cartão de pagamento com o botão <b>Copiar código Pix</b> (Pix copia e cola gerado com a sua chave e o valor).
        Para o cartão aparecer, a sua conta do WhatsApp precisa estar habilitada para pagamentos no Brasil; se não estiver, o Converza manda o texto e o código Pix em mensagens normais.
        O código fica em <code>{'{{pix.codigo}}'}</code>. Para confirmar o pagamento, use depois um <b>Aguarda Resposta</b> + <b>Bloco de IA</b> com “Identificar comprovante”.
      </HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Menu */

function ExpireField({ d, set, what }: { d: D; set: (p: D) => void; what: string }) {
  return (
    <Field label="Tempo de expiração" hint={`Se 0, o padrão é 2 dias. Limite máximo: 31 dias. Com tempo definido, aparece a saída “Inatividade” para quem não ${what}.`}>
      <Duration amount={d.expireAmount ?? 0} unit={d.expireUnit ?? 'days'} onAmount={(expireAmount) => set({ expireAmount })} onUnit={(expireUnit) => set({ expireUnit })}
        units={SHORT_UNITS} testId="expire" />
    </Field>
  );
}

export function MenuEditor({ d, set, vars }: EditorProps) {
  const style = d.style === 'buttons' ? 'buttons' : 'list';
  const options: D[] = Array.isArray(d.options) ? d.options : [];
  const max = style === 'buttons' ? 3 : 10;
  const titleMax = style === 'buttons' ? 20 : 24;
  const upd = (i: number, patch: D) => set({ options: options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  return (
    <>
      <Tabs value={style} options={[['list', 'Lista', 'list'], ['buttons', 'Botões', 'grid']]} onChange={(s) => set({ style: s })} testId="menu-style" />
      <div className="bm-hint" style={{ marginTop: -6, marginBottom: 12 }}>
        {style === 'list' ? 'Um botão abre a lista com até 10 opções (com descrição).' : 'Até 3 botões direto na mensagem.'}
      </div>
      <Field label="Mensagem" required>
        <RichText value={d.text ?? ''} onChange={(text) => set({ text })} vars={vars} rows={3} maxLength={1024} showCount placeholder="Como posso te ajudar hoje?" testId="menu-text" />
      </Field>
      {style === 'list' && (
        <Field label="Texto do botão" required>
          <input className="input" value={d.buttonLabel ?? ''} maxLength={20} placeholder="Ver opções" onChange={(e) => set({ buttonLabel: e.target.value })} data-testid="menu-button" />
        </Field>
      )}
      <ExpireField d={d} set={set} what="escolher" />
      <Section title={`Opções (${options.length}/${max})`} sub="Cada opção vira uma saída do bloco. O cliente pode tocar, digitar o número ou o texto da opção.">
        {style === 'buttons' && options.length > 3 && <div className="bm-warn" style={{ marginBottom: 8 }}>Botões aceitam só 3 opções: com {options.length}, o menu vai como lista.</div>}
        {options.map((o, i) => (
          <div className="bm-opt" key={o.id ?? i}>
            <span className="bm-opt-n">{i + 1}</span>
            <div className="bm-opt-f">
              <input className="input" value={o.title ?? ''} maxLength={titleMax} placeholder={`Opção ${i + 1}`} onChange={(e) => upd(i, { title: e.target.value })} data-testid={`menu-opt-${i}`} />
              {style === 'list' && (
                <input className="input sm" value={o.description ?? ''} maxLength={72} placeholder="Descrição (opcional)" onChange={(e) => upd(i, { description: e.target.value })} />
              )}
            </div>
            <button type="button" className="btn icon sm ghost" disabled={i === 0} onClick={() => set({ options: moveItem(options, i, -1) })} aria-label="Subir">↑</button>
            <button type="button" className="btn icon sm ghost" onClick={() => set({ options: options.filter((_, j) => j !== i) })} aria-label="Remover opção"><Icon name="trash" size={14} /></button>
          </div>
        ))}
        {options.length < max && (
          <button type="button" className="bm-addline" onClick={() => set({ options: [...options, { id: rid('opt'), title: '' }] })} data-testid="menu-add"><Icon name="plus" size={14} />Adicionar opção</button>
        )}
      </Section>
      <Field label="Campo para salvar a resposta" hint={d.saveAs ? <>A opção escolhida fica em <code>{`{{${d.saveAs}}}`}</code> (e em {'{{opcao}}'}).</> : 'Opcional. A escolha também fica em {{opcao}}.'}>
        <input className="input" value={d.saveAs ?? ''} placeholder="interesse" onChange={(e) => set({ saveAs: sanitizeVarName(e.target.value) })} data-testid="menu-save" />
      </Field>
      <Field label="Se a resposta não for uma das opções" hint="Com a saída “Outra resposta” ligada, o fluxo segue por ela. Sem ela, o menu é reenviado com esta mensagem.">
        <input className="input" value={d.invalidText ?? ''} placeholder="Não entendi 🤔 Escolha uma das opções:" onChange={(e) => set({ invalidText: e.target.value })} />
      </Field>
    </>
  );
}

/* ------------------------------------------------------------------ Carrossel */

type BtnType = 'reply' | 'url';
const newCardBtn = (type: BtnType): D => ({ id: rid('btn'), type, title: '', ...(type === 'url' ? { url: '' } : {}) });

/** Todos os cartões com os mesmos botões (tipo e quantidade): regra do WhatsApp. */
function reshape(cards: D[], type: BtnType, count: number): D[] {
  return cards.map((c) => {
    const cur: D[] = Array.isArray(c.buttons) ? c.buttons : [];
    const buttons = Array.from({ length: count }, (_, i) => {
      const b = cur[i];
      return b && (b.type ?? 'reply') === type ? b : newCardBtn(type);
    });
    return { ...c, buttons };
  });
}

export function CarouselEditor({ d, set, vars }: EditorProps) {
  const cards: D[] = Array.isArray(d.cards) ? d.cards : [];
  const first: D[] = Array.isArray(cards[0]?.buttons) ? cards[0].buttons : [];
  const btnType: BtnType = first[0]?.type === 'url' ? 'url' : 'reply';
  const count = btnType === 'url' ? 1 : Math.max(1, Math.min(2, first.length || 1));
  const put = (list: D[]) => set({ cards: list });
  const updCard = (i: number, patch: D) => put(cards.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const updBtn = (i: number, k: number, patch: D) => updCard(i, { buttons: (cards[i].buttons ?? []).map((b: D, j: number) => (j === k ? { ...b, ...patch } : b)) });
  const addCard = () => put([...cards, ...reshape([{ id: rid('card'), text: '', imageUrl: '', imageFileId: '', imageName: '', buttons: [] }], btnType, count)]);

  return (
    <>
      <ExpireField d={d} set={set} what="tocar num botão" />
      <Field label="Texto introdutório" required>
        <RichText value={d.text ?? ''} onChange={(text) => set({ text })} vars={vars} rows={2} maxLength={1024} showCount placeholder="Escolha uma opção abaixo 👇" testId="car-text" />
      </Field>
      <Section title="Botões dos cartões" sub="O WhatsApp exige os mesmos botões em todos os cartões. Cada botão de resposta vira uma saída do bloco.">
        <div className="bm-row2">
          <Tabs value={btnType} options={[['reply', 'Resposta rápida', 'reply'], ['url', 'Link', 'link']]} onChange={(t) => put(reshape(cards, t, t === 'url' ? 1 : count))} testId="car-btntype" />
          {btnType === 'reply' && (
            <select className="select" value={count} onChange={(e) => put(reshape(cards, 'reply', Number(e.target.value)))} data-testid="car-btncount">
              <option value={1}>1 botão por cartão</option>
              <option value={2}>2 botões por cartão</option>
            </select>
          )}
        </div>
      </Section>
      <div className="bm-cards">
        {cards.map((c, i) => (
          <div className="bm-card" key={c.id ?? i} data-testid={`card-${i}`}>
            <div className="bm-item-h">
              <span className="bm-item-ic"><Icon name="carousel" size={14} /></span>
              <b>Cartão {i + 1}</b>
              <span className="spacer" />
              <button type="button" className="btn icon sm ghost" disabled={i === 0} onClick={() => put(moveItem(cards, i, -1))} aria-label="Mover para a esquerda">←</button>
              <button type="button" className="btn icon sm ghost" disabled={i === cards.length - 1} onClick={() => put(moveItem(cards, i, 1))} aria-label="Mover para a direita">→</button>
              <button type="button" className="btn icon sm ghost" disabled={cards.length <= 1} onClick={() => put(cards.filter((_, j) => j !== i))} aria-label="Remover cartão"><Icon name="trash" size={14} /></button>
            </div>
            <Field label="Imagem" required>
              <FileOrUrl kind="image" url={c.imageUrl ?? ''} fileId={c.imageFileId ?? ''} fileName={c.imageName} vars={vars} testId={`card-${i}-image`}
                onChange={(v) => updCard(i, { imageUrl: v.url, imageFileId: v.fileId, imageName: v.fileName })} />
            </Field>
            <Field label="Texto do cartão">
              <RichText value={c.text ?? ''} onChange={(text) => updCard(i, { text })} vars={vars} rows={2} maxLength={160} showCount testId={`card-${i}-text`} />
            </Field>
            {(c.buttons ?? []).map((b: D, k: number) => (
              <div className={cx('bm-row2', btnType !== 'url' && 'one')} key={b.id ?? k}>
                <Field label={btnType === 'url' ? 'Texto do botão' : `Botão ${k + 1}`} required>
                  <input className="input" value={b.title ?? ''} maxLength={20} placeholder={btnType === 'url' ? 'Ver detalhes' : k === 0 ? 'Quero este' : 'Mais informações'}
                    onChange={(e) => updBtn(i, k, { title: e.target.value })} data-testid={`card-${i}-btn-${k}`} />
                </Field>
                {btnType === 'url' && (
                  <Field label="Link" required>
                    <VarInput value={b.url ?? ''} onChange={(url) => updBtn(i, k, { url })} vars={vars} placeholder="https://…" testId={`card-${i}-url`} />
                  </Field>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {cards.length < 10 && (
        <button type="button" className="bm-addline" onClick={addCard} data-testid="car-add"><Icon name="plus" size={14} />Adicionar cartão ({cards.length}/10)</button>
      )}
      <HowItWorks>
        O cliente vê os cartões lado a lado e desliza para ver os outros (de 2 a 10 cartões, cada um com imagem).
        {btnType === 'reply' ? ' O botão tocado decide a saída; o título fica em {{opcao}}.' : ' Botões de link abrem o site e o fluxo segue direto para o próximo bloco.'}
      </HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Aguarda Resposta */

const REACTIONS = ['👍', '❤️', '😂', '😮', '🙏', '✅', '👀', '🔥'];

export function AskEditor({ d, set, vars }: EditorProps) {
  return (
    <>
      <Field label="Mensagem antes de esperar (opcional)">
        <RichText value={d.text ?? ''} onChange={(text) => set({ text })} vars={vars} rows={3} maxLength={4096} placeholder="Qual é o seu melhor e-mail?" testId="ask-text" />
      </Field>
      <ToggleCard title="Aguardar indefinidamente" desc="O contato fica parado aqui até responder, sem prazo." checked={!!d.waitForever}
        onChange={(waitForever) => set({ waitForever })} testId="ask-forever" />
      {!d.waitForever && (
        <Field label="Tempo máximo de espera" hint="Passado esse tempo sem resposta, segue pela saída “Sem resposta”. Máximo: 31 dias.">
          <Duration amount={d.timeoutAmount ?? 1} unit={d.timeoutUnit ?? 'days'} min={1} onAmount={(timeoutAmount) => set({ timeoutAmount })} onUnit={(timeoutUnit) => set({ timeoutUnit })} testId="ask-timeout" />
        </Field>
      )}
      <ToggleCard title="Juntar mensagens seguidas (buffer)" desc="Espera o cliente parar de escrever e junta tudo numa resposta só — bom para quem manda várias mensagens curtas."
        checked={!!d.buffer} onChange={(buffer) => set({ buffer })} testId="ask-buffer" />
      {d.buffer && (
        <Field label="Segundos sem escrever para considerar a resposta pronta">
          <input className="input" type="number" min={1} max={120} value={d.bufferSeconds ?? 5} onChange={(e) => set({ bufferSeconds: Number(e.target.value) })} data-testid="ask-buffer-secs" />
        </Field>
      )}
      <ToggleCard title="Responder citando a mensagem" desc="A próxima mensagem do fluxo sai como resposta à mensagem do cliente." checked={!!d.quote} onChange={(quote) => set({ quote })} testId="ask-quote" />
      <ToggleCard title="Reagir à mensagem" desc="Põe uma reação na mensagem do cliente assim que ele responde." checked={!!d.react} onChange={(react) => set({ react })} testId="ask-react" />
      {d.react && (
        <div className="bm-emojis">
          {REACTIONS.map((e) => <button type="button" key={e} className={cx((d.reactEmoji || '👍') === e && 'on')} onClick={() => set({ reactEmoji: e })}>{e}</button>)}
        </div>
      )}
      <Field label="Campo para salvar a resposta" hint={d.saveAs ? <>Use depois como <code>{`{{${d.saveAs}}}`}</code>. Se existir um campo do contato com esse nome (ou nome/email), ele também é atualizado.</> : 'Ex.: nome, email, cidade. A resposta também fica em {{resposta}}.'}>
        <input className="input" value={d.saveAs ?? ''} placeholder="Nome" onChange={(e) => set({ saveAs: sanitizeVarName(e.target.value) })} data-testid="ask-save" />
      </Field>
      <div className="bm-row2">
        <Field label="Tipo de resposta esperada">
          <select className="select" value={d.validation ?? 'any'} onChange={(e) => set({ validation: e.target.value })} data-testid="ask-validation">
            <option value="any">Qualquer resposta</option>
            <option value="text">Texto (não vazio)</option>
            <option value="email">E-mail</option>
            <option value="number">Número</option>
            <option value="phone">Telefone</option>
          </select>
        </Field>
        {(d.validation ?? 'any') !== 'any' && (
          <Field label="Tentativas extras">
            <input className="input" type="number" min={0} max={5} value={d.maxRetries ?? 2} onChange={(e) => set({ maxRetries: Number(e.target.value) })} />
          </Field>
        )}
      </div>
      {(d.validation ?? 'any') !== 'any' && (
        <Field label="Mensagem quando a resposta for inválida" hint="Depois das tentativas, segue pela saída “Inválida”.">
          <input className="input" value={d.invalidText ?? ''} placeholder="Deixe vazio para usar a mensagem padrão" onChange={(e) => set({ invalidText: e.target.value })} />
        </Field>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Notificação */

const COUNTRIES: [string, string][] = [
  ['55', '🇧🇷 +55'], ['351', '🇵🇹 +351'], ['1', '🇺🇸 +1'], ['54', '🇦🇷 +54'], ['52', '🇲🇽 +52'], ['57', '🇨🇴 +57'],
  ['56', '🇨🇱 +56'], ['595', '🇵🇾 +595'], ['598', '🇺🇾 +598'], ['51', '🇵🇪 +51'], ['34', '🇪🇸 +34'], ['44', '🇬🇧 +44'],
];

/** Templates que dá para usar como reserva: sem cabeçalho/botão com variável e no máximo 1 variável no texto. */
const reserveOk = (t: Tpl) => t.bodyVars.length <= 1 && !(t.header && (t.header.vars.length || t.header.format !== 'TEXT')) && !t.buttons.some((b) => b.hasVar);

export function NotifyEditor({ d, set, vars, lookups, triggerConnectionId }: EditorProps) {
  const conn = lookups.wabas.find((w) => w.id === triggerConnectionId)?.id ?? lookups.wabas[0]?.id ?? '';
  const [connId, setConnId] = useState(conn);
  const tpl = useTemplates(connId);
  const usable = tpl.list.filter(reserveOk);
  const current = d.templateName ? tplKey(d.templateName, d.templateLanguage) : '';
  const opts = usable.map((t) => ({ value: tplKey(t.name, t.language), label: t.name, hint: t.bodyVars.length ? `${t.language} · leva a mensagem` : `${t.language} · texto fixo` }));
  if (current && !opts.some((o) => o.value === current)) opts.unshift({ value: current, label: d.templateName, hint: 'selecionado' });
  return (
    <>
      <Field label="Nome" required hint="Para você saber de onde veio (aparece nas anotações da conversa).">
        <input className="input" value={d.name ?? ''} maxLength={60} placeholder="Ex.: Avisar o gerente de vendas" onChange={(e) => set({ name: e.target.value })} data-testid="notify-name" />
      </Field>
      <Field label="Número" required>
        <div className="bm-phone">
          <select className="select" value={d.country ?? '55'} onChange={(e) => set({ country: e.target.value })} aria-label="País">
            {COUNTRIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <VarInput value={d.phone ?? ''} onChange={(phone) => set({ phone })} vars={vars} placeholder="11 99999-0000" testId="notify-phone" />
        </div>
      </Field>
      <Field label="Mensagem" required>
        <RichText value={d.text ?? ''} onChange={(text) => set({ text })} vars={vars} rows={4} maxLength={4096}
          placeholder={'🔔 Novo lead quente!\nNome: {{nome}}\nTelefone: {{telefone}}'} testId="notify-text" />
      </Field>
      <Section title="Template reserva (fora das 24 h)" sub="O WhatsApp só entrega texto livre para quem falou com o seu número nas últimas 24 h. Para os outros casos, escolha um template aprovado: com 1 variável, ela leva a mensagem acima.">
        {lookups.wabas.length > 1 && (
          <select className="select" style={{ marginBottom: 8 }} value={connId} onChange={(e) => setConnId(e.target.value)}>
            {lookups.wabas.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        {lookups.wabas.length ? (
          <Picker value={current} options={opts} placeholder={tpl.loading ? 'Carregando templates…' : 'Sem template reserva'} testId="notify-template"
            empty={tpl.error || 'Nenhum template aprovado serve (precisa ter no máximo 1 variável e nenhuma mídia no cabeçalho).'}
            onChange={(key) => {
              const t = usable.find((x) => tplKey(x.name, x.language) === key);
              set(t ? { templateName: t.name, templateLanguage: t.language, templateVarCount: t.bodyVars.length, templateParam: t.bodyVars[0] ?? '' }
                : { templateName: '', templateLanguage: '', templateVarCount: 0, templateParam: '' });
            }} />
        ) : <div className="bm-hint">Conecte um número da API oficial para escolher um template.</div>}
      </Section>
      <HowItWorks>
        Manda uma mensagem do seu número para outra pessoa (um vendedor, o gerente, um grupo de plantão) e o fluxo segue normalmente.
        O resultado fica em <code>{'{{notificacao}}'}</code> (enviada / falhou).
      </HowItWorks>
    </>
  );
}
