// Verification-only preload: synthetic fetch plus fail-closed socket/HTTP guards.
import { appendFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const events = process.env.COMPAT_EVENTS;
const record = (value) => appendFileSync(events, JSON.stringify(value) + '\n');
let quotaRequests = 0;
const denied = (kind) => {
  record({ kind: 'blocked-network', api: kind });
  throw new Error(`Compatibility smoke forbids network: ${kind}`);
};
net.Socket.prototype.connect = function () { return denied('socket'); };
for (const [name, module] of [['http', http], ['https', https]]) {
  module.request = () => denied(`${name}.request`);
  module.get = () => denied(`${name}.get`);
}
syncBuiltinESMExports();
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://management.example.invalid') return denied('fetch');
  const path = url.pathname;
  if (path === '/v0/management/auth-files') {
    record({ kind: 'discovery' });
    return Response.json({ files: [{ auth_index: 'synthetic-codex', provider: 'codex', email: 'synthetic@example.invalid' }] });
  }
  if (path === '/v0/management/api-call') {
    const body = JSON.parse(init.body);
    if (body.auth_index !== 'synthetic-codex' || body.url !== 'https://chatgpt.com/backend-api/wham/usage') {
      throw new Error('Unexpected synthetic account routing');
    }
    quotaRequests++;
    const used = quotaRequests === 1 ? 25 : 35;
    record({ kind: 'quota', count: quotaRequests, used });
    return Response.json({ status_code: 200, body: JSON.stringify({ rate_limit: {
      primary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 172800 },
      secondary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 7200 },
    } }) });
  }
  return denied('unexpected-management-path');
};
globalThis[Symbol.for('cliproxy-compat.synthetic-fetch')] = globalThis.fetch;
record({ kind: 'guard-ready' });
