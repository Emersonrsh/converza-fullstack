/**
 * Envio de e-mail por SMTP (qualquer provedor). Sem SMTP configurado nada é enviado e quem chama
 * recebe { sent: false } — os convites continuam valendo pelo link que o app mostra para copiar.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { LOGO_PNG_BASE64 } from './logoData';

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
    // a logo vai anexada e aparece no corpo pelo cid (não depende de o leitor liberar imagens externas)
    const attachments = m.html.includes(`cid:${LOGO_CID}`)
      ? [{ filename: 'converza.png', content: Buffer.from(LOGO_PNG_BASE64, 'base64'), cid: LOGO_CID, contentType: 'image/png', contentDisposition: 'inline' as const }]
      : [];
    await transporter().sendMail({ from: config.email.from, to: m.to, subject: m.subject, html: m.html, text: m.text, attachments });
    return { sent: true };
  } catch (err) {
    console.error('[e-mail] falhou:', (err as Error).message);
    return { sent: false, error: `O servidor de e-mail recusou o envio (${(err as Error).message}).` };
  }
}

/* ------------------------------------------------------------ modelos */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const LOGO_CID = 'converza-logo';

/**
 * Modelo dos e-mails do Converza, com o design system do app: cartão branco sobre o fundo claro,
 * faixa da marca (#142325) com a logo, Inter, verde-água #0e9488 no botão, bordas de 18 px e
 * todo o texto centralizado. Tabelas e estilos inline: é o que os leitores de e-mail aceitam.
 */
export function layout(title: string, paragraphs: string[], button?: { label: string; url: string }, footer?: string) {
  const font = "Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;font-family:${font};font-size:15px;line-height:1.6;color:#3b4a4f;text-align:center">${p}</p>`).join('');
  const btn = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:26px auto 10px"><tr><td align="center" bgcolor="#0e9488" style="border-radius:12px">
         <a href="${esc(button.url)}" style="display:inline-block;padding:14px 30px;font-family:${font};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px">${esc(button.label)}</a>
       </td></tr></table>
       <p style="margin:18px 0 0;font-family:${font};font-size:12px;line-height:1.5;color:#8a989d;text-align:center">Se o botão não abrir, copie este endereço no navegador:<br><a href="${esc(button.url)}" style="color:#0e9488;word-break:break-all;text-decoration:underline">${esc(button.url)}</a></p>`
    : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f7f8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7f8;padding:32px 14px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e8ea;border-radius:18px;overflow:hidden">
  <tr><td align="center" bgcolor="#142325" style="background:#142325;padding:26px 24px 22px">
    <img src="cid:${LOGO_CID}" width="52" height="47" alt="Converza" style="display:block;margin:0 auto 10px;border:0;outline:none">
    <div style="font-family:${font};font-size:19px;font-weight:800;letter-spacing:-0.02em;color:#ffffff">Converza</div>
    <div style="font-family:${font};font-size:12px;color:#9bb0ad;margin-top:3px">Vendas no WhatsApp, no automático</div>
  </td></tr>
  <tr><td align="center" style="padding:32px 34px 30px">
    <h1 style="margin:0 0 16px;font-family:${font};font-size:22px;line-height:1.3;font-weight:800;letter-spacing:-0.02em;color:#0d1b1e;text-align:center">${esc(title)}</h1>
    ${body}${btn}
  </td></tr>
  <tr><td style="padding:0 34px"><div style="height:1px;background:#e3e8ea;line-height:1px;font-size:1px">&nbsp;</div></td></tr>
  <tr><td align="center" style="padding:18px 34px 24px">
    <p style="margin:0;font-family:${font};font-size:12px;line-height:1.5;color:#8a989d;text-align:center">${esc(footer ?? 'Você recebeu este e-mail porque alguém usou o seu endereço no Converza.')}</p>
  </td></tr>
</table>
<p style="margin:16px 0 0;font-family:${font};font-size:11px;color:#a3b0b4;text-align:center">© ${new Date().getFullYear()} Converza</p>
</td></tr></table></body></html>`;
}

export const plainText = (title: string, paragraphs: string[], button?: { label: string; url: string }) =>
  [title, '', ...paragraphs.map((p) => p.replace(/<[^>]+>/g, '')), ...(button ? ['', `${button.label}: ${button.url}`] : [])].join('\n');

export { esc as escapeHtml };
