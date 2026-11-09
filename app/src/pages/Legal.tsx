import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Logo } from './Login';

/**
 * Termos de Uso, Política de Privacidade e Exclusão de dados (páginas públicas, sem login).
 * Os dados da empresa vêm do servidor (variáveis LEGAL_* no Render); o que faltar aparece marcado.
 * A Meta pede os links da Política de Privacidade e das instruções de exclusão de dados no app.
 */
export type LegalDoc = 'termos' | 'privacidade' | 'exclusao';

interface LegalInfo {
  version: string;
  company: { tradeName: string; companyName: string | null; cnpj: string | null; address: string | null; email: string | null; dpoName: string | null; dpoEmail: string | null; city: string | null };
  missing: string[];
  qrCode: boolean;
}

const TITLES: Record<LegalDoc, string> = { termos: 'Termos de Uso', privacidade: 'Política de Privacidade', exclusao: 'Exclusão de dados' };
const PATHS: Record<LegalDoc, string> = { termos: '/termos', privacidade: '/privacidade', exclusao: '/exclusao-de-dados' };
const MISSING_LABEL: Record<string, string> = { companyName: 'razão social (LEGAL_COMPANY_NAME)', cnpj: 'CNPJ (LEGAL_CNPJ)', address: 'endereço (LEGAL_ADDRESS)', email: 'e-mail de contato (LEGAL_EMAIL)', city: 'cidade do foro (LEGAL_CITY)' };

/** Valor da empresa ou um marcador visível de "falta preencher". */
function V({ v, ph }: { v: string | null | undefined; ph: string }) {
  return v ? <>{v}</> : <mark className="lg-missing">[{ph}]</mark>;
}

function H({ n, children }: { n: number; children: ReactNode }) {
  return <h2 id={`s${n}`}><span>{n}.</span> {children}</h2>;
}

