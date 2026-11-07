export type Origin = 'whatsapp' | 'ad' | 'import' | 'manual' | 'webhook';
export type ContactStatus = '' | 'active' | 'inactive' | 'lead' | 'customer';

export interface ContactKanbanRef { cardId: string; boardId: string; boardName: string; columnId: string; columnName: string; color: string; kind: string; }

export interface ContactItem {
  id: string; name: string; phone: string; email: string | null; tags: string[]; stage: string; value: number; origin: Origin;
  custom: Record<string, string>; notes: string | null; sourceUrl: string | null; createdAt: string; lastContactAt: string | null;
  conversationId: string | null; unreadCount: number; kanban: ContactKanbanRef[]; purchases: number;
}

export interface ContactField { id: string; key: string; label: string; type: 'text' | 'number' | 'date' | 'select'; options: string[]; position: number; }

export interface ContactFiltersState {
  q: string; status: ContactStatus; origin: '' | Origin;
  from: string; to: string; field: string; fieldValue: string; tags: string[]; columns: string[]; stages: string[];
}

export interface ContactCounts { total: number; active: number; leads: number; }
export interface ContactListResp { contacts: ContactItem[]; total: number; page: number; pages: number; limit: number; counts: ContactCounts; }

export interface ContactFull {
  id: string; name: string; phone: string; email: string | null; tags: string[]; stage: string; value: number; origin: Origin;
  custom: Record<string, string>; notes: string | null; sourceId: string | null; sourceUrl: string | null;
  createdAt: string; lastContactAt: string | null;
  /** pediu para não receber disparos em massa */
  optedOutAt?: string | null;
}
export interface ContactDetail {
  contact: ContactFull;
  conversation: { id: string; status: string; unreadCount: number; lastMessageAt: string; assignedName: string | null } | null;
  sales: { id: string; amount: number; currency: string; status: 'pending' | 'approved' | 'refused' | 'refunded'; productName: string | null; createdAt: string }[];
  purchases: number; revenue: number; connectionName: string | null;
}

export interface ContactExport { id: string; filename: string; label: string; rows: number; createdAt: string; userName: string | null; }
export interface ImportResult { total: number; created: number; updated: number; skipped: number; errors: { line: number; reason: string }[]; }
