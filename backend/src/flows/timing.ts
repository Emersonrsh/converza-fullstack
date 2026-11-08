/** Esperas do Intervalo Inteligente por horário (puro, testável). */
import { localParts, type Schedule } from '../utils/hours';

/**
 * Janela da semana: dias (0 = domingo) e horário (de/até, HH:MM; "até" menor que "de" vira a noite)
 * — ou os horários de atendimento do número (até 3 intervalos por dia).
 */
export type WeekWindow = { days: number[]; from: string; to: string } | { schedule: Schedule };

const toMin = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return NaN;
  return Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2]));
};

/** Intervalos [início, fim) em minutos de cada dia da semana. */
function dayIntervals(w: WeekWindow): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [[], [], [], [], [], [], []];
  if ('schedule' in w) {
    for (let d = 0; d < 7; d++) {
      for (const i of w.schedule[d] ?? []) {
        const a = toMin(i.start); const b = i.end === '24:00' ? 1440 : toMin(i.end);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) out[d].push([a, b]);
      }
    }
  } else {
    const a = toMin(w.from); const b = toMin(w.to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return out;
    for (const raw of w.days) {
      const d = ((Number(raw) % 7) + 7) % 7;
      if (b > a) out[d].push([a, b]);
      else { // vira a noite: 22:00–06:00
        out[d].push([a, 1440]);
        if (b > 0) out[(d + 1) % 7].push([0, b]);
      }
    }
  }
  for (const l of out) l.sort((x, y) => x[0] - y[0]);
  return out;
}

/** Segundos até a próxima vez que a janela abre (0 = já está aberta). -1 = a janela nunca abre. */
export function secondsUntilWindow(w: WeekWindow, tz: string, now = new Date()): number {
  const ints = dayIntervals(w);
  if (!ints.some((l) => l.length)) return -1;
  const { day, minutes } = localParts(now, tz);
  const nowSec = minutes * 60 + now.getSeconds();
  for (let offset = 0; offset <= 7; offset++) {
    const d = (day + offset) % 7;
    for (const [a, b] of ints[d]) {
      if (offset === 0) {
        if (minutes >= a && minutes < b) return 0;
        if (minutes < a) return a * 60 - nowSec;
      } else {
        return (offset * 1440 + a) * 60 - nowSec;
      }
    }
  }
  return -1;
}
