// Centralized API client.
// The panel session is an HttpOnly cookie set by /api/auth/login, so requests
// only need to be same-origin (credentials: 'include' also covers a
// VITE_API_URL on another origin listed in the backend's CORS_ORIGINS).
// A 401 anywhere means the session expired: the auth gate listens for
// AUTH_EXPIRED_EVENT and shows the login screen again.
import { getApiUrl } from '../config';

export const AUTH_EXPIRED_EVENT = 'panel-auth-expired';

export async function apiFetch(path, options = {}) {
  const res = await fetch(getApiUrl(path), { credentials: 'include', ...options });
  if (res.status === 401 && !String(path).startsWith('/api/auth/')) {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  return res;
}

// A failed request, carrying the server's own explanation. Callers that show an
// alert should prefer `detail`.
export class ApiError extends Error {
  constructor(status, detail, raw) {
    super(`${status}: ${raw}`);   // message kept verbatim for existing callers
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

// Convenience JSON helper.
export async function apiJson(path, options = {}) {
  const res = await apiFetch(path, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      const d = JSON.parse(text).detail;
      // FastAPI details are strings here, but validation errors arrive as objects.
      if (typeof d === 'string') detail = d;
    } catch (_) { /* not JSON — leave detail empty and fall back to the caller's copy */ }
    throw new ApiError(res.status, detail, text);
  }
  return res.json();
}
