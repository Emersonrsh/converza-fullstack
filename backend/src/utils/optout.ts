/**
 * Pedido para sair (ou voltar) dos disparos em massa, pela resposta do cliente.
 * Só vale a mensagem inteira (“SAIR”, “Parar promoções”…), para não pegar frases como “vou sair às 18h”.
 */
const OUT = ['sair', 'parar', 'pare', 'stop', 'cancelar', 'descadastrar', 'remover', 'nao quero mais', 'nao quero receber',
  'parar promocoes', 'nao quero receber mensagens', 'unsubscribe', 'cancelar inscricao', 'me tira da lista', 'sai'];
const IN = ['voltar', 'quero receber', 'start', 'reativar', 'quero voltar a receber'];

export function optKeyword(text: unknown): 'out' | 'in' | null {
  const t = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return null;
  if (OUT.includes(t)) return 'out';
  if (IN.includes(t)) return 'in';
  return null;
}
