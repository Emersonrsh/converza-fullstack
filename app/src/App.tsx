import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Spinner } from './components/ui';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { InviteAccept } from './pages/InviteAccept';
import { NoCompany } from './pages/NoCompany';
import { Dashboard } from './pages/Dashboard';
import { Inbox } from './pages/Inbox';
import { Contacts } from './pages/Contacts';
import { Kanban } from './pages/Kanban';
import { KanbanBoard } from './pages/KanbanBoard';
import { Flows } from './pages/Flows';
import { Agents } from './pages/Agents';
import { Dispatch } from './pages/Dispatch';
import { Connections } from './pages/Connections';
import { Webhooks } from './pages/Webhooks';
import { Meta } from './pages/Meta';
import { Billing } from './pages/Billing';
import { PaddleCheckout } from './pages/PaddleCheckout';
import { SettingsLayout } from './settings/SettingsLayout';
import { Tutorials } from './pages/Tutorials';
import { AgentEditor } from './agents/AgentEditor';
import { WebhookEditor } from './webhooks/WebhookEditor';
import { DispatchRoute } from './dispatch/CampaignView';

// o editor de fluxos (React Flow) só é baixado quando alguém abre um fluxo
const FlowBuilder = lazy(() => import('./pages/FlowBuilder').then((m) => ({ default: m.FlowBuilder })));

export default function App() {
  const { user, accounts, loading, offline, retry } = useAuth();
  const loc = useLocation();
  // página de pagamento da Paddle: pública (o link pode ser aberto sem login)
  if (loc.pathname === '/pagamento') return <PaddleCheckout />;
  if (loading) return <div style={{ height: '100vh' }}><Spinner /></div>;
  if (!user && offline) {
    return (
      <div className="boot-offline" data-testid="boot-offline">
        <b>Não conseguimos falar com o servidor</b>
        <span>Pode ser a sua internet ou uma atualização do Converza em andamento. Sua sessão continua salva.</span>
        <button type="button" className="btn primary" onClick={retry}>Tentar de novo</button>
      </div>
    );
  }
  if (!user) {
    return (
      <Routes>
        <Route path="/convite/:token" element={<InviteAccept />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  // sem nenhuma empresa (saiu, foi removido, empresa excluída): aceitar convite ou criar uma
  if (!accounts.length) {
    return (
      <Routes>
        <Route path="/convite/:token" element={<InviteAccept />} />
        <Route path="*" element={<NoCompany />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/convite/:token" element={<InviteAccept />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/kanban" element={<Kanban />} />
        <Route path="/kanban/:id" element={<KanbanBoard />} />
        <Route path="/flows" element={<Flows />} />
        <Route path="/flows/:id" element={<Suspense fallback={<Spinner />}><FlowBuilder /></Suspense>} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/agents/:id" element={<AgentEditor />} />
        <Route path="/dispatch" element={<Dispatch />} />
        <Route path="/dispatch/:id" element={<DispatchRoute />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/webhooks/:id" element={<WebhookEditor />} />
        <Route path="/meta/*" element={<Meta />} />
        <Route path="/team" element={<Navigate to="/settings/equipe" replace />} />
        <Route path="/billing/*" element={<Billing />} />
        <Route path="/settings" element={<SettingsLayout />} />
        <Route path="/settings/:page" element={<SettingsLayout />} />
        <Route path="/tutorials" element={<Tutorials />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
