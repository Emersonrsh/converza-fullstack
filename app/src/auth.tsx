import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setToken, setAccountId, getToken, getAccountId } from './api';
import { connectSocket, disconnectSocket } from './socket';
import type { User, Account } from './types';

interface AuthShape {
  user: User | null;
  accounts: Account[];
  accountId: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string, companyName: string) => Promise<void>;
  logout: () => void;
  switchAccount: (id: string) => void;
}

const Ctx = createContext<AuthShape>(null as unknown as AuthShape);
export const useAuth = () => useContext(Ctx);

interface AuthResp { token: string; user: User; accounts: Account[]; }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAcc] = useState<string | null>(getAccountId());
  const [loading, setLoading] = useState(true);

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
    (async () => {
      if (!getToken()) { setLoading(false); return; }
      try {
        const me = await api.get<{ user: User; accounts: Account[] }>('/auth/me');
        setUser(me.user);
        setAccounts(me.accounts);
        const current = getAccountId() && me.accounts.some((a) => a.id === getAccountId())
          ? getAccountId() : (me.accounts[0]?.id ?? null);
        setAccountId(current); setAcc(current);
        if (current) connectSocket(getToken()!, current);
      } catch {
        setToken(null); setAccountId(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login: AuthShape['login'] = async (email, password) => {
    applyAuth(await api.post<AuthResp>('/auth/login', { email, password }));
  };
  const register: AuthShape['register'] = async (name, email, password, companyName) => {
    applyAuth(await api.post<AuthResp>('/auth/register', { name, email, password, companyName }));
  };
  const logout = () => {
    setToken(null); setAccountId(null); disconnectSocket();
    setUser(null); setAccounts([]); setAcc(null);
  };
  const switchAccount = (id: string) => {
    setAccountId(id); setAcc(id);
    const t = getToken(); if (t) connectSocket(t, id);
  };

  return (
    <Ctx.Provider value={{ user, accounts, accountId, loading, login, register, logout, switchAccount }}>
      {children}
    </Ctx.Provider>
  );
}
