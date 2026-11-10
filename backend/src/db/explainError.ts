/**
 * Erro do banco em UMA linha legível (em vez de imprimir o objeto de conexão inteiro nos logs do Render).
 * Diz o código, a mensagem do Postgres e o que costuma resolver.
 */
type PgLike = { code?: string; message?: string; detail?: string; hint?: string; cause?: unknown; query?: string; errno?: string; address?: string; hostname?: string };

const TIPS: Record<string, string> = {
  ECONNREFUSED: 'o banco recusou a conexão. Confira se o Postgres está ativo no Render (banco grátis expira em 30 dias) e se DATABASE_URL é a "Internal Database URL".',
  ENOTFOUND: 'o endereço do banco não existe. O banco pode ter sido apagado (plano grátis expira em 30 dias) ou DATABASE_URL está errada.',
  ETIMEDOUT: 'o banco não respondeu a tempo. Confira se API e banco estão na mesma região do Render e se DATABASE_URL é a "Internal Database URL".',
  ECONNRESET: 'a conexão com o banco caiu no meio. Tente o deploy de novo; se repetir, veja se o banco está reiniciando.',
  '28P01': 'usuário ou senha do banco errados. Copie de novo a "Internal Database URL" do Postgres para DATABASE_URL.',
  '28000': 'o banco recusou o acesso deste usuário. Copie de novo a "Internal Database URL" do Postgres para DATABASE_URL.',
  '3D000': 'o banco de dados informado em DATABASE_URL não existe. Copie de novo a "Internal Database URL".',
  '53300': 'o banco está com conexões demais. Reinicie o Postgres no Render ou aguarde alguns minutos.',
  '53100': 'o DISCO DO BANCO ESTÁ CHEIO. No Render, abra o Postgres e aumente o armazenamento (ou apague anexos grandes).',
  '53200': 'o banco ficou sem memória. Suba o plano do Postgres no Render.',
  '57P01': 'o banco foi reiniciado durante o deploy. Tente o deploy de novo.',
  '57P03': 'o banco ainda está iniciando. Aguarde um minuto e faça o deploy de novo.',
  '42P07': 'uma tabela que a migration cria já existe. Me mande esta linha para ajustar a migration.',
  '42701': 'uma coluna que a migration cria já existe. Me mande esta linha para ajustar a migration.',
  '42P01': 'falta uma tabela que a migration esperava. Me mande esta linha para ajustar.',
  '23505': 'há dados duplicados que impedem a mudança. Me mande esta linha para ajustar.',
};

export function explainDbError(err: unknown): string {
  // drizzle embrulha o erro do pg em "cause"
  const chain: PgLike[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) { chain.push(cur as PgLike); cur = (cur as PgLike).cause; }
  const pg = chain.find((e) => e.code) ?? chain[0] ?? {};
  const code = String(pg.code ?? pg.errno ?? '');
  const msg = String(pg.message ?? err ?? '').split('\n')[0].slice(0, 300);
  const tip = TIPS[code] ?? (/ssl|certificate/i.test(msg) ? 'problema de SSL na conexão. Use a "Internal Database URL" do Render em DATABASE_URL.' : '');
  const query = chain.map((e) => e.query).find(Boolean);
  return [
    `ERRO NO BANCO${code ? ` [${code}]` : ''}: ${msg}`,
    pg.detail ? `detalhe: ${String(pg.detail).slice(0, 300)}` : '',
    pg.hint ? `dica do Postgres: ${String(pg.hint).slice(0, 200)}` : '',
    query ? `comando: ${String(query).replace(/\s+/g, ' ').slice(0, 200)}` : '',
    tip ? `O QUE FAZER: ${tip}` : '',
  ].filter(Boolean).join('\n');
}
