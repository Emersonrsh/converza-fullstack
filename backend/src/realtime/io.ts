import type { Server as HttpServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import { config } from '../config';
import { and, eq } from 'drizzle-orm';
import { verifyToken } from '../auth/jwt';
import { db, schema } from '../db';
import { isUuid } from '../utils/http';

let io: IOServer | null = null;

/** Inicializa o Socket.IO. Cada socket entra na "sala" da sua conta. */
export function initIO(server: HttpServer): IOServer {
  io = new IOServer(server, { cors: { origin: config.appOrigin, credentials: true } });

  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const accountId = socket.handshake.auth?.accountId as string | undefined;
    if (!token || !accountId || !isUuid(accountId)) return next(new Error('auth ausente'));
    let userId: string;
    try {
      userId = verifyToken(token).userId;
    } catch {
      return next(new Error('token inválido'));
    }
    try {
      // só entra na sala de contas das quais o usuário é membro
      const [m] = await db.select({ id: schema.memberships.id }).from(schema.memberships)
        .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.accountId, accountId))).limit(1);
      if (!m) return next(new Error('sem acesso a esta conta'));
      socket.data.userId = userId;
      socket.data.accountId = accountId;
      next();
    } catch {
      next(new Error('falha ao validar acesso'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`account:${socket.data.accountId}`);
  });

  return io;
}

/** Emite um evento para todos os sockets de uma conta. */
export function emitToAccount(accountId: string, event: string, payload: unknown) {
  io?.to(`account:${accountId}`).emit(event, payload);
}
