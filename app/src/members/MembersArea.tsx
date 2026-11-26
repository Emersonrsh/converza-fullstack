import { createPortal } from 'react-dom';
/**
 * Converza Members — área do aluno de cada empresa (/m/<slug>).
 * Login próprio do membro, vitrine dos cursos liberados, página do curso e leitor de PDF.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { API_BASE } from '../api';
import { Icon } from '../icons';
import PdfReader, { useFullscreen } from './PdfReader';
import './members.css';

/* ============================================================ API do aluno */

interface Info { title: string; subtitle: string; color: string; company: string; bannerUrl: string | null }
interface Member { id: string; name: string | null; email: string | null; phone: string | null; hasPassword: boolean }
interface LessonLite { id: string; title: string; hasFile: boolean; done: boolean }
interface BuyT { price: number | null; currency: string; paid: number | null; tierMin: number | null; checkoutUrl: string | null; whatsappUrl: string | null }
interface ModuleT { id: string; title: string; bonus?: boolean; coverUrl: string | null; locked: boolean; unlockAt: string | null; buy?: BuyT | null; lessons: LessonLite[]; done: number; total: number }
interface CourseT { id: string; title: string; description: string | null; coverUrl: string | null; modules: ModuleT[]; done: number; total: number }
interface Catalog { member: Member; courses: CourseT[]; continue: { lessonId: string; title: string; moduleTitle: string; courseId: string } | null }
interface LessonFull {
  lesson: { id: string; title: string; description: string | null; fileName: string | null; fileSize: number | null; moduleTitle: string; courseTitle: string; courseId: string; done: boolean };
  hasPdf: boolean; link?: { url: string; embed: string | null } | null; position: number | null; count: number; prevId: string | null; nextId: string | null;
}

const tokenKey = (slug: string) => `cz.member.${slug}`;
class MErr extends Error { status: number; constructor(s: number, m: string) { super(m); this.status = s; } }

