import type { ReactNode } from 'react';
import { Icon } from '../../icons';
import { cx } from '../../components/ui';
import type { Agent, AgentDraft, AgentOptions, AgentRun, KbSummary, Sector } from '../types';

export interface StepProps {
  draft: AgentDraft;
  set: <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) => void;
  patch: (p: Partial<AgentDraft>) => void;
  opt: AgentOptions;
  ro: boolean;
  isNew: boolean;
  agent: Agent | null;
  sectors: Sector[];
  bases: KbSummary[];
  setBases: (b: KbSummary[]) => void;
  recent: AgentRun[];
}

export const Lbl = ({ children, hint, req }: { children: ReactNode; hint?: string; req?: boolean }) => (
  <label className="label">{children}{req && <span className="wz-req"> *</span>}{hint && <span className="lbl-hint"> · {hint}</span>}</label>
);

export function Block({ title, desc, children, right, testId }: { title: string; desc?: string; children: ReactNode; right?: ReactNode; testId?: string }) {
  return (
    <section className="wz-block" data-testid={testId}>
      <header><div><h3>{title}</h3>{desc && <p>{desc}</p>}</div>{right}</header>
      {children}
    </section>
  );
}

/** Grade de opções em cartão (uma escolhida). */
export function Choice<T extends string>({ value, onChange, options, cols, testId }: {
  value: T; onChange: (v: T) => void; cols?: number; testId?: string;
  options: { v: T; label: string; desc?: string; icon?: string; art?: ReactNode }[];
}) {
  return (
    <div className="wz-choice" style={cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined} role="radiogroup" data-testid={testId}>
      {options.map((o) => (
        <button type="button" key={o.v} role="radio" aria-checked={value === o.v} className={cx('wz-opt', value === o.v && 'on')} onClick={() => onChange(o.v)} data-testid={testId ? `${testId}-${o.v}` : undefined}>
          {o.art ?? (o.icon && <Icon name={o.icon} size={17} />)}
          <b>{o.label}</b>
          {o.desc && <small>{o.desc}</small>}
        </button>
      ))}
    </div>
  );
}

export function EmptyBox({ icon, title, text, children }: { icon: string; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="wz-empty">
      <span className="wz-empty-ic"><Icon name={icon} size={24} /></span>
      <b>{title}</b>
      <p>{text}</p>
      {children}
    </div>
  );
}
