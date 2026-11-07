/** Fila do setor: quem vê o quê em "Aguardando" (puro, testável). */
import { sql, type SQL } from 'drizzle-orm';

/**
 * Dono e administradores veem tudo. Atendente vê, na fila (sem responsável), só as conversas do próprio setor
 * e as que não têm setor; as que já têm alguém atendendo e as resolvidas aparecem normalmente.
 */
export function queueVisibility(v: { manager: boolean; departmentId: string | null }): SQL {
  if (v.manager) return sql`true`;
  return v.departmentId
    ? sql`(v.assigned_user_id is not null or v.status = 'resolved' or v.department_id is null or v.department_id = ${v.departmentId})`
    : sql`(v.assigned_user_id is not null or v.status = 'resolved' or v.department_id is null)`;
}
