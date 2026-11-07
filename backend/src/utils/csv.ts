/**
 * CSV no padrão do Excel em português (separador ";" e BOM para os acentos) e
 * leitura tolerante: detecta ";", "," ou tab, aspas, quebras de linha dentro de aspas.
 */

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[;"\r\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (header: string[], data: unknown[][]) =>
  '﻿' + [header, ...data].map((r) => r.map(cell).join(';')).join('\r\n');

function detectDelimiter(text: string): string {
  // olha a primeira linha fora de aspas
  let inQ = false; const count: Record<string, number> = { ';': 0, ',': 0, '\t': 0 };
  for (const ch of text) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === '\n' || ch === '\r')) break;
    else if (!inQ && ch in count) count[ch] += 1;
  }
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ';';
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const d = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQ = true; continue; }
    if (ch === d) { row.push(field); field = ''; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** "E-mail" → "email", "Etapa do funil" → "etapadofunil", "Anotações" → "anotacoes". */
export const normHeader = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** "1.234,56" | "1234.56" | "2.500" (milhar) | "R$ 97,90" → número (NaN se inválido). */
export function parseMoney(raw: string): number {
  const t = raw.trim().replace(/[R$\s]/g, '');
  if (!t) return NaN;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.')
    : /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') : t;
  const n = Number(norm);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}
