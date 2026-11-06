import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
      accountId?: string;
      role?: 'owner' | 'admin' | 'agent';
    }
  }
}

export {};
