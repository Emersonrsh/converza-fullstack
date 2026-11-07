import { useEffect, useState } from 'react';
import { API_BASE } from '../api';
import { Icon } from '../icons';

type PaddleEvent = { name?: string; data?: { transaction_id?: string } };
type PaddleJs = {
  Environment: { set: (env: string) => void };
  Initialize: (o: { token: string; eventCallback?: (e: PaddleEvent) => void }) => void;
};

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    if ((window as unknown as { Paddle?: PaddleJs }).Paddle) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Não foi possível carregar o checkout da Paddle. Confira sua internet e tente de novo.'));
    document.head.appendChild(s);
  });
}

type State = 'loading' | 'open' | 'done' | 'closed' | 'error';

/**
 * Página de pagamento da Paddle (o "Default payment link" da conta Paddle aponta para cá).
 * A Paddle.js lê o ?_ptxn= do endereço e abre o checkout dela por cima: os dados do cartão ficam só na Paddle.
 */
export function PaddleCheckout() {
  const [state, setState] = useState<State>('loading');
  const [msg, setMsg] = useState('');
  const txn = new URLSearchParams(window.location.search).get('_ptxn');

  useEffect(() => {
    if (!txn) { setState('error'); setMsg('Este link de pagamento está incompleto (falta o código da compra).'); return; }
    let done = false;
    (async () => {
      const cfg = await fetch(`${API_BASE}/billing-hooks/paddle-config`).then((r) => r.json()) as { enabled: boolean; clientToken: string | null; environment: string };
      if (!cfg.enabled || !cfg.clientToken) throw new Error('O pagamento internacional ainda não está configurado neste servidor.');
      await loadScript('https://cdn.paddle.com/paddle/v2/paddle.js');
      const P = (window as unknown as { Paddle?: PaddleJs }).Paddle;
      if (!P) throw new Error('Não foi possível carregar o checkout da Paddle.');
      if (cfg.environment === 'sandbox') P.Environment.set('sandbox');
      P.Initialize({
        token: cfg.clientToken,
        eventCallback: (e) => {
          if (e.name === 'checkout.loaded') setState('open');
          if (e.name === 'checkout.completed') {
            done = true; setState('done');
            setTimeout(() => window.location.assign('/billing?pago=1'), 2500);
          }
          if (e.name === 'checkout.closed' && !done) setState('closed');
          if (e.name === 'checkout.error') { setState('error'); setMsg('A Paddle não conseguiu abrir este pagamento. Volte e tente de novo.'); }
        },
      });
      setState((s) => (s === 'loading' ? 'open' : s));
    })().catch((err: Error) => { setState('error'); setMsg(err.message); });
  }, [txn]);

  return (
    <div className="pay-wrap" data-testid="paddle-page">
      <div className="card pay-card">
        <svg className="logo" viewBox="0 0 40 40" fill="none" width="40" height="40">
          <rect width="40" height="40" rx="11" fill="#0e9488" />
          <path d="M11 13a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-7l-5 4v-4V13Z" fill="#fff" fillOpacity=".95" />
          <path d="M18 17h7M18 20.5h4.5" stroke="#0e9488" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {state === 'loading' && <><b>Abrindo o pagamento…</b><span>Carregando o checkout seguro da Paddle.</span></>}
        {state === 'open' && <><b>Pagamento seguro pela Paddle</b><span>Preencha os dados na janela da Paddle. Os dados do cartão não passam pelo Converza.</span></>}
        {state === 'done' && <><Icon name="checkCircle" size={28} /><b data-testid="paddle-done">Pagamento concluído!</b><span>Voltando para Cobranças e assinaturas…</span></>}
        {state === 'closed' && (
          <>
            <b>Pagamento não concluído</b><span>Você fechou o checkout antes de pagar.</span>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button type="button" className="btn primary" onClick={() => window.location.reload()}>Abrir de novo</button>
              <a className="btn" href="/billing">Voltar</a>
            </div>
          </>
        )}
        {state === 'error' && <><Icon name="alert" size={26} /><b>Não deu para abrir o pagamento</b><span data-testid="paddle-error">{msg}</span><a className="btn" href="/billing">Voltar para Cobranças e assinaturas</a></>}
      </div>
    </div>
  );
}
