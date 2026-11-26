/**
 * Converza Members — painel da empresa: cursos (módulos e aulas em PDF), membros e aparência da área.
 */
import { ImageCropper } from '../components/ImageCropper';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, apiFetch, getAccountId, getToken, API_BASE } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Modal, Spinner, TopbarActions, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';

interface CourseRow {
  id: string; title: string; description: string | null; coverUrl: string | null; previewUrl?: string | null; productId: string | null; productName: string | null;
  published: boolean; modules: number; lessons: number; lessonsWithFile: number; members: number;
}
interface Settings { slug: string; url: string; title: string; subtitle: string; color: string; bannerUrl: string | null; storage: 'r2' | 'local' | null }
interface LessonT { id: string; title: string; description: string | null; fileName: string | null; fileSize: number | null; hasFile: boolean; sort: number }
interface ModuleT { id: string; title: string; sort: number; coverUrl: string | null; locked: boolean; unlockAfterDays: number | null; isBonus?: boolean; buyPrice?: number | null; buyUrl?: string | null; unlockRules?: { id: string; productId: string; productName: string }[]; lessons: LessonT[] }
interface CourseFull { course: CourseRow & { members: number }; modules: ModuleT[] }
interface Person {
  id: string; name: string | null; email: string | null; phone: string | null; createdAt: string; lastLoginAt: string | null; hasPassword: boolean;
  courses: { accessId: string; courseId: string; title: string; source: string; since: string; done: number; total: number }[];
}
interface Product { id: string; name: string; price: number }

const mb = (n: number | null | undefined) => (!n ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(n > 10 * 1024 * 1024 ? 0 : 1)} MB`);
const dt = (s: string | null) => (s ? new Date(s).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** Envio de arquivo com progresso (PDFs grandes). */
function upload(path: string, file: File, onProgress?: (p: number) => void): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${path}`);
    const t = getToken(); const a = getAccountId();
    if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
    if (a) xhr.setRequestHeader('x-account-id', a);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let d: Record<string, unknown> = {};
      try { d = JSON.parse(xhr.responseText || '{}'); } catch { /* sem corpo */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(d); else reject(new Error(String(d.error ?? `Erro ${xhr.status}`)));
    };
    xhr.onerror = () => reject(new Error('A conexão caiu durante o envio. Tente de novo.'));
    xhr.send(file);
  });
}

function useCanEdit() {
  const { accountId, accounts } = useAuth();
  return accounts.find((a) => a.id === accountId)?.role !== 'agent';
}

export default function Members() {
  return (
    <Routes>
      <Route path="curso/:id" element={<CourseEditor />} />
      <Route path="*" element={<MembersHome />} />
    </Routes>
  );
}

function StorageWarning({ storage }: { storage: Settings['storage'] | undefined }) {
  // undefined = ainda carregando: só avisa quando o servidor responder que não há armazenamento
  if (storage !== null) return null;
  return (
    <div className="mbx-warn" data-testid="mbx-storage-warn">
      <Icon name="alert" size={16} />
      <span><b>Armazenamento de arquivos não configurado.</b> Os PDFs e as capas ficam no Cloudflare R2. Até o administrador da plataforma configurar, não dá para enviar arquivos.</span>
    </div>
  );
}

/* ============================================================ início: cursos, membros, aparência */

function MembersHome() {
  const [tab, setTab] = useState<'cursos' | 'membros' | 'aparencia'>('cursos');
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => { api.get<Settings>('/members/settings').then(setSettings).catch(() => {}); }, []);
  return (
    <div className="mbx">
      <TopbarActions>
        {settings && <a className="btn" href={settings.url} target="_blank" rel="noreferrer" data-testid="mbx-open-area"><Icon name="external" size={14} />Abrir área de membros</a>}
      </TopbarActions>
      <div className="mbx-head">
        <div className="seg" role="tablist">
          {([['cursos', 'Cursos'], ['membros', 'Membros'], ['aparencia', 'Aparência e endereço']] as const).map(([k, l]) => (
            <button key={k} type="button" className={cx(tab === k && 'active')} onClick={() => setTab(k)} data-testid={`mbx-tab-${k}`}>{l}</button>
          ))}
        </div>
        {settings && <span className="mbx-url"><Icon name="link" size={13} /><a href={settings.url} target="_blank" rel="noreferrer">{settings.url.replace(/^https?:\/\//, '')}</a>
          <button type="button" className="btn icon sm ghost" onClick={() => { void navigator.clipboard?.writeText(settings.url); toast('Endereço copiado'); }} aria-label="Copiar endereço"><Icon name="copy" size={13} /></button></span>}
      </div>
      <StorageWarning storage={settings?.storage} />
      {tab === 'cursos' && <CoursesTab />}
      {tab === 'membros' && <PeopleTab />}
      {tab === 'aparencia' && settings && <LookTab settings={settings} onChange={setSettings} />}
    </div>
  );
}

function CoursesTab() {
  const nav = useNavigate();
  const canEdit = useCanEdit();
  const [rows, setRows] = useState<CourseRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => { api.get<{ courses: CourseRow[] }>('/members/courses').then((r) => setRows(r.courses)).catch((e) => toast(e.message)); }, []);
  useEffect(() => { load(); }, [load]);
  if (!rows) return <Spinner />;
  return (
    <>
      <div className="mbx-intro">
        <div>
          <h2>Cursos</h2>
          <p className="muted">Monte cursos com módulos e aulas em PDF. Ligue o curso a um produto: quando a venda for aprovada, o comprador recebe o acesso pelo WhatsApp e por e-mail.</p>
        </div>
        {canEdit && <button type="button" className="btn primary" onClick={() => setCreating(true)} data-testid="mbx-new-course"><Icon name="plus" size={15} />Novo curso</button>}
      </div>
      {!rows.length ? (
        <div className="mbx-empty"><Icon name="book" size={30} /><b>Nenhum curso ainda</b><span>Crie o primeiro curso e suba os PDFs das aulas.</span>
          {canEdit && <button type="button" className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} />Criar curso</button>}</div>
      ) : (
        <div className="mbx-grid">
          {rows.map((c) => (
            <button type="button" key={c.id} className="mbx-course" onClick={() => nav(`/members/curso/${c.id}`)} data-testid="mbx-course">
              <span className="mbx-cover">{c.coverUrl ? <img src={c.coverUrl} alt="" /> : <span className="mbx-cover-ph"><Icon name="book" size={26} /></span>}</span>
              <span className="mbx-course-body">
                <span className="mbx-course-top"><b>{c.title}</b><span className={cx('pill dot', c.published ? 'green' : '')}>{c.published ? 'Publicado' : 'Rascunho'}</span></span>
                <small>{c.modules} módulo(s) · {c.lessons} aula(s){c.lessons > c.lessonsWithFile ? ` · ${c.lessons - c.lessonsWithFile} sem PDF` : ''}</small>
                <small><Icon name="dollar" size={12} />{c.productName ? `Liberado na venda de “${c.productName}”` : 'Sem produto ligado'}</small>
                <small><Icon name="users" size={12} />{c.members} membro(s)</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {creating && <NewCourseModal onClose={() => setCreating(false)} onDone={(id) => nav(`/members/curso/${id}`)} />}
    </>
  );
}

function NewCourseModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { const r = await api.post<{ course: { id: string } }>('/members/courses', { title }); onDone(r.course.id); }
    catch (e) { toast((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title="Novo curso" icon="book" width={460} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!title.trim() || busy} onClick={() => void save()} data-testid="mbx-create">{busy ? 'Criando…' : 'Criar curso'}</button>
    </>}>
      <label className="label">Nome do curso</label>
      <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) void save(); }} placeholder="Ex.: Treinamento Natal no Pix" data-testid="mbx-course-title" />
    </Modal>
  );
}

