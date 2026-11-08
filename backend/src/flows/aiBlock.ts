/**
 * Bloco de IA do fluxo: provedor (créditos do Converza ou chave própria), entende áudio/imagem/PDF,
 * identifica comprovante de pagamento e escolhe uma "condicional inteligente".
 * Sem banco/rede: tudo passa pelo FlowExecutor (funciona igual no simulador).
 */
import type { Dict } from './types';
import type { AiPart, AiProvider, FlowExecutor, RunState } from './interpreter';
import type { ChatPart } from '../ai/provider';
import { render, sanitizeVar } from './interpreter';
import { parseMoney } from './pix';

export interface AiBlockResult { handle: string | null; reply: string; error?: string }

/** Partes do pedido no formato do chat OpenAI-compatível (texto, imagem, PDF, áudio). */
export function toChatParts(parts: AiPart[]): string | ChatPart[] {
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts.map((p): ChatPart => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    if (p.type === 'image') return { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } };
    if (p.type === 'file') return { type: 'file', file: { filename: p.filename, file_data: `data:${p.mime};base64,${p.data}` } };
    return { type: 'input_audio', input_audio: { data: p.data, format: p.format } };
  });
}

export const RECEIPT_SYSTEM = `Você analisa um arquivo (foto ou PDF) que um cliente mandou no WhatsApp e diz se é um COMPROVANTE DE PAGAMENTO (Pix, TED/DOC, transferência, boleto pago ou cartão aprovado).
Responda SOMENTE com JSON, sem texto em volta, neste formato:
{"comprovante": true, "valor": 49.9, "moeda": "BRL", "nome_pagador": "...", "nome_recebedor": "...", "data": "AAAA-MM-DD HH:MM", "banco": "...", "id_transacao": "..."}
Use null no que não aparecer. Se não for um comprovante (foto de produto, print de conversa, documento qualquer), responda {"comprovante": false}.`;

