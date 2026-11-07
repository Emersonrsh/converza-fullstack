import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, setToken, setAccountId, getToken, getAccountId } from './api';
import { connectSocket, disconnectSocket } from './socket';
import type { User, Account } from './types';

interface AuthShape {
  user: User | null;
  accounts: Account[];
  accountId: string | null;
  loading: boolean;
  /** o servidor não respondeu ao abrir o app (a sessão continua salva) */
  offline: boolean;
  retry: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string, companyName: string, inviteToken?: string | null) => Promise<void>;
  logout: () => void;
  switchAccount: (id: string) => void;
  /** relê as empresas do usuário (depois de criar, sair, excluir ou aceitar convite) */
  reloadAccounts: (preferId?: string | null) => Promise<Account[]>;
}

const Ctx = createContext<AuthShape>(null as unknown as AuthShape);
export const useAuth = () => useContext(Ctx);

interface AuthResp { token: string; user: User; accounts: Account[]; }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAcc] = useState<string | null>(getAccountId());
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  function applyAuth(resp: AuthResp) {
    setToken(resp.token);
    setUser(resp.user);
    setAccounts(resp.accounts);
    const first = resp.accounts[0]?.id ?? null;
    const current = getAccountId() && resp.accounts.some((a) => a.id === getAccountId()) ? getAccountId() : first;
    setAccountId(current);
    setAcc(current);
    if (resp.token && current) connectSocket(resp.token, current);
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!getToken()) { setLoading(false); return; }
      try {
        const me = await api.get<{ user: User; accounts: Account[] }>('/auth/me');
        if (!alive) return;
        setUser(me.user);
        setAccounts(me.accounts);
        const current = getAccountId() && me.accounts.some((a) => a.id === getAccountId())
          ? getAccountId() : (me.accounts[0]?.id ?? null);
        setAccountId(current); setAcc(current);
        setOffline(false);
        if (current) connectSocket(getToken()!, current);
      } catch (e) {
        if (!alive) return;
        // só sai da conta se o servidor recusar o login; queda de rede/deploy não apaga a sessão
        if (e instanceof ApiError && e.status === 401) { setToken(null); setAccountId(null); }
        else setOffline(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [attempt]);
  const retry = () => { setLoading(true); setAttempt((n) => n + 1); };
  // sem servidor: tenta de novo sozinho a cada 5 s (ex.: deploy terminando)
  useEffect(() => {
    if (!offline) return;
    const t = setTimeout(() => setAttempt((n) => n + 1), 5000);
    return () => clearTimeout(t);
  }, [offline, attempt]);

  const login: AuthShape['login'] = async (email, password) => {
    applyAuth(await api.post<AuthResp>('/auth/login', { email, password }));
  };
  const register: AuthShape['register'] = async (name, email, password, companyName, inviteToken) => {
    // código do programa de parceiros guardado quando a pessoa abriu o link ?ref=
    const ref = localStorage.getItem('converza:ref');
    applyAuth(await api.post<AuthResp>('/auth/register', { name, email, password, companyName, ...(ref ? { ref } : {}), ...(inviteToken ? { inviteToken } : {}) }));
    localStorage.removeItem('converza:ref');
  };
  const logout = () => {
    setToken(null); setAccountId(null); disconnectSocket();
    setUser(null); setAccounts([]); setAcc(null);
  };
  const switchAccount = (id: string) => {
    setAccountId(id); setAcc(id);
    const t = getToken(); if (t) connectSocket(t, id);
  };
  const reloadAccounts: AuthShape['reloadAccounts'] = async (preferId) => {
    const me = await api.get<{ user: User; accounts: Account[] }>('/auth/me');
    setUser(me.user);
    setAccounts(me.accounts);
    const want = preferId ?? getAccountId();
    const current = want && me.accounts.some((a) => a.id === want) ? want : (me.accounts[0]?.id ?? null);
    setAccountId(current); setAcc(current);
    const t = getToken();
    if (t && current) connectSocket(t, current); else disconnectSocket();
    return me.accounts;
  };

  return (
    <Ctx.Provider value={{ user, accounts, accountId, loading, offline, retry, login, register, logout, switchAccount, reloadAccounts }}>
      {children}
    </Ctx.Provider>
  );
}