function useMemberApi(slug: string) {
  const [token, setTok] = useState<string | null>(() => { try { return localStorage.getItem(tokenKey(slug)); } catch { return null; } });
  const setToken = useCallback((t: string | null) => {
    try { t ? localStorage.setItem(tokenKey(slug), t) : localStorage.removeItem(tokenKey(slug)); } catch { /* sem storage */ }
    setTok(t);
  }, [slug]);
  const call = useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${API_BASE}/m/${slug}${path}`, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && token) setToken(null);
      throw new MErr(res.status, (data as { error?: string }).error ?? `Erro ${res.status}`);
    }
    return data as T;
  }, [slug, token, setToken]);
  return useMemo(() => ({ token, setToken, call }), [token, setToken, call]);
}

/* ============================================================ casca */

export default function MembersArea() {
  return (
    <Routes>
      <Route path="/m/:slug/*" element={<Area />} />
    </Routes>
  );
}

function Area() {
  const { slug = '' } = useParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [missing, setMissing] = useState(false);
  const api = useMemberApi(slug);

  useEffect(() => {
    fetch(`${API_BASE}/m/${slug}/info`).then(async (r) => { if (!r.ok) throw new Error(); setInfo(await r.json()); }).catch(() => setMissing(true));
  }, [slug]);
  useEffect(() => { if (info) document.title = info.title; }, [info]);
  // iPhone ignora user-scalable=no: a pinça só amplia o PDF (o leitor trata os dois dedos), não a página
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', stop);
    document.addEventListener('gesturechange', stop);
    return () => { document.removeEventListener('gesturestart', stop); document.removeEventListener('gesturechange', stop); };
  }, []);

  const style = useMemo(() => ({ '--mb-accent': info?.color ?? '#19b3a4' }) as CSSProperties, [info]);
  if (missing) return <div className="mbr" style={style}><div className="mbr-empty"><Brand /><h1>Área de membros não encontrada</h1><p>Confira o endereço que você recebeu.</p></div></div>;
  if (!info) return <div className="mbr" style={style}><div className="mbr-loading"><span className="mbr-spin" /></div></div>;

  return (
    <div className="mbr" style={style} data-testid="mbr">
      <Routes>
        <Route path="entrar" element={<Enter slug={slug} info={info} api={api} />} />
        <Route path="*" element={api.token ? <Signed slug={slug} info={info} api={api} /> : <Login slug={slug} info={info} api={api} />} />
      </Routes>
    </div>
  );
}

type Api = ReturnType<typeof useMemberApi>;

function Brand({ small }: { small?: boolean }) {
  return (
    <span className={`mbr-brand${small ? ' sm' : ''}`}>
      <img src="/icon-192.png?v=2" alt="" />
      <span><b>Converza</b> Members</span>
    </span>
  );
}

/* ============================================================ login */

function AuthShell({ info, children }: { info: Info; children: ReactNode }) {
  return (
    <div className="mbr-auth">
      <div className="mbr-auth-art" style={info.bannerUrl ? { backgroundImage: `linear-gradient(180deg, rgba(5,10,11,.35), rgba(5,10,11,.92)), url("${info.bannerUrl}")` } : undefined}>
        <Brand />
        <div>
          <span className="mbr-kicker">Área de membros</span>
          <h1>{info.title}</h1>
          <p>{info.subtitle}</p>
        </div>
        <small>{info.company}</small>
      </div>
      <div className="mbr-auth-side">
        <div className="mbr-auth-card">{children}</div>
      </div>
    </div>
  );
}

/** Entrar digitando o WhatsApp da compra, ou pedir o link de acesso de novo na conversa. */
function Login({ slug, info, api }: { slug: string; info: Info; api: Api }) {
  const nav = useNavigate();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState<'enter' | 'link' | null>(null);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = phone.replace(/\D/g, '').length >= 8;

  async function enter(e: FormEvent) {
    e.preventDefault(); if (!ok) return; setBusy('enter'); setErr(null);
    try { const r = await api.call<{ token: string }>('POST', '/enter', { phone }); api.setToken(r.token); nav(`/m/${slug}`, { replace: true }); }
    catch (e2) { setErr((e2 as Error).message); }
    setBusy(null);
  }
  async function sendLink() {
    if (!ok) return; setBusy('link'); setErr(null);
    try { await api.call('POST', '/forgot', { login: phone }); setSent(true); }
    catch (e2) { setErr((e2 as Error).message); }
    setBusy(null);
  }

  return (
    <AuthShell info={info}>
      <h2>Entrar</h2>
      <p className="mbr-muted">Digite o número de WhatsApp que você usou na compra. Se preferir, toque no link de acesso que você recebeu na conversa.</p>
      <form onSubmit={enter} className="mbr-form">
        <label><span>WhatsApp com DDD</span>
          <input className="mbr-input" type="tel" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setSent(false); }} autoComplete="tel" placeholder="(11) 99999-9999" required autoFocus data-testid="mbr-login" /></label>
        <small className="mbr-hint">Use o mesmo WhatsApp da compra. Fora do Brasil, digite com o código do país.</small>
        {err && <div className="mbr-err" data-testid="mbr-err">{err}</div>}
        <button className="mbr-btn primary" disabled={!!busy || !ok} data-testid="mbr-submit">{busy === 'enter' ? 'Entrando…' : 'Entrar'}</button>
        {sent ? <div className="mbr-ok" data-testid="mbr-sent">Se este número tiver acesso, o link chega no seu WhatsApp em instantes.</div>
          : <button type="button" className="mbr-btn" disabled={!!busy || !ok} onClick={() => void sendLink()} data-testid="mbr-send-link">{busy === 'link' ? 'Enviando…' : 'Receber o link no WhatsApp'}</button>}
      </form>
    </AuthShell>
  );
}

/** Link que chega pelo WhatsApp ou e-mail: entra direto. */
function Enter({ slug, info, api }: { slug: string; info: Info; api: Api }) {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const t = params.get('t') ?? '';
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/m/${slug}/magic`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? 'Link inválido');
        api.setToken(d.token); nav(`/m/${slug}`, { replace: true });
      } catch (e) {
        // link já usado: quem já entrou neste aparelho segue direto
        if (api.token) { nav(`/m/${slug}`, { replace: true }); return; }
        setErr((e as Error).message);
      }
    })();
  }, [slug, t, api, nav]);

  return (
    <AuthShell info={info}>
      {!err ? <div className="mbr-loading inline"><span className="mbr-spin" /></div> : <>
        <h2>Link indisponível</h2>
        <div className="mbr-err" data-testid="mbr-enter-err">{err}</div>
        <Link className="mbr-btn primary" to={`/m/${slug}`}>Entrar com o WhatsApp</Link>
      </>}
    </AuthShell>
  );
}

/* ============================================================ logado */

