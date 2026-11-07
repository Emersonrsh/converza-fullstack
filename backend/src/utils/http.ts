import type { Request, Response, NextFunction } from 'express';

export const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export class AppError extends Error {
  status: number;
  /** campos extras na resposta (ex.: { code: 'agent_limit', limit }) */
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Envolve handlers async para encaminhar erros ao middleware de erro. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ ...(err.extra ?? {}), error: err.message });
  }
  // Erros de validação do zod
  if (err && typeof err === 'object' && 'issues' in err) {
    return res.status(422).json({ error: 'Dados inválidos', issues: (err as { issues: unknown }).issues });
  }
  console.error(err);
  return res.status(500).json({ error: 'Erro interno do servidor' });
}

/** Endereço público da API: PUBLIC_API_URL ou o host da própria requisição (atrás do proxy do Render). */
export function publicBase(req: Request, configured: string): string {
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}
