import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Spinner } from './components/ui';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Inbox } from './pages/Inbox';
import { Contacts } from './pages/Contacts';
import { Kanban } from './pages/Kanban';
import { Flows } from './pages/Flows';
import { Agents } from './pages/Agents';
import { Dispatch } from './pages/Dispatch';
import { Connections } from './pages/Connections';
import { Webhooks } from './pages/Webhooks';
import { Meta } from './pages/Meta';
import { Team } from './pages/Team';
import { Billing } from './pages/Billing';
import { Settings } from './pages/Settings';

// o editor de fluxos (React Flow) só é baixado quando alguém abre um fluxo
const FlowBuilder = lazy(() => import('./pages/FlowBuilder').then((m) => ({ default: m.FlowBuilder })));

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ height: '100vh' }}><Spinner /></div>;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/kanban" element={<Kanban />} />
        <Route path="/flows" element={<Flows />} />
        <Route path="/flows/:id" element={<Suspense fallback={<Spinner />}><FlowBuilder /></Suspense>} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/dispatch" element={<Dispatch />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/meta" element={<Meta />} />
        <Route path="/team" element={<Team />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
