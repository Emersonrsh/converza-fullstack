export type Role = 'owner' | 'admin' | 'agent';
export type Stage = 'new' | 'in_service' | 'negotiating' | 'won' | 'lost';

export interface User { id: string; name: string; email: string; }
export interface Account { id: string; name: string; slug: string; role: Role; }

export interface Contact {
  id: string; name: string; phone: string; waId: string | null;
  stage: Stage; tags: string[]; value: string; lastContactAt: string | null; createdAt: string;
}
export interface Conversation {
  id: string; status: string; unreadCount: number; lastMessageAt: string; botPaused: boolean;
  contactId: string; contactName: string; contactPhone: string; stage: Stage;
}
export interface Message {
  id: string; conversationId: string; direction: 'in' | 'out'; type: string;
  body: string | null; mediaUrl?: string | null; status: string; createdAt: string;
}
export interface ActiveRun { id: string; status: string; startedAt: string; flowId: string; flowName: string; }
export interface Connection {
  id: string; name: string; displayPhone: string | null; phoneNumberId: string | null;
  status: 'connected' | 'disconnected' | 'pending'; createdAt: string;
}
export type FlowStatus = 'draft' | 'active' | 'paused';
export interface Flow {
  id: string; name: string; status: FlowStatus; folderId: string | null; archivedAt: string | null;
  shareCode: string | null; trigger: Record<string, any>; graph: { nodes: FlowNode[]; edges: FlowEdge[] };
  createdAt: string; updatedAt: string;
}
export interface FlowListItem {
  id: string; name: string; status: FlowStatus; folderId: string | null; archivedAt: string | null;
  shareCode: string | null; trigger: Record<string, any>; blocks: number; runs: number; activeRuns: number;
  createdAt: string; updatedAt: string;
}
export interface FlowFolder { id: string; name: string; color: string; flowCount: number; }
export interface FlowNode { id: string; type: string; position?: { x: number; y: number }; x?: number; y?: number; data?: Record<string, any>; }
export interface FlowEdge { id?: string; source: string; target: string; sourceHandle?: string | null; branch?: string | null; }
export interface NodeStat { entries: number; advances: number; }
export interface Product { id: string; name: string; price: string; checkoutUrl: string | null; }
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
