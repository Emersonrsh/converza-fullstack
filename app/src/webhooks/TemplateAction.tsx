import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import type { WaTemplate } from '../chats/types';
import { TokenField } from './TokenField';
import type { Leaf, TemplateAction as TplAction } from './types';

const MEDIA_LABEL: Record<string, string> = { IMAGE: 'imagem', VIDEO: 'vídeo', DOCUMENT: 'documento' };
const isNameVar = (v: string, i: number, positional: boolean) => (positional ? i === 0 : /nome|name/i.test(v));

/** Monta a ação "mandar modelo" a partir de um modelo aprovado (nome no 1º campo, o resto em branco). */
function fromTemplate(t: WaTemplate): TplAction {
  const positional = t.paramFormat === 'positional';
  const named = !positional;
  const fmt = t.header?.format;
  return {
    name: t.name, language: t.language, preview: t.body,
    body: t.bodyVars.map((v, i) => ({ var: v, ...(named ? { name: v } : {}), value: isNameVar(v, i, positional) ? '{{primeiro_nome}}' : '' })),
    header: fmt === 'TEXT' && t.header?.vars.length
      ? { type: 'text', var: t.header.vars[0], ...(named ? { name: t.header.vars[0] } : {}), value: '{{primeiro_nome}}' }
      : fmt === 'IMAGE' || fmt === 'VIDEO' || fmt === 'DOCUMENT' ? { type: fmt.toLowerCase() as 'image' | 'video' | 'document', link: '' } : undefined,
    buttons: t.buttons.map((b, index) => ({ b, index })).filter((x) => x.b.hasVar)
      .map(({ b, index }) => ({ index, subType: b.type === 'COPY_CODE' ? 'copy_code' as const : 'url' as const, value: '' })),
  };
}

export function TemplateActionField({ connectionId, hasWaba, value, onChange, leaves, vars, specials, noneLabel = 'Não mandar mensagem', noConnText }: {
  connectionId: string | null; hasWaba: boolean; value: TplAction | null | undefined; onChange: (v: TplAction | null) => void; leaves: Leaf[]; vars: string[];
  specials?: [string, string][]; noneLabel?: string; noConnText?: string;
}) {
  const [list, setList] = useState<WaTemplate[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setList(null); setErr(null);
    if (!connectionId || !hasWaba) return;
    let alive = true;
    api.get<{ templates: WaTemplate[] }>(`/connections/${connectionId}/templates`)
      .then((r) => { if (alive) setList(r.templates); })
      .catch((e) => { if (alive) { setErr(e instanceof Error ? e.message : 'Não foi possível ler os modelos'); setList([]); } });
    return () => { alive = false; };
  }, [connectionId, hasWaba]);

  if (!connectionId) return <small className="faint">{noConnText ?? 'Escolha a conexão de WhatsApp do webhook (lá em cima) para mandar um modelo.'}</small>;
  if (!hasWaba) return <small className="faint">Esta conexão não tem a conta do WhatsApp Business (WABA ID) cadastrada — sem ela não dá para ler os modelos. Ajuste em Conexões › Detalhes.</small>;
  if (!list) return <small className="faint">Carregando os modelos aprovados…</small>;
  const key = (t: { name: string; language: string }) => `${t.name}|${t.language}`;
  const cur = value ? list.find((t) => key(t) === key(value)) : null;

  return (
    <div className="stack" style={{ gap: 10 }}>
      {err && <div className="hint bad"><Icon name="alert" size={14} />{err}</div>}
      <select className="select" value={value ? key(value) : ''} data-testid="wh-template"
        onChange={(e) => { const t = list.find((x) => key(x) === e.target.value); onChange(t ? fromTemplate(t) : null); }}>
        <option value="">{noneLabel}</option>
        {list.map((t) => <option key={key(t)} value={key(t)}>{t.name} ({t.language}){t.category ? ` · ${t.category.toLowerCase()}` : ''}</option>)}
        {value && !cur && <option value={key(value)}>{value.name} ({value.language}) — não está mais aprovado</option>}
      </select>
      {!list.length && !err && <small className="faint">Nenhum modelo aprovado nesta conta. Crie no Gerenciador do WhatsApp (Meta) e aguarde a aprovação.</small>}
      {value && !cur && <div className="hint warn"><Icon name="alert" size={14} />O modelo “{value.name}” não aparece mais como aprovado nesta conexão: o envio vai falhar.</div>}
      {value && (
        <>
          {cur && <div className="wh-tpl-body"><Icon name="chat" size={13} />{cur.body}</div>}
          {value.header && value.header.type !== 'text' && (
            <div>
              <label className="label">Link público da {MEDIA_LABEL[value.header.type.toUpperCase()] ?? 'mídia'} do cabeçalho <span className="lbl-hint">· https://</span></label>
              <TokenField value={value.header.link} leaves={leaves} vars={vars} specials={specials} placeholder="https://seusite.com/arquivo" testId="wh-tpl-media"
                onChange={(link) => onChange({ ...value, header: { ...(value.header as { type: 'image' | 'video' | 'document'; link: string }), link } })} />
            </div>
          )}
          {value.header?.type === 'text' && (
            <div>
              <label className="label">Cabeçalho {`{{${value.header.var}}}`}</label>
              <TokenField value={value.header.value} leaves={leaves} vars={vars} specials={specials} maxLength={200} testId="wh-tpl-header"
                onChange={(v) => onChange({ ...value, header: { ...(value.header as { type: 'text'; var: string; value: string }), value: v } })} />
            </div>
          )}
          {(value.body ?? []).map((b, i) => (
            <div key={b.var}>
              <label className="label">Variável {`{{${b.var}}}`}{cur?.bodyExamples[i] ? <span className="lbl-hint"> · ex.: {cur.bodyExamples[i]}</span> : null}</label>
              <TokenField value={b.value} leaves={leaves} vars={vars} specials={specials} testId="wh-tpl-var"
                onChange={(v) => onChange({ ...value, body: (value.body ?? []).map((x, j) => (j === i ? { ...x, value: v } : x)) })} />
            </div>
          ))}
          {(value.buttons ?? []).map((b, i) => {
            const btn = cur?.buttons[b.index];
            return (
              <div key={b.index}>
                <label className="label">{b.subType === 'copy_code' ? 'Código do cupom (botão copiar)' : `Final do link do botão “${btn?.text ?? b.index + 1}”`}{btn?.url ? <span className="lbl-hint"> · {btn.url}</span> : null}</label>
                <TokenField value={b.value} leaves={leaves} vars={vars} specials={specials} testId="wh-tpl-button"
                  onChange={(v) => onChange({ ...value, buttons: (value.buttons ?? []).map((x, j) => (j === i ? { ...x, value: v } : x)) })} />
              </div>
            );
          })}
          <small className="faint">Modelo é a única mensagem que a Meta deixa mandar para quem não falou com você nas últimas 24h. Campo que vier vazio é enviado como “-”.</small>
        </>
      )}
    </div>
  );
}
