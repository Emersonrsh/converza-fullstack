/* Integração com o SDK do Facebook para o WhatsApp Embedded Signup. */
declare global {
  interface Window {
    FB?: {
      init: (o: Record<string, unknown>) => void;
      login: (cb: (r: FbLoginResponse) => void, opts: Record<string, unknown>) => void;
    };
    fbAsyncInit?: () => void;
  }
}

interface FbLoginResponse { authResponse?: { code?: string } | null; status?: string; }
export interface ESResult { code: string; phoneNumberId?: string; wabaId?: string; }

let ready: Promise<void> | null = null;

export function loadFbSdk(appId: string, version = 'v21.0'): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('Falha ao carregar o SDK da Meta'));
    document.body.appendChild(s);
  });
  return ready;
}

/** Abre o popup de Embedded Signup e resolve com o code + ids do número/WABA. */
export function launchEmbeddedSignup(configId: string): Promise<ESResult> {
  return new Promise<ESResult>((resolve, reject) => {
    const captured: { phoneNumberId?: string; wabaId?: string } = {};

    const onMsg = (e: MessageEvent) => {
      try {
        if (!new URL(e.origin).hostname.endsWith('facebook.com')) return;
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data?.type === 'WA_EMBEDDED_SIGNUP' && data?.data) {
          captured.phoneNumberId = data.data.phone_number_id ?? captured.phoneNumberId;
          captured.wabaId = data.data.waba_id ?? captured.wabaId;
        }
      } catch { /* ignora mensagens de outras origens */ }
    };
    window.addEventListener('message', onMsg);

    if (!window.FB) { window.removeEventListener('message', onMsg); reject(new Error('SDK da Meta não carregou')); return; }

    window.FB.login((response) => {
      window.removeEventListener('message', onMsg);
      const code = response?.authResponse?.code;
      if (!code) { reject(new Error('Autorização cancelada')); return; }
      resolve({ code, phoneNumberId: captured.phoneNumberId, wabaId: captured.wabaId });
    }, {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { sessionInfoVersion: '3' },
    });
  });
}
