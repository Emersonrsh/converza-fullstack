import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Modal, cx, toast } from '../components/ui';
import { getSocket } from '../socket';
import type { ConnectionFull, QrCodeInfo, WebState, WebStatusResp } from './types';

/** Aviso que aparece antes de conectar por QR Code e nos detalhes da conexão. */
export function QrRiskNotice({ qr, compact = false }: { qr?: QrCodeInfo; compact?: boolean }) {
  return (
    <div className="hint warn qr-risk" data-testid="qr-risk">
      <Icon name="alert" size={15} />
      <div>
        <b>API não oficial: o número pode ser banido pelo WhatsApp</b>
        {!compact && (
          <ul>
            <li>A conexão por QR Code usa o mesmo caminho do WhatsApp Web, mas <b>não é autorizada pela Meta</b> e vai contra os Termos do WhatsApp. O WhatsApp pode restringir ou banir o número a qualquer momento, sem aviso — principalmente com disparos para quem não te conhece ou muitas denúncias.</li>
            <li>Use um número que você aceita arriscar. Para operação séria, prefira a <b>API oficial</b> (Conectar com a Meta).</li>
            <li>Disparos saem devagar de propósito: um contato a cada {qr?.dispatch.minGapSec ?? 15}–{qr?.dispatch.maxGapSec ?? 45} s e no máximo {qr?.dispatch.dailyLimit ?? 250} contatos por dia por número.</li>
            <li>Funciona com WhatsApp e WhatsApp Business. O celular precisa entrar na internet pelo menos a cada 14 dias, senão o WhatsApp desconecta os aparelhos.</li>
            <li>Desligue a <b>mensagem de saudação/ausência</b> do app WhatsApp Business: o que o celular manda sozinho pausa a automação da conversa (como uma resposta sua).</li>
          </ul>
        )}
      </div>
    </div>
  );
}

const fmtPhone = (d: string) => d.replace(/\D/g, '');

/**
 * Janela do QR Code: mostra o QR (ou o código de pareamento) ao vivo, acompanha a leitura e confirma a conexão.
 * O QR chega pelo tempo real (wa:qr) e, como reserva, pela consulta a cada 2 s.
 */
