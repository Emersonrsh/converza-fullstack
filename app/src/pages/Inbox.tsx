import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API_BASE, ApiError, api, getAccountId, getToken } from '../api';
import { getSocket } from '../socket';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner, cx, toast } from '../components/ui';
import { ChatList } from '../chats/ChatList';
import { ChatView, type UploadOpts } from '../chats/ChatView';
import { ContactPanel } from '../chats/ContactPanel';
import { NewChatModal, QuickRepliesModal, TemplateModal, TransferModal, type ContactLite } from '../chats/modals';
import { mergeStatus, upsertMessage } from '../chats/util';
import type {
  AccountTag, ChatConnection, ChatContact, ChatCounts, ChatDepartment, ChatDetail, ChatFilters, ChatItem, ChatMessage, ChatTab, QuickReply, TeamMember, TemplatePayload,
} from '../chats/types';

const EMPTY: ChatFilters = { q: '', chip: 'all', connectionId: '', tag: '', stage: '', assignee: '', from: '', to: '', department: '' };
const LS_TAB = 'converza:chatTab';
const LS_PANEL = 'converza:chatPanel';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* modo privado */ } };

interface ListResp { conversations: ChatItem[]; counts: ChatCounts; nextBefore: string | null }
interface MsgResp { messages: ChatMessage[]; hasMore: boolean }
type Conv = ChatDetail['conversation'];

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4', pdf: 'application/pdf', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', txt: 'text/plain', csv: 'text/csv', doc: 'application/msword', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
};
const mimeOf = (f: File) => f.type || MIME_BY_EXT[f.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';
const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function Inbox() {
  const { user, accounts, accountId } = useAuth();
  const meId = user?.id ?? '';
  const accountName = accounts.find((a) => a.id === accountId)?.name ?? 'Converza';
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('c');
  const select = useCallback((id: string | null) => {
    setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('c', id); else n.delete('c'); return n; }, { replace: true });
  }, [setParams]);

  /* ------------------------------------------------------------ lista */
  const [tab, setTabState] = useState<ChatTab>(() => { const t = lsGet(LS_TAB); return t === 'attending' || t === 'resolved' ? t : 'waiting'; });
  const [filters, setFilters] = useState<ChatFilters>(EMPTY);
  const [items, setItems] = useState<ChatItem[] | null>(null);
  const [counts, setCounts] = useState<ChatCounts | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const listSeq = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const tabRef = useRef(tab);
  tabRef.current = tab;
  const changeTab = useCallback((t: ChatTab) => {
    if (tabRef.current !== t) { tabRef.current = t; setItems(null); setTabState(t); }
    lsSet(LS_TAB, t);
  }, []);

  const queryString = useCallback((extra: Record<string, string> = {}) => {
    const qs = new URLSearchParams({ tab, chip: filters.chip, ...extra });
    (['q', 'connectionId', 'tag', 'stage', 'assignee', 'from', 'to', 'department'] as const).forEach((k) => { if (filters[k]) qs.set(k, filters[k]); });
    return qs.toString();
  }, [tab, filters]);

  /** Recarrega a primeira página (mantendo quantas conversas já estavam carregadas). */
  const loadList = useCallback(async (reset: boolean) => {
    const seq = ++listSeq.current;
    const limit = reset ? 40 : Math.min(100, Math.max(40, itemsRef.current?.length ?? 0));
    try {
      const r = await api.get<ListResp>(`/conversations?${queryString({ limit: String(limit) })}`);
      if (seq !== listSeq.current) return;
      setItems(r.conversations); setCounts(r.counts); setNextBefore(r.nextBefore);
    } catch (e) {
      if (seq !== listSeq.current) return;
      setItems((p) => p ?? []);
      toast(errMsg(e, 'Não foi possível carregar os chats'));
    }
  }, [queryString]);

  useEffect(() => { void loadList(true); }, [loadList, accountId]);

  const loadListRef = useRef(loadList);
  loadListRef.current = loadList;
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Agrupa eventos em tempo real: no máximo uma recarga da lista a cada 700 ms. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; void loadListRef.current(false); }, 700);
  }, []);
  useEffect(() => {
    const t = setInterval(scheduleRefresh, 60_000); // horários relativos ("Ontem") e eventos perdidos
    return () => { clearInterval(t); if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [scheduleRefresh]);

  async function loadMore() {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    const seq = listSeq.current;
    try {
      const r = await api.get<ListResp>(`/conversations?${queryString({ before: nextBefore })}`);
      if (seq !== listSeq.current) return;
      setItems((prev) => [...(prev ?? []), ...r.conversations.filter((x) => !(prev ?? []).some((p) => p.id === x.id))]);
      setNextBefore(r.nextBefore); setCounts(r.counts);
    } catch (e) { toast(errMsg(e, 'Não foi possível carregar mais')); }
    setLoadingMore(false);
  }

  /* --------------------------------------------------------- auxiliares */
  const [connections, setConnections] = useState<ChatConnection[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [tags, setTags] = useState<AccountTag[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [departments, setDepartments] = useState<ChatDepartment[]>([]);
  const membersRef = useRef(members);
  membersRef.current = members;
  useEffect(() => {
    api.get<{ connections: ChatConnection[] }>('/connections').then((r) => setConnections(r.connections)).catch(() => setConnections([]));
    api.get<{ members: TeamMember[] }>('/team').then((r) => setMembers(r.members)).catch(() => setMembers([]));
    api.get<{ tags: AccountTag[] }>('/settings/tags').then((r) => setTags(r.tags)).catch(() => setTags([]));
    api.get<{ quickReplies: QuickReply[] }>('/quick-replies').then((r) => setQuickReplies(r.quickReplies)).catch(() => setQuickReplies([]));
    api.get<{ departments: ChatDepartment[] }>('/departments').then((r) => setDepartments(r.departments)).catch(() => setDepartments([]));
  }, [accountId]);

  // trocou de conta: fecha a conversa aberta (ela é da outra conta)
  const firstAccount = useRef(accountId);
  useEffect(() => {
    if (firstAccount.current !== accountId) { firstAccount.current = accountId; setItems(null); select(null); }
  }, [accountId, select]);

  /* ------------------------------------------------------------ detalhe */
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => lsGet(LS_PANEL) !== '0');
  const [panelKey, setPanelKey] = useState(0);
  const [modal, setModal] = useState<null | 'new' | 'transfer' | 'template' | 'quick'>(null);
  const detailSeq = useRef(0);
  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const pendingTemplate = useRef<string | null>(null);
  const [newInitial, setNewInitial] = useState<ContactLite | null>(null);

  // vindo de Contatos ("Iniciar conversa"): abre a nova conversa já com o contato escolhido
  const novo = params.get('novo');
  useEffect(() => {
    if (!novo) return;
    setParams((p) => { const n = new URLSearchParams(p); n.delete('novo'); return n; }, { replace: true });
    api.get<{ contact: { id: string; name: string; phone: string } }>(`/contacts/${novo}`)
      .then((r) => { setNewInitial({ id: r.contact.id, name: r.contact.name, phone: r.contact.phone }); setModal('new'); })
      .catch((e) => toast(errMsg(e, 'Contato não encontrado')));
  }, [novo, setParams]);

  const panelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpPanel = useCallback(() => {
    if (panelTimer.current) clearTimeout(panelTimer.current);
    panelTimer.current = setTimeout(() => setPanelKey((k) => k + 1), 800);
  }, []);

  const markRead = useCallback(async (id: string) => {
    setItems((list) => list?.map((x) => (x.id === id ? { ...x, unreadCount: 0 } : x)) ?? list);
    setDetail((d) => (d && d.conversation.id === id ? { ...d, conversation: { ...d.conversation, unreadCount: 0 } } : d));
    try { await api.post(`/conversations/${id}/read`); } catch { /* sem problema: tenta de novo na próxima */ }
  }, []);

  const loadDetail = useCallback(async (id: string, quiet = false) => {
    const seq = ++detailSeq.current;
    if (!quiet) { setDetail(null); setMessages([]); setHasMore(false); setDetailErr(null); }
    try {
      const [d, m] = await Promise.all([
        api.get<ChatDetail>(`/conversations/${id}`),
        api.get<MsgResp>(`/conversations/${id}/messages?limit=60`),
      ]);
      if (seq !== detailSeq.current) return;
      setDetail(d);
      if (quiet) setMessages((prev) => m.messages.reduce(upsertMessage, prev));
      else { setMessages(m.messages); setHasMore(m.hasMore); }
      if (d.conversation.unreadCount > 0 && document.visibilityState === 'visible') void markRead(id);
      if (pendingTemplate.current === id) {
        pendingTemplate.current = null;
        if (!d.windowOpen && d.connection) setModal('template');
      }
    } catch (e) {
      if (seq !== detailSeq.current || quiet) return;
      setDetailErr(e instanceof ApiError && e.status === 404 ? 'Esta conversa não existe mais ou é de outra conta.' : errMsg(e, 'Não foi possível abrir a conversa'));
    }
  }, [markRead]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else { detailSeq.current++; setDetail(null); setMessages([]); setDetailErr(null); }
  }, [selectedId, loadDetail]);

  // voltou para a aba do navegador: marca como lida a conversa aberta
  useEffect(() => {
    const h = () => {
      const d = detailRef.current;
      if (document.visibilityState === 'visible' && d && d.conversation.unreadCount > 0) void markRead(d.conversation.id);
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, [markRead]);

  /* --------------------------------------------------------- tempo real */
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onNew = (p: { conversationId: string; message: ChatMessage }) => {
      if (p.conversationId === selRef.current) {
        const msg = p.message.senderUserId && p.message.senderUserId === meId && !p.message.senderName && p.message.type !== 'note'
          ? { ...p.message, senderName: user?.name } : p.message;
        setMessages((list) => upsertMessage(list, msg));
        if (p.message.direction === 'in') {
          const at = p.message.createdAt;
          setDetail((d) => (d && d.conversation.id === p.conversationId ? {
            ...d, lastInboundAt: at, windowOpen: true, windowClosesAt: new Date(Date.parse(at) + 864e5).toISOString(),
            conversation: { ...d.conversation, unreadCount: d.conversation.unreadCount + 1 },
          } : d));
          if (document.visibilityState === 'visible') {
            if (readTimer.current) clearTimeout(readTimer.current);
            readTimer.current = setTimeout(() => void markRead(p.conversationId), 600);
          }
        }
        bumpPanel();
      }
      scheduleRefresh();
    };
    const onStatus = (p: { conversationId: string; id: string; status: string; error?: string | null }) => {
      if (p.conversationId === selRef.current) setMessages((list) => list.map((m) => (m.id === p.id ? mergeStatus(m, p.status, p.error ?? null) : m)));
      // tique da prévia na lista, sem recarregar tudo
      setItems((list) => list?.map((x) => (x.last && x.last.id === p.id ? { ...x, last: mergeStatus({ ...x.last, error: null }, p.status, p.error ?? null) } : x)) ?? list);
    };
    // áudio do cliente transcrito (agente de IA): mostra o texto embaixo do player
    const onTranscript = (p: { conversationId: string; id: string; transcript: string }) => {
      if (p.conversationId === selRef.current) setMessages((list) => list.map((m) => (m.id === p.id ? { ...m, transcript: p.transcript } : m)));
    };
    const onConv = (p: { conversation: Partial<Conv> & { id: string } }) => {
      const row = p.conversation;
      const d = detailRef.current;
      if (d && row.id === d.conversation.id) {
        const conversation: Conv = {
          ...d.conversation,
          ...(row.status !== undefined ? { status: row.status } : {}),
          ...(row.botPaused !== undefined ? { botPaused: row.botPaused } : {}),
          ...(row.assignedUserId !== undefined ? { assignedUserId: row.assignedUserId } : {}),
          ...(row.connectionId !== undefined ? { connectionId: row.connectionId } : {}),
          ...(row.unreadCount !== undefined ? { unreadCount: row.unreadCount } : {}),
          ...(row.departmentId !== undefined ? { departmentId: row.departmentId } : {}),
        };
        const who = conversation.assignedUserId;
        const known = !who || membersRef.current.some((m) => m.userId === who);
        setDetail((cur) => (cur && cur.conversation.id === row.id ? {
          ...cur, conversation,
          assignedName: who === cur.conversation.assignedUserId ? cur.assignedName : (membersRef.current.find((m) => m.userId === who)?.name ?? null),
        } : cur));
        if (!known || conversation.connectionId !== d.conversation.connectionId || (row.departmentId !== undefined && (row.departmentId ?? null) !== (d.department?.id ?? null))) void loadDetail(row.id, true);
        bumpPanel();
      }
      scheduleRefresh();
    };
    const onReconnect = () => { scheduleRefresh(); if (selRef.current) void loadDetail(selRef.current, true); };
    // histórico importado do WhatsApp Business do celular: várias conversas mudaram de uma vez
    const onBulk = (p: { conversationIds?: string[] }) => {
      scheduleRefresh();
      if (selRef.current && (p.conversationIds ?? []).includes(selRef.current)) void loadDetail(selRef.current, true);
    };
    const onSale = () => { if (selRef.current) bumpPanel(); };
    const onKanban = () => { if (selRef.current) bumpPanel(); };
    sock.on('message:new', onNew);
    sock.on('message:status', onStatus);
    sock.on('message:transcript', onTranscript);
    sock.on('conversation:updated', onConv);
    sock.on('conversations:changed', onBulk);
    sock.on('sale:changed', onSale);
    sock.on('kanban:changed', onKanban);
    sock.io.on('reconnect', onReconnect);
    return () => {
      sock.off('message:new', onNew); sock.off('message:status', onStatus); sock.off('message:transcript', onTranscript); sock.off('conversation:updated', onConv); sock.off('conversations:changed', onBulk); sock.off('sale:changed', onSale); sock.off('kanban:changed', onKanban);
      sock.io.off('reconnect', onReconnect);
    };
  }, [accountId, meId, user?.name, markRead, loadDetail, scheduleRefresh, bumpPanel]);

  /* -------------------------------------------------------------- ações */
  const convId = detail?.conversation.id ?? null;

  function applyConv(row: Conv) {
    setDetail((d) => (d && d.conversation.id === row.id ? {
      ...d, conversation: { ...d.conversation, ...row },
      assignedName: row.assignedUserId ? (row.assignedUserId === meId ? user?.name ?? null : members.find((m) => m.userId === row.assignedUserId)?.name ?? d.assignedName) : null,
    } : d));
    scheduleRefresh(); bumpPanel();
  }

  async function act(path: string, body: unknown, okMsg: string): Promise<boolean> {
    if (!convId) return false;
    try {
      const r = await api.post<{ conversation: Conv }>(`/conversations/${convId}/${path}`, body);
      applyConv(r.conversation);
      toast(okMsg);
      return true;
    } catch (e) { toast(errMsg(e, 'Não foi possível concluir')); return false; }
  }

  const accept = async () => { if (await act('accept', {}, 'Você está atendendo esta conversa')) changeTab('attending'); };
  const release = async () => { if (await act('release', {}, 'Conversa devolvida para a fila')) changeTab('waiting'); };
  const resolve = async () => { await act('resolve', {}, 'Conversa resolvida — ela está em “Resolvidos”'); };
  const reopen = async () => { if (await act('reopen', {}, 'Conversa reaberta com você')) changeTab('attending'); };
  async function transfer(userId: string) {
    const name = members.find((m) => m.userId === userId)?.name ?? 'a pessoa';
    if (await act('transfer', { userId }, `Conversa transferida para ${name}`)) setModal(null);
  }
  async function toDepartment(departmentId: string | null) {
    const name = departments.find((d) => d.id === departmentId)?.name;
    if (await act('department', { departmentId }, name ? `Conversa enviada para o setor ${name}` : 'Conversa enviada para a fila geral')) {
      setModal(null); changeTab('waiting');
      if (convId) void loadDetail(convId, true);
    }
  }

  /** Resposta rápida com anexos: o servidor manda tudo, na ordem. */
  async function sendQuick(q: QuickReply): Promise<boolean> {
    if (!convId) return false;
    const before = detailRef.current?.conversation;
    try {
      const r = await api.post<{ messages: ChatMessage[] }>(`/conversations/${convId}/quick-replies/${q.id}`);
      r.messages.forEach(addMine);
      const failed = r.messages.find((m) => m.status === 'failed');
      if (failed) toast(failed.error ?? 'Parte da resposta não foi enviada');
      afterReply(before);
      return !failed;
    } catch (e) {
      toast(errMsg(e, 'Não foi possível enviar a resposta rápida'));
      if (e instanceof ApiError && e.status === 422) void loadDetail(convId, true);
      return false;
    }
  }

  async function setAutomation(paused: boolean) {
    if (!convId) return;
    try {
      const r = await api.patch<{ conversation: Conv }>(`/conversations/${convId}/automation`, { paused });
      applyConv(r.conversation);
      toast(paused ? 'Automação pausada: só a equipe responde esta conversa' : 'Automação ligada: fluxos e IA podem responder');
    } catch (e) { toast(errMsg(e, 'Não foi possível alterar')); }
  }

  /** Quem responde assume a conversa: ela vai para "Atendendo". Recebe o estado de ANTES do envio
   *  (o evento em tempo real da atribuição pode chegar antes da resposta da API). */
  function afterReply(before: Conv | undefined) {
    if (before && (!before.assignedUserId || before.status === 'resolved')) changeTab('attending');
  }
  const addMine = (m: ChatMessage) => setMessages((l) => upsertMessage(l, m.type === 'note' || m.senderName ? m : { ...m, senderName: user?.name }));

  async function sendText(text: string, replyToId?: string | null): Promise<boolean> {
    if (!convId) return false;
    const before = detailRef.current?.conversation;
    try {
      const r = await api.post<{ message: ChatMessage }>(`/conversations/${convId}/messages`, { body: text, ...(replyToId ? { replyToId } : {}) });
      addMine(r.message);
      if (r.message.status === 'failed') toast(r.message.error ?? 'A mensagem não foi enviada');
      afterReply(before);
      return true;
    } catch (e) {
      toast(errMsg(e, 'Não foi possível enviar'));
      if (e instanceof ApiError && e.status === 422) void loadDetail(convId, true);
      return false;
    }
  }

  async function sendNote(text: string): Promise<boolean> {
    if (!convId) return false;
    try {
      const r = await api.post<{ message: ChatMessage }>(`/conversations/${convId}/notes`, { body: text });
      addMine(r.message);
      return true;
    } catch (e) { toast(errMsg(e, 'Não foi possível salvar a nota')); return false; }
  }

  async function upload(file: File, caption: string, opts: UploadOpts = {}): Promise<boolean> {
    if (!convId) return false;
    const mime = mimeOf(file);
    const limit = /^image\/(jpeg|png)$/i.test(mime) ? 5 : 16;
    if (file.size > limit * 1024 * 1024) { toast(`Arquivo grande demais: o limite é ${limit} MB${limit === 5 ? ' para imagens' : ''}`); return false; }
    const qs = new URLSearchParams({ filename: file.name });
    if (caption) qs.set('caption', caption);
    if (opts.voice) qs.set('voice', '1');
    if (opts.replyToId) qs.set('replyToId', opts.replyToId);
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'x-file-type': mime };
    const t = getToken(); const a = getAccountId();
    if (t) headers.Authorization = `Bearer ${t}`;
    if (a) headers['x-account-id'] = a;
    const before = detailRef.current?.conversation;
    try {
      const res = await fetch(`${API_BASE}/conversations/${convId}/media?${qs}`, { method: 'POST', headers, body: file });
      const data = await res.json().catch(() => ({})) as { message?: ChatMessage; error?: string };
      if (!res.ok || !data.message) throw new Error(data.error ?? `Erro ${res.status}`);
      addMine(data.message);
      if (data.message.status === 'failed') toast(data.message.error ?? 'O arquivo não foi enviado');
      afterReply(before);
      return true;
    } catch (e) {
      toast(errMsg(e, 'Não foi possível enviar o arquivo'));
      return false;
    }
  }

  async function sendTemplate(payload: TemplatePayload): Promise<boolean> {
    if (!convId) return false;
    const before = detailRef.current?.conversation;
    try {
      const r = await api.post<{ message: ChatMessage }>(`/conversations/${convId}/template`, payload);
      addMine(r.message);
      afterReply(before);
      if (r.message.status === 'failed') { toast(r.message.error ?? 'O modelo não foi enviado'); return false; }
      toast('Modelo enviado');
      return true;
    } catch (e) { toast(errMsg(e, 'Não foi possível enviar o modelo')); return false; }
  }

  async function loadOlder() {
    if (!convId || !messages.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const r = await api.get<MsgResp>(`/conversations/${convId}/messages?limit=60&before=${encodeURIComponent(messages[0].createdAt)}`);
      setMessages((l) => [...r.messages.filter((m) => !l.some((x) => x.id === m.id)), ...l]);
      setHasMore(r.hasMore);
    } catch (e) { toast(errMsg(e, 'Não foi possível carregar')); }
    setLoadingOlder(false);
  }

  function onContact(c: ChatContact) {
    setDetail((d) => (d && d.contact.id === c.id ? { ...d, contact: { ...d.contact, ...c } } : d));
    setItems((list) => list?.map((x) => (x.contactId === c.id ? { ...x, contactName: c.name, contactTags: c.tags, stage: c.stage } : x)) ?? list);
    scheduleRefresh(); // uma recarga que já estava a caminho pode trazer o nome antigo
  }

  const togglePanel = () => setPanelOpen((v) => { lsSet(LS_PANEL, v ? '0' : '1'); return !v; });

  return (
    <div className={cx('chats', collapsed && 'collapsed', !!detail && panelOpen && !detailErr && 'with-panel')} data-testid="chats">
      {!collapsed && (
        <ChatList
          accountName={accountName} tab={tab} onTab={changeTab} counts={counts}
          filters={filters} onFilters={(f) => setFilters((cur) => ({ ...cur, ...f }))}
          items={items} loading={loadingMore} hasMore={!!nextBefore} onLoadMore={loadMore}
          selectedId={selectedId} onSelect={(id) => select(id)} onNew={() => setModal('new')} onCollapse={() => setCollapsed(true)}
          connections={connections} tags={tags.map((t) => t.name)} members={members} departments={departments}
        />
      )}

      {!selectedId ? (
        <div className="cv-empty" data-testid="chat-empty">
          {collapsed && <button type="button" className="btn sm cv-expand" onClick={() => setCollapsed(false)}><Icon name="chevronRight" size={14} />Mostrar chats</button>}
          <div className="cv-empty-ic"><Icon name="chats" size={30} /></div>
          <b>Selecione um chat</b>
          <span>Escolha uma conversa na lista para começar a atender</span>
        </div>
      ) : detailErr ? (
        <div className="cv-empty">
          <div className="cv-empty-ic warn"><Icon name="alert" size={28} /></div>
          <b>Não foi possível abrir</b>
          <span>{detailErr}</span>
          <button type="button" className="btn sm" style={{ marginTop: 12 }} onClick={() => select(null)}>Voltar</button>
        </div>
      ) : !detail ? (
        <div className="cv-empty"><Spinner /></div>
      ) : (
        <ChatView
          detail={detail} messages={messages} hasMore={hasMore} loadingOlder={loadingOlder} onLoadOlder={loadOlder} meId={meId}
          quickReplies={quickReplies} panelOpen={panelOpen} onTogglePanel={togglePanel}
          onAccept={accept} onRelease={release} onResolve={resolve} onReopen={reopen} onTransfer={() => setModal('transfer')}
          onSend={sendText} onNote={sendNote} onUpload={upload} onTemplate={() => setModal('template')}
          onRetry={(m) => { if (m.body) void sendText(m.body); }} onManageQuick={() => setModal('quick')}
          listCollapsed={collapsed} onExpandList={() => setCollapsed(false)} onQuickSend={sendQuick}
        />
      )}

      {detail && panelOpen && !detailErr && (
        <ContactPanel
          detail={detail} tags={tags} refreshKey={panelKey}
          onContact={onContact} onAutomation={setAutomation} onTagCreated={(t) => setTags((l) => [...l, t])} onClose={togglePanel}
        />
      )}

      {modal === 'new' && (
        <NewChatModal connections={connections} initial={newInitial} onClose={() => { setModal(null); setNewInitial(null); }} onCreated={(id) => {
          setModal(null); setNewInitial(null);
          pendingTemplate.current = id;
          changeTab('attending');
          if (id === selectedId) void loadDetail(id, true); else select(id);
          scheduleRefresh();
        }} />
      )}
      {modal === 'transfer' && detail && (
        <TransferModal members={members} departments={departments} currentId={detail.conversation.assignedUserId} currentDept={detail.department?.id ?? null} meId={meId}
          onClose={() => setModal(null)} onConfirm={transfer} onDepartment={toDepartment} />
      )}
      {modal === 'template' && detail?.connection && (
        <TemplateModal connectionId={detail.connection.id} contactName={detail.contact.name} onClose={() => setModal(null)} onSend={sendTemplate} />
      )}
      {modal === 'quick' && <QuickRepliesModal onClose={() => setModal(null)} onChange={setQuickReplies} />}
    </div>
  );
}