function Signed({ slug, info, api }: { slug: string; info: Info; api: Api }) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loc = useLocation();
  const load = useCallback(() => { api.call<Catalog>('GET', '/catalog').then(setCat).catch((e) => setErr((e as Error).message)); }, [api]);
  useEffect(() => { load(); }, [load, loc.pathname]);

  if (err && !cat) return <div className="mbr-empty"><Brand /><p>{err}</p><button className="mbr-btn" onClick={load}>Tentar de novo</button></div>;
  if (!cat) return <div className="mbr-loading"><span className="mbr-spin" /></div>;
  return (
    <>
      <TopBar slug={slug} member={cat.member} onLogout={() => api.setToken(null)} />
      <Routes>
        <Route path="curso/:courseId" element={<CoursePage slug={slug} cat={cat} />} />
        <Route path="aula/:lessonId" element={<LessonPage slug={slug} api={api} cat={cat} onChange={load} />} />
        <Route path="*" element={<Home slug={slug} info={info} cat={cat} />} />
      </Routes>
      <footer className="mbr-foot"><Brand small /><span>{info.company} · área de membros</span></footer>
    </>
  );
}

function TopBar({ slug, member, onLogout }: { slug: string; member: Member; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const initials = (member.name || member.email || 'M').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <header className="mbr-top">
      <Link to={`/m/${slug}`} className="mbr-home-link"><Brand /></Link>
      <div className="mbr-me">
        <button type="button" className="mbr-avatar" onClick={() => setOpen(!open)} aria-label="Minha conta" data-testid="mbr-avatar">{initials}</button>
        {open && (
          <div className="mbr-menu" onMouseLeave={() => setOpen(false)}>
            <div className="mbr-menu-hd"><b>{member.name || 'Membro'}</b><small>{member.email || member.phone}</small></div>
            <button type="button" onClick={onLogout} data-testid="mbr-logout"><Icon name="logout" size={15} />Sair</button>
          </div>
        )}
      </div>
    </header>
  );
}

const pct = (d: number, t: number) => (t ? Math.round((d / t) * 100) : 0);
const dayMonth = (s: string) => new Date(s).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
const canBuy = (m: ModuleT) => !!m.buy && (!!m.buy.checkoutUrl || !!m.buy.whatsappUrl);
const brl = (v: number, cur = 'BRL') => v.toLocaleString('pt-BR', { style: 'currency', currency: cur || 'BRL' });