/** Primeiro objeto JSON dentro do texto (a IA às vezes escreve algo em volta). */
export function parseJsonLoose(text: string): Dict | null {
  const t = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const v = JSON.parse(t.slice(start, end + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

export function aiConditions(d: Dict): { id: string; label: string; description: string }[] {
  return (Array.isArray(d.conditions) ? d.conditions : [])
    .filter((c: Dict) => c?.id && String(c.label ?? '').trim())
    .slice(0, 10)
    .map((c: Dict) => ({ id: String(c.id), label: String(c.label).trim(), description: String(c.description ?? '').trim() }));
}

export function conditionsPrompt(conds: { label: string; description: string }[]): string {
  const list = conds.map((c, i) => `${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ''}`).join('\n');
  return `Além de responder, classifique a mensagem do cliente em UMA destas condições. A ordem é a prioridade: escolha a primeira que se aplicar.
${list}
Responda SOMENTE com JSON: {"resposta": "sua resposta para o cliente", "condicao": número da condição (0 se nenhuma se aplicar)}`;
}

const str = (v: unknown) => (v == null ? '' : String(v).trim());

export async function runAiBlock(d: Dict, state: RunState, exec: FlowExecutor, scope: Dict): Promise<AiBlockResult> {
  const provider: AiProvider = ['openai', 'gemini', 'openrouter'].includes(d.provider) ? d.provider : 'converza';
  const apiKey = provider === 'converza' ? undefined : render(d.apiKey, scope).trim();
  const model = str(d.model) || undefined;
  let transcript = '';

  const fail = (msg: string): AiBlockResult => {
    state.vars.ia = { resposta: '', erro: msg, transcricao: transcript, condicao: '' };
    exec.note(`⚠️ Bloco de IA: ${msg}`);
    return { handle: 'error', reply: '', error: msg };
  };

  try {
    if (provider !== 'converza' && !apiKey) return fail('informe a chave da API do provedor (ou uma variável global com ela).');
    if (provider !== 'converza' && !model) return fail('escolha o modelo do provedor.');

    let text = render(d.input ?? '{{resposta}}', scope).trim();
    const extra: AiPart[] = [];
    let mediaPart: AiPart | null = null;

    const wantsMedia = !!(d.audio || d.image || d.pdf || d.detectReceipt);
    const media = wantsMedia && state.mediaMsgId ? await exec.lastInboundMedia() : null;
    if (media) {
      if (media.kind === 'audio' && d.audio) {
        const r = await exec.aiAudio(provider, apiKey, media);
        if ('text' in r) {
          transcript = r.text.trim();
          text = [text, transcript].filter(Boolean).join('\n');
          exec.note(`🎧 Áudio transcrito: “${transcript.slice(0, 120)}”`);
        } else extra.push(r.part);
      }
      if ((media.kind === 'image' || media.kind === 'sticker') && (d.image || d.detectReceipt)) {
        mediaPart = { type: 'image', mime: media.mime || 'image/jpeg', data: media.data.toString('base64') };
      }
      if (media.kind === 'document' && /pdf/i.test(media.mime) && (d.pdf || d.detectReceipt)) {
        mediaPart = { type: 'file', mime: 'application/pdf', data: media.data.toString('base64'), filename: media.filename || 'documento.pdf' };
      }
    }

    // comprovante de pagamento: se for um, sai pela saída "Comprovante válido"
    if (d.detectReceipt && mediaPart) {
      const raw = await exec.aiComplete({
        provider, apiKey, model, system: RECEIPT_SYSTEM, history: 0, json: true, maxTokens: 350,
        user: [{ type: 'text', text: 'Analise o arquivo enviado pelo cliente.' }, mediaPart],
      });
      const j = parseJsonLoose(raw);
      const valor = parseMoney(j?.valor);
      if (j && j.comprovante === true && valor > 0) {
        const moeda = /^[A-Z]{3}$/.test(str(j.moeda).toUpperCase()) ? str(j.moeda).toUpperCase() : 'BRL';
        state.vars.comprovante = {
          valido: 'sim', valor: valor.toFixed(2), moeda, currency: moeda,
          nome_pagador: str(j.nome_pagador), nome_recebedor: str(j.nome_recebedor),
          data: str(j.data), banco: str(j.banco), id_transacao: str(j.id_transacao),
        };
        state.vars.ia = { resposta: '', erro: '', transcricao: transcript, condicao: '' };
        exec.note(`🧾 Comprovante identificado: ${moeda} ${valor.toFixed(2)}${j.nome_pagador ? ` de ${str(j.nome_pagador)}` : ''}`);
        return { handle: 'receipt', reply: '' };
      }
      state.vars.comprovante = { valido: 'nao' };
      exec.note('🧾 O arquivo não parece um comprovante de pagamento.');
    }

    if (mediaPart && ((mediaPart.type === 'image' && d.image) || (mediaPart.type === 'file' && d.pdf))) extra.push(mediaPart);
    if (!text && !extra.length) text = '(o cliente não mandou texto)';

    const conds = aiConditions(d);
    let system = str(d.prompt) || 'Você é um assistente útil. Sempre responda em português do Brasil. Seja claro e objetivo.';
    if (conds.length) system += `\n\n${conditionsPrompt(conds)}`;
    const history = d.keepContext ? Math.min(20, Math.max(1, Math.round(Number(d.contextSize ?? 5)) || 5)) : 0;

    const raw = await exec.aiComplete({
      provider, apiKey, model, system, history, json: conds.length > 0, maxTokens: 700,
      user: [...(text ? [{ type: 'text' as const, text }] : []), ...extra],
    });
    let reply = raw.trim();
    let chosen: { id: string; label: string } | undefined;
    if (conds.length) {
      const j = parseJsonLoose(raw);
      if (j) {
        reply = str(j.resposta);
        const n = parseInt(str(j.condicao) || '0', 10);
        if (n >= 1 && n <= conds.length) chosen = conds[n - 1];
      }
    }
    if (reply && d.send !== false) await exec.sendText(reply);
    state.vars.ia = { resposta: reply, erro: '', transcricao: transcript, condicao: chosen?.label ?? '' };
    const key = sanitizeVar(String(d.saveAs ?? '').replace(/^ia\./, 'ia_'));
    if (key && key !== 'ia') state.vars[key] = reply;
    exec.note(chosen ? `🤖 IA → condição “${chosen.label}”` : '🤖 IA respondeu');
    return { handle: chosen?.id ?? null, reply };
  } catch (err) {
    return fail((err as Error).message || 'a IA não respondeu.');
  }
}
