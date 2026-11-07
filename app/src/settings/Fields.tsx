import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../icons';
import { FieldsManager } from '../contacts/CustomFields';
import { Head, Tabs, copyText } from './common';

/** Variáveis que o sistema preenche sozinho nos fluxos (as mesmas do interpretador). */
const SYSTEM: { group: string; items: [string, string, string][] }[] = [
  {
    group: 'Contato',
    items: [
      ['nome', 'Nome completo do contato (como está no cadastro ou no perfil do WhatsApp)', 'Maria Souza'],
      ['primeiro_nome', 'Só o primeiro nome', 'Maria'],
      ['telefone', 'Telefone com DDI e DDD', '5511988887777'],
      ['email', 'E-mail do cadastro (vazio se não tiver)', 'maria@email.com'],
      ['etapa', 'Etapa do funil', 'Em atendimento'],
      ['campos.<chave>', 'Um campo personalizado (aba Customizados)', '{{campos.cpf}}'],
    ],
  },
  {
    group: 'Conversa',
    items: [
      ['resposta', 'Última mensagem que o cliente mandou', 'quero saber o preço'],
      ['opcao', 'Opção escolhida no último Menu', 'Agendar'],
      ['categoria', 'Categoria escolhida pelo bloco Classificar com IA', 'orçamento'],
      ['ia', 'Texto gerado pelo bloco Resposta com IA (ou o nome que você escolher)', '…'],
      ['link_pagamento', 'Link do produto do bloco Pagamento', 'https://…'],
    ],
  },
  {
    group: 'Data e hora (no fuso da empresa)',
    items: [
      ['hora', 'Hora agora', '14:32'],
      ['data', 'Data de hoje (dia e mês)', '07/11'],
      ['data_completa', 'Data de hoje com o ano', '07/11/2026'],
      ['dia', 'Dia da semana', 'sábado'],
      ['saudacao', 'Bom dia / Boa tarde / Boa noite', 'Boa tarde'],
    ],
  },
  {
    group: 'Da empresa',
    items: [['g_<nome>', 'Uma variável global (Configurações › Variáveis Globais)', '{{g_cupom}}']],
  },
];

function SystemVars() {
  return (
    <div data-testid="system-vars">
      <div className="hint" style={{ marginBottom: 14 }}><Icon name="info" size={14} />Estas variáveis já vêm prontas: use nos textos dos fluxos, das respostas rápidas e dos agentes escrevendo entre chaves duplas, como <code>{'{{primeiro_nome}}'}</code>. Se a informação não existir, sai vazio.</div>
      {SYSTEM.map((g) => (
        <section className="st-card" key={g.group} style={{ padding: 0 }}>
          <div className="st-card-h" style={{ padding: '14px 16px 0' }}><b>{g.group}</b></div>
          <table>
            <thead><tr><th>Variável</th><th>O que é</th><th>Exemplo</th></tr></thead>
            <tbody>
              {g.items.map(([k, d, ex]) => (
                <tr key={k} data-testid="system-var">
                  <td><button type="button" className="linkbtn mono" onClick={() => void copyText(`{{${k}}}`)}>{`{{${k}}}`}</button></td>
                  <td className="muted">{d}</td>
                  <td className="faint">{ex}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <div className="st-help">Variáveis que você salva no fluxo (bloco Pergunta, Requisição HTTP…) também ficam disponíveis com o nome que você escolher. Para valores da empresa toda, use as <Link to="/settings/variaveis">Variáveis Globais</Link>.</div>
    </div>
  );
}

export function FieldsPage() {
  const [tab, setTab] = useState<'custom' | 'system'>('custom');
  return (
    <div data-testid="fields-page">
      <Head slug="campos" />
      <Tabs value={tab} onChange={setTab} tabs={[['custom', 'Customizados', 'list'], ['system', 'Sistema (BOT)', 'bot']]} />
      {tab === 'custom' ? <section className="st-card"><FieldsManager /></section> : <SystemVars />}
    </div>
  );
}
