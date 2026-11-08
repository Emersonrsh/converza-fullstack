import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../icons';
import { cx, toast } from '../../components/ui';
import { api } from '../../api';
import { rid, sanitizeVarName } from '../blocks';
import { Field, HowItWorks, RichText, Section, Switch, Tabs, ToggleCard, VarInput } from './fields';
import type { D, EditorProps } from './types';

/* ------------------------------------------------------------------ cURL */

/** Divide um comando como o shell faria (aspas simples/duplas, barra invertida, quebra de linha com \). */
export function shellSplit(input: string): string[] {
  const s = input.replace(/\\\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { cur += s[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") { q = "'"; has = true; i++; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (q) throw new Error('Aspas abertas sem fechar no comando.');
  if (cur || has) out.push(cur);
  return out;
}

export interface ParsedCurl { method: string; url: string; headers: Record<string, string>; body: string }

export function parseCurl(cmd: string): ParsedCurl {
  const t = shellSplit(cmd.trim());
  if (!t.length || !/^curl(\.exe)?$/i.test(t[0])) throw new Error('Cole um comando que comece com curl.');
  let method = '';
  let url = '';
  const headers: Record<string, string> = {};
  const data: string[] = [];
  for (let i = 1; i < t.length; i++) {
    const a = t[i];
    const val = () => { const v = t[++i]; if (v === undefined) throw new Error(`Falta o valor de ${a}.`); return v; };
    if (a === '-X' || a === '--request') method = val().toUpperCase();
    else if (a.startsWith('-X') && a.length > 2) method = a.slice(2).toUpperCase();
    else if (a === '-H' || a === '--header') {
      const h = val();
      const k = h.indexOf(':');
      if (k > 0) headers[h.slice(0, k).trim()] = h.slice(k + 1).trim();
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json'].includes(a)) {
      data.push(val());
      if (a === '--json') { headers['Content-Type'] ??= 'application/json'; headers.Accept ??= 'application/json'; }
    } else if (a === '-u' || a === '--user') headers.Authorization = `Basic ${btoa(val())}`;
    else if (a === '--url') url = val();
    else if (a === '-A' || a === '--user-agent') headers['User-Agent'] = val();
    else if (a === '-b' || a === '--cookie') headers.Cookie = val();
    else if (['-o', '--output', '-w', '--write-out', '-m', '--max-time', '--connect-timeout', '-e', '--referer'].includes(a)) val();
    else if (a.startsWith('-')) continue; // -s, -L, -k, --compressed…
    else if (!url) url = a;
  }
  if (!url) throw new Error('Não encontrei a URL no comando.');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return { method: method || (data.length ? 'POST' : 'GET'), url, headers, body: data.join('&') };
}

/* ------------------------------------------------------------------ Integração */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const varsIn = (...texts: string[]) => [...new Set(texts.flatMap((t) => [...String(t ?? '').matchAll(VAR_RE)].map((m) => m[1])))];

/** JSON com {{variáveis}} (dentro ou fora de aspas) é válido? */
export function jsonWithVarsOk(text: string): boolean {
  if (!String(text ?? '').trim()) return true;
  try { JSON.parse(String(text).replace(VAR_RE, '0')); return true; } catch { return false; }
}

function fill(text: string, values: Record<string, string>, esc: (v: string) => string = (v) => v) {
  return String(text ?? '').replace(VAR_RE, (_m, k: string) => esc(values[k] ?? ''));
}

/** Caminhos das folhas de um JSON (para mapear a resposta). */
function leaves(v: unknown, prefix = '', depth = 0, out: { path: string; sample: string }[] = []) {
  if (out.length >= 80) return out;
  if (v && typeof v === 'object' && depth < 5) {
    const entries = Array.isArray(v) ? v.slice(0, 3).map((x, i) => [String(i), x] as const) : Object.entries(v as D);
    for (const [k, x] of entries) leaves(x, prefix ? `${prefix}.${k}` : k, depth + 1, out);
    return out;
  }
  if (prefix) out.push({ path: prefix, sample: v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 60) });
  return out;
}

interface TestResult { ok: boolean; status: number; body: unknown; error?: string }

export function HttpEditor({ d, set, vars, lookups }: EditorProps) {
  const [tab, setTab] = useState<'headers' | 'body' | 'map'>('headers');
  const [curl, setCurl] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  // variáveis globais já vêm com o valor salvo (o resto o usuário preenche)
  const [testVals, setTestVals] = useState<Record<string, string>>(() => Object.fromEntries(lookups.globals.map((g) => [g.key, g.value])));
  const [result, setResult] = useState<TestResult | null>(null);
  const method = String(d.method ?? 'GET').toUpperCase();
  const mappings: D[] = Array.isArray(d.mappings) ? d.mappings : [];
  const used = varsIn(d.url, d.headersJson, method === 'GET' ? '' : d.body);
  const headersOk = jsonWithVarsOk(d.headersJson ?? '');
  const bodyOk = method === 'GET' || jsonWithVarsOk(d.body ?? '');
  const save = sanitizeVarName(d.saveAs || 'http') || 'http';

  function importCurl() {
    try {
      const c = parseCurl(curl ?? '');
      set({ method: METHODS.includes(c.method) ? c.method : 'POST', url: c.url, headersJson: JSON.stringify(c.headers, null, 2), body: c.body });
      setCurl(null);
      toast('cURL importado ✓');
    } catch (e) { toast((e as Error).message); }
  }

  async function test() {
    setTesting(true); setResult(null);
    try {
      const jsonEsc = (v: string) => JSON.stringify(v).slice(1, -1);
      const url = fill(d.url, testVals, encodeURIComponent).trim();
      let headers: Record<string, string> = {};
      const hj = fill(d.headersJson ?? '', testVals, jsonEsc);
      if (hj.trim()) {
        const parsed = JSON.parse(hj);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Os cabeçalhos precisam ser um objeto JSON.');
        headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')]));
      }
      const body = method === 'GET' ? undefined : fill(d.body ?? '', testVals, jsonEsc);
      const r = await api.post<{ result: TestResult }>('/flows/http-test', { method, url, headers, body });
      setResult(r.result);
      if (r.result.ok) setTab('map');
    } catch (e) {
      setResult({ ok: false, status: 0, body: null, error: e instanceof SyntaxError ? 'Os cabeçalhos não são um JSON válido.' : (e as Error).message });
    } finally { setTesting(false); }
  }

  const found = useMemo(() => (result?.ok ? leaves(result.body) : []), [result]);
  const addMap = (path: string) => {
    if (mappings.some((m) => m.path === path)) return;
    const last = path.split('.').filter((p) => !/^\d+$/.test(p)).pop() ?? 'campo';
    set({ mappings: [...mappings, { id: rid('map'), path, var: sanitizeVarName(last) || 'campo', saveToContact: false }] });
  };
  const updMap = (i: number, patch: D) => set({ mappings: mappings.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  return (
    <>
      <div className="bm-http">
        <select className="select" value={method} onChange={(e) => set({ method: e.target.value })} data-testid="http-method">
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <VarInput value={d.url ?? ''} onChange={(url) => set({ url })} vars={vars} placeholder="https://api.exemplo.com/clientes?telefone={{telefone}}" testId="http-url" />
        <button type="button" className={cx('btn', curl !== null && 'on')} onClick={() => setCurl((c) => (c === null ? '' : null))} data-testid="http-curl"><Icon name="code" size={14} />Colar cURL</button>
      </div>
      {curl !== null && (
        <div className="bm-sec">
          <textarea className="input mono" rows={5} autoFocus value={curl} onChange={(e) => setCurl(e.target.value)} data-testid="http-curl-text"
            placeholder={'curl -X POST https://api.exemplo.com/leads \\\n  -H "Authorization: Bearer SUA_CHAVE" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"nome": "{{nome}}"}\''} />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8, gap: 8 }}>
            <button type="button" className="btn sm ghost" onClick={() => setCurl(null)}>Cancelar</button>
            <button type="button" className="btn sm primary" disabled={!curl.trim()} onClick={importCurl} data-testid="http-curl-import">Importar</button>
          </div>
        </div>
      )}
      <Tabs value={tab} options={[['headers', 'Header'], ['body', 'Corpo'], ['map', `Mapear resposta${mappings.length ? ` (${mappings.length})` : ''}`]]} onChange={setTab} testId="http-tab" />
      {tab === 'headers' && (
        <Field warn={headersOk ? undefined : 'Isto não é um JSON válido. Ex.: { "Authorization": "Bearer {{g_token}}" }'}
          hint="Objeto JSON. Por segurança, os valores não vão junto quando o fluxo é compartilhado.">
          <textarea className={cx('input mono', !headersOk && 'bad')} rows={6} value={d.headersJson ?? ''} onChange={(e) => set({ headersJson: e.target.value })} data-testid="http-headers" spellCheck={false} />
        </Field>
      )}
      {tab === 'body' && (method === 'GET' ? <div className="bm-hint" style={{ marginBottom: 12 }}>Requisições GET não têm corpo: mande os dados na URL (ex.: ?email={'{{email}}'}).</div> : (
        <Field warn={bodyOk ? undefined : 'O corpo não é um JSON válido (confira vírgulas e aspas).'} hint="Variáveis dentro de aspas são escapadas para JSON automaticamente.">
          <RichText value={d.body ?? ''} onChange={(body) => set({ body })} vars={vars} rows={7} placeholder={'{\n  "nome": "{{nome}}",\n  "telefone": "{{telefone}}"\n}'} testId="http-body" />
        </Field>
      ))}
      {tab === 'map' && (
        <Section sub="Leve campos da resposta para variáveis (e, se quiser, para o contato). Ex.: data.cliente.id → id_cliente.">
          {mappings.map((m, i) => (
            <div className="bm-map" key={m.id ?? i} data-testid={`http-map-${i}`}>
              <input className="input mono" value={m.path ?? ''} placeholder="data.cliente.nome" onChange={(e) => updMap(i, { path: e.target.value.trim() })} />
              <span className="faint">→</span>
              <input className="input" value={m.var ?? ''} placeholder="nome_cliente" onChange={(e) => updMap(i, { var: sanitizeVarName(e.target.value) })} />
              <label className="bm-map-c" title="Salvar também no campo do contato com esse nome"><Switch checked={!!m.saveToContact} onChange={(v) => updMap(i, { saveToContact: v })} /><small>contato</small></label>
              <button type="button" className="btn icon sm ghost" onClick={() => set({ mappings: mappings.filter((_, j) => j !== i) })} aria-label="Remover"><Icon name="trash" size={14} /></button>
            </div>
          ))}
          <button type="button" className="bm-addline" onClick={() => set({ mappings: [...mappings, { id: rid('map'), path: '', var: '', saveToContact: false }] })} data-testid="http-map-add"><Icon name="plus" size={14} />Adicionar campo</button>
          {found.length > 0 && (
            <div className="bm-found">
              <small>Campos da última resposta — clique para mapear:</small>
              {found.map((f) => (
                <button type="button" key={f.path} disabled={mappings.some((m) => m.path === f.path)} onClick={() => addMap(f.path)}>
                  <code>{f.path}</code><span>{f.sample}</span>
                </button>
              ))}
            </div>
          )}
        </Section>
      )}
      <Field label="Salvar a resposta inteira em" hint={<>Leia qualquer campo com <code>{`{{${save}.campo}}`}</code> e o código HTTP com <code>{`{{${save}_status}}`}</code>.</>}>
        <input className="input" value={d.saveAs ?? 'http'} onChange={(e) => set({ saveAs: sanitizeVarName(e.target.value) })} data-testid="http-save" />
      </Field>

      <Section title="Testar requisição" sub="Chama a API de verdade agora, com valores de teste no lugar das variáveis.">
        {used.map((v) => (
          <div className="bm-testvar" key={v}>
            <code>{`{{${v}}}`}</code>
            <input className="input sm" value={testVals[v] ?? ''} placeholder="valor de teste" onChange={(e) => setTestVals((t) => ({ ...t, [v]: e.target.value }))} />
          </div>
        ))}
        <button type="button" className="btn sm primary" disabled={testing || !String(d.url ?? '').trim()} onClick={() => void test()} data-testid="http-test">
          <Icon name="play" size={14} />{testing ? 'Chamando…' : 'Testar requisição'}
        </button>
        {result && (
          <div className={cx('bm-result', result.ok ? 'ok' : 'bad')} data-testid="http-result">
            <b>{result.error ? `Falhou: ${result.error}` : `HTTP ${result.status} · ${result.ok ? 'sucesso' : 'erro'}`}</b>
            {!result.error && <pre>{typeof result.body === 'string' ? result.body.slice(0, 4000) : JSON.stringify(result.body, null, 2)?.slice(0, 4000)}</pre>}
          </div>
        )}
      </Section>
      <HowItWorks>Respostas de 200 a 299 seguem por <b>Sucesso</b>; erro, demora maior que 10 s ou endereço bloqueado seguem por <b>Erro</b>. Endereços internos (localhost, rede privada) não são permitidos.</HowItWorks>
    </>
  );
}

/* ------------------------------------------------------------------ Bloco de IA */

export const PROVIDERS: [string, string, string][] = [
  ['converza', 'Converza IA', 'Usa os tokens de IA da sua conta'],
  ['openai', 'OpenAI (GPT)', 'Com a sua chave da OpenAI'],
  ['gemini', 'Google Gemini', 'Com a sua chave do Google AI Studio'],
  ['openrouter', 'OpenRouter', 'Com a sua chave do OpenRouter'],
];

export function AiEditor({ d, set, vars, lookups }: EditorProps) {
  const provider = PROVIDERS.some((p) => p[0] === d.provider) ? d.provider : 'converza';
  const byok = provider !== 'converza';
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<{ list: string[]; loading: boolean; error: string; def?: string }>({ list: [], loading: false, error: '' });
  const conds: D[] = Array.isArray(d.conditions) ? d.conditions : [];
  const updCond = (i: number, patch: D) => set({ conditions: conds.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const listId = `ai-models-${provider}`;

  async function loadModels() {
    setModels((m) => ({ ...m, loading: true, error: '' }));
    try {
      const r = await api.post<{ models: string[]; defaultModel?: string }>('/flows/ai-models', { provider, apiKey: byok ? d.apiKey ?? '' : undefined });
      setModels({ list: r.models, loading: false, error: '', def: r.defaultModel });
    } catch (e) { setModels({ list: [], loading: false, error: (e as Error).message }); }
  }
  // Converza IA: lista na hora; chave própria: quando a chave estiver preenchida
  useEffect(() => { setModels({ list: [], loading: false, error: '' }); if (!byok) void loadModels(); }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Field label="Provedor">
        <div className="bm-cardsel four" data-testid="ai-provider">
          {PROVIDERS.map(([v, l, desc]) => (
            <button type="button" key={v} className={cx(provider === v && 'on')} onClick={() => set({ provider: v, model: '' })} data-testid={`ai-provider-${v}`}>
              <b>{l}</b><small>{desc}</small>
            </button>
          ))}
        </div>
      </Field>
      {byok && (
        <Section title="Autenticação">
          <Field label="Chave da API" required hint={<>Dica: guarde a chave numa variável global (ex.: <code>{'{{g_openai}}'}</code>) e use aqui. Chaves digitadas ficam salvas no fluxo, mas não vão junto quando ele é compartilhado.</>}>
            <div className="bm-key">
              <input className="input mono" type={showKey ? 'text' : 'password'} value={d.apiKey ?? ''} autoComplete="off" spellCheck={false}
                placeholder={provider === 'openai' ? 'sk-…' : provider === 'gemini' ? 'AIza…' : 'sk-or-…'} onChange={(e) => set({ apiKey: e.target.value.trim() })} data-testid="ai-key" />
              <button type="button" className="btn icon" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? 'Esconder chave' : 'Mostrar chave'}><Icon name={showKey ? 'eyeOff' : 'eye'} size={15} /></button>
              {lookups.globals.length > 0 && (
                <select className="select" value="" onChange={(e) => e.target.value && set({ apiKey: `{{${e.target.value}}}` })} aria-label="Usar variável global" style={{ maxWidth: 150 }}>
                  <option value="">Variável global…</option>
                  {lookups.globals.map((g) => <option key={g.key} value={g.key}>{g.key}</option>)}
                </select>
              )}
            </div>
          </Field>
        </Section>
      )}
      <Field label="Modelo" required={byok}
        right={<button type="button" className="linkbtn" disabled={models.loading || (byok && !String(d.apiKey ?? '').trim())} onClick={() => void loadModels()} data-testid="ai-load-models">
          <Icon name="refresh" size={12} />{models.loading ? 'Carregando…' : models.list.length ? `${models.list.length} modelos` : 'Carregar modelos'}</button>}
        warn={models.error || undefined}
        hint={byok ? 'Carregue a lista com a sua chave ou digite o nome exato do modelo.' : `Vazio: o modelo padrão da plataforma${models.def ? ` (${models.def})` : ''}.`}>
        <input className="input mono" list={listId} value={d.model ?? ''} placeholder={byok ? (provider === 'gemini' ? 'gemini-2.5-flash' : provider === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini') : models.def || 'Padrão da plataforma'}
          onChange={(e) => set({ model: e.target.value.trim() })} data-testid="ai-model" />
        <datalist id={listId}>{models.list.map((m) => <option key={m} value={m} />)}</datalist>
      </Field>
      <Field label="Mensagem enviada ao modelo" hint="O que a IA vai ler. Normalmente a resposta do cliente.">
        <RichText value={d.input ?? ''} onChange={(input) => set({ input })} vars={vars} rows={2} placeholder="{{resposta}}" testId="ai-input" />
      </Field>
      <Field label="Prompt (instruções)" required>
        <RichText value={d.prompt ?? ''} onChange={(prompt) => set({ prompt })} vars={vars} rows={6} testId="ai-prompt"
          placeholder="Você é a atendente da Clínica Sorriso. Responda dúvidas sobre horários e valores. Seja simpática e breve." />
      </Field>
      <div className="bm-row2">
        <Field label="Campo para salvar a resposta" hint="Opcional. Também fica em {{ia.resposta}}.">
          <input className="input" value={d.saveAs ?? ''} placeholder="resposta_ia" onChange={(e) => set({ saveAs: sanitizeVarName(e.target.value) })} data-testid="ai-save" />
        </Field>
        <div style={{ alignSelf: 'end', marginBottom: 14 }}>
          <ToggleCard title="Enviar resposta automaticamente" checked={d.send !== false} onChange={(send) => set({ send })} testId="ai-send" />
        </div>
      </div>
      <Section title="Mídias do cliente" sub="O que a IA consegue ler da última mensagem do cliente (até 15 MB).">
        <ToggleCard title="Entender áudio" checked={!!d.audio} onChange={(audio) => set({ audio })} testId="ai-audio"
          desc={provider === 'converza' ? 'Transcreve o áudio (consome tokens) e manda o texto para a IA.' : provider === 'openai' ? 'Transcreve com o Whisper da sua conta OpenAI.' : 'Manda o áudio (MP3) direto para o modelo — use um modelo que aceite áudio.'} />
        <ToggleCard title="Entender imagem" desc="Fotos e figurinhas vão junto para o modelo (use um modelo com visão)." checked={!!d.image} onChange={(image) => set({ image })} testId="ai-image" />
        <ToggleCard title="Entender PDF" desc={provider === 'gemini' ? 'Atenção: o Gemini pela API compatível pode não ler PDFs.' : 'Documentos PDF vão junto para o modelo.'} checked={!!d.pdf} onChange={(pdf) => set({ pdf })} testId="ai-pdf" />
        <ToggleCard title="Identificar comprovante" accent checked={!!d.detectReceipt} onChange={(detectReceipt) => set({ detectReceipt })} testId="ai-receipt"
          desc={<>Se o cliente mandar a foto ou o PDF de um comprovante de pagamento, segue pela saída <b>Comprovante válido</b> com <code>{'{{comprovante.valor}}'}</code>, <code>{'{{comprovante.nome_pagador}}'}</code>, data, banco e ID. A IA lê o arquivo: confira o dinheiro no banco antes de liberar algo caro.</>} />
      </Section>
      <Section title={`Condicionais inteligentes (${conds.length}/10)`} sub="A IA escolhe a que melhor descreve a mensagem e o fluxo segue por ela. Sem nenhuma, sai por “Resposta”.">
        {conds.map((c, i) => (
          <div className="bm-opt" key={c.id ?? i}>
            <span className="bm-opt-n">{i + 1}</span>
            <div className="bm-opt-f">
              <input className="input" value={c.label ?? ''} maxLength={40} placeholder="Quer comprar" onChange={(e) => updCond(i, { label: e.target.value })} data-testid={`ai-cond-${i}`} />
              <input className="input sm" value={c.description ?? ''} maxLength={200} placeholder="Quando acontece: pergunta preço, formas de pagamento…" onChange={(e) => updCond(i, { description: e.target.value })} />
            </div>
            <button type="button" className="btn icon sm ghost" onClick={() => set({ conditions: conds.filter((_, j) => j !== i) })} aria-label="Remover condição"><Icon name="trash" size={14} /></button>
          </div>
        ))}
        {conds.length < 10 && <button type="button" className="bm-addline" onClick={() => set({ conditions: [...conds, { id: rid('aic'), label: '', description: '' }] })} data-testid="ai-cond-add"><Icon name="plus" size={14} />Adicionar condição</button>}
      </Section>
      <ToggleCard title="Manter contexto" desc="Manda as últimas mensagens da conversa junto, para a IA entender o assunto." checked={!!d.keepContext} onChange={(keepContext) => set({ keepContext })} testId="ai-context" />
      {d.keepContext && (
        <Field label="Quantas trocas de mensagem lembrar (máx. 20)">
          <input className="input" type="number" min={1} max={20} value={d.contextSize ?? 5} onChange={(e) => set({ contextSize: Math.min(20, Math.max(1, Number(e.target.value) || 5)) })} data-testid="ai-context-size" />
        </Field>
      )}
      <HowItWorks>
        A resposta fica em <code>{'{{ia.resposta}}'}</code>, a transcrição do áudio em <code>{'{{ia.transcricao}}'}</code> e a condição escolhida em <code>{'{{ia.condicao}}'}</code>.
        Se der erro (chave inválida, sem saldo, modelo errado) segue por <b>Falha</b> — ou pela saída normal, se Falha não estiver ligada — com o motivo em <code>{'{{ia.erro}}'}</code>.
        {provider === 'converza' ? ' Consome tokens de IA da conta.' : ' O custo é cobrado pelo provedor, na sua conta dele.'}
      </HowItWorks>
    </>
  );
}
