/** Horário de atendimento (puro, testável): semana com até 3 intervalos por dia, no fuso da empresa. */

export interface Interval { start: string; end: string }
/** "0" (domingo) … "6" (sábado) */
export type Schedule = Record<string, Interval[]>;

export const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Segunda a sexta, das 9h às 18h. */
export const DEFAULT_SCHEDULE: Schedule = {
  0: [], 1: [{ start: '09:00', end: '18:00' }], 2: [{ start: '09:00', end: '18:00' }], 3: [{ start: '09:00', end: '18:00' }],
  4: [{ start: '09:00', end: '18:00' }], 5: [{ start: '09:00', end: '18:00' }], 6: [],
};

/** Confere e organiza a semana. Lança Error com a mensagem para a tela. */
export function normalizeSchedule(raw: unknown): Schedule {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Schedule = {};
  for (let d = 0; d < 7; d++) {
    const list = Array.isArray(src[d]) ? (src[d] as unknown[]) : [];
    if (list.length > 3) throw new Error(`No máximo 3 intervalos por dia (${DAY_NAMES[d]}).`);
    const ints = list.map((it) => {
      const i = (it ?? {}) as Record<string, unknown>;
      const start = String(i.start ?? '');
      const end = String(i.end ?? '');
      if (!HHMM.test(start) || !(HHMM.test(end) || end === '24:00')) throw new Error(`Horário inválido em ${DAY_NAMES[d]}: use HH:MM.`);
      if (toMin(end === '24:00' ? '23:59' : end) <= toMin(start) && end !== '24:00') {
        throw new Error(`Em ${DAY_NAMES[d]}, o fim (${end}) precisa ser depois do começo (${start}). Para virar a noite, use dois dias.`);
      }
      return { start, end };
    }).sort((a, b) => a.start.localeCompare(b.start));
    for (let k = 1; k < ints.length; k++) {
      if (toMin(ints[k].start) < toMin(ints[k - 1].end === '24:00' ? '23:59' : ints[k - 1].end)) {
        throw new Error(`Os intervalos de ${DAY_NAMES[d]} se sobrepõem.`);
      }
    }
    out[d] = ints;
  }
  return out;
}

/** Dia da semana (0 = domingo) e minutos do dia no fuso. */
export function localParts(now: Date, tz: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day: day < 0 ? 0 : day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const endMin = (e: string) => (e === '24:00' ? 24 * 60 : toMin(e));

export function isOpen(schedule: Schedule, tz: string, now = new Date()): boolean {
  const { day, minutes } = localParts(now, tz);
  return (schedule[day] ?? []).some((i) => minutes >= toMin(i.start) && minutes < endMin(i.end));
}

/** Texto para a tela: "Aberto agora — até 18:00" / "Fechado agora — abre segunda às 09:00". */
export function describeNow(schedule: Schedule, tz: string, now = new Date()): { open: boolean; text: string } {
  const { day, minutes } = localParts(now, tz);
  const today = schedule[day] ?? [];
  const cur = today.find((i) => minutes >= toMin(i.start) && minutes < endMin(i.end));
  if (cur) return { open: true, text: `Aberto agora — até ${cur.end}` };
  for (let k = 0; k < 8; k++) {
    const d = (day + k) % 7;
    const next = (schedule[d] ?? []).find((i) => k > 0 || toMin(i.start) > minutes);
    if (next) {
      const when = k === 0 ? 'hoje' : k === 1 ? 'amanhã' : DAY_NAMES[d];
      return { open: false, text: `Fechado agora — abre ${when} às ${next.start}` };
    }
  }
  return { open: false, text: 'Fechado — nenhum horário de atendimento cadastrado' };
}

/** Fuso válido no Intl (America/Sao_Paulo, Europe/Lisbon…). */
export function validTimezone(tz: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date()); return true; } catch { return false; }
}

/** Variáveis de data e hora para os fluxos (no fuso da empresa). */
export function timeVars(tz: string, now = new Date()): Record<string, string> {
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('pt-BR', { timeZone: tz, ...o }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now));
  return {
    hora: f({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    data: f({ day: '2-digit', month: '2-digit' }),
    data_completa: f({ day: '2-digit', month: '2-digit', year: 'numeric' }),
    dia: f({ weekday: 'long' }),
    saudacao: hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite',
  };
}
