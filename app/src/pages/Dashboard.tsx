import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Icon } from '../icons';
import { Spinner, toast } from '../components/ui';
import { AreaChart, Bars } from '../components/charts';
import type { Dashboard as DashboardData } from '../types';

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<DashboardData>('/dashboard').then(setData).catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="empty">Não foi possível carregar o dashboard: {err}</div>;
  if (!data) return <Spinner />;

  const k = data.kpis;
  const kpis: [string, string, string][] = [
    ['Leads novos', String(k.leads), 'users'],
    ['Faturamento', money(k.revenue), 'trend'],
    ['Vendas', String(k.sales), 'card'],
    ['Ticket médio', money(k.ticket), 'tag'],
    ['Conversão', `${k.conversion}%`, 'flow'],
    ['Conexões ativas', '—', 'plug'],
  ];
  const byHour = data.series.byHour;

  return (
    <div className="fade grid">
      <div className="row">
        <div className="seg">{['Hoje', '7 dias', '30 dias'].map((x, i) =>
          <button key={x} className={i === 0 ? 'active' : ''} onClick={() => toast('Período: ' + x)}>{x}</button>)}</div>
        <div className="spacer" />
        <button className="btn sm" onClick={() => toast('Exportando…')}>Exportar</button>
      </div>

      <div className="kpi-grid">
        {kpis.map(([t, v, ic]) => (
          <div className="card kpi" key={t}>
            <div className="top"><span>{t}</span><Icon name={ic} size={16} /></div>
            <div className="val">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        <div className="card pad">
          <div className="row" style={{ marginBottom: 6 }}><span className="title">Faturamento por horário</span>
            <span className="spacer" /><span className="pill teal dot">hoje</span></div>
          <AreaChart data={byHour.map((h) => h.revenue)} />
          <div className="row" style={{ justifyContent: 'space-between', color: 'var(--faint)', fontSize: 10.5, marginTop: 4 }}>
            {[0, 4, 8, 12, 16, 20, 23].map((h) => <span key={h}>{String(h).padStart(2, '0')}h</span>)}
          </div>
        </div>
        <div className="card pad">
          <div className="title" style={{ marginBottom: 6 }}>Vendas por horário</div>
          <Bars data={byHour.map((h) => h.count)} labels={byHour.map((h) => String(h.hour).padStart(2, '0'))} />
        </div>
      </div>
    </div>
  );
}
