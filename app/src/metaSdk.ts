/* Integração com o SDK do Facebook para o WhatsApp Embedded Signup (conexão em 1 clique). */
declare global {
  interface Window {
    FB?: {
      init: (o: Record<string, unknown>) => void;
      login: (cb: (r: FbLoginResponse) => void, opts: Record<string, unknown>) => void;
    };
    fbAsyncInit?: () => void;
  }
}

interface FbLoginResponse { authResponse?: { code?: string; accessToken?: string } | null; status?: string; }
export interface ESResult { code: string; phoneNumberId?: string; wabaId?: string; event?: string }

let ready: Promise<void> | null = null;

export function loadFbSdk(appId: string, version = 'v24.0'): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.onerror = () => { ready = null; reject(new Error('Não foi possível carregar o login da Meta. Confira sua internet ou bloqueadores de anúncio.')); };
    document.body.appendChild(s);
  });
  return ready;
}

/**
 * Abre a janela da Meta e resolve com o code + ids do número/WABA.
 * `coexistence`: conecta o WhatsApp Business que já está no celular (continua usando o app).
 */
export function launchEmbeddedSignup(configId: string, opts: { coexistence?: boolean } = {}): Promise<ESResult> {
  return new Promise<ESResult>((resolve, reject) => {
    const captured: { phoneNumberId?: string; wabaId?: string; event?: string; error?: string; canceled?: boolean } = {};

    const onMsg = (e: MessageEvent) => {
      try {
        if (!new URL(e.origin).hostname.endsWith('facebook.com')) return;
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
        captured.event = data.event;
        if (data.event === 'CANCEL') captured.canceled = true;
        if (data.event === 'ERROR') captured.error = data.data?.error_message ?? 'erro na Meta';
        if (data.data?.phone_number_id) captured.phoneNumberId = data.data.phone_number_id;
        if (data.data?.waba_id) captured.wabaId = data.data.waba_id;
      } catch { /* mensagens de outras origens */ }
    };
    window.addEventListener('message', onMsg);

    if (!window.FB) { window.removeEventListener('message', onMsg); reject(new Error('O login da Meta não carregou')); return; }

    window.FB.login((response) => {
      const code = response?.authResponse?.code;
      // o evento com os ids às vezes chega logo depois do retorno do login
      const finish = (tries: number) => {
        if (code && !captured.wabaId && tries > 0) { setTimeout(() => finish(tries - 1), 250); return; }
        window.removeEventListener('message', onMsg);
        if (!code) {
          reject(new Error(captured.error ? `A Meta não concluiu: ${captured.error}` : 'Conexão cancelada antes de terminar'));
          return;
        }
        resolve({ code, phoneNumberId: captured.phoneNumberId, wabaId: captured.wabaId, event: captured.event });
      };
      finish(8);
    }, {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, sessionInfoVersion: '3', ...(opts.coexistence ? { featureType: 'whatsapp_business_app_onboarding' } : {}) },
    });
  });
}

/**
 * Login de um perfil para os anúncios (menu Facebook). Com a configuração do Facebook Login for Business
 * (app do tipo Empresa) volta um code; sem ela, pede as permissões direto e volta o token.
 * "reauthenticate" faz a Meta pedir a senha de novo — é aí que dá para entrar com outro perfil.
 */
export function loginForAds(configId: string | null): Promise<{ code?: string; accessToken?: string }> {
  return new Promise((resolve, reject) => {
    if (!window.FB) { reject(new Error('O login da Meta não carregou')); return; }
    // a configuração "token de acesso do usuário" já devolve o token no próprio login: pedir um code aqui fazia
    // a troca no servidor falhar ("Error validating verification code… redirect_uri"), porque o code do SDK
    // do JavaScript não tem um redirect_uri que o servidor consiga repetir
    const opts: Record<string, unknown> = configId
      ? { config_id: configId, auth_type: 'reauthenticate' }
      : { scope: 'ads_read,business_management', auth_type: 'reauthenticate', return_scopes: true };
    window.FB.login((r) => {
      const code = r?.authResponse?.code;
      const accessToken = r?.authResponse?.accessToken;
      // o token tem preferência; o code só se a Meta não mandar o token
      if (accessToken || code) resolve(accessToken ? { accessToken } : { code: code! });
      else reject(new Error('Login cancelado antes de terminar'));
    }, opts);
  });
}
