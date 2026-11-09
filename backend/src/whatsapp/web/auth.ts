/**
 * Sessão do WhatsApp Web guardada no Postgres (e não em arquivos): o Render apaga o disco a cada deploy,
 * e sem as chaves o número teria de ler o QR Code de novo toda vez.
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../../db';
import type { Baileys } from './baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from '@whiskeysockets/baileys';

const CREDS = 'creds';
/** dados do Converza (não do protocolo) que continuam valendo se o número desconectar e ler o QR de novo */
export const KEEP_KINDS = ['peer-lid'];

const CHUNK = 200;
const chunks = <T>(list: T[], size = CHUNK) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * O aparelho já foi pareado (leu o QR ou digitou o código)? `account` só existe depois do pareamento —
 * `me` aparece antes, quando se pede o código de pareamento.
 */
export async function hasSession(connectionId: string): Promise<boolean> {
  await settled(connectionId);
  const [row] = await db.select({ v: schema.waWebAuth.value }).from(schema.waWebAuth)
    .where(and(eq(schema.waWebAuth.connectionId, connectionId), eq(schema.waWebAuth.kind, CREDS))).limit(1);
  if (!row) return false;
  try { return !!(JSON.parse(row.v) as { account?: unknown }).account; } catch { return false; }
}

/** Conexões por QR Code com aparelho pareado (para religar sozinhas quando o servidor reinicia). */
export async function pairedConnectionIds(): Promise<string[]> {
  const r = await db.execute(sql`
    select c.id from connections c
    where c.provider = 'web' and exists (
      select 1 from wa_web_auth a where a.connection_id = c.id and a.kind = ${CREDS} and a.value like '%"account"%')`);
  return (r.rows as { id: string }[]).map((x) => x.id);
}

/** Apaga as chaves do protocolo (desconectou/saiu): o próximo início pede um QR Code novo. */
export async function clearSession(connectionId: string) {
  await settled(connectionId);
  await db.delete(schema.waWebAuth)
    .where(and(eq(schema.waWebAuth.connectionId, connectionId), notInArray(schema.waWebAuth.kind, KEEP_KINDS)));
}

/**
 * Gravações da sessão em fila, uma de cada vez por conexão: duas transações gravando as mesmas chaves ao mesmo
 * tempo podem travar uma à outra no Postgres (deadlock) e perder chaves. E ao religar (ex.: logo depois de ler o QR,
 * o WhatsApp pede para reiniciar), a sessão nova só lê o banco depois que a anterior terminou de gravar.
 */
const writing = new Map<string, Promise<unknown>>();
function serial<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writing.get(connectionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  writing.set(connectionId, tail);
  void tail.then(() => { if (writing.get(connectionId) === tail) writing.delete(connectionId); });
  return run;
}
export const settled = (connectionId: string) => writing.get(connectionId) ?? Promise.resolve();

export async function dbAuthState(B: Baileys, connectionId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const encode = (v: unknown) => JSON.stringify(v, B.BufferJSON.replacer);
  const decode = (s: string) => JSON.parse(s, B.BufferJSON.reviver);
  await settled(connectionId);

  const [row] = await db.select().from(schema.waWebAuth)
    .where(and(eq(schema.waWebAuth.connectionId, connectionId), eq(schema.waWebAuth.kind, CREDS), eq(schema.waWebAuth.keyId, CREDS))).limit(1);
  const creds: AuthenticationCreds = row ? decode(row.value) : B.initAuthCreds();

  const saveCreds = () => serial(connectionId, async () => {
    // lê o estado na hora de gravar (se várias atualizações chegarem juntas, grava a mais nova)
    const value = encode(creds);
    await db.insert(schema.waWebAuth).values({ connectionId, kind: CREDS, keyId: CREDS, value })
      .onConflictDoUpdate({ target: [schema.waWebAuth.connectionId, schema.waWebAuth.kind, schema.waWebAuth.keyId], set: { value, updatedAt: new Date() } });
  });

  const keys = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const part of chunks([...new Set(ids)], 500)) {
        if (!part.length) continue;
        const rows = await db.select({ keyId: schema.waWebAuth.keyId, value: schema.waWebAuth.value }).from(schema.waWebAuth)
          .where(and(eq(schema.waWebAuth.connectionId, connectionId), eq(schema.waWebAuth.kind, type), inArray(schema.waWebAuth.keyId, part)));
        for (const r of rows) {
          let v = decode(r.value);
          if (type === 'app-state-sync-key' && v) v = B.proto.Message.AppStateSyncKeyData.fromObject(v);
          out[r.keyId] = v;
        }
      }
      return out;
    },
    async set(data: SignalDataSet) {
      const upserts: { connectionId: string; kind: string; keyId: string; value: string; updatedAt: Date }[] = [];
      const removals = new Map<string, string[]>();
      const now = new Date();
      for (const kind of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
        const entries = data[kind] ?? {};
        for (const id of Object.keys(entries)) {
          const v = (entries as Record<string, unknown>)[id];
          if (v) upserts.push({ connectionId, kind, keyId: id, value: encode(v), updatedAt: now });
          else removals.set(kind, [...(removals.get(kind) ?? []), id]);
        }
      }
      if (!upserts.length && !removals.size) return;
      upserts.sort((a, b) => (a.kind === b.kind ? (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0) : a.kind < b.kind ? -1 : 1));
      await serial(connectionId, () => db.transaction(async (tx) => {
        for (const part of chunks(upserts)) {
          await tx.insert(schema.waWebAuth).values(part).onConflictDoUpdate({
            target: [schema.waWebAuth.connectionId, schema.waWebAuth.kind, schema.waWebAuth.keyId],
            set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
          });
        }
        for (const [kind, ids] of removals) {
          for (const part of chunks(ids, 500)) {
            await tx.delete(schema.waWebAuth).where(and(eq(schema.waWebAuth.connectionId, connectionId), eq(schema.waWebAuth.kind, kind), inArray(schema.waWebAuth.keyId, part)));
          }
        }
      }));
    },
  };

  return { state: { creds, keys }, saveCreds };
}

/* --------------------------------------------- contatos que só aparecem pelo identificador anônimo (@lid) */

export async function rememberLidPeer(connectionId: string, id: string, jid: string) {
  await db.insert(schema.waWebAuth).values({ connectionId, kind: 'peer-lid', keyId: id, value: jid })
    .onConflictDoUpdate({ target: [schema.waWebAuth.connectionId, schema.waWebAuth.kind, schema.waWebAuth.keyId], set: { value: jid, updatedAt: new Date() } });
}

export async function lidPeerJid(connectionId: string, id: string): Promise<string | null> {
  const [row] = await db.select({ v: schema.waWebAuth.value }).from(schema.waWebAuth)
    .where(and(eq(schema.waWebAuth.connectionId, connectionId), eq(schema.waWebAuth.kind, 'peer-lid'), eq(schema.waWebAuth.keyId, id))).limit(1);
  return row?.v ?? null;
}
