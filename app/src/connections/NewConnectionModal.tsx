import { useState } from 'react';
import { ApiError, api } from '../api';
import { Icon } from '../icons';
import { Modal, cx, toast } from '../components/ui';
import { launchEmbeddedSignup, loadFbSdk } from '../metaSdk';
import { QrRiskNotice } from './QrConnect';
import type { ConnectionFull, QrCodeInfo, SignupConfig, WebhookInfo } from './types';

type Method = 'meta' | 'coexistence' | 'manual' | 'qr';

export function CopyField({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="cn-copy">
      <small>{label}</small>
      <div><code data-testid={testId}>{value}</code>
        <button type="button" className="btn icon sm ghost" onClick={() => { void navigator.clipboard?.writeText(value); toast(`${label} copiado`); }} aria-label={`Copiar ${label}`}><Icon name="copy" size={14} /></button>
      </div>
    </div>
  );
}

/** Passo a passo para quem conecta com o próprio app da Meta (conexão manual). */
export function WebhookHelp({ webhook, coexistence = false }: { webhook: WebhookInfo; coexistence?: boolean }) {
  return (
    <div className="cn-help">
      <b><Icon name="webhook" size={14} />Configure o webhook no seu app da Meta</b>
      <span>Em Meta for Developers › seu app › WhatsApp › Configuração, cadastre:</span>
      <CopyField label="URL de retorno" value={webhook.url} testId="webhook-url" />
      <CopyField label="Token de verificação" value={webhook.verifyToken} testId="webhook-token" />
      <span>Depois inscreva o campo <code>messages</code>{coexistence ? <> (e <code>smb_message_echoes</code>, <code>history</code>, <code>smb_app_state_sync</code>)</> : null}.</span>
    </div>
  );
}

/** Abre a janela da Meta (Embedded Signup) e finaliza a conexão no Converza. Também serve para reconectar. */
export async function connectViaMeta(signup: SignupConfig, coexistence: boolean) {
  await loadFbSdk(signup.appId, signup.graphVersion);
  const r = await launchEmbeddedSignup(signup.configId, { coexistence });
  if (!r.wabaId) throw new Error('A Meta não devolveu a conta do WhatsApp Business. Tente de novo.');
  return api.post<{ connection: ConnectionFull; registerError: string | null }>('/connections/embedded-signup/exchange', {
    code: r.code, wabaId: r.wabaId, phoneNumberId: r.phoneNumberId ?? null, coexistence,
  });
}

