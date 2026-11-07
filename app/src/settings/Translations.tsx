import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Field, Modal, Spinner, toast } from '../components/ui';
import { Badge, EmptyBox, Head, LoadError, StatTile, errMsg, fmtNum, relTime, useLoad, useSocketEvent } from './common';

interface Translation {
  id: string; status: 'running' | 'done' | 'failed'; language: string; languageLabel: string;
  sourceFlowId: string | null; sourceName: string; copyFlowId: string | null; copyName: string | null;
  reserved: number; used: number; refunded: number; charged: number; error: string | null;
  createdAt: string; finishedAt: string | null; createdByName: string | null;
}
interface Resp {
  translations: Translation[]; stats: { total: number; done: number; failed: number; running: number; tokens: number };
  balance: number; active: boolean; aiEnabled: boolean; languages: { code: string; label: string }[];
}
interface Estimate { texts: number; tokens: number; balance: number; active: boolean; enough: boolean; aiEnabled: boolean }

const STATUS: Record<string, [string, string]> = { running: ['Traduzindo…', 'blue'], done: ['Concluída', 'green'], failed: ['Falhou', 'red'] };

function NewTranslationModal({ languages, onClose, onDone }: { languages: Resp['languages']; onClose: () => void; onDone: () => void }) {
  const flows = useLoad(() => api.get<{ flows: { id: string; name: string; status: string; archivedAt: string | null }[] }>('/flows'), []);
  const [flowId, setFlowId] = useState('');
  const [lang, setLang] = useState('en');
  const [est, setEst] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);
  const list = (flows.data?.flows ?? []).filter((f) => !f.archivedAt);
  useEffect(() => { if (!flowId && list[0]) setFlowId(list[0].id); }, [list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setEst(null);
    if (!flowId) return;
    let alive = true;
    api.get<Estimate>(`/flows/${flowId}/translate/estimate`).then((r) => alive && setEst(r)).catch(() => {});
    return () => { alive = false; };
  }, [flowId]);

  async function go() {
    if (!flowId || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ flow: { id: string; name: string }; translation: Translation }>(`/flows/${flowId}/translate`, { language: lang });
      toast(`Pronto: “${r.flow.name}” criado como rascunho (${fmtNum(r.translation.used)} tokens)`);
      onDone();
    } catch (e) { toast(errMsg(e, 'Não foi possível traduzir')); setBusy(false); }
  }

  const blocked = !est || !est.aiEnabled || !est.active || !est.enough || est.texts === 0;
  return (
    <Modal title="Traduzir fluxo" subtitle="Cria uma cópia traduzida (em rascunho) — o original não muda" icon="translate" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={blocked || busy} onClick={go} data-testid="tr-go">{busy ? 'Traduzindo… (pode levar um minuto)' : 'Traduzir'}</button>
    </>}>
      {!flows.data ? <Spinner /> : list.length === 0 ? <EmptyBox icon="flow" title="Nenhum fluxo para traduzir" text="Crie um fluxo em Fluxos primeiro." /> : (
        <div className="stack" style={{ gap: 14 }}>
          <Field label="Fluxo">
            <select className="select" value={flowId} onChange={(e) => setFlowId(e.target.value)} data-testid="tr-flow">
              {list.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="Traduzir para">
            <select className="select" value={lang} onChange={(e) => setLang(e.target.value)} data-testid="tr-lang">
              {languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </Field>
          {est ? (
            <div className="hint" data-testid="tr-estimate">
              <Icon name="sparkles" size={14} />
              <span>
                {est.texts === 0 ? 'Este fluxo não tem textos para traduzir.' : <>
                  {est.texts} texto(s). A tradução <b>reserva cerca de {fmtNum(est.tokens)} tokens</b> antes de começar (assim não para no meio) e devolve o que sobrar no fim. Saldo: <b>{fmtNum(est.balance)}</b>.
                </>}
                {!est.aiEnabled && <><br />A IA não está configurada neste servidor.</>}
                {est.aiEnabled && !est.active && <><br />A assinatura não está ativa — a IA só funciona com a assinatura em dia.</>}
                {est.aiEnabled && est.active && est.texts > 0 && !est.enough && <><br /><b>Saldo insuficiente.</b> <Link to="/billing">Comprar tokens</Link></>}
              </span>
            </div>
          ) : <div style={{ height: 50 }}><Spinner /></div>}
          <div className="st-help">Variáveis como {'{{nome}}'} e emojis ficam como estão. Botões e listas são traduzidos respeitando os limites do WhatsApp — revise a cópia antes de ativar.</div>
        </div>
      )}
    </Modal>
  );
}

