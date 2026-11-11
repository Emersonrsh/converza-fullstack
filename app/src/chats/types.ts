export type ChatTab = 'waiting' | 'attending' | 'resolved';
export type ChatChip = 'all' | 'unread' | 'unanswered';

export interface ChatFilters {
  q: string; chip: ChatChip; connectionId: string; tag: string; stage: string; assignee: string; from: string; to: string;
  /** setor: '' (todos), 'none' (sem setor) ou o id */
  department: string;
}

export interface ChatItem {
  id: string; status: 'open' | 'pending' | 'resolved'; botPaused: boolean; unreadCount: number; lastMessageAt: string;
  connectionId: string | null; connectionName: string | null; assignedUserId: string | null; assignedName: string | null;
  contactId: string; contactName: string; contactPhone: string; contactTags: string[]; stage: string;
  last: { id: string; body: string | null; type: string; direction: 'in' | 'out'; status: string; fileName: string | null } | null;
  awaitingReply: boolean;
  departmentId?: string | null; departmentName?: string | null; departmentColor?: string | null;
}
export interface ChatCounts { waiting: number; attending: number; resolved: number; unread: number; }

export interface ReplyPreview { id: string; body: string | null; type: string; direction: 'in' | 'out'; fileName: string | null; senderUserId: string | null; }
export interface ChatMessage {
  id: string; conversationId: string; direction: 'in' | 'out'; type: string; body: string | null;
  mediaUrl: string | null; mimeType: string | null; fileName: string | null; status: string; error: string | null;
  senderUserId: string | null; senderName?: string | null; createdAt: string; waMessageId?: string | null;
  /** enviada por um agente de IA */
  agentId?: string | null; agentName?: string | null;
  /** áudio: o que foi dito */
  transcript?: string | null;
  /** mensagem citada ("responder") */
  replyToId?: string | null; reply?: ReplyPreview | null;
  /** WhatsApp Business do celular: 'phone' = respondida pelo app; 'history' = importada do histórico */
  via?: 'phone' | 'history' | null;
}

export interface ChatContact {
  id: string; name: string; phone: string; stage: string; tags: string[]; value: string | number; notes: string | null;
  sourceId: string | null; sourceUrl: string | null; createdAt: string; email?: string | null; custom?: Record<string, string>;
}

export interface ChatDetail {
  conversation: { id: string; status: 'open' | 'pending' | 'resolved'; botPaused: boolean; assignedUserId: string | null; connectionId: string | null; contactId: string; unreadCount: number; departmentId?: string | null };
  contact: ChatContact;
  connection: { id: string; name: string; displayPhone: string | null; status: string; hasWaba: boolean; provider?: 'cloud' | 'web' } | null;
  assignedName: string | null;
  lastInboundAt: string | null;
  windowOpen: boolean;
  windowClosesAt: string | null;
  department?: { id: string; name: string; color: string } | null;
}

export type QuickActionType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker';
export interface QuickFile { id: string; mime: string; fileName: string; size: number; url: string }
export interface QuickAction { type: QuickActionType; text?: string; fileId?: string; caption?: string; file?: QuickFile | null }
export interface QuickReply { id: string; shortcut: string; text: string; actions?: QuickAction[]; types?: QuickActionType[]; createdAt?: string }
export interface WaTemplateButton { type: string; text: string; url: string | null; hasVar: boolean; example: string | null; }
export interface WaTemplate {
  name: string; language: string; category: string; status: string;
  /** "positional" = {{1}}, {{2}}…; "named" = {{nome_cliente}} */
  paramFormat: 'positional' | 'named';
  header: { format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION'; text: string | null; vars: string[]; example: string | null } | null;
  body: string; bodyVars: string[]; bodyExamples: string[];
  footer: string | null;
  buttons: WaTemplateButton[];
}
export interface TemplatePayload {
  name: string; language: string; preview: string;
  body: { name?: string; value: string }[];
  header?: { type: 'text'; name?: string; value: string } | { type: 'image' | 'video' | 'document'; link: string; filename?: string };
  buttons?: { index: number; subType: 'url' | 'copy_code'; value: string }[];
}
export interface TeamMember { userId: string; name: string; email: string; role: string; }
export interface ChatRun { id: string; status: string; startedAt: string; flowId: string; flowName: string; failedMessageId?: string | null; error?: string | null }
export interface ChatSale {
  id: string; amount: number; currency: string; status: 'pending' | 'approved' | 'refused' | 'refunded'; productName: string | null; createdAt: string;
}
export interface AccountTag { id: string; name: string; color: string; }
export interface ChatConnection { id: string; name: string; displayPhone: string | null; status: string; }
export interface ChatDepartment { id: string; name: string; color: string; }