export function NewConnectionModal({ signup, webhook, qrCode, onClose, onDone, onQr }: {
  signup: SignupConfig; webhook: WebhookInfo | null; qrCode?: QrCodeInfo; onClose: () => void; onDone: (c: ConnectionFull, msg?: string) => void;
  /** conexão por QR Code criada: abre a janela do QR */
  onQr?: (c: ConnectionFull) => void;
}) {
  const [method, setMethod] = useState<Method>(signup.configured ? 'meta' : 'manual');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [needSecret, setNeedSecret] = useState(false);
  const [f, setF] = useState({ name: '', phoneNumberId: '', wabaId: '', accessToken: '', appSecret: '' });
  const [qrName, setQrName] = useState('');
  const [qrAccept, setQrAccept] = useState(false);

  async function viaQr() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ connection: ConnectionFull }>('/connections/web', { name: qrName.trim(), acceptRisk: true });
      onQr?.(r.connection);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Não foi possível criar a conexão'); }
    setBusy(false);
  }

  async function viaMeta(coexistence: boolean) {
    setBusy(true); setErr(null);
    try {
      const res = await connectViaMeta(signup, coexistence);
      onDone(res.connection, res.registerError ? `Conectado, mas o registro do número falhou: ${res.registerError}` : coexistence ? 'WhatsApp Business conectado — os contatos e o histórico do celular estão chegando' : 'WhatsApp conectado ✓');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Falha ao conectar'); }
    setBusy(false);
  }

  async function manual() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ connection: ConnectionFull }>('/connections', f);
      onDone(r.connection, r.connection.status === 'connected' ? 'Conexão adicionada ✓' : 'Conexão adicionada — confira os avisos');
    } catch (e) {
      if (e instanceof ApiError && e.data?.field === 'appSecret') setNeedSecret(true);
      setErr(e instanceof Error ? e.message : 'Não foi possível conectar');
    }
    setBusy(false);
  }

  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const manualOk = f.name.trim() && /^\d{6,}$/.test(f.phoneNumberId.trim()) && f.accessToken.trim().length >= 20;
  return (
    <Modal title="Nova conexão" subtitle={method === 'qr' ? 'Conecte qualquer WhatsApp ou WhatsApp Business lendo um QR Code' : 'Conecte um número de WhatsApp pela API oficial da Meta'} icon="plug" width={qrCode?.enabled ? 720 : 640} onClose={onClose} footer={method === 'manual' ? <>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!manualOk || busy} onClick={() => void manual()} data-testid="manual-save">{busy ? 'Conferindo na Meta…' : 'Conectar'}</button>
    </> : method === 'qr' ? <>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!qrName.trim() || !qrAccept || busy} onClick={() => void viaQr()} data-testid="qr-create"><Icon name="qr" size={15} />{busy ? 'Preparando…' : 'Gerar QR Code'}</button>
    </> : undefined}>
      <div className={cx('cn-methods', qrCode?.enabled && 'four')}>
        <button type="button" className={cx(method === 'meta' && 'on')} disabled={!signup.configured} onClick={() => setMethod('meta')} data-testid="method-meta">
          <span className="cn-m-ic"><Icon name="bolt" size={17} /></span><b>Conectar com a Meta</b><small>Login com o Facebook, sem copiar token. Para número novo na API.</small>
          {signup.configured && <span className="pill teal mini">recomendado</span>}
        </button>
        <button type="button" className={cx(method === 'coexistence' && 'on')} disabled={!signup.configured} onClick={() => setMethod('coexistence')} data-testid="method-coexistence">
          <span className="cn-m-ic"><Icon name="phone" size={17} /></span><b>WhatsApp Business do celular</b><small>Continue usando o app no celular — as conversas aparecem aqui também.</small>
        </button>
        <button type="button" className={cx(method === 'manual' && 'on')} onClick={() => setMethod('manual')} data-testid="method-manual">
          <span className="cn-m-ic"><Icon name="gear" size={17} /></span><b>Manual</b><small>Já tem um app na Meta for Developers e o token de acesso.</small>
        </button>
        {qrCode?.enabled && (
          <button type="button" className={cx('cn-m-qr', method === 'qr' && 'on')} onClick={() => setMethod('qr')} data-testid="method-qr">
            <span className="cn-m-ic"><Icon name="qr" size={17} /></span><b>QR Code</b><small>Leia o QR com o celular, como no WhatsApp Web. Sem Meta e sem aprovação.</small>
            <span className="pill amber mini">não oficial</span>
          </button>
        )}
      </div>
      {!signup.configured && <div className="hint" style={{ marginTop: 12 }}><Icon name="info" size={14} />A conexão em 1 clique precisa das credenciais de Tech Provider da Meta no servidor (META_APP_ID e META_EMBEDDED_SIGNUP_CONFIG_ID). Por enquanto, use a conexão manual.</div>}

      {method === 'meta' && (
        <div className="cn-step">
          <ol>
            <li>Clique em <b>Continuar com a Meta</b> e entre com o Facebook do dono do negócio.</li>
            <li>Escolha ou crie a conta do WhatsApp Business e o número (ele não pode estar em uso no app do celular).</li>
            <li>Confirme o código por SMS ou ligação. Pronto: o Converza registra o número e passa a receber as mensagens.</li>
          </ol>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void viaMeta(false)} data-testid="go-meta"><Icon name="bolt" size={15} />{busy ? 'Conectando…' : 'Continuar com a Meta'}</button>
        </div>
      )}
      {method === 'coexistence' && (
        <div className="cn-step">
          <ol>
            <li>No celular, atualize o <b>WhatsApp Business</b> (versão 2.24.17 ou mais nova).</li>
            <li>Clique em <b>Continuar com a Meta</b>, escolha “conectar o WhatsApp Business existente” e informe o número.</li>
            <li>No celular, abra a mensagem da Meta e leia o QR code. As conversas dos últimos 6 meses e os contatos chegam em alguns minutos.</li>
          </ol>
          <div className="hint"><Icon name="info" size={14} />O celular continua funcionando. Grupos, listas de transmissão, chamadas e mensagens temporárias ficam só no app. O que você responder pelo celular aparece aqui e pausa a automação daquela conversa.</div>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void viaMeta(true)} data-testid="go-coexistence"><Icon name="phone" size={15} />{busy ? 'Conectando…' : 'Continuar com a Meta'}</button>
        </div>
      )}
      {method === 'manual' && (
        <div className="cn-step stack" style={{ gap: 12 }}>
          <div className="cn-two">
            <div><label className="label">Nome da conexão</label><input className="input" maxLength={60} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Vendas 01" data-testid="m-name" /></div>
            <div><label className="label">Phone Number ID</label><input className="input" inputMode="numeric" value={f.phoneNumberId} onChange={(e) => set('phoneNumberId', e.target.value.replace(/\D/g, ''))} placeholder="Só números" data-testid="m-phone-id" /></div>
          </div>
          <div className="cn-two">
            <div><label className="label">WABA ID <span className="lbl-hint">· recomendado</span></label><input className="input" inputMode="numeric" value={f.wabaId} onChange={(e) => set('wabaId', e.target.value.replace(/\D/g, ''))} placeholder="ID da conta do WhatsApp Business" data-testid="m-waba" /></div>
            <div><label className="label">Token de acesso</label><input className="input" type="password" value={f.accessToken} onChange={(e) => set('accessToken', e.target.value.trim())} placeholder="EAAG…" data-testid="m-token" autoComplete="off" /></div>
          </div>
          <div>
            <label className="label">Chave secreta do app <span className="lbl-hint">· {needSecret ? 'obrigatória para este token' : 'se o token for do seu próprio app'}</span></label>
            <input className={cx('input', needSecret && 'bad')} type="password" value={f.appSecret} onChange={(e) => set('appSecret', e.target.value.trim())} placeholder="App Secret (Configurações do app › Básico)" data-testid="m-secret" autoComplete="off" />
            <small className="faint">Usada só para conferir que as mensagens recebidas vieram mesmo da Meta.</small>
          </div>
          <small className="faint">Use um token de usuário do sistema (permanente): Gerenciador de Negócios › Usuários do sistema › Gerar token com <code>whatsapp_business_messaging</code> e <code>whatsapp_business_management</code>. O token temporário da página de testes vence em 24 horas.</small>
          {webhook && <WebhookHelp webhook={webhook} />}
        </div>
      )}
      {method === 'qr' && (
        <div className="cn-step stack" style={{ gap: 12 }}>
          <QrRiskNotice qr={qrCode} />
          {qrCode?.simulator && <div className="hint"><Icon name="info" size={14} />Servidor de testes: o “celular” é simulado (WA_WEB_DRIVER=mock).</div>}
          <div>
            <label className="label">Nome da conexão</label>
            <input className="input" maxLength={60} value={qrName} onChange={(e) => setQrName(e.target.value)} placeholder="Ex.: Atendimento loja" data-testid="qr-name"
              onKeyDown={(e) => { if (e.key === 'Enter' && qrName.trim() && qrAccept) void viaQr(); }} />
          </div>
          <label className="qr-accept">
            <input type="checkbox" checked={qrAccept} onChange={(e) => setQrAccept(e.target.checked)} data-testid="qr-accept" />
            <span>Entendi que a conexão por QR Code não é oficial, que o WhatsApp pode banir o número e que a responsabilidade pelo uso é minha.</span>
          </label>
        </div>
      )}
      {err && <div className="hint bad" style={{ marginTop: 12 }} data-testid="new-conn-error"><Icon name="alert" size={14} />{err}</div>}
    </Modal>
  );
}
