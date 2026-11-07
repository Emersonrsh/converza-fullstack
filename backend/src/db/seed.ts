import bcrypt from 'bcryptjs';
import { db, pool, schema } from './index';

/** Popula dados de demonstração: usuário, conta, contatos, produtos e vendas. */
async function main() {
  const email = 'demo@converza.app';
  const passwordHash = await bcrypt.hash('converza123', 10);

  const [user] = await db.insert(schema.users)
    .values({ name: 'Demo Converza', email, passwordHash })
    .onConflictDoNothing().returning();
  if (!user) {
    console.log('Seed já aplicado (usuário demo existe). Abortando.');
    await pool.end();
    return;
  }

  const [account] = await db.insert(schema.accounts)
    .values({ name: 'Loja Demo', slug: `loja-demo-${Math.random().toString(36).slice(2, 6)}`, subscriptionStatus: 'active' })
    .returning();
  await db.insert(schema.memberships).values({ userId: user.id, accountId: account.id, role: 'owner' });
  const periodEnd = new Date(); periodEnd.setMonth(periodEnd.getMonth() + 1);
  await db.insert(schema.subscriptions).values({
    accountId: account.id, status: 'active', instances: 3, startedAt: new Date(),
    // demonstração: vale até o fim do período e não renova (não há cobrança de verdade por trás)
    cancelAtPeriodEnd: true, aiTokensBalance: 10000, currentPeriodEnd: periodEnd,
  });

  const [product] = await db.insert(schema.products)
    .values({ accountId: account.id, name: 'Plano Completo', price: '497.00' }).returning();

  const names = ['Marina Alves', 'Rafael Souza', 'Juliana Prado', 'Carlos Mendes', 'Beatriz Lima'];
  const stages = ['negotiating', 'new', 'in_service', 'negotiating', 'new'] as const;
  const contactsInserted = [];
  for (let i = 0; i < names.length; i++) {
    const [c] = await db.insert(schema.contacts).values({
      accountId: account.id, name: names[i], phone: `+5511999${String(100000 + i)}`,
      stage: stages[i], tags: ['Instagram'], value: (i * 200).toFixed(2), lastContactAt: new Date(),
    }).returning();
    contactsInserted.push(c);
  }

  // Algumas vendas no dia de hoje para o dashboard mostrar números
  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setHours(10 + i * 2, 15, 0, 0);
    await db.insert(schema.sales).values({
      accountId: account.id, contactId: contactsInserted[i].id, productId: product.id,
      amount: '497.00', status: 'approved', createdAt: d,
    });
  }

  console.log('Seed aplicado.');
  console.log('Login:', email, '/ senha: converza123');
  console.log('accountId (x-account-id):', account.id);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
