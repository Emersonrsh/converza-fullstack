import { io, type Socket } from 'socket.io-client';

const URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:4000';
let socket: Socket | null = null;

export function connectSocket(token: string, accountId: string): Socket {
  if (socket) socket.disconnect();
  socket = io(URL, { auth: { token, accountId }, transports: ['websocket', 'polling'] });
  return socket;
}

export function getSocket(): Socket | null { return socket; }

export function disconnectSocket() { socket?.disconnect(); socket = null; }
