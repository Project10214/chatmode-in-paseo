// Offline test process: temporary Store + real Broker, no HTTP or browser control.
import readline from 'node:readline';
import {fixture} from '../helpers.mjs';
const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)});
const initial=await f.ready();await f.sending(initial);
const session=()=>f.broker.snapshot(initial.id);
const binding=()=>{const s=session();return {sessionId:s.id,observationLease:s.observation.lease,
  tabId:s.tabId,documentKey:s.documentKey,url:'https://chatgpt.com/c/'+s.conversationId,conversationId:s.conversationId};};
process.stdout.write(JSON.stringify({binding:binding()})+'\n');
try {
  for await(const line of readline.createInterface({input:process.stdin})) {
    let value;
    try {
      const message=JSON.parse(line);
      if(message.op==='close'){process.stdout.write('{"closed":true}\n');break;}
      if(message.op==='view') value=await f.view(initial,{state:'standby',items:message.view.items,
        approvals:message.view.approvals,closedApprovals:message.view.closedApprovals,issues:message.view.issues});
      else if(message.op==='snapshot')value=session();
      else if(message.op==='read')value=await f.broker.artifactTransfer.read(message.input);
      else if(message.op==='rpc'){
        const methods={'artifact-begin':'begin','artifact-chunk':'chunk','artifact-commit':'commit','artifact-unsupported':'unsupported'};
        const method=methods[message.event.type];if(!method)throw Error('UNEXPECTED_RPC');
        value=await f.broker.artifactTransfer[method](message.event);
      } else if(message.op!=='view')throw Error('UNEXPECTED_OPERATION');
      process.stdout.write(JSON.stringify({value})+'\n');
    } catch(error){process.stdout.write(JSON.stringify({error:error.code??error.message})+'\n');}
  }
} finally {for(const fn of cleanup.reverse())await fn();}
