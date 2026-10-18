import { createHash } from 'node:crypto';
import { artifactSourceIdentity, artifactSourceRevision } from './artifact-identity.mjs';
import { assertObservation } from './continuous-observation.mjs';
import { artifactMetadata, ARTIFACT_LIMITS } from './artifacts.mjs';
import { identifier, invariant, nativeMessageId, object, conversationId } from './protocol.mjs';

const reasons = new Set(['native_source_unproven','capture_busy','resource_unavailable','mime_unsupported','oversized','capture_timeout','not_loaded','tainted','preview_failed']);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const quality = {'native-original':3,'visible-image-resource':2,'rendered-preview':1};
function sourceId(value) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0') && value.isWellFormed(), 'ARTIFACT_SOURCE_INVALID');
  return value;
}
function sourceProof(session, id) {
  const matches = (Array.isArray(session.sources) ? session.sources : []).filter(row => row?.id === id);
  invariant(matches.length === 1, 'ARTIFACT_SOURCE_UNPROVEN');
  const source = matches[0], media = source.media;
  invariant(['image','file'].includes(source.kind) && object(media) && media.kind === source.kind &&
    ['native-original','visible-image-resource','rendered-preview'].includes(media.provenance), 'ARTIFACT_SOURCE_UNPROVEN');
  const messageId = media.messageId ?? null, assetId = media.assetId ?? null;
  if (messageId !== null) nativeMessageId(messageId);
  if (assetId !== null) invariant(typeof assetId === 'string' && /^file_[A-Za-z0-9_-]{8,100}$/.test(assetId), 'ARTIFACT_SOURCE_UNPROVEN');
  invariant(source.nativeMessageId == null || messageId === null || source.nativeMessageId === messageId, 'ARTIFACT_SOURCE_UNPROVEN');
  invariant(media.provenance === 'native-original' ? messageId !== null && assetId !== null : source.kind === 'image', 'ARTIFACT_SOURCE_UNPROVEN');
  invariant(typeof session.conversationId === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(session.conversationId), 'ARTIFACT_SOURCE_UNPROVEN');
  const identity = artifactSourceIdentity(session,source);
  // Caption/order/visibility and the ledger's whole-source revision are NOT
  // asset revisions. Only resource identity, actual URL or explicit revision
  // may revoke bytes already captured from this source.
  invariant(typeof source.text === 'string', 'ARTIFACT_SOURCE_UNPROVEN');
  return {identity,sourceText:source.text,revision:artifactSourceRevision(session,source)};
}
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const envelope = event => ({ sessionId:identifier(event.sessionId), observationLease:event.observationLease,
  tabId:event.tabId, documentKey:event.documentKey, url:'https://chatgpt.com/c/'+conversationId(event.url), sourceId:sourceId(event.sourceId) });

/** Observation-lease-fenced upload adapter; no URL fetching or turn-state gate.
 * begin -> {uploadId}; chunk -> {uploadId,offset,nextOffset,total} (base64 chars);
 * commit/unsupported -> generated-file timeline item; read -> ArtifactStore chunk.
 * Upload/ACK ownership is process-local; persisted history/blobs survive restart.
 * A restarted in-flight upload must begin again. RPC authentication is the caller's
 * responsibility; read grants are resolved only from that session's stored row.
 */
