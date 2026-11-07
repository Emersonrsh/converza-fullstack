export type Period = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'last_month' | 'custom';

export interface DashFilters {
  period: Period;
  from: string;
  to: string;
  connectionId: string;
  productId: string;
  currency: string;
}

export interface RangeInfo {
  period: Period; from: string; to: string; days: number; bucket: 'hour' | 'day'; tz: string;
  previous: { from: string; to: string };
}

export interface SalesKpis {
  leads: number; revenue: number; sales: number; adSpend: number; roas: number;
  conversion: number; ticket: number; cost: number; fees: number; profit: number;
}

export interface SalesDash {
  range: RangeInfo;
  header: { accountName: string; totalLeads: number };
  kpis: SalesKpis;
  previous: SalesKpis;
  profitSettings: { gatewayFeePercent: number; taxPercent: number };
  series: {
    period: { key: string; label: string; revenue: number; count: number }[];
    byHour: { hour: number; revenue: number; count: number }[];
  };
  byConnection: { id: string | null; name: string; phone: string | null; count: number; revenue: number }[];
  byState: { state: string | null; count: number; revenue: number }[];
  byProduct: { id: string; name: string; count: number; revenue: number }[];
  currencies: string[];
}

export interface SaleRow {
  id: string; createdAt: string; dateLabel: string; status: 'pending' | 'approved' | 'refused' | 'refunded';
  amount: number; currency: string; externalId: string | null; sourceId: string | null; state: string | null;
  origin: string; notes: string | null; invoiceNumber: string | null; invoiceUrl: string | null; invoiceIssuedAt: string | null;
  productId: string | null; contactId: string | null; connectionId: string | null;
  productName: string | null; customerName: string | null; customerPhone: string | null;
  connectionName: string | null; connectionPhone: string | null;
}

export interface AttendanceKpis {
  conversations: number; leads: number; inbound: number; outbound: number; outboundAuto: number; outboundHuman: number;
  firstResponseSec: number | null; firstHumanResponseSec: number | null; flowsDone: number; humanQueue?: number;
}

export interface AttendanceDash {
  range: RangeInfo;
  kpis: AttendanceKpis & { humanQueue: number };
  previous: AttendanceKpis;
  series: {
    period: { key: string; label: string; inbound: number; outbound: number }[];
    byHour: { hour: number; count: number }[];
  };
  byConnection: { id: string | null; name: string; phone: string | null; conversations: number; messages: number }[];
  byAgent: { id: string; name: string; messages: number; conversations: number }[];
  funnel: { stage: string; count: number }[];
  topFlows: { id: string; name: string; started: number; done: number }[];
  leadSources: { ads: number; organic: number };
}

export interface Achievements {
  revenue: number; sales: number;
  level: { key: string; label: string } | null;
  next: { key: string; label: string; target: number; progress: number } | null;
  levels: { key: string; label: string; target: number; reached: boolean }[];
  steps: { key: string; label: string; done: boolean; route: string }[];
}

export interface PartnerInfo {
  enabled: boolean; code?: string; link?: string; commissionPercent?: number; contactUrl?: string | null;
  referrals?: number; activeReferrals?: number;
}

export interface AdSpendEntry {
  id: string; date: string; amount: number; currency: string; campaignName: string | null; origin: string;
}