export function QrConnectModal({ connection, onClose, onConnected }: {
  connection: ConnectionFull; onClose: () => void; onConnected: (c: ConnectionFull) => void;
}) {
  const id = connection.id;
  const [conn, setConn] = useState(connection);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<WebState | null>(connection.webState);
  const [attempt, setAttempt] = useState({ n: 0, max: 6 });
  const [useCode, setUseCode] = useState(false);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const done = useRef(false);

  const apply = useCallback((s: Partial<WebStatusResp> & { state?: WebState | null }) => {
    if (s.connection) setConn(s.connection);
    const st = s.state ?? s.qrState ?? s.connection?.webState ?? null;
    if (s.connection?.status === 'connected' && s.connection.webState === 'open') setState('open');
    else if (st) setState(st);
    if (s.qr !== undefined && s.qr !== null) setQr(s.qr);
    if (s.pairingCode !== undefined) setCode(s.pairingCode);
    if (s.attempt) setAttempt({ n: s.attempt, max: s.maxAttempts ?? 6 });
  }, []);

  // consulta periódica (reserva do tempo real)
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try { const r = await api.get<WebStatusResp>(`/connections/${id}/web`); if (!stop) apply(r); } catch { /* tenta de novo */ }
    };
    void tick();
    const t = setInterval(() => { if (!done.current) void tick(); }, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [id, apply]);

  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onQr = (p: { connectionId: string; state: WebState; qr: string | null; pairingCode: string | null; attempt?: number; maxAttempts?: number; error?: string }) => {
      if (p.connectionId !== id) return;
      apply({ state: p.state, qr: p.qr, pairingCode: p.pairingCode, attempt: p.attempt, maxAttempts: p.maxAttempts });
      if (p.error) setErr(p.error);
    };
    const onState = (p: { connectionId: string; state: WebState }) => { if (p.connectionId === id) setState(p.state); };
    const onConn = (p: { connection?: ConnectionFull }) => { if (p.connection?.id === id) apply({ connection: p.connection }); };
    sock.on('wa:qr', onQr);
    sock.on('wa:state', onState);
    sock.on('connection:updated', onConn);
    return () => { sock.off('wa:qr', onQr); sock.off('wa:state', onState); sock.off('connection:updated', onConn); };
  }, [id, apply]);

  // aberto pelo "Ler QR Code" com a sessão parada (desconectado, QR expirado…): já pede um QR novo
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const st = connection.webState;
    if (!st || ['logged_out', 'qr_expired', 'closed', 'replaced'].includes(st)) void restart();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state === 'open' && conn.status === 'connected' && !done.current) {
      done.current = true;
      onConnected(conn);
    }
  }, [state, conn, onConnected]);

  async function restart(withPhone?: string) {
    setBusy(true); setErr(null); setQr(null); setCode(null);
    try {
      const r = await api.post<WebStatusResp>(`/connections/${id}/web/start`, withPhone ? { phone: withPhone } : {});
      apply(r);
      if (!withPhone) setState(r.qrState ?? 'starting');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Não foi possível gerar o QR Code'); }
    setBusy(false);
  }

  const open = state === 'open' && conn.status === 'connected';
  const ended = state === 'qr_expired' || state === 'closed' || state === 'logged_out' || state === 'replaced';
  const scanning = state === 'connecting' && !open;
  return (
    <Modal title={open ? 'WhatsApp conectado' : 'Conectar por QR Code'} subtitle={conn.name} icon="qr" width={560} onClose={onClose} footer={open ? (
      <button type="button" className="btn primary" onClick={onClose} data-testid="qr-done">Concluir</button>
    ) : (
      <button type="button" className="btn" onClick={onClose}>Fechar</button>
    )}>
      {open ? (
        <div className="qr-ok" data-testid="qr-connected">
          <span className="qr-ok-ic"><Icon name="checkCircle" size={34} /></span>
          <b>{conn.displayPhone ?? 'Número conectado'}</b>
          <span>{conn.verifiedName ? `${conn.verifiedName} · ` : ''}As conversas novas desse número já chegam no Chats ao vivo, e os fluxos, agentes e disparos podem usar esta conexão.</span>
        </div>
      ) : (
        <div className="qr-wrap">
          <div className={cx('qr-box', (ended || scanning) && 'dim')} data-testid="qr-box">
            {useCode && code ? (
              <div className="qr-code" data-testid="qr-pairing-code">{code}</div>
            ) : qr && !ended ? (
              <img src={qr} alt="QR Code para conectar o WhatsApp" data-testid="qr-image" />
            ) : (
              <div className="qr-wait">{ended ? <Icon name="refresh" size={28} /> : <span className="spin" />}</div>
            )}
            {scanning && <div className="qr-over"><span className="spin" /><b>Conectando…</b></div>}
          </div>
          <div className="qr-steps">
            {ended ? (
              <div className="stack" style={{ gap: 10 }} data-testid="qr-ended">
                <b>{state === 'qr_expired' ? 'O QR Code expirou' : state === 'logged_out' ? 'O aparelho foi desconectado' : state === 'replaced' ? 'A sessão foi aberta em outro lugar' : 'Sem conexão com o WhatsApp'}</b>
                <span className="faint">{conn.lastError ?? 'Gere um novo QR Code e leia com o celular.'}</span>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void restart()} data-testid="qr-retry"><Icon name="refresh" size={14} />{busy ? 'Gerando…' : 'Gerar novo QR Code'}</button>
              </div>
            ) : useCode ? (
              <>
                <ol>
                  <li>Abra o <b>WhatsApp</b> (ou WhatsApp Business) no celular.</li>
                  <li>Toque em <b>⋮ Mais opções</b> (Android) ou <b>Configurações</b> (iPhone) › <b>Aparelhos conectados</b> › <b>Conectar um aparelho</b>.</li>
                  <li>Toque em <b>Conectar com número de telefone</b> e digite o código ao lado.</li>
                </ol>
                {!code && (
                  <div className="cn-inline">
                    <input className="input" inputMode="tel" placeholder="55 11 99999-0000" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="qr-phone" />
                    <button type="button" className="btn primary" disabled={busy || fmtPhone(phone).length < 10} onClick={() => void restart(phone)} data-testid="qr-get-code">{busy ? 'Gerando…' : 'Gerar código'}</button>
                  </div>
                )}
                {code && <small className="faint">O código vale por alguns minutos. Se expirar, gere outro.</small>}
                <button type="button" className="linkbtn" onClick={() => { setUseCode(false); setCode(null); void restart(); }} data-testid="qr-use-qr">Prefiro ler o QR Code</button>
              </>
            ) : (
              <>
                <ol>
                  <li>Abra o <b>WhatsApp</b> (ou WhatsApp Business) no celular do número que vai usar.</li>
                  <li>Toque em <b>⋮ Mais opções</b> (Android) ou <b>Configurações</b> (iPhone) › <b>Aparelhos conectados</b> › <b>Conectar um aparelho</b>.</li>
                  <li>Aponte a câmera para este QR Code.</li>
                </ol>
                <small className="faint" data-testid="qr-attempt">{qr ? `O QR Code muda sozinho a cada 20 segundos${attempt.n ? ` (${attempt.n} de ${attempt.max})` : ''}.` : 'Gerando o QR Code…'}</small>
                <button type="button" className="linkbtn" onClick={() => setUseCode(true)} data-testid="qr-use-code">Sem câmera? Conectar com um código</button>
              </>
            )}
            {err && <div className="hint bad"><Icon name="alert" size={14} />{err}</div>}
          </div>
        </div>
      )}
    </Modal>
  );
}
