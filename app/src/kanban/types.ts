export type ColumnKind = 'open' | 'won' | 'lost';

export interface KColumn { id: string; name: string; color: string; kind: ColumnKind; position: number; cards?: number; value?: number; }
export interface KStats { cards: number; value: number; won: number; conversion: number; }
export interface KBoardSummary {
  id: string; name: string; description: string | null; createdAt: string; updatedAt: string;
  columns: KColumn[]; stats: KStats;
}
export interface KTotals { boards: number; cards: number; value: number; conversion: number; }

export interface KCard {
  id: string; columnId: string; title: string; value: number; notes: string | null; position: number; dueDate: string | null;
  assignedUserId: string | null; assignedName: string | null;
  contactId: string | null; contactName: string | null; contactPhone: string | null; contactTags: string[];
  conversationId: string | null; unreadCount: number; lastMessageAt: string | null;
  movedAt: string; createdAt: string; updatedAt: string;
}
export interface KBoard {
  board: { id: string; name: string; description: string | null; createdAt: string; updatedAt: string };
  columns: KColumn[]; stats: KStats; cards: KCard[];
}

/** Cards do contato (painel do Chats ao vivo). */
export interface KContactCard {
  id: string; boardId: string; boardName: string; columnId: string; columnName: string; columnColor: string; columnKind: ColumnKind; value: number; movedAt: string;
}
export interface KContactInfo { cards: KContactCard[]; boards: { id: string; name: string; columns: KColumn[] }[]; }