function PeopleTab() {
  const canEdit = useCanEdit();
  const [rows, setRows] = useState<Person[] | null>(null);
  const [q, setQ] = useState('');
  const [revoke, setRevoke] = useState<{ p: Person; c: Person['courses'][number] } | null>(null);
  const [revokeAll, setRevokeAll] = useState<Person | null>(null);
  const [mods, setMods] = useState<Person | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => { api.get<{ members: Person[] }>(`/members/people${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => setRows(r.members)).catch((e) => toast(e.message)); }, [q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  async function resend(p: Person) {
    try { const r = await api.post<{ whatsapp: boolean; email: boolean }>(`/members/people/${p.id}/resend`); toast(`Link enviado${r.whatsapp ? ' pelo WhatsApp' : ''}${r.whatsapp && r.email ? ' e' : ''}${r.email ? ' por e-mail' : ''}`); }
    catch (e) { toast((e as Error).message); }
  }
  return (
    <>
      <div className="mbx-intro">
        <div><h2>Membros</h2><p className="muted">Quem tem acesso aos cursos. O acesso é liberado sozinho na venda aprovada de um produto ligado ao curso, ou por você, pelo número de WhatsApp.</p></div>
        <div className="mbx-people-acts">
          <input className="input" style={{ maxWidth: 280 }} placeholder="Buscar por nome, e-mail ou WhatsApp" value={q} onChange={(e) => setQ(e.target.value)} data-testid="mbx-people-q" />
          {canEdit && <button type="button" className="btn primary" onClick={() => setAdding(true)} data-testid="mbx-add-person"><Icon name="plus" size={15} />Liberar acesso</button>}
        </div>
      </div>
      {!rows ? <Spinner /> : !rows.length ? (
        <div className="mbx-empty"><Icon name="users" size={28} /><b>{q ? 'Ninguém encontrado' : 'Nenhum membro ainda'}</b><span>{q ? 'Tente outro termo.' : 'Ligue um curso a um produto; a primeira venda aprovada cria o primeiro membro.'}</span></div>
      ) : (
        <div className="card mbx-table-wrap">
          <table className="table mbx-table" data-testid="mbx-people">
            <thead><tr><th>Membro</th><th>Cursos e progresso</th><th>Desde</th><th>Último acesso</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} data-testid="mbx-person">
                  <td><b>{p.name || 'Sem nome'}</b><small className="faint">{[p.email, p.phone ? `+${p.phone}` : null].filter(Boolean).join(' · ')}</small></td>
                  <td>{p.courses.map((c) => (
                    <div key={c.accessId} className="mbx-pc">
                      <span>{c.title}</span>{(c.source === 'manual' || c.source === 'flow') && <small className="mbx-src">{c.source === 'flow' ? 'fluxo' : 'manual'}</small>}<span className="mbx-mini"><i style={{ width: `${c.total ? Math.round((c.done / c.total) * 100) : 0}%` }} /></span><small>{c.done}/{c.total}</small>
                      {canEdit && <button type="button" className="btn icon sm ghost" title="Tirar o acesso a este curso" onClick={() => setRevoke({ p, c })} data-testid="mbx-revoke"><Icon name="close" size={12} /></button>}
                    </div>
                  ))}</td>
                  <td>{dt(p.createdAt)}</td>
                  <td>{p.lastLoginAt ? dt(p.lastLoginAt) : <span className="faint">nunca entrou</span>}</td>
                  <td>{canEdit && <div className="mbx-person-acts">
                    <button type="button" className="btn sm" onClick={() => setMods(p)} data-testid="mbx-person-modules"><Icon name="layers" size={13} />Módulos</button>
                    <button type="button" className="btn sm" onClick={() => void resend(p)} data-testid="mbx-resend"><Icon name="send" size={13} />Reenviar acesso</button>
                    <button type="button" className="btn sm ghost danger" onClick={() => setRevokeAll(p)} data-testid="mbx-revoke-all"><Icon name="lock" size={13} />Bloquear acesso</button>
                  </div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mods && <MemberModulesModal person={mods} onClose={() => setMods(null)} />}
      {adding && <GrantModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {revokeAll && (
        <ConfirmModal title="Bloquear o acesso?" confirm="Bloquear acesso" danger onClose={() => setRevokeAll(null)}
          onConfirm={async () => { await api.del(`/members/people/${revokeAll.id}/access`); setRevokeAll(null); load(); toast('Acesso bloqueado'); }}>
          <p><b>{revokeAll.name || (revokeAll.phone ? `+${revokeAll.phone}` : revokeAll.email)}</b> perde o acesso a todos os cursos ({revokeAll.courses.length}) e não consegue mais entrar na área de membros. Para devolver, use “Liberar acesso” com o mesmo número.</p>
        </ConfirmModal>
      )}
      {revoke && (
        <ConfirmModal title="Tirar o acesso?" confirm="Tirar acesso" danger onClose={() => setRevoke(null)}
          onConfirm={async () => { await api.del(`/members/access/${revoke.c.accessId}`); setRevoke(null); load(); toast('Acesso removido'); }}>
          <p><b>{revoke.p.name || revoke.p.email || 'Este membro'}</b> deixa de ver o curso <b>{revoke.c.title}</b>. Uma nova venda aprovada do produto libera de novo.</p>
        </ConfirmModal>
      )}
    </>
  );
}

interface MemberModule {
  id: string; title: string; isBonus: boolean; defaultLocked: boolean; defaultUnlockAt: string | null; ruleLocked: boolean; unlockAfterDays: number | null;
  override: 'unlocked' | 'locked' | null; overrideSource: 'manual' | 'sale' | 'flow' | null; saleProduct: string | null; locked: boolean; unlockAt: string | null;
  pendingSale: string | null; pendingAt: string | null;
}
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

/** Liberar ou bloquear módulos só para um aluno. */
function MemberModulesModal({ person, onClose }: { person: Person; onClose: () => void }) {
  const [data, setData] = useState<{ courses: { id: string; title: string; modules: MemberModule[] }[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api.get<{ courses: { id: string; title: string; modules: MemberModule[] }[] }>(`/members/people/${person.id}/modules`).then(setData).catch((e) => toast(e.message)), [person.id]);
  useEffect(() => { void load(); }, [load]);
  async function set(m: MemberModule, state: 'unlocked' | 'locked' | null) {
    setBusy(m.id);
    try { await api.put(`/members/people/${person.id}/modules/${m.id}`, { state }); await load(); } catch (e) { toast((e as Error).message); }
    setBusy(null);
  }
  const ruleText = (m: MemberModule) => !m.ruleLocked ? 'liberado' : m.unlockAfterDays ? (m.defaultLocked && m.defaultUnlockAt ? `libera em ${fmtDay(m.defaultUnlockAt)}` : 'já liberado pelos dias') : 'bloqueado';
  const who = person.name || (person.phone ? `+${person.phone}` : person.email);
  return (
    <Modal title={`Módulos de ${who}`} icon="layers" width={620} onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Pronto</button>}>
      <p className="muted" style={{ marginTop: 0 }}>O que você escolher aqui vale só para este aluno e vence a regra do módulo. “Seguir regra” volta ao que vale para todos.</p>
      {!data ? <Spinner /> : !data.courses.length ? <p className="faint">Este aluno não tem cursos.</p> : data.courses.map((c) => (
        <div key={c.id} className="mbx-mm-course">
          <h4>{c.title}</h4>
          {c.modules.map((m) => (
            <div key={m.id} className={cx('mbx-mm', m.locked ? 'is-locked' : 'is-open')} data-testid="mbx-mm">
              <div className="mbx-mm-t">
                <b>{m.isBonus && <span className="mbx-bonus-tag"><Icon name="gift" size={11} />Bônus</span>} {m.title}</b>
                <small>
                  {m.locked ? <span className="mbx-mm-st off"><Icon name="lock" size={11} />Bloqueado{m.unlockAt ? ` até ${fmtDay(m.unlockAt)}` : ''}</span> : <span className="mbx-mm-st on"><Icon name="check" size={11} />Liberado</span>}
                  {m.override ? (m.overrideSource === 'sale' ? ` · pela venda de ${m.saleProduct ?? 'um produto'}` : m.overrideSource === 'flow' ? ' · pelo fluxo' : ' · escolha para este aluno') : ` · regra do módulo: ${ruleText(m)}`}
                  {m.locked && m.pendingSale !== null && m.pendingSale !== undefined && <span className="mbx-mm-pend" data-testid="mbx-mm-pending-sale"> · libera na venda aprovada{m.pendingSale ? ` de ${m.pendingSale}` : ''}</span>}
                </small>
              </div>
              <div className="mbx-seg" role="group" aria-label="Acesso ao módulo">
                <button type="button" className={cx(!m.override && 'on')} disabled={busy === m.id} onClick={() => void set(m, null)} data-testid="mbx-mm-rule">Seguir regra</button>
                <button type="button" className={cx(m.override === 'unlocked' && 'on')} disabled={busy === m.id} onClick={() => void set(m, 'unlocked')} data-testid="mbx-mm-open"><Icon name="check" size={12} />Liberar</button>
                <button type="button" className={cx(m.override === 'locked' && 'on')} disabled={busy === m.id} onClick={() => void set(m, 'locked')} data-testid="mbx-mm-lock"><Icon name="lock" size={12} />Bloquear</button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </Modal>
  );
}

/** Liberar cursos para um número de WhatsApp, sem venda. */
function GrantModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [courses, setCourses] = useState<CourseRow[] | null>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [pick, setPick] = useState<string[]>([]);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<{ courses: CourseRow[] }>('/members/courses').then((r) => { setCourses(r.courses); if (r.courses.length === 1) setPick([r.courses[0].id]); }).catch((e) => toast(e.message)); }, []);
  const digits = phone.replace(/\D/g, '');
  async function save() {
    setBusy(true);
    try {
      const r = await api.post<{ granted: string[]; already: number; notified: { whatsapp: boolean; email: boolean; error?: string } | null }>('/members/people', { phone, name: name.trim() || undefined, courseIds: pick, notify });
      const sent = r.notified ? (r.notified.whatsapp ? ' Link enviado pelo WhatsApp.' : r.notified.email ? ' Link enviado por e-mail.' : ' O link não saiu: sem conversa recente no WhatsApp nem e-mail; o cliente entra digitando o número.') : '';
      toast(r.granted.length ? `Acesso liberado a ${r.granted.length} curso(s).${sent}` : 'Esse número já tinha acesso a esses cursos.');
      onDone();
    } catch (e) { toast((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title="Liberar acesso" icon="users" width={500} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={busy || digits.length < 10 || !pick.length} onClick={() => void save()} data-testid="mbx-grant-save">{busy ? 'Liberando…' : 'Liberar acesso'}</button>
    </>}>
      <div className="mbx-form">
        <label className="label">WhatsApp do cliente (com DDD)</label>
        <input className="input" type="tel" autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 99999-9999 ou +52 55 1234 5678" data-testid="mbx-grant-phone" />
        <small className="faint">É com este número que o cliente entra na área de membros.</small>
        <label className="label">Nome (opcional)</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Como aparece na área" data-testid="mbx-grant-name" />
        <label className="label">Cursos</label>
        {!courses ? <Spinner /> : !courses.length ? <small className="faint">Crie um curso primeiro.</small> : (
          <div className="mbx-checks">
            {courses.map((c) => (
              <label key={c.id} className={cx('mbx-check', pick.includes(c.id) && 'on')} data-testid="mbx-grant-course">
                <input type="checkbox" checked={pick.includes(c.id)} onChange={(e) => setPick(e.target.checked ? [...pick, c.id] : pick.filter((x) => x !== c.id))} />
                <span>{c.title}</span>{!c.published && <small className="faint">rascunho</small>}
              </label>
            ))}
          </div>
        )}
        <label className="mbx-check plain">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} data-testid="mbx-grant-notify" />
          <span>Mandar o link de acesso pelo WhatsApp (se ele falou com você nas últimas 24 h) ou por e-mail</span>
        </label>
      </div>
    </Modal>
  );
}

function LookTab({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const canEdit = useCanEdit();
  const [f, setF] = useState({ slug: settings.slug, title: settings.title, subtitle: settings.subtitle, color: settings.color });
  const [busy, setBusy] = useState(false);
  const [up, setUp] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = f.slug !== settings.slug || f.title !== settings.title || f.subtitle !== settings.subtitle || f.color !== settings.color;
  async function save() {
    setBusy(true);
    try { onChange(await api.put<Settings>('/members/settings', f)); toast('Área de membros atualizada'); }
    catch (e) { toast((e as Error).message); }
    setBusy(false);
  }
  async function banner(file: File) {
    setUp(0);
    try { onChange((await upload('/members/settings/banner', file, setUp)) as unknown as Settings); toast('Imagem de capa atualizada'); }
    catch (e) { toast((e as Error).message); }
    setUp(null);
  }
  const base = settings.url.replace(/\/m\/[^/]+$/, '/m/');
  return (
    <div className="mbx-look">
      <div className="card mbx-card">
        <h3>Endereço e textos</h3>
        <label className="label">Endereço da área</label>
        <div className="mbx-slug"><span>{base.replace(/^https?:\/\//, '')}</span><input className="input" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} disabled={!canEdit} data-testid="mbx-slug" /></div>
        <small className="faint">Mudar o endereço faz os links antigos pararem de funcionar.</small>
        <label className="label">Título da página inicial</label>
        <input className="input" maxLength={80} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} disabled={!canEdit} data-testid="mbx-title" />
        <label className="label">Frase de boas-vindas</label>
        <input className="input" maxLength={160} value={f.subtitle} onChange={(e) => setF({ ...f, subtitle: e.target.value })} disabled={!canEdit} data-testid="mbx-subtitle" />
        <label className="label">Cor de destaque</label>
        <div className="mbx-colors">
          {['#19b3a4', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#eab308', '#ef4444'].map((c) => (
            <button key={c} type="button" className={cx(f.color.toLowerCase() === c && 'on')} style={{ background: c }} onClick={() => canEdit && setF({ ...f, color: c })} aria-label={`Cor ${c}`} />
          ))}
          <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} disabled={!canEdit} aria-label="Outra cor" />
        </div>
        {canEdit && <div className="mbx-acts"><button type="button" className="btn primary" disabled={!dirty || busy} onClick={() => void save()} data-testid="mbx-look-save">{busy ? 'Salvando…' : 'Salvar'}</button></div>}
      </div>
      <div className="card mbx-card">
        <h3>Imagem de capa</h3>
        <p className="muted">Aparece no topo da página inicial e na tela de login. Use uma imagem larga (1920 × 800, até 5 MB).</p>
        <div className="mbx-banner" style={settings.bannerUrl ? { backgroundImage: `url("${settings.bannerUrl}")` } : { background: `radial-gradient(70% 90% at 85% 30%, ${f.color}55, transparent 60%), #0a1314` }}>
          <div><small>Área de membros</small><b>{f.title}</b><span>{f.subtitle}</span></div>
        </div>
        {canEdit && <div className="mbx-acts">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const x = e.target.files?.[0]; if (x) void banner(x); e.target.value = ''; }} />
          {settings.bannerUrl && <button type="button" className="btn ghost" onClick={async () => { onChange(await api.del<Settings>('/members/settings/banner')); }}>Remover</button>}
          <button type="button" className="btn" disabled={up !== null || !settings.storage} onClick={() => fileRef.current?.click()} data-testid="mbx-banner-up"><Icon name="upload" size={14} />{up !== null ? `Enviando ${Math.round(up * 100)}%` : 'Enviar imagem'}</button>
        </div>}
      </div>
    </div>
  );
}

