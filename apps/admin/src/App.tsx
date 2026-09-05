import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useLogout, useSession } from './api/hooks';
import { Login } from './pages/Login';
import { Calendar } from './pages/Calendar';
import { Customers } from './pages/Customers';
import { CustomerDetail } from './pages/CustomerDetail';
import { Services } from './pages/Services';
import { Hours } from './pages/Hours';
import { Policy } from './pages/Policy';
import { Calls } from './pages/Calls';
import { Loading } from './components/ui';

export function App() {
  const session = useSession();
  const logout = useLogout();

  if (session.isLoading) return <Loading what="session" />;
  if (session.isError || !session.data) return <Login />;

  const { salon, credential } = session.data;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">{salon.name}</div>
        <div className="brand-sub">{salon.timezone}</div>
        <nav className="nav">
          <NavLink to="/appointments">Appointments</NavLink>
          <NavLink to="/customers">Customers</NavLink>
          <NavLink to="/calls">Call review</NavLink>
          <NavLink to="/services">Services</NavLink>
          <NavLink to="/hours">Hours &amp; closures</NavLink>
          <NavLink to="/policy">Booking policy</NavLink>
        </nav>
        <div className="sidebar-footer">
          <div>{credential.name}</div>
          <button className="link small" onClick={() => logout.mutate()} style={{ marginTop: 6 }}>
            Sign out
          </button>
          <div style={{ marginTop: 8 }}>
            <a href="/docs" target="_blank" rel="noreferrer" className="small">
              API reference ↗
            </a>
          </div>
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/appointments" replace />} />
          <Route path="/appointments" element={<Calendar />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/calls" element={<Calls />} />
          <Route path="/services" element={<Services />} />
          <Route path="/hours" element={<Hours />} />
          <Route path="/policy" element={<Policy />} />
          <Route path="*" element={<Navigate to="/appointments" replace />} />
        </Routes>
      </main>
    </div>
  );
}
