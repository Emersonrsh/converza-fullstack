import type { Request, Response, NextFunction } from 'express';

export const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    return res.status(err.status).json({ error: err.message });
  }
  // Erros de validação do zod
  if (err && typeof err === 'object' && 'issues' in err) {
    return res.status(422).json({ error: 'Dados inválidos', issues: (err as { issues: unknown }).issues });
  }
  console.error(err);
  return res.status(500).json({ error: 'Erro interno do servidor' });
}
