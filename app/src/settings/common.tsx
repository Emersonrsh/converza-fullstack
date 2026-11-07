import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons';
import { getSocket } from '../socket';
import { cx, toast, useBackdrop } from '../components/ui';
import { pageInfo } from './meta';

export const errMsg = (e: unknown, fallback = 'Não foi possível concluir') => (e instanceof Error && e.message ? e.message : fallback);

export const fmtDate = (s: string | Date | null | undefined) => (s ? new Date(s).toLocaleDateString('pt-BR') : '—');
export const fmtDateTime = (s: string | Date | null | undefined) =>
  (s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtNum = (n: number) => n.toLocaleString('pt-BR');
export const fmtMoney = (n: number, currency = 'BRL') => n.toLocaleString('pt-BR', { style: 'currency', currency });

/** "há 5 min", "há 2 h", "ontem", "12/10" */
export function relTime(s: string | Date | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s).getTime();
  const diff = Date.now() - d;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 3600_000) return `em ${Math.max(1, Math.round(ahead / 60_000))} min`;
    if (ahead < 86_400_000) return `em ${Math.round(ahead / 3600_000)} h`;
    return `em ${Math.round(ahead / 86_400_000)} dia(s)`;
  }
  if (diff < 60_000) return 'agora';
  if (diff < 3600_000) return `há ${Math.round(diff / 60_000)} min`;
  if (diff < 86_400_000) return `há ${Math.round(diff / 3600_000)} h`;
  if (diff < 2 * 86_400_000) return 'ontem';
  return new Date(s).toLocaleDateString('pt-BR');
}

/** Carrega dados de uma rota e recarrega quando quiser. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await fnRef.current();
      if (n === seq.current) { setData(r); setError(null); }
    } catch (e) {
      if (n === seq.current) setError(errMsg(e, 'Não foi possível carregar'));
    }
  }, []);
  useEffect(() => { void reload(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, setData, error, reload };
}

/** Ouve um evento do tempo real enquanto a tela estiver aberta. */
export function useSocketEvent(events: string | string[], fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  const key = Array.isArray(events) ? events.join('|') : events;
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const h = () => { if (t) clearTimeout(t); t = setTimeout(() => ref.current(), 300); };
    const list = key.split('|');
    list.forEach((e) => sock.on(e, h));
    return () => { list.forEach((e) => sock.off(e, h)); if (t) clearTimeout(t); };
  }, [key]);
}

export function PageHead({ title, desc, actions }: { title: string; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="st-head">
      <div>
        <div className="st-eyebrow">Configurações</div>
        <h2 data-testid="st-title">{title}</h2>
        {desc && <p>{desc}</p>}
      </div>
      {actions && <div className="st-head-actions">{actions}</div>}
    </div>
  );
}

/** Cabeçalho com o título e a descrição cadastrados para a página. */
export function Head({ slug, actions }: { slug: string; actions?: ReactNode }) {
  const p = pageInfo(slug);
  return <PageHead title={p?.title ?? ''} desc={p?.desc} actions={actions} />;
}

export function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="st-card"><EmptyBox icon="alert" title="Não foi possível carregar" text={error}
      action={<button type="button" className="btn" onClick={onRetry}>Tentar de novo</button>} /></div>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Buscar…', testId }: { value: string; onChange: (v: string) => void; placeholder?: string; testId?: string }) {
  return (
    <label className="st-search">
      <Icon name="search" size={15} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} data-testid={testId} />
      {value && <button type="button" className="btn icon sm ghost" style={{ width: 24, height: 24 }} onClick={() => onChange('')} aria-label="Limpar"><Icon name="close" size={12} /></button>}
    </label>
  );
}

