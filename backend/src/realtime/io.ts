import type { Server as HttpServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import { config } from '../config';
import { verifyToken } from '../auth/jwt';

let io: IOServer | null = null;

/** Inicializa o Socket.IO. Cada socket entra na "sala" da sua conta. */
export function initIO(server: HttpServer): IOServer {
  io = new IOServer(server, { cors: { origin: config.appOrigin, credentials: true } });

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const accountId = socket.handshake.auth?.accountId as string | undefined;
    if (!token || !accountId) return next(new Error('auth ausente'));
    try {
      const payload = verifyToken(token);
      socket.data.userId = payload.userId;
      socket.data.accountId = accountId;
      next();
    } catch {
      next(new Error('token inválido'));
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
