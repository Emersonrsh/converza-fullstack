/** Blocos antigos: continuam funcionando nos fluxos que já os usam (não aparecem mais na barra Ferramentas). */
import type { ReactNode } from 'react';
import { Icon } from '../../icons';
import { money } from '../../api';
import { AI_MODELS, STAGES, rid, sanitizeVarName } from '../blocks';
import { Field, RichText, TagInput, ToggleCard, VarInput } from './fields';
import type { D, EditorProps } from './types';

export function LegacyNote({ children }: { children: ReactNode }) {
  return <div className="bm-legacy"><Icon name="info" size={14} /><span>{children}</span></div>;
}

export function MediaEditor({ d, set, vars }: EditorProps) {
  return (
    <>
      <LegacyNote>Bloco antigo. Nos fluxos novos, use <b>Mensagem</b> (aceita vários conteúdos e envio de arquivo).</LegacyNote>
      <Field label="Tipo">
        <select className="select" value={d.mediaType ?? 'image'} onChange={(e) => set({ mediaType: e.target.value })}>
          <option value="image">Imagem</option><option value="video">Vídeo</option><option value="audio">Áudio</option><option value="document">Documento / PDF</option>
        </select>
      </Field>
      <Field label="Link do arquivo" hint="Link público (https://…) que abra direto o arquivo.">
        <VarInput value={d.url ?? ''} onChange={(url) => set({ url })} vars={vars} placeholder="https://meusite.com/catalogo.pdf" />
      </Field>
      {d.mediaType !== 'audio' && <Field label="Legenda (opcional)"><RichText value={d.caption ?? ''} onChange={(caption) => set({ caption })} vars={vars} rows={2} /></Field>}
      {d.mediaType === 'document' && <Field label="Nome do arquivo"><input className="input" value={d.filename ?? ''} placeholder="catalogo.pdf" onChange={(e) => set({ filename: e.target.value })} /></Field>}
    </>
  );
}

export function RandomEditor({ d, set }: EditorProps) {
  const a = Number(d.percentA ?? 50);
  return (
    <>
      <LegacyNote>Bloco antigo. Nos fluxos novos, use o <b>Distribuidor</b> (várias saídas, rodízio e sem repetição).</LegacyNote>
      <Field label={`Caminho A: ${a}% · Caminho B: ${100 - a}%`} hint="Útil para testar duas mensagens e ver qual converte mais nas estatísticas.">
        <input type="range" min={0} max={100} step={5} value={a} onChange={(e) => set({ percentA: Number(e.target.value) })} style={{ width: '100%' }} />
      </Field>
    </>
  );
}

