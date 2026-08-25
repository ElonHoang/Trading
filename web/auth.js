let sessionPromise = null;

export async function getAuthSession({ refresh = false } = {}) {
  if (refresh || !sessionPromise) {
    sessionPromise = fetch('/api/auth/session', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Không thể kiểm tra phiên đăng nhập (HTTP ${response.status}).`);
      return response.json();
    }).catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export function canWrite(session) {
  return Boolean(session?.user?.canWrite);
}

export async function csrfFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(method)) {
    const session = await getAuthSession();
    const csrf = session.csrf;
    if (!csrf?.headerName || !csrf.token) throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    headers.set(csrf.headerName, csrf.token);
  }
  return fetch(url, { ...options, headers });
}