export function createArtifactTransfer({ store, artifacts, emit = () => {} }) {
  const owners = new Map(), byKey = new Map();
  function authorize(event, data = store.read()) {
    invariant(object(event), 'ARTIFACT_EVENT_INVALID');
    const request = envelope(event), session = Object.hasOwn(data.sessions,request.sessionId) ? data.sessions[request.sessionId] : null;
    assertObservation(session,request);
    return { request, session, proof:sourceProof(session,request.sourceId) };
  }
  function validateOwner(owner, event) {
    const value = authorize(event);
    invariant(same(value.request,owner.request), 'ARTIFACT_UPLOAD_OWNER_MISMATCH');
    invariant(value.proof.revision === owner.proof.revision && same(value.proof.identity,owner.proof.identity), 'ARTIFACT_SOURCE_CHANGED');
    return value;
  }
  function remove(owner) {
    artifacts.abort(owner.uploadId); owners.delete(owner.uploadId);
    if (byKey.get(owner.key) === owner) byKey.delete(owner.key);
  }
  function prune() {
    const data = store.read(), now = Date.now();
    for (const owner of owners.values()) {
      let valid = now-owner.created <= (owner.item ? 5*60000 : ARTIFACT_LIMITS.lifetime);
      if (valid) try {
        const value = authorize(owner.request,data);
        valid = value.proof.revision === owner.proof.revision && same(value.proof.identity,owner.proof.identity);
      } catch { valid = false; }
      // Never evict an asynchronous commit while it owns a pending operation.
      if (!valid && !owner.busy) remove(owner);
    }
    // Completed ACK entries are bounded independently of the blob quota.
    for (const owner of owners.values()) {
      if (owners.size < 256) break;
      if (owner.item && !owner.busy) remove(owner);
    }
  }
  function lookup(event) {
    authorize(event); // Even a replayed/unknown upload must prove the live lease.
    invariant(typeof event.uploadId === 'string', 'ARTIFACT_UPLOAD_UNKNOWN');
    const owner = owners.get(event.uploadId);
    invariant(owner, 'ARTIFACT_UPLOAD_UNKNOWN'); validateOwner(owner,event);
    return owner;
  }
  function queued(owner, operation) {
    const result = owner.tail.then(async () => {
      owner.busy = true;
      try { return await operation(); }
      finally { owner.busy = false; }
    });
    owner.tail = result.catch(() => {}); return result;
  }
  function historyRow(session,id) {
    const matches = (session.history ?? []).filter(row => row.id === 'artifact:'+id);
    invariant(matches.length <= 1, 'ARTIFACT_HISTORY_CONFLICT');
    const row = matches[0];
    invariant(!row || (row.type === 'plugin' && row.pluginId === 'chatmode-in-paseo' && row.version === 1 &&
      ((row.kind === 'generated-file' && row.data?.sessionId === session.id && row.data.sourceId === id) ||
       (row.kind === 'page-source' && row.data?.source?.id === id))), 'ARTIFACT_HISTORY_CONFLICT');
    return row;
  }
  async function publish(owner, event, resource) {
    validateOwner(owner,event);
    const result = await store.transaction(data => {
      const {session,proof} = validateOwnerIn(data,owner,event), previous = historyRow(session,event.sourceId);
      session.artifactIdentities ??= [];
      const knownIndex=session.artifactIdentities.findIndex(row=>row.sourceId===proof.identity.sourceId);
      const known=knownIndex<0?null:session.artifactIdentities[knownIndex];
      const retain=previous?.data.status==='available' && known?.revision===proof.revision && quality[previous.data.provenance]>quality[owner.provenance];
      // A transient raw-read failure must not overwrite verified original
      // bytes with a lower-fidelity fallback of the very same asset.
      const item = retain ? {...previous,data:{...previous.data,sourceText:proof.sourceText}} :
        {type:'plugin',pluginId:'chatmode-in-paseo',id:'artifact:'+proof.identity.sourceId,kind:'generated-file',version:1,
          data:{...proof.identity,sourceText:proof.sourceText,provenance:owner.provenance,status:'available',resource}};
      const stamp={sourceId:proof.identity.sourceId,revision:proof.revision};
      if(knownIndex<0)session.artifactIdentities.push(stamp);else session.artifactIdentities[knownIndex]=stamp;
      const changed = !same(previous,item);
      if (changed) {
        session.history ??= [];
        const index = session.history.findIndex(row => row.id === item.id);
        if (index < 0) session.history.push(item); else session.history[index] = item;
      }
      return {item,changed};
    });
    validateOwner(owner,event); // Do not emit across a rebind after persistence.
    owner.item = result.item;
    if (result.changed) await emit({id:owner.request.sessionId,state:'artifact',item:clone(result.item)});
    return clone(result.item);
  }
  function validateOwnerIn(data,owner,event) {
    const value = authorize(event,data);
    invariant(same(value.request,owner.request), 'ARTIFACT_UPLOAD_OWNER_MISMATCH');
    invariant(value.proof.revision === owner.proof.revision && same(value.proof.identity,owner.proof.identity), 'ARTIFACT_SOURCE_CHANGED');
    return value;
  }
  async function begin(event) {
    const {request,proof} = authorize(event), metadata = artifactMetadata(event.metadata);
    invariant(proof.identity.kind !== 'image' || metadata.mimeType.startsWith('image/'), 'ARTIFACT_MIME_MISMATCH');
    prune();
    invariant(event.provenance === proof.identity.provenance || (proof.identity.kind === 'image' && event.provenance === 'rendered-preview'), 'ARTIFACT_PROVENANCE_INVALID');
    const key = fingerprint([request,proof.identity,proof.revision,metadata,event.provenance]), previous = byKey.get(key);
    if (previous) { validateOwner(previous,event); return clone(previous.receipt); }
    invariant(owners.size < 256, 'ARTIFACT_UPLOAD_LIMIT');
    const {uploadId} = artifacts.begin(metadata);
    const owner = { uploadId,key,request,proof,metadata,provenance:event.provenance,created:Date.now(),chunks:new Map(),nextOffset:0,tail:Promise.resolve(),busy:false,receipt:{uploadId} };
    try { validateOwner(owner,event); } catch (error) { artifacts.abort(uploadId); throw error; }
    owners.set(uploadId,owner); byKey.set(key,owner);
    return clone(owner.receipt);
  }
  async function chunk(event) {
    const owner = lookup(event);
    return queued(owner,async () => {
      validateOwner(owner,event);
      invariant(Number.isSafeInteger(event.offset) && event.offset >= 0 && event.offset % 4 === 0, 'ARTIFACT_OFFSET_INVALID');
      invariant(typeof event.data === 'string' && event.data.length > 0 && event.data.length <= ARTIFACT_LIMITS.chunk, 'ARTIFACT_DATA_INVALID');
      const digest = fingerprint(event.data), previous = owner.chunks.get(event.offset);
      if (previous) {
        invariant(previous.digest === digest, 'ARTIFACT_CHUNK_CONFLICT');
        validateOwner(owner,event); return clone(previous.receipt);
      }
      invariant(!owner.resource && !owner.item, 'ARTIFACT_UPLOAD_COMMITTED');
      const accepted = await artifacts.append(owner.uploadId,{offset:event.offset,data:event.data});
      validateOwner(owner,event);
      const receipt = {uploadId:owner.uploadId,offset:event.offset,...accepted};
      owner.chunks.set(event.offset,{digest,receipt}); owner.nextOffset=accepted.nextOffset; return clone(receipt);
    });
  }
  async function commit(event) {
    const owner = lookup(event);
    return queued(owner,async () => {
      validateOwner(owner,event);
      if (owner.item) return clone(owner.item);
      invariant(owner.nextOffset === null, 'ARTIFACT_INCOMPLETE');
      // A failed state.json publish may be retried without consuming the blob
      // upload twice. This metadata exists only after ArtifactStore validation.
      if (!owner.resource) {
        try { owner.resource=await artifacts.commit(owner.uploadId); }
        catch (error) { remove(owner); throw error; }
      }
      validateOwner(owner,event);
      return publish(owner,event,owner.resource);
    });
  }
  async function unsupported(event) {
    const initial = authorize(event);
    invariant(reasons.has(event.reason), 'ARTIFACT_REASON_INVALID');
    const result = await store.transaction(data => {
      const {session,proof} = authorize(event,data), previous = historyRow(session,event.sourceId);
      invariant(proof.revision === initial.proof.revision, 'ARTIFACT_SOURCE_CHANGED');
      // A temporary missing DOM/expired resource is not evidence that already
      // stored original bytes ceased to exist. Preserve the available card.
      if (previous?.data.status === 'available') return {item:previous,changed:false};
      const item = { type:'plugin',pluginId:'chatmode-in-paseo',id:'artifact:'+proof.identity.sourceId,
        kind:'generated-file',version:1,data:{...proof.identity,sourceText:proof.sourceText,status:'unsupported',reason:event.reason} };
      const changed = !same(previous,item);
      if (changed) {
        session.history ??= [];
        const index = session.history.findIndex(row => row.id === item.id);
        if (index < 0) session.history.push(item); else session.history[index] = item;
      }
      return {item,changed};
    });
    invariant(authorize(event).proof.revision === initial.proof.revision, 'ARTIFACT_SOURCE_CHANGED');
    if (result.changed) await emit({id:event.sessionId,state:'artifact',item:clone(result.item)});
    return clone(result.item);
  }
  function readGrant(input) {
    invariant(object(input), 'ARTIFACT_READ_INVALID');
    const id = identifier(input.sessionId); sourceId(input.sourceId);
    invariant(typeof input.digest === 'string' && /^[a-f0-9]{64}$/.test(input.digest), 'ARTIFACT_UNKNOWN');
    const data = store.read(), session = Object.hasOwn(data.sessions,id) ? data.sessions[id] : null;
    invariant(session, 'SESSION_UNKNOWN');
    const row = historyRow(session,input.sourceId);
    invariant(row?.kind === 'generated-file' && row.data.status === 'available' && row.data.resource?.digest === input.digest, 'ARTIFACT_UNKNOWN');
    return artifactMetadata(row.data.resource);
  }
  async function read(input) {
    const metadata = readGrant(input), result = await artifacts.read(metadata,{offset:input.offset ?? 0});
    invariant(same(readGrant(input),metadata), 'ARTIFACT_UNKNOWN'); return result;
  }
  return Object.freeze({begin,chunk,commit,unsupported,read});
}
