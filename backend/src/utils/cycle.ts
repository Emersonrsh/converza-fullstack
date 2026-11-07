/** Ciclos da assinatura (puro, testável). */

/** Soma meses sem estourar o dia (31/01 + 1 mês = 28 ou 29/02). */
export function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + n);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/** Ciclo atual: do mês anterior ao vencimento da assinatura até ele; sem vencimento, o mês do calendário. */
export function cycleOf(periodEnd: Date | null | undefined, now = new Date()): { start: Date; end: Date; key: string } {
  let start: Date; let end: Date;
  if (periodEnd) {
    end = new Date(periodEnd.getTime());
    // assinatura que passou do vencimento sem renovar: segue em ciclos mensais a partir dele
    let guard = 0;
    while (end.getTime() <= now.getTime() && guard++ < 240) end = addMonths(end, 1);
    start = addMonths(end, -1);
    guard = 0;
    while (start.getTime() > now.getTime() && guard++ < 240) { end = start; start = addMonths(end, -1); }
  } else {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
  return { start, end, key: start.toISOString().slice(0, 10) };
}