/* ============================================================ editor do curso */

function CourseEditor() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const canEdit = useCanEdit();
  const [d, setD] = useState<CourseFull | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [storage, setStorage] = useState<Settings['storage'] | undefined>(undefined);
  const [f, setF] = useState({ title: '', description: '', productId: '' });
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<null | { kind: 'course' } | { kind: 'module'; m: ModuleT } | { kind: 'lesson'; l: LessonT }>(null);
  const [newMod, setNewMod] = useState('');
  const [coverUp, setCoverUp] = useState<number | null>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLInputElement>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<CourseFull>(`/members/courses/${id}`);
      setD(r); setF({ title: r.course.title, description: r.course.description ?? '', productId: r.course.productId ?? '' });
    } catch (e) { toast((e as Error).message); nav('/members'); }
  }, [id, nav]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api.get<{ products: Product[] }>('/settings/products').then((r) => setProducts(r.products)).catch(() => {});
    api.get<Settings>('/members/settings').then((s) => setStorage(s.storage)).catch(() => {});
  }, []);

  if (!d) return <Spinner />;
  const c = d.course;
  const dirty = f.title !== c.title || f.description !== (c.description ?? '') || f.productId !== (c.productId ?? '');
  const lessonsTotal = d.modules.reduce((s, m) => s + m.lessons.length, 0);
  const missing = d.modules.reduce((s, m) => s + m.lessons.filter((l) => !l.hasFile).length, 0);

  async function saveInfo() {
    setBusy(true);
    try { await api.patch(`/members/courses/${id}`, { title: f.title, description: f.description || null, productId: f.productId || null }); await load(); toast('Curso salvo'); }
    catch (e) { toast((e as Error).message); }
    setBusy(false);
  }
  async function togglePublish() {
    try { await api.patch(`/members/courses/${id}`, { published: !c.published }); await load(); toast(c.published ? 'Curso voltou para rascunho' : 'Curso publicado'); }
    catch (e) { toast((e as Error).message); }
  }
  async function addModule() {
    if (!newMod.trim()) return;
    try { await api.post(`/members/courses/${id}/modules`, { title: newMod.trim() }); setNewMod(''); await load(); }
    catch (e) { toast((e as Error).message); }
  }
  async function move(kind: 'module' | 'lesson', mi: number, li: number, dir: -1 | 1) {
    const mods = d!.modules.map((m) => ({ id: m.id, lessons: m.lessons.map((l) => l.id) }));
    if (kind === 'module') { const j = mi + dir; if (j < 0 || j >= mods.length) return; [mods[mi], mods[j]] = [mods[j], mods[mi]]; }
    else { const arr = mods[mi].lessons; const j = li + dir; if (j < 0 || j >= arr.length) return; [arr[li], arr[j]] = [arr[j], arr[li]]; }
    try { await api.post(`/members/courses/${id}/order`, { modules: mods }); await load(); } catch (e) { toast((e as Error).message); }
  }
  async function cover(file: File) {
    setCoverUp(0);
    try { await upload(`/members/courses/${id}/cover`, file, setCoverUp); await load(); } catch (e) { toast((e as Error).message); }
    setCoverUp(null);
  }
  async function savePreview(blob: Blob) {
    try {
      await upload(`/members/courses/${id}/preview`, new File([blob], 'previa.jpg', { type: 'image/jpeg' }));
      setCropFile(null); await load(); toast('Prévia do link salva');
    } catch (e) { toast((e as Error).message); }
  }

  return (
    <div className="mbx">
      <TopbarActions>
        <Link to="/members" className="btn ghost"><Icon name="arrowLeft" size={14} />Cursos</Link>
        {canEdit && <button type="button" className={cx('btn', c.published ? '' : 'primary')} onClick={() => void togglePublish()} data-testid="mbx-publish">{c.published ? 'Voltar para rascunho' : 'Publicar curso'}</button>}
      </TopbarActions>
      <StorageWarning storage={storage} />
      <div className="mbx-editor">
        <aside className="card mbx-card mbx-info">
          <div className="mbx-cover big" onClick={() => canEdit && storage && coverRef.current?.click()} role="button" title="Trocar a capa">
            {c.coverUrl ? <img src={c.coverUrl} alt="" /> : <span className="mbx-cover-ph"><Icon name="image" size={26} /><small>Capa vertical (2:3)</small></span>}
            {coverUp !== null && <span className="mbx-cover-up">{Math.round(coverUp * 100)}%</span>}
          </div>
          <input ref={coverRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const x = e.target.files?.[0]; if (x) void cover(x); e.target.value = ''; }} />
          <label className="label" style={{ marginTop: 10 }}>Prévia do link no WhatsApp</label>
          <div className="mbx-preview" onClick={() => canEdit && storage && previewRef.current?.click()} role="button" title="Escolher a imagem da prévia (1200 × 628)" data-testid="mbx-preview">
            {c.previewUrl
              ? <img src={c.previewUrl} alt="" />
              : c.coverUrl
                ? <><img src={c.coverUrl} alt="" /><span className="tag">automática: recorte da capa</span></>
                : <span className="mbx-cover-ph"><Icon name="image" size={22} /><small>1200 × 628</small></span>}
          </div>
          <small className="faint" style={{ display: 'block', marginTop: 4 }}>
            Aparece quando o link de acesso é enviado no WhatsApp. Envie qualquer imagem e enquadre no tamanho exato (1200 × 628).
            {c.previewUrl && canEdit && <> <button type="button" className="linklike" onClick={() => void api.del(`/members/courses/${id}/preview`).then(load).catch((e) => toast((e as Error).message))}>Usar recorte da capa</button></>}
          </small>
          <input ref={previewRef} type="file" accept="image/jpeg,image/png,image/webp" hidden data-testid="mbx-preview-file"
            onChange={(e) => { const x = e.target.files?.[0]; if (x) setCropFile(x); e.target.value = ''; }} />
          {cropFile && <ImageCropper file={cropFile} width={1200} height={628} title="Prévia do link no WhatsApp" onCancel={() => setCropFile(null)} onDone={savePreview} />}
          <div className="mbx-pub"><span className={cx('pill dot', c.published ? 'green' : '')} data-testid="mbx-status">{c.published ? 'Publicado' : 'Rascunho'}</span><small className="faint">{c.members} membro(s) · {lessonsTotal} aula(s)</small></div>
          <label className="label">Nome</label>
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} disabled={!canEdit} data-testid="mbx-edit-title" />
          <label className="label">Descrição</label>
          <textarea className="input" rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} disabled={!canEdit} placeholder="O que o aluno vai aprender" />
          <label className="label">Liberar acesso na venda de</label>
          <select className="select" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })} disabled={!canEdit} data-testid="mbx-product">
            <option value="">Nenhum produto (sem liberação automática)</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <small className="faint">Venda aprovada desse produto (Pix, InfinitePay, XPag ou registrada pelo fluxo) cria o membro e manda o link de acesso.</small>
          {canEdit && <div className="mbx-acts">
            <button type="button" className="btn ghost danger" onClick={() => setDel({ kind: 'course' })} data-testid="mbx-del-course"><Icon name="trash" size={14} />Excluir</button>
            <button type="button" className="btn primary" disabled={!dirty || busy || !f.title.trim()} onClick={() => void saveInfo()} data-testid="mbx-save-course">{busy ? 'Salvando…' : 'Salvar'}</button>
          </div>}
        </aside>

        <section className="mbx-modules">
          <div className="mbx-intro">
            <div><h2>Módulos e aulas</h2><p className="muted">{missing ? `${missing} aula(s) ainda sem PDF.` : 'Cada aula tem um PDF. O aluno lê na própria área e marca como concluída.'}</p></div>
          </div>
          {d.modules.map((m, mi) => (
            <ModuleCard key={m.id} m={m} index={mi} count={d.modules.length} canEdit={canEdit} storage={storage}
              onReload={load} onMove={(dir) => void move('module', mi, 0, dir)} onMoveLesson={(li, dir) => void move('lesson', mi, li, dir)}
              onDelete={() => setDel({ kind: 'module', m })} onDeleteLesson={(l) => setDel({ kind: 'lesson', l })} />
          ))}
          {canEdit && (
            <div className="mbx-addmod">
              <input className="input" placeholder={d.modules.length ? 'Nome do próximo módulo' : 'Nome do primeiro módulo (ex.: Módulo 1 · Começando)'} value={newMod}
                onChange={(e) => setNewMod(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addModule(); }} data-testid="mbx-new-module" />
              <button type="button" className="btn" disabled={!newMod.trim()} onClick={() => void addModule()} data-testid="mbx-add-module"><Icon name="plus" size={14} />Adicionar módulo</button>
            </div>
          )}
        </section>
      </div>

      {del && (
        <ConfirmModal danger confirm="Excluir" onClose={() => setDel(null)}
          title={del.kind === 'course' ? 'Excluir o curso?' : del.kind === 'module' ? 'Excluir o módulo?' : 'Excluir a aula?'}
          onConfirm={async () => {
            if (del.kind === 'course') { await api.del(`/members/courses/${id}`); nav('/members'); return; }
            if (del.kind === 'module') await api.del(`/members/modules/${del.m.id}`); else await api.del(`/members/lessons/${del.l.id}`);
            setDel(null); await load();
          }}>
          <p>{del.kind === 'course' ? <>O curso <b>{c.title}</b>, os módulos, as aulas e os PDFs são apagados, e os membros perdem o acesso a ele.</>
            : del.kind === 'module' ? <>O módulo <b>{del.m.title}</b> e as {del.m.lessons.length} aula(s) dele são apagados, com os PDFs.</>
              : <>A aula <b>{del.l.title}</b> e o PDF dela são apagados.</>} Não dá para desfazer.</p>
        </ConfirmModal>
      )}
    </div>
  );
}

