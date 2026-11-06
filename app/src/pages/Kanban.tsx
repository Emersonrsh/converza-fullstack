import { useEffect, useRef, useState } from 'react';
import { api, money } from '../api';
import { Avatar, Spinner, toast } from '../components/ui';
import type { Contact, Stage } from '../types';

const STAGES: Stage[] = ['new', 'in_service', 'negotiating', 'won'];
const stageColor: Record<string, string> = { new: 'blue', in_service: 'amber', negotiating: 'teal', won: 'green', lost: 'red' };
const stageLabel: Record<string, string> = { new: 'Novo', in_service: 'Em atendimento', negotiating: 'Negociação', won: 'Ganho', lost: 'Perdido' };

export function Kanban() {
  const [cards, setCards] = useState<Contact[] | null>(null);
  const drag = useRef<string | null>(null);

  useEffect(() => { api.get<{ contacts: Contact[] }>('/contacts').then((r) => setCards(r.contacts)); }, []);

  async function move(id: string, stage: Stage) {
    setCards((cs) => cs?.map((c) => (c.id === id ? { ...c, stage } : c)) ?? cs);
    try { await api.patch(`/contacts/${id}`, { stage }); }
    catch (e) { toast(e instanceof Error ? e.message : 'Erro ao mover'); }
  }

  if (!cards) return <Spinner />;
  const total = (stage: Stage) => cards.filter((c) => c.stage === stage).reduce((a, c) => a + Number(c.value), 0);

  return (
    <div className="fade" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, alignItems: 'start' }}>
      {STAGES.map((stage) => (
        <div key={stage} onDragOver={(e) => e.preventDefault()}
          onDrop={() => { if (drag.current) { move(drag.current, stage); drag.current = null; } }}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="card pad" style={{ padding: '12px 14px' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className={`pill ${stageColor[stage]} dot`} style={{ height: 22 }}>{stageLabel[stage]}</span>
              <b className="muted">{cards.filter((c) => c.stage === stage).length}</b>
            </div>
            <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>{money(total(stage))}</div>
          </div>
          {cards.filter((c) => c.stage === stage).map((c) => (
            <div key={c.id} className="card pad" draggable onDragStart={() => { drag.current = c.id; }}
              style={{ padding: 13, cursor: 'grab' }}>
              <div className="row"><Avatar name={c.name} size={30} />
                <div style={{ minWidth: 0 }}><b style={{ fontSize: 13 }}>{c.name}</b><div className="faint" style={{ fontSize: 11 }}>{c.phone}</div></div></div>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
                <b>{Number(c.value) ? money(Number(c.value)) : '—'}</b></div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
