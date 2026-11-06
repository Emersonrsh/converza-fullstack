export type Role = 'owner' | 'admin' | 'agent';
export type Stage = 'new' | 'in_service' | 'negotiating' | 'won' | 'lost';

export interface User { id: string; name: string; email: string; }
export interface Account { id: string; name: string; slug: string; role: Role; }

export interface Contact {
  id: string; name: string; phone: string; waId: string | null;
  stage: Stage; tags: string[]; value: string; lastContactAt: string | null; createdAt: string;
}
export interface Conversation {
  id: string; status: string; unreadCount: number; lastMessageAt: string;
  contactId: string; contactName: string; contactPhone: string; stage: Stage;
}
export interface Message {
  id: string; conversationId: string; direction: 'in' | 'out'; type: string;
  body: string | null; status: string; createdAt: string;
}
export interface Connection {
  id: string; name: string; displayPhone: string | null; phoneNumberId: string | null;
  status: 'connected' | 'disconnected' | 'pending'; createdAt: string;
}
export interface Flow {
  id: string; name: string; status: 'draft' | 'active' | 'paused';
  trigger: Record<string, unknown>; graph: { nodes: FlowNode[]; edges: FlowEdge[] }; createdAt: string;
}
export interface FlowNode { id: string; type: string; x?: number; y?: number; data?: Record<string, unknown>; }
export interface FlowEdge { source: string; target: string; branch?: 'true' | 'false'; }
export interface Agent {
  id: string; name: string; model: string; enabled: boolean; systemPrompt: string; createdAt: string;
}
export interface Campaign {
  id: string; name: string; message: string; status: string;
  sentCount: number; totalCount: number; scheduledAt: string | null; createdAt: string;
}
export interface Webhook { id: string; name: string; token: string; events: string[]; hits: number; url?: string; }
export interface Member { membershipId: string; role: Role; userId: string; name: string; email: string; }
export interface Plan { id: string; name: string; price: number; features: string[]; }
export interface Subscription { plan: string; status: string; currentPeriodEnd: string | null; }
export interface Dashboard {
  kpis: { leads: number; revenue: number; sales: number; ticket: number; conversion: number };
  series: { byHour: { hour: number; count: number; revenue: number }[] };
}
