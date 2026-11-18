import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; verified: boolean };
      accountId?: string;
      role?: 'owner' | 'admin' | 'agent';
      /** equipe de suporte do Converza entrando com acesso temporário liberado pela empresa */
      support?: boolean;
    }
  }
}

export {};
