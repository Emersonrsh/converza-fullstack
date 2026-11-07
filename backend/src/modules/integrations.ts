/** Integrações: um painel com o estado de tudo que a conta conecta (e o que o servidor oferece). */
import { Router } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { asyncHandler } from '../utils/http';
import { config } from '../config';
import { emailConfigured } from '../email/mailer';
import { aiEnabled } from '../ai/provider';
import { voiceEnabled } from '../ai/voice';

export const integrationsRouter = Router();

const one = async <T = Record<string, any>>(q: SQL) => ((await db.execute(q)).rows[0] ?? {}) as T;

type State = 'ok' | 'warn' | 'off';

integrationsRouter.get('/', asyncHandler(async (req, res) => {
  const a = req.accountId!;
  const since30 = new Date(Date.now() - 30 * 86_400_000);
  const since1 = new Date(Date.now() - 86_400_000);

  const wa = await one<{ total: number; connected: number; issues: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where status = 'connected')::int as connected,
           count(*) filter (where status <> 'connected' or quality_rating = 'RED' or phone_status in ('FLAGGED', 'RESTRICTED'))::int as issues
      from connections where account_id = ${a}`);
  const fb = await one<{ profiles: number; broken: number; ads: number; synced: Date | null }>(sql`
    select (select count(*)::int from meta_profiles where account_id = ${a}) as profiles,
           (select count(*)::int from meta_profiles where account_id = ${a} and status <> 'connected') as broken,
           (select count(*)::int from meta_ad_accounts where account_id = ${a} and selected) as ads,
           (select max(last_sync_at) from meta_ad_accounts where account_id = ${a} and selected) as synced`);
  const px = await one<{ total: number; active: number; failing: number; last: Date | null }>(sql`
    select count(*)::int as total, count(*) filter (where status = 'active')::int as active,
           count(*) filter (where last_error is not null and status = 'active')::int as failing, max(last_event_at) as last
      from pixels where account_id = ${a}`);
  const wh = await one<{ total: number; enabled: number; last: Date | null; hits: number }>(sql`
    select count(*)::int as total, count(*) filter (where enabled)::int as enabled, max(last_event_at) as last, coalesce(sum(hits), 0)::int as hits
      from webhooks where account_id = ${a}`);
  const tr = await one<{ total: number; active: number; clicks: number; contacts: number }>(sql`
    select count(*)::int as total, count(*) filter (where active)::int as active,
           (select count(*)::int from tracking_clicks where account_id = ${a} and created_at >= ${since30}) as clicks,
           (select count(*)::int from contacts where account_id = ${a} and tracking_link_id is not null) as contacts
      from tracking_links where account_id = ${a}`);
  const mcp = await one<{ keys: number; calls: number; last: Date | null }>(sql`
    select (select count(*)::int from api_keys where account_id = ${a} and revoked_at is null) as keys,
           (select count(*)::int from mcp_calls where account_id = ${a} and created_at >= ${since1}) as calls,
           (select max(last_used_at) from api_keys where account_id = ${a} and revoked_at is null) as last`);

  const n = (v: unknown) => Number(v ?? 0);
  const state = (on: boolean, warn = false): State => (!on ? 'off' : warn ? 'warn' : 'ok');

  const items = [
    {
      id: 'whatsapp', name: 'WhatsApp (API oficial)', href: '/connections',
      description: 'Números conectados pela Cloud API da Meta: conversas, fluxos, agentes e disparos.',
      state: state(n(wa.total) > 0, n(wa.issues) > 0),
      detail: n(wa.total) ? `${n(wa.connected)} de ${n(wa.total)} número(s) conectado(s)${n(wa.issues) ? ` · ${n(wa.issues)} com alerta` : ''}` : 'Nenhum número conectado',
    },
    {
      id: 'facebook_ads', name: 'Facebook e Instagram Ads', href: '/meta',
      description: 'Gasto, cliques e leads dos anúncios, ligados às conversas e vendas.',
      state: state(n(fb.profiles) > 0, n(fb.broken) > 0),
      detail: n(fb.profiles) ? `${n(fb.profiles)} perfil(is) · ${n(fb.ads)} conta(s) de anúncio${fb.synced ? '' : ' · ainda sem sincronizar'}${n(fb.broken) ? ` · ${n(fb.broken)} perfil(is) precisam reconectar` : ''}` : 'Nenhum perfil conectado',
    },
    {
      id: 'pixels', name: 'Pixel e API de Conversões', href: '/meta/pixel',
      description: 'Manda leads e vendas do WhatsApp para a Meta otimizar as campanhas.',
      state: state(n(px.active) > 0, n(px.failing) > 0),
      detail: n(px.total) ? `${n(px.active)} ativo(s)${n(px.failing) ? ` · ${n(px.failing)} com erro no último envio` : ''}` : 'Nenhum pixel',
    },
    {
      id: 'webhooks', name: 'Webhooks de entrada', href: '/webhooks',
      description: 'Recebe vendas e eventos de outras plataformas (Hotmart, Kiwify, n8n, Zapier…) e dispara automações.',
      state: state(n(wh.total) > 0, n(wh.enabled) === 0),
      detail: n(wh.total) ? `${n(wh.enabled)} ativo(s) · ${n(wh.hits).toLocaleString('pt-BR')} evento(s) recebidos${n(wh.enabled) === 0 ? ' · todos desligados' : ''}` : 'Nenhum webhook',
      lastAt: wh.last ?? null,
    },
    {
      id: 'tracking', name: 'Links rastreáveis', href: '/settings/trackeamento',
      description: 'Links para o WhatsApp que marcam de onde veio cada contato.',
      state: state(n(tr.total) > 0, n(tr.active) === 0),
      detail: n(tr.total) ? `${n(tr.active)} ativo(s) · ${n(tr.clicks)} clique(s) em 30 dias · ${n(tr.contacts)} contato(s)${n(tr.active) === 0 ? ' · todos pausados' : ''}` : 'Nenhum link',
    },
    {
      id: 'mcp', name: 'Ferramentas MCP', href: '/settings/mcp',
      description: 'Deixe o Claude, ChatGPT, Cursor ou n8n consultarem e agirem na sua conta.',
      state: state(n(mcp.keys) > 0),
      detail: n(mcp.keys) ? `${n(mcp.keys)} chave(s) · ${n(mcp.calls)} chamada(s) em 24h` : 'Nenhuma chave',
      lastAt: mcp.last ?? null,
    },
  ];

  // recursos que dependem de quem hospeda a Converza (variáveis de ambiente do servidor)
  const server = [
    { id: 'ai', name: 'IA (agentes, blocos de IA, gerador e tradutor)', on: aiEnabled(), hint: 'OPENAI_API_KEY' },
    { id: 'voice', name: 'Voz (falar em áudio, transcrever, clonar voz)', on: voiceEnabled(), hint: 'ELEVENLABS_API_KEY' },
    { id: 'email', name: 'E-mails (convites, avisos de instância)', on: emailConfigured(), hint: 'SMTP_HOST e EMAIL_FROM' },
    { id: 'meta_app', name: 'App da Meta (login do Facebook, conectar números)', on: Boolean(config.whatsapp.appId && config.whatsapp.appSecret), hint: 'META_APP_ID e META_APP_SECRET' },
    { id: 'payments', name: 'Pagamento da assinatura (Asaas / Paddle)', on: Boolean(config.billing.asaas.apiKey || config.billing.paddle.apiKey), hint: 'ASAAS_API_KEY ou PADDLE_API_KEY' },
  ];

  res.json({ items, server, showServerHints: req.role !== 'agent' });
}));
