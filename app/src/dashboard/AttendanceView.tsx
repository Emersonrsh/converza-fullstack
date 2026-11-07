import { useNavigate } from 'react-router-dom';
import { Donut, EmptyChart, HBarList, HourBars, TimeChart } from './charts';
import { KpiCard, Panel } from './widgets';
import { fmtDuration, fmtNum, STAGE_PT, trend } from './format';
import type { AttendanceDash } from './types';

/** Aba "Atendimento": volume de conversas, mensagens, tempo de resposta, equipe e fluxos. */
export function AttendanceView({ data }: { data: AttendanceDash }) {
  const nav = useNavigate();
  const k = data.kpis; const p = data.previous;
  // tempo de resposta: menor é melhor (seta verde quando cai)
  const tSec = (a: number | null, b: number | null) => (a === null || b === null ? 0 : trend(a, b));
  const cards = [
    { icon: 'chats', tone: 'blue', label: 'Conversas novas', value: fmtNum(k.conversations), t: trend(k.conversations, p.conversations), info: 'Conversas abertas no período (primeiro contato de cada pessoa por número).' },
    { icon: 'messageIn', tone: 'teal', label: 'Mensagens recebidas', value: fmtNum(k.inbound), t: trend(k.inbound, p.inbound), info: 'Mensagens que os clientes enviaram no período.' },
    { icon: 'messageOut', tone: 'purple', label: 'Mensagens enviadas', value: fmtNum(k.outbound), t: trend(k.outbound, p.outbound), info: `Total enviado no período: ${fmtNum(k.outboundHuman)} pela equipe e ${fmtNum(k.outboundAuto)} automáticas.` },
    { icon: 'bot', tone: 'amber', label: 'Respostas automáticas', value: fmtNum(k.outboundAuto), t: trend(k.outboundAuto, p.outboundAuto), info: 'Mensagens enviadas por fluxos, agentes de IA e disparos.' },
    { icon: 'timer', tone: 'green', label: 'Tempo de 1ª resposta', value: fmtDuration(k.firstResponseSec), t: tSec(k.firstResponseSec, p.firstResponseSec), invert: true, info: 'Tempo médio entre a primeira mensagem do cliente e a primeira resposta (automática ou humana).' },
    { icon: 'headset', tone: 'pink', label: '1ª resposta humana', value: fmtDuration(k.firstHumanResponseSec), t: tSec(k.firstHumanResponseSec, p.firstHumanResponseSec), invert: true, info: 'Tempo médio até alguém da equipe responder pela primeira vez.' },
    { icon: 'flow', tone: 'teal', label: 'Fluxos concluídos', value: fmtNum(k.flowsDone), t: trend(k.flowsDone, p.flowsDone), info: 'Execuções de fluxo que chegaram ao fim no período.' },
    { icon: 'userArrow', tone: 'red', label: 'Aguardando humano', value: fmtNum(k.humanQueue), t: 0, hide: true, info: 'Conversas em atendimento humano agora (automação pausada), ainda não resolvidas.', action: { icon: 'arrowRight', title: 'Abrir Chats ao vivo', onClick: () => nav('/inbox') } },
  ] as const;

  const hours = data.series.byHour;
  return (
    <>
      <div className="kgrid">
        {cards.map((x) => (
          <KpiCard key={x.label} icon={x.icon} tone={x.tone} label={x.label} value={x.value} trend={x.t} info={x.info}
            invertTrend={'invert' in x} hideTrend={'hide' in x} action={'action' in x ? x.action : undefined} testId={`kpi-${x.label}`} />
        ))}
      </div>

      <div className="drow two">
        <Panel title="Mensagens por período" sub="Recebidas e enviadas ao longo do tempo" testId="chart-messages">
          <TimeChart data={data.series.period} integer area={false}
            series={[
              { key: 'inbound', name: 'Recebidas', color: '#2f73e0', format: (v) => fmtNum(v) },
              { key: 'outbound', name: 'Enviadas', color: '#19b3a4', format: (v) => fmtNum(v) },
            ]} />
          <div className="legend"><span><i style={{ background: '#2f73e0' }} />Recebidas</span><span><i style={{ background: '#19b3a4' }} />Enviadas</span></div>
        </Panel>
        <Panel title="Mensagens por horário" sub="Quando os clientes mais chamam, por hora do dia">
          <HourBars data={hours.map((h) => ({ hour: h.hour, value: h.count }))} color="#2f73e0"
            tooltip={(i) => (<><b>{String(hours[i].hour).padStart(2, '0')}h</b><div>Recebidas: <b>{hours[i].count}</b></div></>)} />
        </Panel>
      </div>

      <div className="drow three">
        <Panel title="Atendimento por instância" sub="Conversas e mensagens por conexão">
          <HBarList color="#2f73e0" items={data.byConnection.map((c) => ({ key: c.id ?? 'none', label: c.name, sub: `${fmtNum(c.conversations)} conversas`, value: c.messages, display: `${fmtNum(c.messages)} msgs` }))} />
        </Panel>
        <Panel title="Mensagens por atendente" sub="Respostas enviadas pela equipe">
          <HBarList color="#db2777" empty="Nenhuma resposta da equipe no período."
            items={data.byAgent.map((a) => ({ key: a.id, label: a.name, sub: `${fmtNum(a.conversations)} conversas`, value: a.messages, display: `${fmtNum(a.messages)} msgs` }))} />
        </Panel>
        <Panel title="Origem dos leads" sub="Anúncios (clique para o WhatsApp) × orgânico">
          <Donut items={[
            { key: 'ads', label: 'Anúncios', value: data.leadSources.ads },
            { key: 'organic', label: 'Orgânico', value: data.leadSources.organic },
          ]} format={(v) => fmtNum(v)} centerLabel="leads" />
        </Panel>
      </div>

      <div className="drow two">
        <Panel title="Fluxos mais executados" sub="Execuções iniciadas e concluídas no período">
          {data.topFlows.length === 0 ? <EmptyChart /> : (
            <div className="dtable">
              <table>
                <thead><tr><th>Fluxo</th><th>Iniciadas</th><th>Concluídas</th><th>Conclusão</th></tr></thead>
                <tbody>
                  {data.topFlows.map((f) => (
                    <tr key={f.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/flows/${f.id}`)}>
                      <td><b>{f.name}</b></td><td>{fmtNum(f.started)}</td><td>{fmtNum(f.done)}</td>
                      <td style={{ minWidth: 140 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <div className="progress" style={{ flex: 1 }}><i style={{ width: `${f.started ? Math.round((f.done / f.started) * 100) : 0}%` }} /></div>
                          <b style={{ fontSize: 12 }}>{f.started ? Math.round((f.done / f.started) * 100) : 0}%</b>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="Funil de vendas" sub="Contatos em cada etapa (agora)">
          <HBarList color="#8b5cf6" items={data.funnel.map((f) => ({ key: f.stage, label: STAGE_PT[f.stage] ?? f.stage, value: f.count, display: fmtNum(f.count) }))} />
        </Panel>
      </div>
    </>
  );
}