export function LegalPage({ doc }: { doc: LegalDoc }) {
  const [info, setInfo] = useState<LegalInfo | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    api.get<LegalInfo>('/public/legal').then(setInfo).catch(() => setErr(true));
  }, []);
  useEffect(() => { document.title = `${TITLES[doc]} · ${info?.company.tradeName ?? 'Converza'}`; window.scrollTo(0, 0); }, [doc, info]);

  const c = info?.company;
  const brand = c?.tradeName ?? 'Converza';
  const version = info ? new Date(`${info.version}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
  const contactEmail = c?.dpoEmail ?? c?.email ?? null;

  return (
    <div className="lg-page" data-testid={`legal-${doc}`}>
      <header className="lg-top">
        <Link to="/" className="lg-brand"><Logo /><b>{brand}</b></Link>
        <nav>
          {(Object.keys(TITLES) as LegalDoc[]).map((d) => (
            <Link key={d} to={PATHS[d]} className={d === doc ? 'on' : ''} data-testid={`legal-tab-${d}`}>{TITLES[d]}</Link>
          ))}
        </nav>
      </header>
      <main className="lg-main">
        <h1>{TITLES[doc]}</h1>
        {info && <p className="lg-ver">Versão de {version}{c?.companyName ? ` · ${c.companyName}` : ''}</p>}
        {err && <p className="lg-ver">Não conseguimos carregar os dados da empresa agora. O texto abaixo vale do mesmo jeito; tente recarregar a página para ver os contatos.</p>}
        {info && info.missing.length > 0 && (
          <div className="lg-warn" data-testid="legal-missing">
            <b>Para o dono do sistema:</b> preencha no Render (converza-api › Environment) {info.missing.map((m) => MISSING_LABEL[m] ?? m).join(', ')}. Até lá, esses dados aparecem marcados no texto.
          </div>
        )}
        {doc === 'termos' && <Terms c={c} brand={brand} qrCode={info?.qrCode ?? true} contactEmail={contactEmail} />}
        {doc === 'privacidade' && <Privacy c={c} brand={brand} qrCode={info?.qrCode ?? true} contactEmail={contactEmail} />}
        {doc === 'exclusao' && <Deletion c={c} brand={brand} contactEmail={contactEmail} />}
        <footer className="lg-foot">
          <span>© {new Date().getFullYear()} {c?.companyName ?? brand}{c?.cnpj ? ` · CNPJ ${c.cnpj}` : ''}</span>
          <span>{(Object.keys(TITLES) as LegalDoc[]).map((d) => <Link key={d} to={PATHS[d]}>{TITLES[d]}</Link>)}</span>
        </footer>
      </main>
    </div>
  );
}

type Props = { c: LegalInfo['company'] | undefined; brand: string; contactEmail: string | null; qrCode?: boolean };

function Who({ c, brand }: Pick<Props, 'c' | 'brand'>) {
  return <><b>{brand}</b>, serviço operado por <V v={c?.companyName} ph="razão social" />, inscrita no CNPJ sob o nº <V v={c?.cnpj} ph="CNPJ" />, com sede em <V v={c?.address} ph="endereço" /></>;
}

/* ============================================================== Termos de Uso */

function Terms({ c, brand, qrCode, contactEmail }: Props) {
  return (
    <article className="lg-doc">
      <p>Estes Termos de Uso regulam o uso da plataforma <Who c={c} brand={brand} /> (“{brand}”, “nós”). Ao criar uma conta ou usar o {brand}, você declara que leu e concorda com estes Termos e com a <Link to="/privacidade">Política de Privacidade</Link>. Se estiver contratando em nome de uma empresa, você declara ter poderes para isso.</p>

      <H n={1}>O que é o {brand}</H>
      <p>O {brand} é um software online (SaaS) de atendimento, CRM, automação e vendas pelo WhatsApp: caixa de conversas da equipe, contatos, Kanban, fluxos automáticos, agentes de inteligência artificial, disparos em massa, integrações por webhook, pixels de conversão, relatórios e cobranças. Algumas funções dependem de serviços de terceiros (Meta/WhatsApp, provedores de IA, meios de pagamento), cujas regras também se aplicam.</p>

      <H n={2}>Conta e acesso</H>
      <ul>
        <li>Para usar, é preciso ter 18 anos ou mais e informar dados verdadeiros.</li>
        <li>Você é responsável por guardar a sua senha e por tudo o que for feito com o seu login e pelos membros que você convidar para a equipe.</li>
        <li>Avise-nos imediatamente se suspeitar de uso indevido da sua conta.</li>
        <li>O acesso de suporte do {brand} a uma empresa só acontece quando o dono ou um administrador libera, por tempo limitado, e pode ser revogado a qualquer momento.</li>
      </ul>

      <H n={3}>Planos, pagamento e cancelamento</H>
      <ul>
        <li>A assinatura é cobrada por instância (cada número de WhatsApp conectado), de forma recorrente, pelo meio de pagamento escolhido (Asaas ou Paddle). Tokens de IA e disparos extras podem ser comprados à parte. Os preços vigentes ficam na tela de Cobranças e assinaturas.</li>
        <li>Reajustes de preço são avisados com pelo menos 30 dias de antecedência e valem a partir da renovação seguinte.</li>
        <li>Você pode cancelar quando quiser em Cobranças e assinaturas: o acesso continua até o fim do período já pago, sem nova cobrança.</li>
        <li><b>Direito de arrependimento:</b> se você contratou como consumidor, pode desistir em até 7 dias da primeira contratação e receber o valor pago de volta (art. 49 do Código de Defesa do Consumidor). Fora desse prazo, não há devolução proporcional do período em curso, salvo quando a lei exigir.</li>
        <li>Sem pagamento, a conta fica inativa: os números param de enviar mensagens (o que os clientes mandam continua chegando) até a regularização.</li>
        <li>Na API oficial, a Meta cobra as mensagens diretamente da conta do WhatsApp Business do cliente (com o cartão cadastrado na Meta). Esses valores não fazem parte da assinatura do {brand}.</li>
      </ul>

      <H n={4}>Uso permitido e proibido</H>
      <p>Você se compromete a usar o {brand} de forma lícita e de acordo com as políticas do WhatsApp e da Meta. É proibido:</p>
      <ul>
        <li>enviar mensagens para quem não autorizou o contato, usar listas compradas ou obtidas sem consentimento, ou insistir com quem pediu para sair (o {brand} tira automaticamente dos disparos quem responde “SAIR”);</li>
        <li>praticar golpes, phishing, fraude, falsidade, assédio, discriminação ou discurso de ódio;</li>
        <li>vender ou divulgar produtos e serviços proibidos por lei ou pelas Políticas Comerciais do WhatsApp;</li>
        <li>coletar ou usar dados pessoais sem base legal, em desacordo com a Lei Geral de Proteção de Dados (LGPD);</li>
        <li>tentar invadir, sobrecarregar, copiar ou fazer engenharia reversa da plataforma, ou revender o acesso sem autorização.</li>
      </ul>
      <p>Podemos suspender ou encerrar contas que descumpram estas regras, com ou sem aviso prévio conforme a gravidade, para proteger os titulares de dados, a plataforma e os demais clientes.</p>

      <H n={5}>WhatsApp pela API oficial da Meta</H>
      <p>Nas conexões pela Cloud API (Conectar com a Meta, WhatsApp Business do celular ou conexão manual), o uso também está sujeito aos termos e políticas da Meta. A Meta pode, por decisão própria, limitar, restringir ou desativar números (por exemplo, por denúncias ou baixa qualidade), recusar modelos de mensagem e alterar preços e regras. O {brand} não controla essas decisões.</p>

      {qrCode && <>
        <H n={6}>Conexão por QR Code (API não oficial)</H>
        <div className="lg-box">
          <p>A conexão por QR Code liga o seu número ao {brand} como um “aparelho conectado”, pelo mesmo caminho técnico do WhatsApp Web. <b>Ela não é autorizada nem suportada pela Meta/WhatsApp e pode contrariar os Termos de Serviço do WhatsApp.</b> Ao usá-la, você declara que entende e aceita que:</p>
          <ul>
            <li>o WhatsApp pode restringir, banir ou desconectar o número a qualquer momento, sem aviso e sem possibilidade de recurso pelo {brand}, inclusive com perda do acesso ao número, aos contatos e ao histórico;</li>
            <li>o risco é maior em disparos para quem não conhece a sua empresa, em envios repetitivos e quando há denúncias ou bloqueios;</li>
            <li>o funcionamento pode parar ou mudar sem aviso se o WhatsApp alterar o protocolo, e o {brand} pode suspender ou encerrar essa função a qualquer tempo;</li>
            <li>os limites de segurança do {brand} (intervalo entre envios e limite diário) reduzem o risco, mas não o eliminam;</li>
            <li>a decisão de usar, o conteúdo enviado e as consequências para o número são de sua inteira responsabilidade, e o {brand} não responde por banimentos, perdas de número, contatos, vendas ou lucros decorrentes.</li>
          </ul>
          <p>Para operações em que o número não pode cair, use a API oficial da Meta.</p>
        </div>
      </>}

      <H n={qrCode ? 7 : 6}>Inteligência artificial</H>
      <p>Os agentes e blocos de IA geram respostas automaticamente e podem errar, inventar informações ou interpretar mal uma mensagem. Você é responsável por configurar, testar e acompanhar o que a IA responde em seu nome, e por não usá-la sozinha em decisões que exijam um profissional (saúde, jurídico, financeiro). O conteúdo enviado para a IA é processado pelos provedores indicados na Política de Privacidade.</p>

      <H n={qrCode ? 8 : 7}>Seus dados e os dados dos seus clientes</H>
      <ul>
        <li>As informações que você coloca no {brand} (contatos, conversas, arquivos, fluxos, vendas) são suas. Você nos autoriza a tratá-las apenas para prestar o serviço.</li>
        <li>Em relação aos dados dos seus clientes, <b>a sua empresa é a controladora</b> e o {brand} atua como <b>operador</b> (art. 39 da LGPD): tratamos esses dados conforme as suas instruções e a Política de Privacidade. Cabe a você ter base legal para tratá-los e informar os seus clientes.</li>
        <li>Você pode exportar seus contatos a qualquer momento. Recomendamos guardar cópias do que for importante para você.</li>
      </ul>

      <H n={qrCode ? 9 : 8}>Disponibilidade e suporte</H>
      <p>Trabalhamos para manter o {brand} no ar e seguro, com cópias de segurança do banco de dados, mas não garantimos funcionamento ininterrupto: podem ocorrer manutenções, falhas de provedores (hospedagem, Meta, WhatsApp, meios de pagamento) e eventos fora do nosso controle. Não há acordo de nível de serviço (SLA), salvo contratação específica por escrito.</p>

      <H n={qrCode ? 10 : 9}>Propriedade intelectual</H>
      <p>O software, a marca e o conteúdo do {brand} pertencem aos seus titulares. A assinatura dá a você uma licença de uso pessoal e intransferível enquanto estiver ativa. Sugestões que você nos enviar podem ser usadas para melhorar o produto, sem obrigação de pagamento.</p>

      <H n={qrCode ? 11 : 10}>Limitação de responsabilidade</H>
      <p>Na máxima extensão permitida pela lei, o {brand} não responde por danos indiretos, lucros cessantes, perda de dados causada por terceiros ou pelo próprio cliente, nem por decisões da Meta/WhatsApp (incluindo restrições e banimentos de números). Quando houver responsabilidade, ela fica limitada ao valor pago pelo cliente nos 12 meses anteriores ao fato. Esta cláusula não afasta direitos garantidos ao consumidor pelo Código de Defesa do Consumidor.</p>

      <H n={qrCode ? 12 : 11}>Suspensão e encerramento</H>
      <p>A conta pode ser suspensa por falta de pagamento, por violação destes Termos ou por ordem de autoridade. Cancelar a assinatura não apaga os dados (para você poder voltar); quando a empresa é excluída (Configurações › Empresa), os dados são apagados conforme a Política de Privacidade, exceto o que a lei manda guardar.</p>

      <H n={qrCode ? 13 : 12}>Mudanças nestes Termos</H>
      <p>Podemos atualizar estes Termos. Mudanças relevantes são avisadas por e-mail ou dentro do app com pelo menos 15 dias de antecedência. Se você continuar usando depois disso, as novas regras passam a valer; se não concordar, pode cancelar.</p>

      <H n={qrCode ? 14 : 13}>Lei aplicável e foro</H>
      <p>Valem as leis da República Federativa do Brasil. Fica eleito o foro da comarca de <V v={c?.city} ph="cidade" />, ressalvado o direito do consumidor de propor a ação no seu domicílio.</p>

      <H n={qrCode ? 15 : 14}>Contato</H>
      <p>Dúvidas sobre estes Termos: <V v={contactEmail} ph="e-mail de contato" />.</p>
    </article>
  );
}

/* ====================================================== Política de Privacidade */

function Privacy({ c, brand, qrCode, contactEmail }: Props) {
  return (
    <article className="lg-doc">
      <p>Esta Política explica como o <Who c={c} brand={brand} /> trata dados pessoais, de acordo com a Lei Geral de Proteção de Dados Pessoais (Lei 13.709/2018 — LGPD) e o Marco Civil da Internet (Lei 12.965/2014).</p>

      <H n={1}>Quem cuida dos seus dados</H>
      <ul>
        <li><b>Controlador</b> dos dados de quem usa a plataforma (donos de empresa, administradores e atendentes): <V v={c?.companyName} ph="razão social" />, CNPJ <V v={c?.cnpj} ph="CNPJ" />.</li>
        <li><b>Encarregado pelo tratamento de dados (DPO):</b> <V v={c?.dpoName} ph="nome do encarregado" /> — <V v={contactEmail} ph="e-mail do encarregado" />.</li>
        <li><b>Dados dos clientes finais</b> (as pessoas que conversam pelo WhatsApp com as empresas que usam o {brand}): a <b>empresa cliente é a controladora</b> e o {brand} é <b>operador</b>, tratando esses dados só para prestar o serviço contratado por ela.</li>
      </ul>

      <H n={2}>Quais dados tratamos</H>
      <ul>
        <li><b>Cadastro:</b> nome, e-mail, senha (guardada só como hash bcrypt, nunca em texto), nome da empresa e o registro do aceite destes documentos (data e versão).</li>
        <li><b>Cobrança:</b> nome ou razão social, CPF/CNPJ e dados de contato para a nota e a cobrança. <b>Os dados do cartão são digitados direto no meio de pagamento</b> (Asaas ou Paddle) e não passam pelo {brand}.</li>
        <li><b>Registros de acesso:</b> data, hora, endereço IP e navegador de cada acesso, guardados por 6 meses, como exige o art. 15 do Marco Civil da Internet.</li>
        <li><b>Conteúdo do atendimento</b> (em nome da empresa cliente): contatos (nome, telefone, e-mail, etiquetas, campos personalizados), mensagens, áudios, imagens e documentos trocados no WhatsApp, anotações da equipe, vendas, cartões do Kanban, respostas de fluxos e conversas com agentes de IA.</li>
        <li><b>Integrações:</b> tokens de acesso e identificadores da Meta (conta do WhatsApp Business, número, contas de anúncio, pixels), chaves de API e webhooks configurados pela empresa. {qrCode ? 'Na conexão por QR Code, as chaves da sessão do WhatsApp Web do número. ' : ''}Esses segredos ficam no banco de dados com acesso restrito e não são mostrados de volta na tela.</li>
        <li><b>Anúncios:</b> quando a empresa conecta o Facebook, números de campanhas (gasto, cliques, resultados) e, nos pixels, eventos de conversão (com e-mail e telefone convertidos em hash, como a Meta e o TikTok pedem).</li>
      </ul>
      <p>O app usa apenas o armazenamento local do navegador para manter você conectado e lembrar preferências — sem cookies de publicidade. O código da Meta (SDK do Facebook) só é carregado quando você escolhe “Conectar com a Meta”.</p>

      <H n={3}>Para que usamos e com qual base legal</H>
      <ul>
        <li>Prestar o serviço contratado, autenticar, cobrar e dar suporte — <i>execução de contrato</i> (art. 7º, V).</li>
        <li>Cumprir obrigações legais e fiscais e guardar registros de acesso — <i>obrigação legal</i> (art. 7º, II).</li>
        <li>Segurança, prevenção a fraudes e abusos, estatísticas de uso e melhoria do produto — <i>legítimo interesse</i> (art. 7º, IX), sempre com o mínimo de dados necessário.</li>
        <li>Avisos sobre a conta (número desconectado, cobrança, convites) — execução de contrato. Comunicações de marketing só com o seu consentimento, que pode ser revogado.</li>
        <li>Dados dos clientes finais: conforme as instruções e a base legal definidas pela empresa cliente (controladora).</li>
      </ul>

      <H n={4}>Com quem compartilhamos (suboperadores)</H>
      <p>Não vendemos dados. Compartilhamos apenas o necessário para o serviço funcionar, com:</p>
      <ul>
        <li><b>Render</b> (hospedagem da aplicação e do banco de dados — Estados Unidos);</li>
        <li><b>Meta Platforms</b> (WhatsApp Cloud API, API de Conversões e Marketing API), quando a empresa conecta esses serviços;</li>
        {qrCode && <li><b>WhatsApp</b>, nas conexões por QR Code (as mensagens trafegam pelos servidores do WhatsApp, como no WhatsApp Web);</li>}
        <li><b>Provedores de IA</b> — OpenRouter, OpenAI e Google (geração de respostas, transcrição de áudios, leitura de imagens e documentos) e ElevenLabs (voz), apenas quando a empresa usa esses recursos;</li>
        <li><b>Asaas</b> (pagamentos no Brasil) e <b>Paddle</b> (pagamentos internacionais, que atua como revendedor responsável pela venda);</li>
        <li>o <b>provedor de e-mail</b> usado para enviar avisos e convites;</li>
        <li><b>TikTok</b>, só quando a empresa ativa o pixel do TikTok;</li>
        <li>autoridades públicas, quando houver obrigação legal ou ordem judicial.</li>
      </ul>

      <H n={5}>Transferência internacional</H>
      <p>Parte desses fornecedores fica fora do Brasil (principalmente nos Estados Unidos). As transferências seguem o art. 33 da LGPD, com fornecedores que adotam cláusulas contratuais e padrões de segurança compatíveis com a proteção exigida pela lei brasileira.</p>

      <H n={6}>Por quanto tempo guardamos</H>
      <ul>
        <li>Dados da conta e do atendimento: enquanto a empresa existir no {brand}. Se a assinatura for cancelada e a empresa não for excluída, os dados continuam guardados para você poder voltar — exclua a empresa para apagá-los.</li>
        <li>Quando a empresa é excluída, os dados saem do sistema na hora; as cópias de segurança do banco são sobrescritas em até 30 dias.</li>
        <li>Registros de acesso: 6 meses (Marco Civil da Internet).</li>
        <li>Notas fiscais, faturas e o necessário para obrigações fiscais e defesa em processos: pelo prazo previsto em lei (em geral, 5 anos).</li>
        {qrCode && <li>Arquivos recebidos e enviados pela conexão por QR Code: 31 dias.</li>}
        <li>Arquivos de exportação de contatos: só os mais recentes ficam guardados para baixar de novo; os antigos são apagados.</li>
      </ul>

      <H n={7}>Seus direitos</H>
      <p>Pelo art. 18 da LGPD, você pode pedir: confirmação de que tratamos seus dados; acesso; correção de dados incompletos ou errados; anonimização, bloqueio ou eliminação de dados desnecessários ou tratados em desacordo com a lei; portabilidade; informação sobre com quem compartilhamos; eliminação dos dados tratados com consentimento e revogação do consentimento; e revisão de decisões tomadas só por meios automatizados (art. 20).</p>
      <p>Para exercer seus direitos, escreva para <V v={contactEmail} ph="e-mail do encarregado" /> a partir do e-mail cadastrado. Respondemos em até 15 dias. Se você é cliente de uma empresa que usa o {brand}, fale primeiro com essa empresa (ela é a controladora); se nos procurar, encaminhamos o pedido a ela. Você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).</p>
      <p>Veja como apagar seus dados na página <Link to="/exclusao-de-dados">Exclusão de dados</Link>.</p>

      <H n={8}>Segurança</H>
      <p>Usamos conexão criptografada (HTTPS), senhas com hash bcrypt, chaves de API guardadas só como hash, separação total entre empresas, permissões por função (dono, administrador, atendente), acesso de suporte só com liberação da empresa e cópias de segurança. Nenhum sistema é 100% seguro: se acontecer um incidente com risco relevante, avisaremos os afetados e a ANPD, como manda o art. 48 da LGPD.</p>

      <H n={9}>Crianças e adolescentes</H>
      <p>O {brand} é destinado a empresas e a maiores de 18 anos. Não coletamos intencionalmente dados de crianças como usuárias da plataforma.</p>

      <H n={10}>Mudanças e contato</H>
      <p>Esta Política pode ser atualizada; a data da versão fica no topo da página e mudanças relevantes são avisadas por e-mail ou no app. Contato do encarregado: <V v={contactEmail} ph="e-mail do encarregado" />{c?.address ? <> · {c.address}</> : null}.</p>
    </article>
  );
}

/* ============================================================ Exclusão de dados */

function Deletion({ c, brand, contactEmail }: Props) {
  return (
    <article className="lg-doc">
      <p>Aqui está como pedir a exclusão dos seus dados no {brand}. Escolha o caso que combina com você.</p>

      <H n={1}>Você usa o {brand} (dono de empresa)</H>
      <ol>
        <li>Entre no {brand} com o login de <b>dono</b> da empresa.</li>
        <li>Abra <b>Configurações › Empresa</b> e clique no ícone de lixeira (<b>Excluir empresa</b>). Confirme digitando o nome da empresa.</li>
        <li>Isso apaga a empresa e tudo o que é dela: contatos, conversas, arquivos, fluxos, agentes, disparos, conexões de WhatsApp e integrações. As conexões por QR Code também saem de “Aparelhos conectados” no celular.</li>
      </ol>
      <p>Antes, cancele a assinatura em <b>Cobranças e assinaturas</b> e, se quiser, exporte seus contatos em <b>Contatos › Exportar</b>.</p>

      <H n={2}>Você é atendente ou administrador</H>
      <p>Peça ao dono da empresa para tirar você da equipe (Configurações › Equipe), ou saia da empresa você mesmo. Para apagar também o seu login, escreva para <V v={contactEmail} ph="e-mail do encarregado" /> a partir do e-mail cadastrado, com o assunto “Excluir meus dados”.</p>

      <H n={3}>Você conversou pelo WhatsApp com uma empresa que usa o {brand}</H>
      <p>Seus dados (nome, telefone e mensagens) pertencem à empresa com quem você conversou — ela é a controladora e decide sobre eles. Peça a exclusão diretamente para ela. Se não conseguir, escreva para <V v={contactEmail} ph="e-mail do encarregado" /> informando o número de WhatsApp e o nome da empresa: encaminhamos o pedido a ela e acompanhamos a resposta. Responder <b>SAIR</b> na conversa já impede que você receba novos disparos em massa daquela empresa.</p>

      <H n={4}>Você conectou o Facebook / a Meta ao {brand}</H>
      <ol>
        <li>No {brand}, exclua a conexão em <b>Conexões</b> (e, se usou anúncios, em <b>Facebook › Perfis</b>): os tokens e identificadores recebidos da Meta são apagados na hora.</li>
        <li>No Facebook, abra <b>Configurações e privacidade › Configurações › Integrações comerciais</b> (ou <b>Apps e sites</b>), encontre o {brand} e clique em <b>Remover</b>. Isso revoga o acesso do {brand} à sua conta.</li>
        <li>Para apagar também o que já foi recebido (conversas, contatos, números de anúncios), siga o passo 1 desta página ou escreva para nós.</li>
      </ol>

      <H n={5}>Prazo e o que fica guardado</H>
      <p>A exclusão pela tela (Configurações › Empresa) é imediata. Pedidos por e-mail são respondidos em até 15 dias, com a confirmação. As cópias de segurança do banco são sobrescritas em até 30 dias. Guardamos apenas o que a lei obriga: registros de acesso (6 meses, Marco Civil da Internet) e documentos fiscais e de cobrança (em geral, 5 anos).</p>

      <H n={6}>Contato</H>
      <p>Encarregado de dados: <V v={c?.dpoName} ph="nome do encarregado" /> — <V v={contactEmail} ph="e-mail do encarregado" />.</p>
    </article>
  );
}
