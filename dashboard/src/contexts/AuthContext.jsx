// Panel session + server configuration.
// - Asks /api/auth/status whether the session cookie is valid; the login
//   screen (main.jsx) shows until it is.
// - Loads /api/config and /api/settings once signed in. API keys never reach
//   the browser: `keys` only says which ones are set server-side.
// The legacy cloud fields (billingEnabled, isManaged, plan...) are kept as
// constants so the components that still read them stay in self-host mode.
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiFetch, apiJson, AUTH_EXPIRED_EVENT } from '../lib/api';

const AuthContext = createContext(null);
// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);

const NOOP = () => {};
const EMPTY_KEYS = { gemini_api_key: false, elevenlabs_api_key: false, fal_api_key: false, postiz_api_key: false };

export function AuthProvider({ children }) {
  const [authenticated, setAuthenticated] = useState(null); // null = checking
  const [passwordFromEnv, setPasswordFromEnv] = useState(false);
  const [config, setConfig] = useState({});
  const [settings, setSettings] = useState(null);

  const refreshSettings = useCallback(async () => {
    try {
      const [cfg, s] = await Promise.all([apiJson('/api/config'), apiJson('/api/settings')]);
      setConfig(cfg || {});
      setSettings(s || null);
      return s;
    } catch (_) {
      return null;
    }
  }, []);

  const checkSession = useCallback(async () => {
    try {
      const data = await apiJson('/api/auth/status');
      setPasswordFromEnv(!!data.passwordFromEnv);
      setAuthenticated(!!data.authenticated);
      if (data.authenticated) await refreshSettings();
    } catch (_) {
      setAuthenticated(false);
    }
  }, [refreshSettings]);

  useEffect(() => { checkSession(); }, [checkSession]);

  useEffect(() => {
    const onExpired = () => setAuthenticated(false);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const login = useCallback(async (password) => {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      let msg = 'Login failed.';
      try { msg = (await res.json()).detail || msg; } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    setAuthenticated(true);
    await refreshSettings();
  }, [refreshSettings]);

  const logout = useCallback(async () => {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
    setAuthenticated(false);
    setSettings(null);
  }, []);

  const saveSettings = useCallback(async (changes) => {
    const s = await apiJson('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    setSettings(s);
    apiJson('/api/config').then(setConfig).catch(() => {});
    return s;
  }, []);

  const keys = { ...EMPTY_KEYS, ...(config.keys || {}) };

  const value = {
    authenticated,
    passwordFromEnv,
    login,
    logout,
    config,
    settings,
    keys,
    postizConfigured: !!config.postizConfigured,
    refreshSettings,
    saveSettings,
    jobRetentionSeconds: config.jobRetentionSeconds ?? 0,
    localLlm: config.localLlm || null,
    // Legacy cloud fields: this panel is always self-hosted.
    billingEnabled: false,
    isManaged: false,
    isSignedIn: true,
    me: null,
    plan: null,
    refreshMe: NOOP,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
