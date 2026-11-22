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

      {!revoke && (
        <>
          <ToggleCard title="Mandar o link de acesso na conversa" desc="Uma mensagem com o link que entra direto na área (vale 7 dias, uma vez). Depois, o cliente entra digitando o número." checked={d.sendMessage !== false} onChange={(sendMessage) => set({ sendMessage })} testId="mb-send" />
          {d.sendMessage !== false && (
            <Field label="Mensagem">
              <RichText value={d.text ?? MEMBERS_TEXT} onChange={(text) => set({ text })} vars={[...vars, 'membros.link', 'membros.area', 'membros.cursos', 'membros.modulos']} rows={5} testId="mb-text" />
            </Field>
          )}
          <div className="bm-hint fx-mb-after">Depois deste bloco você pode usar {'{{membros.link}}'}, {'{{membros.area}}'}, {'{{membros.cursos}}'} e {'{{membros.modulos}}'} em outras mensagens.</div>
        </>
      )}
      {revoke && <div className="bm-hint">O cliente não recebe aviso. Para devolver, use outro bloco com “Liberar acesso”.</div>}
    </>
  );
}