/** Texto digitado com atraso (para buscar no servidor sem pedir a cada letra). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function StatTile({ icon, tone = '', value, label, testId }: { icon: string; tone?: string; value: ReactNode; label: string; testId?: string }) {
  return (
    <div className="st-stat" data-testid={testId}>
      <span className={cx('st-stat-ic', tone)}><Icon name={icon} size={18} /></span>
      <div><b>{value}</b><small>{label}</small></div>
    </div>
  );
}

export function EmptyBox({ icon, title, text, action }: { icon: string; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="st-empty">
      <span className="st-empty-ic"><Icon name={icon} size={26} /></span>
      <b>{title}</b>
      {text && <span>{text}</span>}
      {action}
    </div>
  );
}

export function Badge({ tone = '', children }: { tone?: string; children: ReactNode }) {
  return <span className={cx('st-badge', tone)}>{children}</span>;
}

export interface KebabItem { label: string; icon?: string; onClick: () => void; danger?: boolean; disabled?: boolean; hidden?: boolean }
export function Kebab({ items, testId }: { items: KebabItem[]; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const visible = items.filter((i) => !i.hidden);
  if (!visible.length) return null;
  return (
    <div className="st-kebab menu-wrap" ref={ref}>
      <button type="button" className="btn icon sm ghost" onClick={() => setOpen((v) => !v)} aria-label="Ações" data-testid={testId ?? 'kebab'}><Icon name="dots" size={16} /></button>
      {open && (
        <div className="menu fade">
          {visible.map((i) => (
            <button type="button" key={i.label} className={cx(i.danger && 'danger')} disabled={i.disabled}
              onClick={() => { setOpen(false); i.onClick(); }}>
              {i.icon && <Icon name={i.icon} size={15} />}{i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const PRESET_COLORS = ['#3b82f6', '#0e9488', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

export function ColorChooser({ value, onChange, colors = PRESET_COLORS }: { value: string; onChange: (c: string) => void; colors?: string[] }) {
  const custom = !colors.includes(value.toLowerCase());
  return (
    <div className="st-colors" role="radiogroup" aria-label="Cor">
      {colors.map((c) => (
        <button type="button" key={c} className={cx(value.toLowerCase() === c && 'on')} style={{ background: c }} onClick={() => onChange(c)} aria-label={`Cor ${c}`} aria-checked={value.toLowerCase() === c} role="radio" />
      ))}
      <label className={cx('st-custom')} title="Escolher outra cor" style={custom ? { borderStyle: 'solid', borderColor: value } : undefined}>
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#0e9488'} onChange={(e) => onChange(e.target.value)} aria-label="Cor personalizada" />
        Personalizada
      </label>
    </div>
  );
}

/** Pílula com a cor da etiqueta/setor (fundo claro da própria cor). */
export function ColorPill({ name, color, testId }: { name: string; color: string; testId?: string }) {
  return <span className="st-pill" style={{ background: `${color}22`, color, boxShadow: `inset 0 0 0 1px ${color}33` }} data-testid={testId}>{name}</span>;
}

export async function copyText(text: string, okMsg = 'Copiado') {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { toast('Não deu para copiar — selecione e copie manualmente'); }
}

export function CopyField({ value, testId, mono = true }: { value: string; testId?: string; mono?: boolean }) {
  return (
    <div className="st-copy">
      <input className="input" readOnly value={value} onFocus={(e) => e.currentTarget.select()} style={mono ? undefined : { fontFamily: 'inherit' }} data-testid={testId} />
      <button type="button" className="btn icon" onClick={() => void copyText(value)} aria-label="Copiar"><Icon name="copy" size={15} /></button>
    </div>
  );
}

export function CodeBlock({ code, testId }: { code: string; testId?: string }) {
  return (
    <div className="st-code" data-testid={testId}>
      <button type="button" className="btn sm" onClick={() => void copyText(code)}><Icon name="copy" size={13} />Copiar</button>
      {code}
    </div>
  );
}

export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const bg = useBackdrop(onClose);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-bg')) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  return createPortal(
    <div className="st-drawer-bg" {...bg}>
      <aside className="st-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="st-drawer-h"><b>{title}</b>{actions}<button type="button" className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button></div>
        <div className="st-drawer-b">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string, string?][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="st-tabs" role="tablist">
      {tabs.map(([k, label, icon]) => (
        <button type="button" role="tab" key={k} aria-selected={value === k} className={cx(value === k && 'on')} onClick={() => onChange(k)} data-testid={`st-tab-${k}`}>
          {icon && <Icon name={icon} size={15} />}{label}
        </button>
      ))}
    </div>
  );
}

/** Mini gráfico de barras por dia (últimos N dias). */
export function DaySpark({ days, series, testId }: { days: number; series: { day: string; n: number }[][]; testId?: string }) {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const maps = series.map((s) => new Map(s.map((x) => [x.day, x.n])));
  const max = Math.max(1, ...maps.flatMap((m) => [...m.values()]));
  return (
    <div className="st-spark" data-testid={testId}>
      {keys.map((k) => (
        <div key={k} style={{ flex: 1, display: 'flex', gap: 1, alignItems: 'flex-end', height: '100%' }} title={`${k.split('-').reverse().join('/')}: ${maps.map((m) => m.get(k) ?? 0).join(' / ')}`}>
          {maps.map((m, i) => <i key={i} className={cx(i === 1 && 'alt')} style={{ height: `${((m.get(k) ?? 0) / max) * 100}%` }} />)}
        </div>
      ))}
    </div>
  );
}
