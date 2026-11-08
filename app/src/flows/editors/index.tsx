import { useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import './editors.css';
import { Icon } from '../../icons';
import { useBackdrop } from '../../components/ui';
import { BLOCKS, durationSeconds, type BlockType, type Lookups } from '../blocks';
import type { BlockFlowNode } from '../canvas';
import { AskEditor, CarouselEditor, MenuEditor, MessageEditor, NotifyEditor, PixEditor, TemplateEditor } from './messages';
import { ConditionEditor, DelayEditor, DistributorEditor, GotoFlowEditor, SetVarEditor, TriggerEditor } from './logic';
import { AiAgentEditor, ChatStatusEditor, DepartmentEditor, KanbanEditor, PixelEditor, SaleEditor, TagsEditor } from './crm';
import { AiEditor, HttpEditor } from './integrations';
import { ActionEditor, AiClassifyEditor, AiReplyEditor, HandoffEditor, MediaEditor, PaymentEditor, RandomEditor } from './legacy';
import type { D, EditorCtx, EditorProps } from './types';

export type { EditorCtx } from './types';

const EDITORS: Record<BlockType, ComponentType<EditorProps>> = {
  trigger: TriggerEditor,
  message: MessageEditor, template: TemplateEditor, tags: TagsEditor, pix: PixEditor, menu: MenuEditor, carousel: CarouselEditor,
  ask: AskEditor, chat_status: ChatStatusEditor, notify: NotifyEditor, condition: ConditionEditor, distributor: DistributorEditor,
  goto_flow: GotoFlowEditor, pixel: PixelEditor, delay: DelayEditor, department: DepartmentEditor, http: HttpEditor, ai: AiEditor,
  ai_agent: AiAgentEditor, kanban: KanbanEditor, set_var: SetVarEditor, sale: SaleEditor,
  media: MediaEditor, random: RandomEditor, action: ActionEditor, handoff: HandoffEditor, payment: PaymentEditor,
  ai_reply: AiReplyEditor, ai_classify: AiClassifyEditor,
};

const WIDE = new Set(['message', 'template', 'carousel', 'http', 'ai', 'condition', 'menu', 'action']);
const blank = (v: unknown) => !String(v ?? '').trim();

/** O que falta para poder salvar o bloco (o botão Salvar fica desligado). null = pode salvar. */
export function requiredOf(type: string, d: D, lk: Lookups): string | null {
  switch (type) {
    case 'trigger': return d.type === 'keyword' && blank(d.keywords) ? 'Escreva pelo menos uma palavra-chave' : null;
    case 'message': return (Array.isArray(d.items) ? d.items : []).length ? null : 'Adicione pelo menos um conteúdo';
    case 'template':
      if (blank(d.name)) return 'Escolha um template aprovado';
      if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(d.headerFormat)) && blank(d.headerMediaUrl)) return 'Informe o link da mídia do cabeçalho';
      return null;
    case 'tags': return (Array.isArray(d.tags) ? d.tags : []).length ? null : 'Adicione pelo menos uma etiqueta';
    case 'pix':
      if (blank(d.key)) return 'Informe a chave Pix';
      if (blank(d.merchantName)) return 'Informe o destinatário';
      if (blank(d.amount)) return 'Informe o valor';
      return null;
    case 'menu': {
      const opts: D[] = Array.isArray(d.options) ? d.options : [];
      if (blank(d.text)) return 'Escreva a mensagem do menu';
      if (d.style !== 'buttons' && blank(d.buttonLabel)) return 'Escreva o texto do botão';
      if (!opts.length) return 'Adicione pelo menos uma opção';
      if (opts.some((o) => blank(o.title))) return 'Todas as opções precisam de texto';
      return null;
    }
    case 'carousel': {
      const cards: D[] = Array.isArray(d.cards) ? d.cards : [];
      if (blank(d.text)) return 'Escreva o texto introdutório';
      if (cards.length < 2) return 'O WhatsApp exige pelo menos 2 cartões';
      if (cards.some((c) => blank(c.imageUrl) && blank(c.imageFileId))) return 'Todo cartão precisa de imagem';
      if (cards.some((c) => (c.buttons ?? []).some((b: D) => blank(b.title)))) return 'Todos os botões precisam de texto';
      if (cards.some((c) => (c.buttons ?? []).some((b: D) => b.type === 'url' && blank(b.url)))) return 'Informe o link de cada botão';
      return null;
    }
    case 'chat_status': return d.status === 'open' && blank(d.assignUserId) ? 'Escolha o atendente' : null;
    case 'notify':
      if (blank(d.name)) return 'Dê um nome à notificação';
      if (blank(d.phone)) return 'Informe o número';
      if (blank(d.text)) return 'Escreva a mensagem';
      return null;
    case 'condition': {
      const rules: D[] = Array.isArray(d.rules) ? d.rules : [];
      if (!rules.length) return 'Adicione pelo menos uma condição';
      if (rules.some((r) => r.field === 'var' && blank(r.varName))) return 'Escolha a variável de cada condição';
      if (rules.some((r) => r.field === 'global' && blank(r.globalKey))) return 'Escolha a variável global';
      if (rules.some((r) => r.field === 'field' && blank(r.fieldKey))) return 'Escolha o campo personalizado';
      return null;
    }
    case 'distributor': return (Array.isArray(d.outputs) ? d.outputs : []).length >= 2 ? null : 'Crie pelo menos 2 saídas';
    case 'goto_flow': return blank(d.flowId) ? 'Escolha o fluxo de destino' : null;
    case 'pixel':
      if (blank(d.pixelId)) return 'Escolha o pixel';
      if (blank(d.event)) return 'Escolha o tipo do evento';
      return null;
    case 'delay':
      if (d.mode === 'date') return blank(d.date) ? 'Escolha a data' : null;
      if (d.mode === 'hours') return !d.useBusinessHours && !(Array.isArray(d.days) && d.days.length) ? 'Escolha pelo menos um dia' : null;
      if (String(d.amount ?? '').includes('{{')) return null;
      return durationSeconds(d.amount, d.unit) > 0 ? null : 'O tempo precisa ser maior que zero';
    case 'department': return d.action !== 'clear' && blank(d.departmentId) ? 'Escolha o departamento' : null;
    case 'http': return blank(d.url) ? 'Informe a URL' : null;
    case 'ai':
      if (d.provider && d.provider !== 'converza') {
        if (blank(d.apiKey)) return 'Informe a chave da API';
        if (blank(d.model)) return 'Escolha o modelo';
      }
      return blank(d.prompt) ? 'Escreva o prompt' : null;
    case 'ai_agent': return d.action !== 'remove' && blank(d.agentId) ? 'Escolha o agente' : null;
    case 'kanban':
      if (blank(d.boardId)) return 'Escolha o Kanban';
      if (d.action !== 'remove' && blank(d.columnId)) return 'Escolha a coluna';
      return lk.kanban.length && !lk.kanban.some((b) => b.id === d.boardId) ? 'O Kanban escolhido não existe mais' : null;
    case 'set_var': return blank(d.name) ? 'Informe o nome da variável' : null;
    default: return null;
  }
}

