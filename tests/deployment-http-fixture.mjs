import assert from 'node:assert/strict';

export async function loginDeploymentFixture({ password = 'private-fixture-password' } = {}) {
  const cookies = new Map();
  const request = async (resource, options = {}) => {
    const response = await fetch(`http://127.0.0.1:3010${resource}`, {
      ...options, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { ...options.headers, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') },
    });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0];
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    assert.equal(response.status, 200, `${resource} must return HTTP 200`);
    return response.json();
  };
  const { csrfToken } = await request('/api/auth/csrf');
  assert.equal(typeof csrfToken, 'string');
  await request('/api/auth/callback/admin-login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrfToken, username: 'fixture', password,
      callbackUrl: 'http://localhost:3010', json: 'true' }),
  });
  assert.equal((await request('/api/auth/session')).user.email, 'admin@local');
  return async (resource, body) => request(resource, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