function ModuleCard({ m, index, count, canEdit, storage, onReload, onMove, onMoveLesson, onDelete, onDeleteLesson }: {
  m: ModuleT; index: number; count: number; canEdit: boolean; storage: Settings['storage'] | undefined; onReload: () => Promise<void>;
  onMove: (dir: -1 | 1) => void; onMoveLesson: (li: number, dir: -1 | 1) => void; onDelete: () => void; onDeleteLesson: (l: LessonT) => void;
}) {
  const [title, setTitle] = useState(m.title);
  const [newLesson, setNewLesson] = useState('');
  const [coverUp, setCoverUp] = useState<number | null>(null);
  const [lockOpen, setLockOpen] = useState(false);
  const coverRef = useRef<HTMLInputElement>(null);
  useEffect(() => setTitle(m.title), [m.title]);
  async function rename() {
    if (!title.trim() || title === m.title) { setTitle(m.title); return; }
    try { await api.patch(`/members/modules/${m.id}`, { title: title.trim() }); await onReload(); } catch (e) { toast((e as Error).message); }
  }
  async function toggleBonus() {
    try { await api.patch(`/members/modules/${m.id}`, { isBonus: !m.isBonus }); await onReload(); toast(m.isBonus ? 'Módulo voltou para o curso' : 'Módulo marcado como bônus'); } catch (e) { toast((e as Error).message); }
  }
  async function addLesson() {
    if (!newLesson.trim()) return;
    try { await api.post(`/members/modules/${m.id}/lessons`, { title: newLesson.trim() }); setNewLesson(''); await onReload(); } catch (e) { toast((e as Error).message); }
  }
  async function cover(file: File) {
    setCoverUp(0);
    try { await upload(`/members/modules/${m.id}/cover`, file, setCoverUp); await onReload(); } catch (e) { toast((e as Error).message); }
    setCoverUp(null);
  }
  return (
    <div className="card mbx-mod" data-testid="mbx-module">
      <div className="mbx-mod-hd">
        <div className="mbx-cover sm" onClick={() => canEdit && storage && coverRef.current?.click()} role="button" title="Capa do módulo (aparece na vitrine)">
          {m.coverUrl ? <img src={m.coverUrl} alt="" /> : <span className="mbx-cover-ph"><Icon name="image" size={16} /></span>}
          {coverUp !== null && <span className="mbx-cover-up">{Math.round(coverUp * 100)}%</span>}
        </div>
        <input ref={coverRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const x = e.target.files?.[0]; if (x) void cover(x); e.target.value = ''; }} />
        <div className="mbx-mod-title">
          <small>{m.isBonus ? <span className="mbx-bonus-tag" data-testid="mbx-bonus-tag"><Icon name="gift" size={11} />Bônus</span> : `Módulo ${index + 1}`}{m.locked && <span className="mbx-locked" data-testid="mbx-module-locked"><Icon name="lock" size={11} />{m.unlockAfterDays ? `libera ${m.unlockAfterDays} dia(s) após a compra` : 'bloqueado'}</span>}{!!m.unlockRules?.length && <span className="mbx-rule-tag" data-testid="mbx-rule-tag"><Icon name="cart" size={11} />libera na venda de {m.unlockRules.map((r) => r.productName).join(', ')}</span>}</small>
          <input className="input bare" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} disabled={!canEdit} data-testid="mbx-module-title" />
        </div>
        {canEdit && <div className="mbx-row-acts">
          <button type="button" className={cx('btn sm', m.isBonus ? 'mbx-bonusbtn on' : 'ghost')} onClick={() => void toggleBonus()} data-testid="mbx-bonus" title={m.isBonus ? 'Este módulo aparece na fileira de Bônus. Clique para voltar ao curso.' : 'Mostrar este módulo na fileira de Bônus, separada do curso'}><Icon name="gift" size={13} />{m.isBonus ? 'É bônus' : 'Bônus'}</button>
          <button type="button" className={cx('btn sm', m.locked ? 'mbx-lockbtn on' : 'ghost')} onClick={() => setLockOpen(true)} data-testid="mbx-lock"><Icon name="lock" size={13} />{m.locked ? 'Bloqueado' : 'Bloquear'}</button>
          <button type="button" className="btn icon sm ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Subir módulo"><Icon name="chevronUp" size={14} /></button>
          <button type="button" className="btn icon sm ghost" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Descer módulo"><Icon name="chevron" size={14} /></button>
          <button type="button" className="btn icon sm ghost danger" onClick={onDelete} aria-label="Excluir módulo"><Icon name="trash" size={14} /></button>
        </div>}
      </div>
      <div className="mbx-lessons">
        {m.lessons.map((l, li) => (
          <LessonRow key={l.id} l={l} index={li} count={m.lessons.length} canEdit={canEdit} storage={storage} onReload={onReload}
            onMove={(dir) => onMoveLesson(li, dir)} onDelete={() => onDeleteLesson(l)} />
        ))}
        {!m.lessons.length && <div className="faint mbx-none">Nenhuma aula neste módulo.</div>}
      </div>
      {lockOpen && <LockModal m={m} onClose={() => setLockOpen(false)} onReload={onReload} onDone={async () => { setLockOpen(false); await onReload(); }} />}
      {canEdit && (
        <div className="mbx-addlesson">
          <input className="input" placeholder="Nome da nova aula" value={newLesson} onChange={(e) => setNewLesson(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addLesson(); }} data-testid="mbx-new-lesson" />
          <button type="button" className="btn sm" disabled={!newLesson.trim()} onClick={() => void addLesson()} data-testid="mbx-add-lesson"><Icon name="plus" size={13} />Aula</button>
        </div>
      )}
    </div>
  );
}

