import type { Env } from './types';

/**
 * Basic Auth。只有 API_USERNAME 与 API_PASSWORD 都非空时才启用；
 * 未配置时放行（本地开发便利），部署前务必通过 secret/vars 配置。
 */
export async function authenticate(request: Request, env: Env): Promise<boolean> {
  const user = env.API_USERNAME;
  const pass = env.API_PASSWORD;
  if (!user && !pass) return true;

  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Basic ')) return false;

  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(':');
    if (idx === -1) return false;
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    return u === user && p === pass;
  } catch {
    return false;
  }
}

export function unauthorized(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="resend-inbox", charset="UTF-8"' },
  });
}
