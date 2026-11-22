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
      <div className="fx-note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.5, padding: '10px 12px', borderRadius: 10, background: 'var(--primary-50)', color: 'var(--text)' }}>
        <Icon name="book" size={15} />
        <span>Usa o WhatsApp do contato como login na <b>Converza Members</b>. Ao liberar, o fluxo pode mandar na conversa um link que entra direto na área. Os cursos ficam em <Link to="/members">Converza Members</Link>.</span>
      </div>

      <div className="mbx-seg-row" role="group" aria-label="Ação" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <button type="button" className={cx('fx-choice', !revoke && 'on')} onClick={() => set({ action: 'grant' })} data-testid="mb-action-grant"><Icon name="unlock" size={15} />Liberar acesso</button>
        <button type="button" className={cx('fx-choice', revoke && 'on')} onClick={() => set({ action: 'revoke' })} data-testid="mb-action-revoke"><Icon name="lock" size={15} />Tirar acesso</button>
      </div>

      <Field label={revoke ? 'Tirar o acesso a' : 'Entregar'} required>
        {!courses.length ? (
          <div className="faint" style={{ fontSize: 13 }}>Nenhum curso criado ainda. <Link to="/members">Criar curso</Link></div>
        ) : (
          <div className="fx-mb-list">
            {courses.map((c) => {
              const whole = courseIds.includes(c.id);
              const lockedMods = c.modules.filter((m) => m.locked || moduleIds.includes(m.id));
              return (
                <div key={c.id} className={cx('fx-mb-course', whole && 'on')}>
                  <label className="fx-mb-row" data-testid="mb-course">
                    <input type="checkbox" checked={whole} onChange={(e) => set({ courseIds: toggle(courseIds, c.id, e.target.checked) })} />
                    <span><b>{c.title}</b><small>{revoke ? 'O curso inteiro' : 'O curso inteiro (módulos bloqueados continuam bloqueados)'}{!c.published && ' · rascunho'}</small></span>
                  </label>
                  {lockedMods.length > 0 && (
                    <div className="fx-mb-mods">
                      <small className="faint">{revoke ? 'Ou bloquear só estes módulos:' : 'Também liberar estes módulos bloqueados:'}</small>
                      {(revoke ? c.modules : lockedMods).map((m) => (
                        <label key={m.id} className="fx-mb-row sm" data-testid="mb-module">
                          <input type="checkbox" checked={moduleIds.includes(m.id)} onChange={(e) => set({ moduleIds: toggle(moduleIds, m.id, e.target.checked) })} />
                          <span>{m.isBonus && <Icon name="gift" size={11} />} {m.title}{m.locked && <Icon name="lock" size={11} />}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  {revoke && !lockedMods.length && c.modules.length > 0 && (
                    <div className="fx-mb-mods">
                      <small className="faint">Ou bloquear só estes módulos:</small>
                      {c.modules.map((m) => (
                        <label key={m.id} className="fx-mb-row sm" data-testid="mb-module">
                          <input type="checkbox" checked={moduleIds.includes(m.id)} onChange={(e) => set({ moduleIds: toggle(moduleIds, m.id, e.target.checked) })} />
                          <span>{m.title}</span>
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

      {!revoke && (
        <>
          <ToggleCard title="Mandar o link de acesso na conversa" desc="Uma mensagem com o link que entra direto na área (vale 7 dias, uma vez). Depois, o cliente entra digitando o número." checked={d.sendMessage !== false} onChange={(sendMessage) => set({ sendMessage })} testId="mb-send" />
          {d.sendMessage !== false && (
            <Field label="Mensagem">
              <RichText value={d.text ?? MEMBERS_TEXT} onChange={(text) => set({ text })} vars={[...vars, 'membros.link', 'membros.area', 'membros.cursos', 'membros.modulos']} rows={5} testId="mb-text" />
            </Field>
          )}
          <small className="faint" style={{ display: 'block', marginTop: -4 }}>Depois deste bloco você pode usar {'{{membros.link}}'}, {'{{membros.area}}'}, {'{{membros.cursos}}'} e {'{{membros.modulos}}'} em outras mensagens.</small>
        </>
      )}
      {revoke && <small className="faint" style={{ display: 'block' }}>O cliente não recebe aviso. Para devolver, use outro bloco com “Liberar acesso”.</small>}
    </>
  );
}
