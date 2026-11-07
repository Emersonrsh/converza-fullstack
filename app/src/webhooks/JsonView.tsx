import { useState, type ReactNode } from 'react';
import { toast } from '../components/ui';

/** JSON recebido, com cores; clicar num valor copia o caminho dele (ex.: data.buyer.phone). */
export function JsonView({ value, onPick }: { value: unknown; onPick?: (path: string) => void }) {
  return <div className="wh-json" data-testid="wh-json"><Node v={value} path="" depth={0} onPick={onPick} /></div>;
}

function Node({ v, path, depth, onPick, label }: { v: unknown; path: string; depth: number; onPick?: (p: string) => void; label?: ReactNode }) {
  const [open, setOpen] = useState(depth < 3);
  const key = label !== undefined ? <>{label}<span className="p">: </span></> : null;
  if (v !== null && typeof v === 'object') {
    const arr = Array.isArray(v);
    const entries = arr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
    const [o, c] = arr ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return <div className="ln">{key}<span className="p">{o}{c}</span></div>;
    return (
      <div className="ln">
        <button type="button" className="tg" onClick={() => setOpen((x) => !x)} aria-label={open ? 'Recolher' : 'Expandir'}>{open ? '▾' : '▸'}</button>
        {key}<span className="p">{o}</span>
        {open ? (
          <div className="kids">
            {entries.slice(0, 200).map(([k, x]) => (
              <Node key={k} v={x} depth={depth + 1} onPick={onPick} path={path ? `${path}.${k}` : k} label={arr ? <span className="i">{k}</span> : <span className="k">"{k}"</span>} />
            ))}
            {entries.length > 200 && <div className="ln more">… mais {entries.length - 200}</div>}
          </div>
        ) : <span className="more"> {entries.length} {arr ? 'itens' : 'campos'} </span>}
        <span className="p">{c}</span>
      </div>
    );
  }
  const cls = v === null ? 'n' : typeof v === 'number' ? 'num' : typeof v === 'boolean' ? 'b' : 's';
  const text = typeof v === 'string' ? `"${v}"` : String(v);
  return (
    <div className="ln">
      {key}
      <button type="button" className={`val ${cls}`} title={`${path} — clique para copiar o caminho`}
        onClick={() => { if (onPick) onPick(path); else { void navigator.clipboard?.writeText(path); toast(`Caminho copiado: ${path}`); } }}>
        {text.length > 300 ? `${text.slice(0, 300)}…` : text}
      </button>
    </div>
  );
}
