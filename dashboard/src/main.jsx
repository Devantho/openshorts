import { StrictMode, useState, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { Lock, Loader2 } from 'lucide-react'
import './index.css'
import { AuthProvider, useAuth } from './contexts/AuthContext'

const App = lazy(() => import('./App.jsx'))

const Loading = () => (
  <div className="min-h-screen bg-paper flex items-center justify-center text-muted text-sm lowercase">loading…</div>
)

function LoginScreen() {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await login(password);
    } catch (err) {
      setError(err.message || 'Login failed.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper text-ink2 flex items-center justify-center p-6">
      <form onSubmit={submit} className="card w-full max-w-sm p-6 sm:p-8 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-paper3 rounded-input overflow-hidden border border-rule shrink-0">
            <img src="/logo-openshorts.png" alt="" className="w-full h-full object-cover" />
          </div>
          <div>
            <h1 className="font-display lowercase text-xl text-ink">bomshort</h1>
            <p className="text-xs text-muted">Private panel</p>
          </div>
        </div>
        <label className="block space-y-2">
          <span className="text-sm text-muted flex items-center gap-2"><Lock size={14} /> Password</span>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input-field"
          />
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button type="submit" disabled={!password || busy} className="btn-primary w-full justify-center">
          {busy ? <Loader2 size={16} className="animate-spin" /> : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// The panel is the only page: no landing, no pricing, no legal pages.
function Root() {
  const { authenticated } = useAuth();
  if (authenticated === null) return <Loading />;
  if (!authenticated) return <LoginScreen />;
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <Suspense fallback={<Loading />}>
        <Root />
      </Suspense>
    </AuthProvider>
  </StrictMode>,
)
