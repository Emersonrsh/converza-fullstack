import { Link } from 'react-router-dom';
import { Icon } from '../../icons';
import { MEMBERS_TEXT } from '../blocks';
import { Field, RichText, ToggleCard } from './fields';
import type { EditorProps } from './types';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** Área de membros: entrega (ou tira) cursos e módulos do Converza Members para o contato da conversa. */
export function MembersEditor({ d, set, vars, lookups }: EditorProps) {
  const revoke = d.action === 'revoke';
  const courseIds: string[] = Array.isArray(d.courseIds) ? d.courseIds : [];
  const moduleIds: string[] = Array.isArray(d.moduleIds) ? d.moduleIds : [];
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
  const courses = lookups.courses;
  return (
    <>
      <div className="fx-mb-note">
        <Icon name="book" size={16} />
        <span>Usa o WhatsApp do contato como login na <b>Converza Members</b>. Ao liberar, o fluxo pode mandar na conversa um link que entra direto na área. Os cursos ficam em <Link to="/members">Converza Members</Link>.</span>
      </div>

      <div className="fx-mb-actions" role="group" aria-label="Ação">
        <button type="button" className={cx('fx-choice', !revoke && 'on')} onClick={() => set({ action: 'grant', moduleIds: [] })} data-testid="mb-action-grant"><Icon name="unlock" size={15} />Liberar acesso</button>
        <button type="button" className={cx('fx-choice', revoke && 'on')} onClick={() => set({ action: 'revoke', moduleIds: [] })} data-testid="mb-action-revoke"><Icon name="lock" size={15} />Tirar acesso</button>
      </div>

      <Field label={revoke ? 'Tirar o acesso a' : 'Entregar'} required>
        {!courses.length ? (
          <div className="bm-hint">Nenhum curso criado ainda. <Link to="/members">Criar curso</Link></div>
        ) : (
          <div className="fx-mb-list">
            {courses.map((c) => {
              const whole = courseIds.includes(c.id);
              const cm: Record<string, string[]> = d.courseModules && typeof d.courseModules === 'object' ? d.courseModules : {};
              // módulos liberados na entrega; sem escolha salva, vale o que está liberado no curso hoje
              const picked = cm[c.id] ?? c.modules.filter((m) => !m.locked || moduleIds.includes(m.id)).map((m) => m.id);
              const setPicked = (list: string[]) => set({ courseModules: { ...cm, [c.id]: list } });
              const pickCourse = (on: boolean) => {
                const next = { ...cm };
                if (on) next[c.id] = picked; else delete next[c.id];
                set({ courseIds: toggle(courseIds, c.id, on), courseModules: next });
              };
              return (
                <div key={c.id} className={cx('fx-mb-course', whole && 'on')}>
                  <label className="fx-mb-row" data-testid="mb-course">
                    <input type="checkbox" checked={whole} onChange={(e) => (revoke ? set({ courseIds: toggle(courseIds, c.id, e.target.checked) }) : pickCourse(e.target.checked))} />
                    <span><b>{c.title}</b><small>{revoke ? 'O curso inteiro' : whole ? `${picked.length} de ${c.modules.length} módulo(s) liberado(s) na entrega` : `${c.modules.length} módulo(s)`}{!c.published && ' · rascunho'}</small></span>
                  </label>
                  {!revoke && whole && c.modules.length > 0 && (
                    <div className="fx-mb-mods" data-testid="mb-modules">
                      <div className="fx-mb-mods-hd">
                        <small>Módulos liberados na entrega</small>
                        <span>
                          <button type="button" onClick={() => setPicked(c.modules.map((m) => m.id))} data-testid="mb-all">Todos</button>
                          <button type="button" onClick={() => setPicked([])} data-testid="mb-none">Nenhum</button>
                        </span>
                      </div>
                      {c.modules.map((m) => (
                        <label key={m.id} className="fx-mb-row sm" data-testid="mb-module">
                          <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(toggle(picked, m.id, e.target.checked))} />
                          <span>{m.isBonus && <Icon name="gift" size={12} />}<em>{m.title}</em>{!picked.includes(m.id) && <Icon name="lock" size={12} />}</span>
                        </label>
                      ))}
                      <small className="fx-mb-tip">Os desmarcados ficam bloqueados para este contato até você liberar (na aba Membros, com uma regra de venda ou com outro bloco).</small>
                    </div>
                  )}
                  {revoke && c.modules.length > 0 && (
                    <div className="fx-mb-mods">
                      <div className="fx-mb-mods-hd"><small>Ou bloquear só estes módulos</small></div>
                      {c.modules.map((m) => (
                        <label key={m.id} className="fx-mb-row sm" data-testid="mb-module">
                          <input type="checkbox" checked={moduleIds.includes(m.id)} onChange={(e) => set({ moduleIds: toggle(moduleIds, m.id, e.target.checked) })} />
                          <span><em>{m.title}</em></span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Field>

      {!revoke && courseIds.length > 0 && <PaidTiers d={d} set={set} lookups={lookups} courseIds={courseIds} />}

      {!revoke && (
        <>
          <ToggleCard title="Liberar o resto dos módulos na venda aprovada" desc="Os módulos desmarcados liberam sozinhos quando entrar uma venda aprovada deste contato. O cliente recebe um aviso." checked={!!d.unlockRestOnSale} onChange={(unlockRestOnSale) => set({ unlockRestOnSale })} testId="mb-rest-sale" />
          {d.unlockRestOnSale && (
            <div className="fx-mb-sub">
              <Field label="Venda de qual produto?">
                <select className="select" value={d.unlockRestProductId ?? ''} onChange={(e) => set({ unlockRestProductId: e.target.value })} data-testid="mb-rest-product">
                  <option value="">Qualquer venda aprovada</option>
                  {lookups.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            </div>
          )}
          <ToggleCard title="Liberar o resto dos módulos depois de alguns dias" desc="Os módulos desmarcados liberam sozinhos depois do prazo, contado a partir da entrega. O cliente recebe um aviso." checked={!!d.unlockRestAfter} onChange={(unlockRestAfter) => set({ unlockRestAfter, unlockRestDays: d.unlockRestDays ?? 7 })} testId="mb-rest-days" />
          {d.unlockRestAfter && (
            <div className="fx-mb-sub fx-mb-days">
              <input className="input" type="number" min={1} max={3650} value={d.unlockRestDays ?? 7} onChange={(e) => set({ unlockRestDays: Number(e.target.value) })} data-testid="mb-rest-days-n" />
              <span>dia(s) depois da entrega</span>
            </div>
          )}
          {(d.unlockRestOnSale || d.unlockRestAfter) && <div className="bm-hint fx-mb-after">Com os dois ligados, vale o que acontecer primeiro. Só mexe nos módulos desmarcados acima{d.tiersOn ? ' que não estão em nenhuma faixa de valor' : ''}.</div>}
          <ToggleCard title="Mandar o link de acesso na conversa" desc="Uma mensagem com o link curto que entra direto na área. É o link permanente do cliente: é sempre por ele que entra." checked={d.sendMessage !== false} onChange={(sendMessage) => set({ sendMessage })} testId="mb-send" />
          {d.sendMessage !== false && (
            <Field label="Mensagem">
              <RichText value={(d.text ?? MEMBERS_TEXT).replace(/\n*Das próximas vezes, acesse \{\{\s*membros\.area\s*\}\} e digite (?:este|o seu) número de WhatsApp\.?/g, '')} onChange={(text) => set({ text })} vars={[...vars, 'membros.link', 'membros.area', 'membros.cursos', 'membros.modulos']} rows={5} testId="mb-text" />
            </Field>
          )}
          <div className="bm-hint fx-mb-after">Depois deste bloco você pode usar {'{{membros.link}}'}, {'{{membros.area}}'}, {'{{membros.cursos}}'} e {'{{membros.modulos}}'} em outras mensagens.</div>
        </>
      )}
      {revoke && <div className="bm-hint">O cliente não recebe aviso. Para devolver, use outro bloco com “Liberar acesso”.</div>}
    </>
  );
}

interface Tier { id: string; min: number | string; modules: string[] }

/** Faixas por valor pago: cada faixa libera mais módulos e inclui as menores. */
function PaidTiers({ d, set, lookups, courseIds }: { d: EditorProps['d']; set: EditorProps['set']; lookups: EditorProps['lookups']; courseIds: string[] }) {
  const tiers: Tier[] = Array.isArray(d.tiers) ? d.tiers : [];
  const cm: Record<string, string[]> = d.courseModules && typeof d.courseModules === 'object' ? d.courseModules : {};
  const courses = lookups.courses.filter((c) => courseIds.includes(c.id));
  // módulos que não saem na entrega: são eles que as faixas liberam
  const lockable = courses.flatMap((c) => c.modules.filter((m) => !(cm[c.id] ?? []).includes(m.id)).map((m) => ({ ...m, course: c.title })));
  const sorted = [...tiers].sort((a, b) => Number(a.min) - Number(b.min));
  const setTiers = (list: Tier[]) => set({ tiers: list });
  const upd = (id: string, patch: Partial<Tier>) => setTiers(tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const add = () => {
    const last = sorted[sorted.length - 1];
    setTiers([...tiers, { id: `t${Date.now().toString(36)}`, min: last ? Number(last.min) + 10 : 20, modules: [] }]);
  };
  // módulos já liberados por uma faixa menor (aparecem marcados e travados nas maiores)
  const below = (t: Tier) => new Set(sorted.filter((x) => Number(x.min) < Number(t.min)).flatMap((x) => x.modules));
  const fmt = (v: number | string) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return (
    <>
      <ToggleCard title="Liberar módulos conforme o valor pago" desc="Ex.: quem paga R$ 15 recebe os módulos 1 e 2; quem paga R$ 20, também o 3; quem paga R$ 40, tudo. Cada faixa inclui as menores."
        checked={!!d.tiersOn} onChange={(tiersOn) => set({ tiersOn, ...(tiersOn && !tiers.length ? { tiers: [{ id: 't1', min: 20, modules: [] }] } : {}) })} testId="mb-tiers" />
      {d.tiersOn && (
        <div className="fx-mb-sub fx-mb-tiers" data-testid="mb-tiers-box">
          {!lockable.length && <div className="bm-hint">Todos os módulos já saem na entrega. Desmarque acima os que devem depender do valor pago.</div>}
          {sorted.map((t) => {
            const inherited = below(t);
            return (
              <div key={t.id} className="fx-mb-tier" data-testid="mb-tier">
                <div className="fx-mb-tier-hd">
                  <span>A partir de</span>
                  <span className="fx-mb-money">R$<input className="input" type="number" min={0.01} step="0.01" value={t.min} onChange={(e) => upd(t.id, { min: e.target.value })} data-testid="mb-tier-min" /></span>
                  <span>pagos, libera:</span>
                  <button type="button" className="btn icon sm ghost" onClick={() => setTiers(tiers.filter((x) => x.id !== t.id))} title="Remover faixa" data-testid="mb-tier-del"><Icon name="trash" size={14} /></button>
                </div>
                {lockable.map((m) => {
                  const fromBelow = inherited.has(m.id);
                  return (
                    <label key={m.id} className={cx('fx-mb-row sm', fromBelow && 'dim')} data-testid="mb-tier-module">
                      <input type="checkbox" disabled={fromBelow} checked={fromBelow || t.modules.includes(m.id)}
                        onChange={(e) => upd(t.id, { modules: e.target.checked ? [...new Set([...t.modules, m.id])] : t.modules.filter((x) => x !== m.id) })} />
                      <span>{m.isBonus && <Icon name="gift" size={12} />}<em>{m.title}</em>{courses.length > 1 && <small> · {m.course}</small>}{fromBelow && <small> · já na faixa menor</small>}</span>
                    </label>
                  );
                })}
              </div>
            );
          })}
          <button type="button" className="btn sm" onClick={add} data-testid="mb-tier-add"><Icon name="plus" size={14} />Adicionar faixa</button>
          <Field label="Contar os pagamentos de">
            <select className="select" value={d.tierProductId ?? ''} onChange={(e) => set({ tierProductId: e.target.value })} data-testid="mb-tier-product">
              <option value="">Qualquer produto (soma das vendas aprovadas do contato)</option>
              {lookups.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <div className="bm-hint fx-mb-after">
            Se o cliente já pagou quando este bloco roda, libera na hora a faixa do valor pago. Se ainda não pagou, libera sozinho quando a venda for aprovada
            {sorted.length ? ` (${sorted.map((t) => fmt(t.min)).join(', ')})` : ''}, somando tudo o que ele pagou. O cliente recebe um aviso.
          </div>
        </div>
      )}
    </>
  );
}
