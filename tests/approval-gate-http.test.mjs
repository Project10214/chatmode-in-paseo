import test from 'node:test';
import assert from 'node:assert/strict';
import { httpHarness } from './fixtures/runtime-http.mjs';
import { pageView, until } from './helpers.mjs';

test('APPROVAL-GATE-HTTP: authenticated pre-click gate rejects disabled/revoked auto intent',async t=>{
  const h=await httpHarness(t);
  const {session}=await h.bound();
  const broker=h.runtime.broker;
  const key='6f1c2d3e-0000-4000-8000-000000000090';
  const card={key,app:'mymac',tool:'run_shell_command',input:'{"args":{"command":"echo test"}}',
    clickable:true,canDeny:true,allowLabel:'Allow once',denyLabel:'Deny',
    labels:['Allow once','Deny'],autoEligible:true,autoTier:'once'};
  await broker.observeView(pageView(broker.snapshot(session.id),{state:'standby',approvals:[card]}));
  await broker.setAutoAllowApprovals(true);
  const task=broker.answerApproval(session.id,key,'allow-auto');task.catch(()=>{});
  const command=await until(()=>broker.queued().find(c=>c.kind==='approval'));
  const bound=broker.snapshot(session.id);
  const claim=await broker.claim(command.id,bound.tabId,bound.documentKey);
  const input={id:command.id,lease:claim.lease};
  const unauthenticated=await h.request('/verify-approval',input);
  assert.equal(unauthenticated.status,403);
  assert.equal((await (await h.signed('/verify-approval',input)).json()).allowed,true);
  const stolen=await h.signed('/verify-approval',{...input,lease:'different-lease'});
  assert.equal(stolen.status,400);
  assert.equal((await stolen.json()).error,'APPROVAL_NOT_AUTHORIZED');
  await broker.setAutoAllowApprovals(false);
  const revoked=await h.signed('/verify-approval',input);
  assert.equal(revoked.status,400);
  assert.equal((await revoked.json()).error,'APPROVAL_VETOED');
  await broker.result(command.id,claim.lease,{error:'APPROVAL_VETOED'});
  await assert.rejects(task,e=>e.code==='APPROVAL_VETOED');
  assert.equal(broker.snapshot(session.id).approvals[key].state,'open');
  assert.equal(Object.values(h.runtime.store.read().commands).filter(c=>c.kind==='send').length,1,
    'approval verification must never create a second native Send');
});