export function ActionEditor({ d, set, vars, lookups, setLookups }: EditorProps) {
  const fields: D[] = Array.isArray(d.setFields) ? d.setFields : [];
  const globals: D[] = Array.isArray(d.setGlobals) ? d.setGlobals : [];
  const onCreated = (t: { name: string; color: string }) => setLookups((l) => ({ ...l, tags: l.tags.some((x) => x.name.toLowerCase() === t.name.toLowerCase()) ? l.tags : [...l.tags, t] }));
  return (
    <>
      <LegacyNote>Bloco antigo. Nos fluxos novos, use <b>Etiquetas</b>, <b>Kanban</b> e <b>Manipulador</b>.</LegacyNote>
      <Field label="Mover no funil para">
        <select className="select" value={d.setStage ?? ''} onChange={(e) => set({ setStage: e.target.value })}>
          <option value="">(não mudar)</option>
          {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      <Field label="Adicionar etiquetas"><TagInput tags={Array.isArray(d.addTags) ? d.addTags : []} onChange={(addTags) => set({ addTags })} catalog={lookups.tags} onCreated={onCreated} /></Field>
      <Field label="Remover etiquetas"><TagInput tags={Array.isArray(d.removeTags) ? d.removeTags : []} onChange={(removeTags) => set({ removeTags })} catalog={lookups.tags} /></Field>
      <Field label="Atualizar nome do contato (opcional)"><VarInput value={d.setName ?? ''} onChange={(setName) => set({ setName })} vars={vars} placeholder="{{nome_cliente}}" /></Field>
      <Field label="Salvar em campos do contato" hint={lookups.fields.length ? undefined : 'Crie campos em Configurações › Campos Personalizados.'}>
        {fields.map((f, i) => (
          <div className="bm-map" key={i}>
            <select className="select" value={f.key ?? ''} onChange={(e) => set({ setFields: fields.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} data-testid="action-field-key">
              <option value="">Campo…</option>
              {lookups.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
            <VarInput value={f.value ?? ''} onChange={(value) => set({ setFields: fields.map((x, j) => (j === i ? { ...x, value } : x)) })} vars={vars} placeholder="{{resposta}}" testId="action-field-value" />
            <button type="button" className="btn icon sm ghost" onClick={() => set({ setFields: fields.filter((_, j) => j !== i) })} aria-label="Remover campo"><Icon name="trash" size={14} /></button>
          </div>
        ))}
        {lookups.fields.length > 0 && <button type="button" className="bm-addline" onClick={() => set({ setFields: [...fields, { key: lookups.fields[0].key, value: '' }] })}><Icon name="plus" size={13} />Adicionar campo</button>}
      </Field>
      <Field label="Variáveis globais" hint="Somar e subtrair só para variáveis do tipo número.">
        {globals.map((g, i) => {
          const upd = (patch: D) => set({ setGlobals: globals.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
          const isNum = lookups.globals.find((x) => x.key === g.key)?.type === 'number';
          return (
            <div className="bm-map" key={i}>
              <select className="select" value={g.key ?? ''} onChange={(e) => upd({ key: e.target.value })} data-testid="action-global-key">
                <option value="">Variável…</option>
                {lookups.globals.map((x) => <option key={x.key} value={x.key}>{x.key}</option>)}
              </select>
              <select className="select" value={g.op ?? 'set'} onChange={(e) => upd({ op: e.target.value })} style={{ maxWidth: 110 }} data-testid="action-global-op">
                <option value="set">definir</option>{isNum && <option value="add">somar</option>}{isNum && <option value="subtract">subtrair</option>}
              </select>
              <VarInput value={g.value ?? ''} onChange={(value) => upd({ value })} vars={vars} testId="action-global-value" />
              <button type="button" className="btn icon sm ghost" onClick={() => set({ setGlobals: globals.filter((_, j) => j !== i) })} aria-label="Remover"><Icon name="trash" size={14} /></button>
            </div>
          );
        })}
        {lookups.globals.length > 0 && <button type="button" className="bm-addline" onClick={() => set({ setGlobals: [...globals, { key: lookups.globals[0].key, op: 'set', value: '' }] })}><Icon name="plus" size={13} />Adicionar variável global</button>}
      </Field>
      <Field label="Colocar no Kanban">
        <select className="select" value={d.kanbanBoardId ?? ''} onChange={(e) => { const b = lookups.kanban.find((x) => x.id === e.target.value); set({ kanbanBoardId: e.target.value, kanbanColumnId: b?.columns[0]?.id ?? '' }); }} data-testid="action-kanban-board">
          <option value="">(não mexer no Kanban)</option>
          {lookups.kanban.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        {d.kanbanBoardId && (
          <select className="select" style={{ marginTop: 6 }} value={d.kanbanColumnId ?? ''} onChange={(e) => set({ kanbanColumnId: e.target.value })} data-testid="action-kanban-column">
            <option value="">Escolha a coluna…</option>
            {lookups.kanban.find((b) => b.id === d.kanbanBoardId)?.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </Field>
    </>
  );
}

export function HandoffEditor({ d, set, vars, lookups }: EditorProps) {
  return (
    <>
      <LegacyNote>Bloco antigo. Nos fluxos novos, use <b>Controlador de Chat</b> e <b>Departamento</b>.</LegacyNote>
      <Field label="Mensagem antes de transferir (opcional)"><RichText value={d.message ?? ''} onChange={(message) => set({ message })} vars={vars} rows={3} /></Field>
      <Field label="Atribuir a">
        <select className="select" value={d.assignUserId ?? ''} onChange={(e) => set({ assignUserId: e.target.value, ...(e.target.value ? { departmentId: '' } : {}) })}>
          <option value="">Equipe (sem responsável)</option>
          {lookups.team.map((t) => <option key={t.userId} value={t.userId}>{t.name}</option>)}
        </select>
      </Field>
      {!d.assignUserId && (
        <Field label="Fila do setor">
          <select className="select" value={d.departmentId ?? ''} onChange={(e) => set({ departmentId: e.target.value })}>
            <option value="">Fila geral (qualquer pessoa)</option>
            {lookups.departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
      )}
    </>
  );
}

export function PaymentEditor({ d, set, vars, lookups, openProducts }: EditorProps) {
  return (
    <>
      <LegacyNote>Bloco antigo: continua funcionando. Nos fluxos novos, use <b>Botão PIX</b> e <b>Venda aprovada</b>.</LegacyNote>
      <Field label="Produto" right={<button type="button" className="linkbtn" onClick={openProducts}><Icon name="dollar" size={12} />Gerenciar produtos</button>}>
        <select className="select" value={d.productId ?? ''} onChange={(e) => set({ productId: e.target.value })}>
          <option value="">Link personalizado</option>
          {lookups.products.map((p) => <option key={p.id} value={p.id}>{p.name} — {money(Number(p.price))}{p.checkoutUrl ? '' : ' (sem link!)'}</option>)}
        </select>
      </Field>
      {!d.productId && <Field label="Link de pagamento"><VarInput value={d.url ?? ''} onChange={(url) => set({ url })} vars={vars} placeholder="https://pay.exemplo.com/..." /></Field>}
      <Field label="Mensagem"><RichText value={d.text ?? ''} onChange={(text) => set({ text })} vars={[...vars, 'link', 'produto', 'preco']} rows={3} /></Field>
      <ToggleCard title="Aguardar a confirmação do pagamento" desc="Saídas “Pago” e “Não pago”. A confirmação chega pelos Webhooks de entrada." checked={!!d.wait} onChange={(wait) => set({ wait })} />
      {d.wait && <Field label="Tempo limite (minutos)"><input className="input" type="number" min={5} value={d.timeoutMinutes ?? 60} onChange={(e) => set({ timeoutMinutes: Number(e.target.value) })} /></Field>}
    </>
  );
}

export function AiReplyEditor({ d, set }: EditorProps) {
  return (
    <>
      <LegacyNote>Bloco antigo. Nos fluxos novos, use o <b>Bloco de IA</b> (com chave própria, mídias e condicionais).</LegacyNote>
      <Field label="Instruções para a IA"><textarea className="input" rows={6} value={d.prompt ?? ''} onChange={(e) => set({ prompt: e.target.value })} /></Field>
      <Field label="Modelo">
        <select className="select" value={d.model ?? ''} onChange={(e) => set({ model: e.target.value })}>{AI_MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </Field>
      <ToggleCard title="Usar o histórico da conversa" checked={d.useHistory !== false} onChange={(useHistory) => set({ useHistory })} />
      <ToggleCard title="Enviar a resposta ao cliente" checked={d.send !== false} onChange={(send) => set({ send })} />
      <Field label="Salvar resposta na variável"><input className="input" value={d.saveAs ?? ''} placeholder="ia" onChange={(e) => set({ saveAs: sanitizeVarName(e.target.value) })} /></Field>
      <Field label="Mensagem se a IA falhar"><input className="input" value={d.fallbackText ?? ''} placeholder="Já te respondo! 😊" onChange={(e) => set({ fallbackText: e.target.value })} /></Field>
    </>
  );
}

export function AiClassifyEditor({ d, set }: EditorProps) {
  const cats: D[] = Array.isArray(d.categories) ? d.categories : [];
  const upd = (i: number, patch: D) => set({ categories: cats.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <>
      <LegacyNote>Bloco antigo. Nos fluxos novos, use as <b>Condicionais inteligentes</b> do Bloco de IA.</LegacyNote>
      {cats.map((c, i) => (
        <div className="bm-opt" key={c.id ?? i}>
          <span className="bm-opt-n">{i + 1}</span>
          <div className="bm-opt-f">
            <input className="input" value={c.label ?? ''} placeholder="Nome da categoria" onChange={(e) => upd(i, { label: e.target.value })} />
            <input className="input sm" value={c.description ?? ''} placeholder="Descrição (ajuda a IA a entender)" onChange={(e) => upd(i, { description: e.target.value })} />
          </div>
          <button type="button" className="btn icon sm ghost" onClick={() => set({ categories: cats.filter((_, j) => j !== i) })} aria-label="Remover"><Icon name="trash" size={14} /></button>
        </div>
      ))}
      {cats.length < 10 && <button type="button" className="bm-addline" onClick={() => set({ categories: [...cats, { id: rid('cat'), label: '', description: '' }] })}><Icon name="plus" size={14} />Adicionar categoria</button>}
      <Field label="Instruções extras (opcional)"><textarea className="input" rows={3} value={d.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value })} /></Field>
    </>
  );
}
