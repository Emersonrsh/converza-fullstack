import { getToken } from './api';
import { io, type Socket } from 'socket.io-client';

const URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:4000';
let socket: Socket | null = null;

export function connectSocket(token: string, accountId: string): Socket {
  if (socket) socket.disconnect();
  // a cada reconexão lê o token atual (ele é renovado de tempos em tempos)
  socket = io(URL, { auth: (cb) => cb({ token: getToken() ?? token, accountId }), transports: ['websocket', 'polling'] });
  return socket;
}

export function getSocket(): Socket | null { return socket; }

export function disconnectSocket() { socket?.disconnect(); socket = null; }
