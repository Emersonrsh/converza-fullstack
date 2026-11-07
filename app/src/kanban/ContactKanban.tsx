import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { toast } from '../components/ui';
import type { KContactInfo } from './types';

/**
 * Em que quadros do Kanban o contato está: trocar de coluna, abrir no quadro e adicionar a outro quadro.
 * Usado no painel do Chats ao vivo e no cadastro do contato.
 */
export function ContactKanban({ contactId, refreshKey = 0 }: { contactId: string; refreshKey?: number }) {
  const [kb, setKb] = useState<KContactInfo | null>(null);
  const [add, setAdd] = useState<{ boardId: string; columnId: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api.get<KContactInfo>(`/kanban/contact/${contactId}`).then((r) => alive && setKb(r)).catch(() => alive && setKb({ cards: [], boards: [] }));
    return () => { alive = false; };
  }, [contactId, refreshKey]);

  async function place(boardId: string, columnId: string) {
    try {
      const r = await api.post<{ created: boolean }>(`/kanban/contact/${contactId}`, { boardId, columnId });
      const info = await api.get<KContactInfo>(`/kanban/contact/${contactId}`);
      setKb(info);
      const card = info.cards.find((x) => x.boardId === boardId);
      toast(r.created ? `Adicionado ao quadro “${card?.boardName ?? ''}”` : `Movido para “${card?.columnName ?? ''}”`);
      return true;
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível atualizar o Kanban'); return false; }
  }

  if (!kb) return <div className="faint" style={{ fontSize: 12.5 }}>Carregando…</div>;
  if (!kb.boards.length) {
    return <div className="faint" style={{ fontSize: 12.5 }}>Nenhum quadro ainda. <Link to="/kanban" style={{ color: 'var(--primary)', fontWeight: 700 }}>Criar um Kanban</Link></div>;
  }
  const free = kb.boards.filter((b) => !kb.cards.some((k) => k.boardId === b.id));
  return (
    <div className="ck">
      {kb.cards.length === 0 && !add && <div className="faint" style={{ fontSize: 12.5, marginBottom: 6 }}>Este contato não está em nenhum quadro.</div>}
      {kb.cards.map((card) => {
        const board = kb.boards.find((b) => b.id === card.boardId);
        return (
          <div key={card.id} className="cp-kb" style={{ ['--cc' as string]: card.columnColor }} data-testid="contact-kanban">
            <div className="cp-kb-hd">
              <b title={card.boardName}>{card.boardName}</b>
              <Link to={`/kanban/${card.boardId}?card=${card.id}`} title="Abrir no Kanban" aria-label={`Abrir ${card.boardName}`}><Icon name="arrowRight" size={14} /></Link>
            </div>
            <select className="select sm" value={card.columnId} onChange={(e) => { void place(card.boardId, e.target.value); }} aria-label={`Coluna em ${card.boardName}`} data-testid="contact-kanban-column">
              {board?.columns.map((col) => <option key={col.id} value={col.id}>{col.name}</option>)}
            </select>
          </div>
        );
      })}
      {add ? (
        <div className="cp-kb-add" data-testid="kanban-add-form">
          <select className="select sm" value={add.boardId} aria-label="Quadro"
            onChange={(e) => { const b = kb.boards.find((x) => x.id === e.target.value); setAdd({ boardId: e.target.value, columnId: b?.columns[0]?.id ?? '' }); }}>
            {free.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select className="select sm" value={add.columnId} aria-label="Coluna" onChange={(e) => setAdd({ ...add, columnId: e.target.value })}>
            {kb.boards.find((b) => b.id === add.boardId)?.columns.map((col) => <option key={col.id} value={col.id}>{col.name}</option>)}
          </select>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
            <button type="button" className="btn sm ghost" onClick={() => setAdd(null)}>Cancelar</button>
            <button type="button" className="btn sm primary" disabled={!add.columnId} onClick={async () => { if (await place(add.boardId, add.columnId)) setAdd(null); }} data-testid="kanban-add-confirm">Adicionar</button>
          </div>
        </div>
      ) : free.length > 0 && (
        <button type="button" className="ck-add" onClick={() => setAdd({ boardId: free[0].id, columnId: free[0].columns[0]?.id ?? '' })} data-testid="kanban-add">
          <Icon name="plus" size={13} />Adicionar a um quadro
        </button>
      )}
    </div>
  );
}
