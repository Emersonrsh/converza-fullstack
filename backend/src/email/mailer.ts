/**
 * Envio de e-mail por SMTP (qualquer provedor). Sem SMTP configurado nada é enviado e quem chama
 * recebe { sent: false } — os convites continuam valendo pelo link que o app mostra para copiar.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';

let transport: Transporter | null = null;

export const emailConfigured = () => Boolean(config.email.host && config.email.from);

function transporter() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: config.email.user ? { user: config.email.user, pass: config.email.pass } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transport;
}

export interface MailResult { sent: boolean; error?: string }

export async function sendMail(m: { to: string; subject: string; html: string; text: string }): Promise<MailResult> {
  if (!emailConfigured()) return { sent: false, error: 'O envio de e-mail não está configurado no servidor (SMTP_HOST e EMAIL_FROM).' };
  try {
    await transporter().sendMail({ from: config.email.from, to: m.to, subject: m.subject, html: m.html, text: m.text });
    return { sent: true };
  } catch (err) {
    console.error('[e-mail] falhou:', (err as Error).message);
    return { sent: false, error: `O servidor de e-mail recusou o envio (${(err as Error).message}).` };
  }
}

/* ------------------------------------------------------------ modelos */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Layout simples (tabela + estilos inline: é o que os leitores de e-mail aceitam). */
export function layout(title: string, paragraphs: string[], button?: { label: string; url: string }, footer?: string) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1f2d31">${p}</p>`).join('');
  const btn = button
    ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="background:#0e9488;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">${esc(button.label)}</a></p>
       <p style="margin:0 0 14px;font-size:12px;color:#5f7076">Se o botão não abrir, copie este endereço: <br><span style="word-break:break-all">${esc(button.url)}</span></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f5f7f8;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7f8;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;padding:28px">
<tr><td><div style="font-size:20px;font-weight:800;color:#0e9488;margin-bottom:18px">Converza</div>
<h1 style="font-size:19px;margin:0 0 16px;color:#0d1b1e">${esc(title)}</h1>${body}${btn}
<p style="margin:22px 0 0;font-size:12px;color:#8a989d">${esc(footer ?? 'Você recebeu este e-mail porque alguém usou o seu endereço no Converza.')}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export const plainText = (title: string, paragraphs: string[], button?: { label: string; url: string }) =>
  [title, '', ...paragraphs.map((p) => p.replace(/<[^>]+>/g, '')), ...(button ? ['', `${button.label}: ${button.url}`] : [])].join('\n');

export { esc as escapeHtml };