/** Bloquear ou liberar um módulo para os alunos (na hora, ou N dias depois da compra de cada um). */
function LockModal({ m, onClose, onDone, onReload }: { m: ModuleT; onClose: () => void; onDone: () => Promise<void>; onReload: () => Promise<void> }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [prod, setProd] = useState('');
  const [past, setPast] = useState(true);
  const [ruleBusy, setRuleBusy] = useState(false);
  useEffect(() => { api.get<{ products: Product[] }>('/settings/products').then((r) => setProducts(r.products)).catch(() => {}); }, []);
  const rules = m.unlockRules ?? [];
  async function addRule() {
    if (!prod) return;
    setRuleBusy(true);
    try {
      const r = await api.post<{ applied: number }>(`/members/modules/${m.id}/rules`, { productId: prod, applyPast: past });
      setProd(''); await onReload();
      toast(r.applied ? `Regra criada. ${r.applied} comprador(es) antigo(s) já ganharam o módulo.` : 'Regra criada: a próxima venda aprovada libera o módulo');
    } catch (e) { toast((e as Error).message); }
    setRuleBusy(false);
  }
  async function delRule(id: string) {
    try { await api.del(`/members/rules/${id}`); await onReload(); toast('Regra removida. Quem já ganhou o módulo continua com ele.'); } catch (e) { toast((e as Error).message); }
  }
  const [mode, setMode] = useState<'open' | 'locked' | 'drip'>(!m.locked ? 'open' : m.unlockAfterDays ? 'drip' : 'locked');
  const [days, setDays] = useState(m.unlockAfterDays ?? 7);
  const [price, setPrice] = useState(m.buyPrice != null ? String(m.buyPrice) : '');
  const [link, setLink] = useState(m.buyUrl ?? '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const buy = { buyPrice: price.trim() ? Number(price.replace(',', '.')) : null, buyUrl: link.trim() || null };
      await api.patch(`/members/modules/${m.id}`, mode === 'open' ? { locked: false, ...buy } : { locked: true, unlockAfterDays: mode === 'drip' ? Math.max(1, Math.round(days)) : null, ...buy });
      toast(mode === 'open' ? 'Módulo liberado para os alunos' : mode === 'drip' ? `Módulo libera ${days} dia(s) após a compra` : 'Módulo bloqueado');
      await onDone();
    } catch (e) { toast((e as Error).message); setBusy(false); }
  }
  const opt = (k: typeof mode, title: string, desc: string) => (
    <label className={cx('mbx-opt', mode === k && 'on')} data-testid={`mbx-lock-${k}`}>
      <input type="radio" name="lock" checked={mode === k} onChange={() => setMode(k)} />
      <span><b>{title}</b><small>{desc}</small></span>
    </label>
  );
  return (
    <Modal title={`Acesso ao “${m.title}”`} icon="lock" width={520} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={busy || (mode === 'drip' && !(days >= 1))} onClick={() => void save()} data-testid="mbx-lock-save">{busy ? 'Salvando…' : 'Salvar'}</button>
    </>}>
      <div className="mbx-opts">
        {opt('open', 'Liberado', 'Todos os alunos com acesso ao curso veem e abrem as aulas.')}
        {opt('locked', 'Bloqueado', 'Os alunos veem o módulo com um cadeado, mas não abrem as aulas até você liberar.')}
        {opt('drip', 'Liberar depois de alguns dias', 'Cada aluno ganha o módulo alguns dias depois da compra dele.')}
        {mode === 'drip' && <div className="mbx-days"><input className="input" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="mbx-lock-days" /><span>dia(s) depois da compra</span></div>}
      </div>
      {mode !== 'open' && (
        <div className="mbx-rules" data-testid="mbx-buy">
          <b>Como o aluno compra este módulo</b>
          <small className="faint">Na área de membros, quem clicar no módulo bloqueado vê o preço e os botões de compra. Sem link, ele fala com você pelo WhatsApp com uma mensagem pronta. Em faixas por valor pago, ele vê quanto falta.</small>
          <div className="mbx-buy-row">
            <label><span>Preço (R$)</span><input className="input" inputMode="decimal" placeholder="Opcional" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.,]/g, ''))} data-testid="mbx-buy-price" /></label>
            <label className="grow"><span>Link de compra (checkout)</span><input className="input" type="url" placeholder="https://… (opcional)" value={link} onChange={(e) => setLink(e.target.value)} data-testid="mbx-buy-url" /></label>
          </div>
        </div>
      )}
      <div className="mbx-rules" data-testid="mbx-rules">
        <b>Liberar quando houver venda aprovada</b>
        <small className="faint">Assim que a venda de um destes produtos for aprovada, o módulo libera para o comprador, mesmo que esteja bloqueado para os outros. Se ele ainda não tiver o curso, ganha o acesso também. Bom para upsell e order bump.</small>
        {rules.map((r) => (
          <div className="mbx-rule" key={r.id} data-testid="mbx-rule"><Icon name="cart" size={14} /><span>Venda aprovada de <b>{r.productName}</b></span><button type="button" className="btn sm ghost danger" onClick={() => void delRule(r.id)} aria-label="Remover regra" data-testid="mbx-rule-del"><Icon name="trash" size={13} /></button></div>
        ))}
        <div className="mbx-rule-add">
          <select className="input" value={prod} onChange={(e) => setProd(e.target.value)} data-testid="mbx-rule-product">
            <option value="">Escolha o produto…</option>
            {products.filter((p) => !rules.some((r) => r.productId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="button" className="btn" disabled={!prod || ruleBusy} onClick={() => void addRule()} data-testid="mbx-rule-add"><Icon name="plus" size={14} />Adicionar</button>
        </div>
        {!!prod && <label className="mbx-check plain"><input type="checkbox" checked={past} onChange={(e) => setPast(e.target.checked)} data-testid="mbx-rule-past" /><span>Liberar também para quem já comprou esse produto (sem mandar mensagem)</span></label>}
        {!products.length && <small className="faint">Cadastre produtos em Configurações → Produtos para usar esta regra.</small>}
      </div>
    </Modal>
  );
}

function LessonRow({ l, index, count, canEdit, storage, onReload, onMove, onDelete }: {
  l: LessonT; index: number; count: number; canEdit: boolean; storage: Settings['storage'] | undefined; onReload: () => Promise<void>; onMove: (dir: -1 | 1) => void; onDelete: () => void;
}) {
  const [title, setTitle] = useState(l.title);
  const [up, setUp] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => setTitle(l.title), [l.title]);
  async function rename() {
    if (!title.trim() || title === l.title) { setTitle(l.title); return; }
    try { await api.patch(`/members/lessons/${l.id}`, { title: title.trim() }); await onReload(); } catch (e) { toast((e as Error).message); }
  }
  async function send(file: File) {
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { toast('Envie o material em PDF.'); return; }
    if (file.size > 100 * 1024 * 1024) { toast('PDF grande demais: o limite é 100 MB por aula.'); return; }
    setUp(0);
    try { await upload(`/members/lessons/${l.id}/file`, new File([file], file.name, { type: 'application/pdf' }), setUp); await onReload(); toast('PDF enviado'); }
    catch (e) { toast((e as Error).message); }
    setUp(null);
  }
  async function preview() {
    try { const r = await apiFetch(`/members/lessons/${l.id}/file`).then((x) => x.json()) as { url: string }; window.open(r.url, '_blank', 'noopener'); }
    catch (e) { toast((e as Error).message); }
  }
  return (
    <div className={cx('mbx-lesson', !l.hasFile && 'nofile')} data-testid="mbx-lesson"
      onDragOver={(e) => { if (canEdit) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); const x = e.dataTransfer.files?.[0]; if (x && canEdit && storage) void send(x); }}>
      <span className="mbx-lesson-n">{index + 1}</span>
      <input className="input bare" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} disabled={!canEdit} />
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { const x = e.target.files?.[0]; if (x) void send(x); e.target.value = ''; }} data-testid="mbx-pdf-input" />
      {up !== null ? <span className="mbx-up"><span className="mbx-mini"><i style={{ width: `${Math.round(up * 100)}%` }} /></span><small>{Math.round(up * 100)}%</small></span>
        : l.hasFile ? <button type="button" className="mbx-file" onClick={() => void preview()} title="Abrir o PDF" data-testid="mbx-file"><Icon name="file" size={13} /><span>{l.fileName}</span><small>{mb(l.fileSize)}</small></button>
          : <span className="mbx-nofile">sem PDF</span>}
      {canEdit && <div className="mbx-row-acts">
        <button type="button" className="btn sm" disabled={up !== null || !storage} onClick={() => fileRef.current?.click()} data-testid="mbx-upload"><Icon name="upload" size={13} />{l.hasFile ? 'Trocar' : 'Enviar PDF'}</button>
        <button type="button" className="btn icon sm ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Subir aula"><Icon name="chevronUp" size={13} /></button>
        <button type="button" className="btn icon sm ghost" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Descer aula"><Icon name="chevron" size={13} /></button>
        <button type="button" className="btn icon sm ghost danger" onClick={onDelete} aria-label="Excluir aula"><Icon name="trash" size={13} /></button>
      </div>}
    </div>
  );
}