export function TranslationsPage() {
  const { accountId } = useAuth();
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => api.get<Resp>('/flow-translations'), [accountId]);
  useSocketEvent(['translations:changed', 'tokens:update'], () => void reload());
  const [creating, setCreating] = useState(false);
  const head = <Head slug="traducoes" actions={<button type="button" className="btn primary" onClick={() => setCreating(true)} data-testid="new-translation"><Icon name="translate" size={15} />Traduzir fluxo</button>} />;
  if (error && !data) return <>{head}<LoadError error={error} onRetry={reload} /></>;
  if (!data) return <>{head}<Spinner /></>;
  const s = data.stats;
  return (
    <div data-testid="translations-page">
      {head}
      <div className="st-stats">
        <StatTile icon="translate" value={s.total} label="Traduções" />
        <StatTile icon="check" tone="green" value={s.done} label="Concluídas" />
        <StatTile icon="alert" tone="red" value={s.failed} label="Falharam" />
        <StatTile icon="bolt" tone="amber" value={fmtNum(s.tokens)} label="Tokens gastos" testId="tr-tokens" />
        <StatTile icon="sparkles" tone="blue" value={fmtNum(data.balance)} label="Saldo de tokens" />
      </div>
      {data.translations.length === 0 ? (
        <div className="st-card"><EmptyBox icon="translate" title="Nenhuma tradução ainda" text="Traduza um fluxo para inglês, espanhol, francês, italiano ou alemão: a IA cria uma cópia em rascunho com todos os textos traduzidos. Cada tradução aparece aqui com os tokens reservados, gastos e devolvidos."
          action={<button type="button" className="btn primary" onClick={() => setCreating(true)}><Icon name="translate" size={15} />Traduzir fluxo</button>} /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Fluxo</th><th>Idioma</th><th>Status</th><th>Tokens</th><th>Quem</th><th>Quando</th><th className="acts" /></tr></thead>
            <tbody>
              {data.translations.map((t) => {
                const [label, tone] = STATUS[t.status] ?? [t.status, ''];
                return (
                  <tr key={t.id} data-testid="tr-row">
                    <td>
                      <b>{t.sourceFlowId ? <Link to={`/flows/${t.sourceFlowId}`}>{t.sourceName}</Link> : t.sourceName}</b>
                      {t.copyName && <div className="st-mini">→ {t.copyName}</div>}
                      {t.error && <div className="st-mini" style={{ color: 'var(--danger)' }}>{t.error}</div>}
                    </td>
                    <td>{t.languageLabel}</td>
                    <td><Badge tone={tone}>{label}</Badge></td>
                    <td>
                      <b>{fmtNum(t.status === 'running' ? t.reserved : t.used)}</b>
                      <div className="st-mini">{t.status === 'running' ? 'reservados' : `reservou ${fmtNum(t.reserved)}${t.refunded ? ` · devolveu ${fmtNum(t.refunded)}` : ''}`}</div>
                    </td>
                    <td className="muted">{t.createdByName ?? '—'}</td>
                    <td className="muted">{relTime(t.createdAt)}</td>
                    <td className="acts">{t.copyFlowId && <button type="button" className="btn sm" onClick={() => nav(`/flows/${t.copyFlowId}`)}>Abrir cópia</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewTranslationModal languages={data.languages} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void reload(); }} />}
    </div>
  );
}