/** Folha de compra de um módulo bloqueado: quanto custa (ou quanto falta) e onde pagar. */
function BuySheet({ m, course, onClose }: { m: ModuleT; course: string; onClose: () => void }) {
  const b = m.buy!;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const tier = b.tierMin != null;
  // vai para a raiz da área (fora de seções com camadas próprias), mantendo as cores da área
  const host = (document.querySelector('.mbr') as HTMLElement | null) ?? document.body;
  return createPortal(
    <div className="mbr-sheet-bg" onClick={onClose} data-testid="mbr-buy">
      <div className="mbr-sheet" role="dialog" aria-modal="true" aria-label={`Liberar ${m.title}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="mbr-sheet-x" onClick={onClose} aria-label="Fechar"><Icon name="close" size={18} /></button>
        {m.coverUrl ? <img src={m.coverUrl} alt="" className="mbr-sheet-cover" /> : <span className="mbr-sheet-ic"><Icon name="lock" size={26} /></span>}
        <small className="mbr-muted">{course}</small>
        <h2>Liberar “{m.title}”</h2>
        <p className="mbr-muted">{m.lessons.length ? `${m.lessons.length} aula(s) esperando por você.` : 'Conteúdo exclusivo deste módulo.'}</p>
        {b.price != null && b.price > 0 && (
          <div className="mbr-sheet-price" data-testid="mbr-buy-price">
            {tier ? <><span>Falta só</span><b>{brl(b.price, b.currency)}</b><small>Você já contribuiu com {brl(b.paid ?? 0)}; a partir de {brl(b.tierMin ?? 0)} este módulo libera.</small></>
              : <><span>Por</span><b>{brl(b.price, b.currency)}</b></>}
          </div>
        )}
        {m.unlockAt && <p className="mbr-muted">Ou espere: ele libera sozinho em {dayMonth(m.unlockAt)}.</p>}
        <div className="mbr-sheet-actions">
          {b.checkoutUrl && <a className="mbr-btn primary" href={b.checkoutUrl} target="_blank" rel="noopener noreferrer" data-testid="mbr-buy-checkout"><Icon name="cart" size={16} />Comprar agora</a>}
          {b.whatsappUrl && <a className={`mbr-btn${b.checkoutUrl ? '' : ' primary'}`} href={b.whatsappUrl} target="_blank" rel="noopener noreferrer" data-testid="mbr-buy-whatsapp"><Icon name="whatsapp" size={16} />{b.checkoutUrl ? 'Falar no WhatsApp' : 'Liberar pelo WhatsApp'}</a>}
        </div>
        <small className="mbr-faint">Assim que o pagamento for confirmado, o módulo libera aqui e você recebe um aviso.</small>
      </div>
    </div>,
    host,
  );
}

const lockText = (m: ModuleT) => (m.unlockAt ? `Libera em ${dayMonth(m.unlockAt)}` : 'Bloqueado');
/** aulas que o aluno pode abrir agora (fora dos módulos bloqueados) */
const openLessons = (c: CourseT) => c.modules.filter((m) => !m.locked).flatMap((m) => m.lessons);

function Home({ slug, info, cat }: { slug: string; info: Info; cat: Catalog }) {
  const nav = useNavigate();
  const first = cat.courses[0];
  const firstLesson = first ? (openLessons(first).find((l) => !l.done) ?? openLessons(first)[0]) : undefined;
  const [notice, setNotice] = useState<string | null>(null);
  const [buy, setBuy] = useState<{ m: ModuleT; course: string } | null>(null);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 3500); return () => clearTimeout(t); }, [notice]);
  const go = cat.continue ? cat.continue.lessonId : firstLesson?.id;
  const poster = (c: CourseT, m: ModuleT, i: number) => (
              <button type="button" key={m.id} className={`mbr-poster${m.locked ? ' locked' : ''}`} data-testid="mbr-module"
                onClick={() => {
                  if (m.locked) { if (canBuy(m)) setBuy({ m, course: c.title }); else setNotice(`“${m.title}” está bloqueado${m.unlockAt ? ` e libera em ${dayMonth(m.unlockAt)}` : ' por enquanto'}.`); return; }
                  const l = m.lessons.find((x) => !x.done) ?? m.lessons[0]; if (l) nav(`/m/${slug}/aula/${l.id}`); else nav(`/m/${slug}/curso/${c.id}`);
                }}>
                {m.coverUrl ? <img src={m.coverUrl} alt="" loading="lazy" /> : <span className="mbr-poster-fill" style={{ '--h': `${((i + (m.bonus ? 5 : 0)) * 47) % 360}` } as CSSProperties}><span>{m.title}</span></span>}
                {m.locked && <span className="mbr-lock" data-testid="mbr-module-lock"><Icon name="lock" size={22} /><b>{lockText(m)}</b>{canBuy(m) && <em className="mbr-lock-buy">Toque para liberar</em>}</span>}
                <span className="mbr-poster-info">
                  {m.bonus ? <small>Bônus</small> : !/^\s*m[óo]dulo\b/i.test(m.title) && <small>Módulo {i + 1}</small>}
                  <b>{m.title}</b>
                  <span className="mbr-bar"><i style={{ width: `${pct(m.done, m.total)}%` }} /></span>
                  <em>{m.total ? (m.done ? `${m.done} de ${m.total} aulas` : `${m.total} aula(s)`) : 'Em breve'}</em>
                </span>
              </button>
  );
  return (
    <main className="mbr-main">
      <section className="mbr-hero" style={info.bannerUrl ? { backgroundImage: `linear-gradient(90deg, rgba(6,12,13,.94) 0%, rgba(6,12,13,.7) 45%, rgba(6,12,13,.15) 100%), url("${info.bannerUrl}")` } : undefined} data-testid="mbr-hero">
        <div className="mbr-hero-in">
          <span className="mbr-kicker">{cat.member.name ? `Olá, ${cat.member.name.split(/\s+/)[0]}` : 'Bem-vindo(a)'}</span>
          <h1>{info.title}</h1>
          <p>{info.subtitle}</p>
          {go && <button type="button" className="mbr-btn white" onClick={() => nav(`/m/${slug}/aula/${go}`)} data-testid="mbr-hero-go"><Icon name="play" size={16} />{cat.continue ? 'Continuar' : 'Começar agora'}</button>}
        </div>
      </section>

      {cat.continue && (
        <section className="mbr-sec">
          <h2>Continue de onde parou</h2>
          <button type="button" className="mbr-continue" onClick={() => nav(`/m/${slug}/aula/${cat.continue!.lessonId}`)} data-testid="mbr-continue">
            <span className="mbr-continue-ic"><Icon name="file" size={22} /></span>
            <span><small>{cat.continue.moduleTitle}</small><b>{cat.continue.title}</b></span>
            <Icon name="chevronRight" size={18} />
          </button>
        </section>
      )}

      {!cat.courses.length && (
        <div className="mbr-empty in" data-testid="mbr-no-courses"><Icon name="book" size={30} /><h2>Nenhum curso liberado ainda</h2><p>Quando sua compra for confirmada, os cursos aparecem aqui.</p></div>
      )}

      {cat.courses.map((c) => (
        <section className="mbr-sec" key={c.id} data-testid="mbr-course-row">
          <div className="mbr-sec-hd">
            <div>
              <h2><Link to={`/m/${slug}/curso/${c.id}`}>{c.title}</Link></h2>
              <small>{c.modules.filter((m) => !m.bonus).length} módulo(s) · {c.total} aula(s) · {pct(c.done, c.total)}% concluído</small>
            </div>
            <Link to={`/m/${slug}/curso/${c.id}`} className="mbr-btn ghost sm">Ver curso</Link>
          </div>
          <Rail>{c.modules.filter((m) => !m.bonus).map((m, i) => poster(c, m, i))}</Rail>
        </section>
      ))}
      {cat.courses.filter((c) => c.modules.some((m) => m.bonus)).map((c) => (
        <section className="mbr-sec" key={`b-${c.id}`} data-testid="mbr-bonus-row">
          <div className="mbr-sec-hd">
            <div>
              <h2>Bônus{cat.courses.length > 1 ? <span className="mbr-sec-of"> · {c.title}</span> : null}</h2>
              <small>{c.modules.filter((m) => m.bonus).length} bônus incluído(s)</small>
            </div>
          </div>
          <Rail>{c.modules.filter((m) => m.bonus).map((m, i) => poster(c, m, i))}</Rail>
        </section>
      ))}
      {notice && <div className="mbr-toast" data-testid="mbr-toast"><Icon name="lock" size={15} />{notice}</div>}
      {buy && <BuySheet m={buy.m} course={buy.course} onClose={() => setBuy(null)} />}
    </main>
  );
}

/** Fileira horizontal com setas (no celular, arrasta com o dedo). */
function Rail({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const by = (dir: number) => ref.current?.scrollBy({ left: dir * (ref.current.clientWidth * 0.85), behavior: 'smooth' });
  return (
    <div className="mbr-rail-wrap">
      <button type="button" className="mbr-rail-btn l" onClick={() => by(-1)} aria-label="Anteriores"><Icon name="chevronLeft" size={18} /></button>
      <div className="mbr-rail" ref={ref}>{children}</div>
      <button type="button" className="mbr-rail-btn r" onClick={() => by(1)} aria-label="Próximos"><Icon name="chevronRight" size={18} /></button>
    </div>
  );
}

function CoursePage({ slug, cat }: { slug: string; cat: Catalog }) {
  const { courseId } = useParams();
  const c = cat.courses.find((x) => x.id === courseId);
  const nav = useNavigate();
  const [buy, setBuy] = useState<{ m: ModuleT; course: string } | null>(null);
  if (!c) return <div className="mbr-empty in"><h2>Curso não encontrado</h2><Link className="mbr-btn" to={`/m/${slug}`}>Voltar</Link></div>;
  const next = openLessons(c).find((l) => !l.done) ?? openLessons(c)[0];
  return (
    <main className="mbr-main narrow">
      <Link to={`/m/${slug}`} className="mbr-back"><Icon name="arrowLeft" size={15} />Início</Link>
      <section className="mbr-course-hd">
        {c.coverUrl && <img src={c.coverUrl} alt="" className="mbr-course-cover" />}
        <div>
          <h1>{c.title}</h1>
          {c.description && <p className="mbr-muted">{c.description}</p>}
          <div className="mbr-progress"><span className="mbr-bar big"><i style={{ width: `${pct(c.done, c.total)}%` }} /></span><b>{pct(c.done, c.total)}%</b><small>{c.done} de {c.total} aulas</small></div>
          {next && <button type="button" className="mbr-btn primary" onClick={() => nav(`/m/${slug}/aula/${next.id}`)}><Icon name="play" size={15} />{c.done ? 'Continuar' : 'Começar'}</button>}
        </div>
      </section>
      {c.modules.map((m, k) => { const i = groupIdx(c.modules, m); return (<Fragment key={m.id}>
        {m.bonus && (k === 0 || !c.modules[k - 1].bonus) && <h2 className="mbr-group-t">Bônus</h2>}
        <section className={`mbr-mod${m.locked ? ' locked' : ''}`}>
          <div className="mbr-mod-hd">{m.bonus ? <small>Bônus</small> : !/^\s*m[óo]dulo\b/i.test(m.title) && <small>Módulo {i + 1}</small>}<b>{m.title}</b>{m.locked ? <span className="mbr-lock-tag" data-testid="mbr-course-lock"><Icon name="lock" size={13} />{lockText(m)}</span> : <span>{m.done}/{m.total}</span>}{m.locked && canBuy(m) && <button type="button" className="mbr-btn primary sm" onClick={() => setBuy({ m, course: c.title })} data-testid="mbr-unlock"><Icon name="unlock" size={14} />Liberar</button>}</div>
          {m.locked ? m.lessons.map((l, j) => (
            <div key={l.id} className="mbr-lesson off"><span className="mbr-lesson-n">{j + 1}</span><span>{l.title}</span><Icon name="lock" size={14} /></div>
          )) : m.lessons.length ? m.lessons.map((l, j) => (
            <Link key={l.id} to={`/m/${slug}/aula/${l.id}`} className={`mbr-lesson${l.done ? ' done' : ''}`} data-testid="mbr-lesson-link">
              <span className="mbr-lesson-n">{l.done ? <Icon name="check" size={14} /> : j + 1}</span>
              <span>{l.title}</span>
              {!l.hasFile && <em>em breve</em>}
              <Icon name="chevronRight" size={16} />
            </Link>
          )) : <div className="mbr-muted pad">Aulas em breve.</div>}
        </section>
      </Fragment>); })}
      {buy && <BuySheet m={buy.m} course={buy.course} onClose={() => setBuy(null)} />}
    </main>
  );
}

const modName = (m: { title: string; bonus?: boolean }, i: number) => (m.bonus
  ? (/b[ôo]nus/i.test(m.title) ? m.title : `Bônus · ${m.title}`)
  : /^\s*m[óo]dulo\b/i.test(m.title) ? m.title : `Módulo ${i + 1} · ${m.title}`);
/** posição do módulo entre os do mesmo tipo (curso ou bônus) */
const groupIdx = (mods: ModuleT[], m: ModuleT) => mods.filter((x) => !!x.bonus === !!m.bonus).indexOf(m);

function LessonPage({ slug, api, cat, onChange }: { slug: string; api: Api; cat: Catalog; onChange: () => void }) {
  const { lessonId = '' } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<LessonFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [fsToc, setFsToc] = useState(false);
  const [loading, setLoading] = useState(true);
  const stage = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(stage);
  useEffect(() => {
    // a tela cheia continua entre as aulas: o palco não é desmontado durante a troca
    setErr(null); setAtEnd(false); setDrawer(false); setFsToc(false); setLoading(true);
    let alive = true;
    api.call<LessonFull>('GET', `/lessons/${lessonId}`).then((r) => { if (alive) { setD(r); setLoading(false); } }).catch((e) => { if (alive) { setErr((e as Error).message); setLoading(false); } });
    if (!stage.current || !fs.full) window.scrollTo(0, 0);
    return () => { alive = false; };
  }, [api, lessonId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(done: boolean, goNext = false) {
    if (!d) return;
    setBusy(true);
    try {
      await api.call('POST', `/lessons/${d.lesson.id}/complete`, { done });
      setD({ ...d, lesson: { ...d.lesson, done } }); onChange();
      if (goNext && d.nextId) nav(`/m/${slug}/aula/${d.nextId}`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  const course = d ? cat.courses.find((c) => c.id === d.lesson.courseId) : null;
  const titleOf = (id: string | null) => (id && course ? course.modules.flatMap((m) => m.lessons).find((l) => l.id === id)?.title ?? null : null);
  if (err) return <div className="mbr-empty in" data-testid="mbr-lesson-err"><Icon name={/bloqueado/i.test(err) ? 'lock' : 'alert'} size={28} /><h2>{/bloqueado/i.test(err) ? 'Módulo bloqueado' : 'Não foi possível abrir a aula'}</h2><p>{err}</p><Link className="mbr-btn" to={`/m/${slug}`}>Voltar</Link></div>;
  if (!d) return <div className="mbr-loading"><span className="mbr-spin" /></div>;
  const goLesson = (id: string | null) => id && nav(`/m/${slug}/aula/${id}`);
  const prevT = titleOf(d.prevId), nextT = titleOf(d.nextId);
  const modIdx = course ? course.modules.findIndex((m) => m.lessons.some((l) => l.id === d.lesson.id)) : -1;
  const modLabel = course && modIdx >= 0 ? modName(course.modules[modIdx], groupIdx(course.modules, course.modules[modIdx])) : d.lesson.moduleTitle;
  return (
    <main className="mbr-lessonpage">
      <div className="mbr-viewer">
        <header className="mbr-viewer-hd">
          <nav className="mbr-crumbs" aria-label="Caminho">
            <Link to={`/m/${slug}/curso/${d.lesson.courseId}`} className="mbr-back"><Icon name="arrowLeft" size={15} />{d.lesson.courseTitle}</Link>
            <Icon name="chevronRight" size={13} />
            <span>{modLabel}</span>
          </nav>
          <div className="mbr-title-row">
            <h1 data-testid="mbr-lesson-title">{d.lesson.title}</h1>
            <div className="mbr-title-meta">
              {d.position && <span className="mbr-chip">Aula {d.position} de {d.count}</span>}
              {d.lesson.done && <span className="mbr-chip ok"><Icon name="check" size={12} />Concluída</span>}
              {course && <button type="button" className="mbr-chip btn mbr-toc-btn" onClick={() => setDrawer(true)} data-testid="mbr-toc-open"><Icon name="list" size={13} />Conteúdo</button>}
            </div>
          </div>
          {d.lesson.description && <p className="mbr-muted">{d.lesson.description}</p>}
        </header>
        <div ref={stage} className={`mbr-stage${fs.full ? ' full' : ''}${fs.pseudo ? ' pseudo' : ''}`} data-testid="mbr-stage">
          {fs.full && (
            <div className="mbr-fsbar" data-testid="mbr-fsbar">
              <button type="button" className="mbr-ibtn" onClick={() => setFsToc(!fsToc)} aria-label="Conteúdo do curso" data-testid="mbr-fs-toc"><Icon name="list" size={18} /></button>
              <div className="mbr-fsbar-t"><small>{modLabel}</small><b>{d.lesson.title}</b></div>
            </div>
          )}
          {loading ? <div className="mbr-reader mbr-reader-wait"><div className="mbr-reader-msg"><span className="mbr-spin" /><p>Abrindo a aula…</p></div></div>
            : d.link
              ? d.link.embed
                ? <div className="mbr-embed" data-testid="mbr-embed"><iframe src={d.link.embed} title={d.lesson.title} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /></div>
                : <div className="mbr-reader mbr-reader-wait"><div className="mbr-reader-msg mbr-linkcard" data-testid="mbr-linkcard"><Icon name="link" size={28} /><p>O conteúdo desta aula fica em outra página.</p><a className="mbr-btn primary" href={d.link.url} target="_blank" rel="noopener noreferrer" data-testid="mbr-link-open"><Icon name="external" size={15} />Abrir conteúdo</a><small>{new URL(d.link.url).hostname.replace(/^www\./, '')} · depois volte aqui e marque como concluída</small></div></div>
            : d.hasPdf
              ? <PdfReader url={`${API_BASE}/m/${slug}/lessons/${d.lesson.id}/pdf`} token={api.token} storeKey={`cz.member.pos.${d.lesson.id}`} onEnd={setAtEnd} full={fs.full} onToggleFull={fs.toggle} />
              : <div className="mbr-reader mbr-reader-wait"><div className="mbr-reader-msg"><Icon name="file" size={28} /><p>O material desta aula ainda não foi publicado.</p>{fs.full && <button type="button" className="mbr-btn sm" onClick={fs.toggle}>Sair da tela cheia</button>}</div></div>}
          {fs.full && (
            <div className="mbr-fsnav" data-testid="mbr-fsnav">
              <button type="button" className="mbr-fsnav-btn" disabled={!d.prevId || loading} onClick={() => goLesson(d.prevId)} aria-label="Aula anterior" title={prevT ? `Anterior: ${prevT}` : 'Anterior'} data-testid="mbr-fs-prev"><Icon name="chevronLeft" size={18} /></button>
              {d.lesson.done
                ? <button type="button" className="mbr-btn sm done" disabled={busy || loading || !d.nextId} onClick={() => goLesson(d.nextId)} data-testid="mbr-fs-next-done">{d.nextId ? <>Próxima<Icon name="chevronRight" size={15} /></> : <><Icon name="checkCircle" size={15} />Concluída</>}</button>
                : <button type="button" className={`mbr-btn sm primary${atEnd ? ' pulse' : ''}`} disabled={busy || loading} onClick={() => void toggle(true, true)} data-testid="mbr-fs-complete"><Icon name="check" size={15} /><span className="mbr-fs-lbl">{d.nextId ? 'Concluir e avançar' : 'Concluir'}</span><span className="mbr-fs-sh">Concluir</span></button>}
              <button type="button" className="mbr-fsnav-btn" disabled={!d.nextId || loading} onClick={() => goLesson(d.nextId)} aria-label="Próxima aula" title={nextT ? `Próxima: ${nextT}` : 'Próxima'} data-testid="mbr-fs-next"><Icon name="chevronRight" size={18} /></button>
            </div>
          )}
          {fs.full && fsToc && course && (
            <>
              <div className="mbr-fs-scrim" onClick={() => setFsToc(false)} />
              <div className="mbr-fs-toc" data-testid="mbr-fs-toc-panel">
                <div className="mbr-side-hd">
                  <div><b className="mbr-side-t">{course.title}</b><small>{course.done} de {course.total} aulas · {pct(course.done, course.total)}%</small></div>
                  <button type="button" className="mbr-ibtn" onClick={() => setFsToc(false)} aria-label="Fechar"><Icon name="close" size={16} /></button>
                </div>
                <div className="mbr-side-list">
                  {course.modules.map((m, k) => (
                    <Fragment key={m.id}>
                      {m.bonus && (k === 0 || !course.modules[k - 1].bonus) && <div className="mbr-side-group">Bônus</div>}
                      <SideModule slug={slug} m={m} i={groupIdx(course.modules, m)} current={d.lesson.id} />
                    </Fragment>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="mbr-lesson-acts">
          <button type="button" className="mbr-navbtn" disabled={!d.prevId} onClick={() => d.prevId && nav(`/m/${slug}/aula/${d.prevId}`)} data-testid="mbr-prev">
            <Icon name="chevronLeft" size={18} /><span><small>Anterior</small>{prevT && <b>{prevT}</b>}</span>
          </button>
          {d.lesson.done
            ? <button type="button" className="mbr-btn done" disabled={busy} onClick={() => void toggle(false)} data-testid="mbr-undone" title="Marcar como não concluída"><Icon name="checkCircle" size={16} />Concluída</button>
            : <button type="button" className={`mbr-btn primary${atEnd ? ' pulse' : ''}`} disabled={busy} onClick={() => void toggle(true, true)} data-testid="mbr-complete"><Icon name="check" size={16} />{d.nextId ? 'Concluir e avançar' : 'Concluir aula'}</button>}
          <button type="button" className="mbr-navbtn r" disabled={!d.nextId} onClick={() => d.nextId && nav(`/m/${slug}/aula/${d.nextId}`)} data-testid="mbr-next">
            <span><small>Próxima</small>{nextT && <b>{nextT}</b>}</span><Icon name="chevronRight" size={18} />
          </button>
        </div>
      </div>
      {course && (
        <>
          {drawer && <div className="mbr-scrim" onClick={() => setDrawer(false)} />}
          <aside className={`mbr-side${drawer ? ' open' : ''}`} data-testid="mbr-side">
            <div className="mbr-side-hd">
              <div>
                <b className="mbr-side-t">{course.title}</b>
                <small>{course.done} de {course.total} aulas · {pct(course.done, course.total)}%</small>
              </div>
              <button type="button" className="mbr-ibtn mbr-side-x" onClick={() => setDrawer(false)} aria-label="Fechar"><Icon name="close" size={16} /></button>
            </div>
            <span className="mbr-bar"><i style={{ width: `${pct(course.done, course.total)}%` }} /></span>
            <div className="mbr-side-list">
              {course.modules.map((m, k) => (
                <Fragment key={m.id}>
                  {m.bonus && (k === 0 || !course.modules[k - 1].bonus) && <div className="mbr-side-group">Bônus</div>}
                  <SideModule slug={slug} m={m} i={groupIdx(course.modules, m)} current={d.lesson.id} />
                </Fragment>
              ))}
            </div>
          </aside>
        </>
      )}
    </main>
  );
}

function SideModule({ slug, m, i, current }: { slug: string; m: ModuleT; i: number; current: string }) {
  const has = m.lessons.some((l) => l.id === current);
  const [open, setOpen] = useState(has || !m.locked);
  useEffect(() => { if (has) setOpen(true); }, [has]);
  return (
    <div className={`mbr-side-mod${open ? ' open' : ''}`}>
      <button type="button" className="mbr-side-mh" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span><b>{modName(m, i)}</b><small>{m.locked ? lockText(m) : `${m.done}/${m.total} concluídas`}</small></span>
        {m.locked ? <span className="mbr-mh-ic"><Icon name="lock" size={14} /></span> : <span className="mbr-mh-ic chev"><Icon name="chevronDown" size={16} /></span>}
      </button>
      {open && m.lessons.map((l, j) => m.locked ? (
        <span key={l.id} className="mbr-side-l off" title={lockText(m)}><span className="mbr-dot"><Icon name="lock" size={10} /></span><em>{l.title}</em></span>
      ) : (
        <Link key={l.id} to={`/m/${slug}/aula/${l.id}`} className={`mbr-side-l${l.id === current ? ' on' : ''}${l.done ? ' done' : ''}`} aria-current={l.id === current ? 'page' : undefined}>
          <span className="mbr-dot">{l.done ? <Icon name="check" size={11} /> : l.id === current ? <i /> : j + 1}</span><em>{l.title}</em>
        </Link>
      ))}
    </div>
  );
}
