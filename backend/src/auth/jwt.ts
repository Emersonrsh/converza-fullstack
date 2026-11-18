import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface TokenPayload {
  userId: string;
  email: string;
  /** false = e-mail ainda não confirmado (tokens antigos, sem o campo, são de contas já confirmadas) */
  ev?: boolean;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload & { iat?: number } {
  return jwt.verify(token, config.jwtSecret) as TokenPayload & { iat?: number };
}