interface Props {
  node: BlockFlowNode;
  ctx: EditorCtx;
  onSave: (data: D) => void;
  onClose: () => void;
  onDelete: () => void;
}

/** "Editar Mensagem", "Editar Menu"…: edita uma cópia e só aplica no Salvar. */
export function BlockModal({ node, ctx, onSave, onClose, onDelete }: Props) {
  const type = (node.type ?? 'message') as BlockType;
  const meta = BLOCKS[type] ?? BLOCKS.message;
  const Editor = EDITORS[type];
  const initial = useRef(JSON.stringify(node.data ?? {}));
  const [draft, setDraft] = useState<D>(() => JSON.parse(initial.current));
  const set = useCallback((patch: D) => setDraft((cur) => ({ ...cur, ...patch })), []);
  const dirty = JSON.stringify(draft) !== initial.current;
  const missing = requiredOf(type, draft, ctx.lookups);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    if (!dirty || confirm('Descartar as alterações deste bloco?')) onClose();
  }, [dirty, onClose]);
  const save = useCallback(() => { if (!missing) onSave(draft); }, [missing, onSave, draft]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const all = document.querySelectorAll('.modal-bg');
      if (all[all.length - 1] !== ref.current) return; // outro modal por cima (ex.: produtos)
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key.toLowerCase() === 's')) { e.preventDefault(); save(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [close, save]);
  const bg = useBackdrop(close);

  return (
    <div className="modal-bg" ref={ref} {...bg}>
      <div className="modal bm fade" style={{ maxWidth: WIDE.has(type) ? 760 : 620, '--c': meta.color } as CSSProperties}
        onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Editar ${meta.label}`} data-testid="block-modal">
        <div className="mh">
          <div className="mh-t">
            <span className="bm-ic"><Icon name={meta.icon} size={17} stroke={2.2} /></span>
            <div><b style={{ fontSize: 15 }}>Editar {meta.label.replace(/ \(antigo\)$/, '')}</b><small>{meta.desc}</small></div>
          </div>
          <button type="button" className="btn icon sm ghost" onClick={close} aria-label="Fechar"><Icon name="close" /></button>
        </div>
        <div className="mb">
          {type !== 'trigger' && (
            <div className="bm-title">
              <label htmlFor="bm-title">Nome do bloco</label>
              <input id="bm-title" className="input sm" value={draft.title ?? ''} maxLength={60} placeholder={meta.label} onChange={(e) => set({ title: e.target.value })} data-testid="block-title" />
            </div>
          )}
          {Editor ? <Editor {...ctx} d={draft} set={set} /> : <div className="bm-hint">Este bloco não tem configurações.</div>}
        </div>
        <div className="mf">
          {type !== 'trigger' && (
            <button type="button" className="btn ghost danger" onClick={onDelete} data-testid="block-delete"><Icon name="trash" size={15} />Excluir bloco</button>
          )}
          <span className="spacer" />
          {missing && <small className="bm-missing" data-testid="block-missing">{missing}</small>}
          <button type="button" className="btn" onClick={close} data-testid="block-cancel">Cancelar</button>
          <button type="button" className="btn primary" disabled={!!missing} onClick={save} title={missing ?? 'Salvar (Ctrl+Enter)'} data-testid="block-save">Salvar</button>
        </div>
      </div>
    </div>
  );
}
