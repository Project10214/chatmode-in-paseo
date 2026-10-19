import { safeDiagnostic, safeError } from './diagnostics.mjs';
import { catalogService } from './catalog.mjs';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { Broker } from './broker.mjs';
import { PROTOCOL, PRODUCT, LIMITS, invariant, object } from './protocol.mjs';

const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function privateJson(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
}
/** @param {{directory?: string, port?: number, maxConcurrent?: number, commandTimeout?: number, onExternalTurn?: (sessionId: string) => unknown}} options */
export async function createRuntime({ directory, port = 17843, maxConcurrent = 2, commandTimeout = 90000, onExternalTurn } = {}) {
  invariant(typeof directory === 'string' && path.isAbsolute(directory), 'ABSOLUTE_STATE_DIRECTORY_REQUIRED');
  invariant(Number.isInteger(port) && port >= 0 && port <= 65535, 'INVALID_PORT');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // No automatic deletion of someone else's lock or takeover of their running instance.
  const lockPath = path.join(directory, 'runtime.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`RUNTIME_LOCKED: inspect ${lockPath}; do not run standalone and Paseo runtimes together.`); throw e; }
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); await lock.close();
  let server, timer, store, broker, runtimeHandle;
  const sockets = new Set(); const epoch = randomUUID();
  try {
    store = await new Store(directory).open();
    broker = new Broker(store, { maxConcurrent, commandTimeout }); await broker.recover();
    await broker.inputFiles.pruneOlderThan();
    const credentialPath = path.join(directory, 'bridge-credential.json');
    let credential = null;
    try { credential = JSON.parse(await fs.readFile(credentialPath, 'utf8')); invariant(/^[a-p]{32}$/.test(credential.extensionId) && /^[a-f0-9]{64}$/.test(credential.token), 'INVALID_CREDENTIAL'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    let pairing = { code: randomBytes(24).toString('hex'), expiresAt: Date.now() + 15 * 60000 };
    await privateJson(path.join(directory, 'pairing.json'), pairing);
    let lastSeen = 0, count = 0, windowStart = Date.now();
    const json = (res, status, value, origin) => {
      const data = JSON.stringify(value);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-CIP-Extension, X-CIP-Engine, X-CIP-Browser, X-CIP-Features', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } : {}) });
      res.end(data);
    };
    const body = async req => {
      invariant(req.headers['content-type']?.split(';')[0] === 'application/json', 'JSON_REQUIRED');
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; invariant(bytes <= LIMITS.body, 'BODY_TOO_LARGE'); chunks.push(chunk); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); invariant(object(value), 'OBJECT_REQUIRED'); return value;
    };
    server = http.createServer(async (req, res) => {
      const origin = req.headers.origin;
      try {
        const localPort = server.address().port;
        invariant(req.headers.host === `127.0.0.1:${localPort}`, 'HOST_REJECTED');
        invariant(!origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin), 'ORIGIN_REJECTED');
        if (Date.now() - windowStart > 60000) { count = 0; windowStart = Date.now(); }
        invariant(++count <= 1800, 'RATE_LIMITED');
        const route = req.url;
        const fileCapable=req.headers['x-cip-features']==='files-v2';
        if (req.method === 'OPTIONS') return json(res, 204, {}, origin);
        if (req.method === 'GET' && route === '/hello') return json(res, 200, { product: PRODUCT, protocol: PROTOCOL, epoch }, origin);
        if (req.method === 'POST' && route === '/pair') {
          const value = await body(req);
          invariant(/^[a-p]{32}$/.test(value.extensionId), 'EXTENSION_ID_INVALID');
          invariant(!origin || origin === `chrome-extension://${value.extensionId}`, 'ORIGIN_REJECTED');
          invariant(pairing && pairing.expiresAt > Date.now() && equal(value.code, pairing.code), 'PAIRING_REJECTED');
          pairing = null;
          const nextCredential = { extensionId: value.extensionId, token: randomBytes(32).toString('hex') };
          await privateJson(credentialPath, nextCredential); credential = nextCredential;
          await fs.rm(path.join(directory, 'pairing.json'), { force: true });
          return json(res, 200, { token: credential.token, protocol: PROTOCOL }, origin);
        }
        invariant(credential && equal(req.headers.authorization, `Bearer ${credential.token}`) && req.headers['x-cip-extension'] === credential.extensionId, 'AUTH_REQUIRED');
        invariant(!origin || origin === `chrome-extension://${credential.extensionId}`, 'ORIGIN_REJECTED');
        invariant(!broker.closed,'RUNTIME_CLOSED');
        lastSeen = Date.now();
        if (req.method === 'GET' && route === '/commands') {
          // Only the paired, updated extension can trigger automatic discovery. Health reads cannot.
          const browser = req.headers['x-cip-browser'];
          if (runtimeHandle && req.headers['x-cip-engine'] === 'cos-native-alpha4.3' && typeof browser === 'string' && /^[a-zA-Z0-9-]{16,64}$/.test(browser))
            catalogService(runtimeHandle).noteBrowser(`${credential.extensionId}:${browser}`);
          return json(res, 200, { commands: broker.queued().filter(c=>!c.payload?.files?.length||fileCapable), epoch }, origin);
        }
        if (req.method === 'GET' && route === '/observations')
          return json(res,200,{sessions:broker.observationBindings()},origin);
        if (req.method === 'GET' && route === '/recovery-targets')
          return json(res, 200, { sessions: broker.recoveryTargets() }, origin);
        invariant(req.method === 'POST', 'ROUTE_NOT_FOUND');
        const value = await body(req); let result;
        switch (route) {
          case '/claim': {
            const command=store.read().commands[value.id];
            if(command?.payload?.files?.length) invariant(fileCapable,'ATTACHMENT_FEATURE_REQUIRED');
            result = await broker.claim(value.id, value.tabId, value.documentKey, value); break;
          }
          case '/input-chunk':
            invariant(fileCapable,'ATTACHMENT_FEATURE_REQUIRED');
            result=await broker.readInputChunk(value);break;
          case '/fail-unclaimed':
            result=await broker.failUnclaimed(value.id,value.error);
            if(store.read().commands[value.id]?.payload?.files?.length)
              await broker.inputFiles.remove(value.id);
            break;
          case '/authorize': result = await broker.authorize(value.id, value.lease); break;
          case '/verify-tab-close': result = broker.verifyTabClose(value.id, value.lease); break;
          case '/verify-approval': result = broker.verifyApproval(value.id, value.lease); break;
          case '/bind-conversation':
            result = await broker.bindConversation(value.id,value.lease,
              {tabId:value.tabId,documentKey:value.documentKey,url:value.url});break;
          case '/result': {
            result = await broker.result(value.id, value.lease, value.result);
            const command = store.read().commands[value.id];
            if(command?.kind==='send' && ['done','failed'].includes(command.phase) && command.payload?.files?.length)
              await broker.inputFiles.remove(value.id);
            // Log bounded outcomes only. Never dump a browser request, lease or tool output.
            if (command?.kind === 'catalog') console.warn('[CIP catalog]', JSON.stringify({
              phase: command.phase, elapsedMs: Math.max(0, Date.now() - command.createdAt),
              error: command.error ? safeError(command.error) : null, diagnostic: safeDiagnostic(command.diagnostic),
              models: command.result?.catalog?.models.length ?? 0, apps: command.result?.catalog?.apps.length ?? 0
            }));
            if (command?.kind === 'send') console.warn('[CIP send]', JSON.stringify({
              phase: command.phase, elapsedMs: Math.max(0, Date.now() - command.createdAt),
              error: command.error ? safeError(command.error) : null, diagnostic: safeDiagnostic(command.diagnostic)
            }));
            break;
          }
          case '/resume-agent': {
            // A paired extension can wake only an existing, exact bound Agent.
            // This request NEVER creates a native turn or authorizes a Send.
            const s=store.read().sessions[value.sessionId];
            invariant(s && s.conversationId===value.conversationId &&
              s.status!=='abandoned','SESSION_UNKNOWN');
            if(typeof onExternalTurn==='function')
              void Promise.resolve().then(()=>onExternalTurn(s.id)).catch(()=>{});
            result={queued:typeof onExternalTurn==='function'};
            break;
          }
          case '/rebind-observation': result = await broker.rebindObservation(value); break;
          case '/page-view':
            result=await broker.observeView(value);
            if(!result.duplicate&&!result.stale&&typeof onExternalTurn==='function')
              void Promise.resolve().then(()=>onExternalTurn(value.sessionId)).catch(()=>{});
            break;
          case '/observation-gap': result=await broker.observeGap(value);break;
          case '/receipt-observation': result=await broker.recoverReceipt(value);break;
          case '/artifact/begin': result=await broker.artifactTransfer.begin(value);break;
          case '/artifact/chunk': result=await broker.artifactTransfer.chunk(value);break;
          case '/artifact/commit': result=await broker.artifactTransfer.commit(value);break;
          case '/artifact/unsupported': result=await broker.artifactTransfer.unsupported(value);break;
          default: throw Object.assign(new Error('ROUTE_NOT_FOUND'), { code: 'ROUTE_NOT_FOUND' });
        }
        json(res, 200, result, origin);
      } catch (e) {
        // Never reflect arbitrary exception text, request payloads, tokens, or stack traces.
        const code = typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code) ? e.code : 'INVALID_REQUEST';
        const status = ['AUTH_REQUIRED', 'PAIRING_REJECTED', 'HOST_REJECTED', 'ORIGIN_REJECTED'].includes(code) ? 403 : code === 'ROUTE_NOT_FOUND' ? 404 : code === 'RATE_LIMITED' ? 429 : 400;
        if (!res.headersSent) json(res, status, { error: code }, /^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? '') ? origin : null);
        else res.destroy();
      }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    const address = `http://127.0.0.1:${server.address().port}`;
    await privateJson(path.join(directory, 'endpoint.json'), { address, pid: process.pid, protocol: PROTOCOL });
    let ticking = false, lastFilePruneAt=Date.now();
    timer = setInterval(async () => {
      if(ticking)return;ticking=true;
      try {
        broker.slots.pump();await broker.tick();
        if(runtimeHandle)catalogService(runtimeHandle).tick();
        if(Date.now()-lastFilePruneAt>=3600000){
          lastFilePruneAt=Date.now();
          await broker.inputFiles.pruneOlderThan();
        }
      } catch {} finally { ticking=false; }
    },1000);timer.unref();
    let closed = false;
    runtimeHandle = {
      broker, store, address,
      status: () => ({ address, paired: Boolean(credential), connected: Date.now() - lastSeen < 45000, lastSeenAt: lastSeen, protocol: PROTOCOL }),
      async renewPairing() {
        pairing = { code: randomBytes(24).toString('hex'), expiresAt: Date.now() + 15 * 60000 };
        await privateJson(path.join(directory, 'pairing.json'), pairing);
        return { address, ...pairing };
      },
      async close() {
        if (closed) return; closed = true; clearInterval(timer);
        catalogService(runtimeHandle).close();
        await broker.close();
        await new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); });
        await fs.rm(path.join(directory, 'endpoint.json'), { force: true });
        await fs.rm(path.join(directory, 'pairing.json'), { force: true });
        await fs.rm(lockPath, { force: true });
      }
    };
    return runtimeHandle;
  } catch (e) {
    clearInterval(timer); server?.close(); for (const socket of sockets) socket.destroy();
    await fs.rm(lockPath, { force: true }); throw e;
  }
}
