/* OFFLINE FIXTURE: deliberately synthetic page state, never real account/model data.
 * The real transplanted Fiber reader must discover this state; no reply messages are mocked.
 */
window.fixtureRealRoute = true;
const oldModel=document.getElementById('model');oldModel.remove();document.getElementById('thinking').remove();
const pickerButton=document.createElement('button');pickerButton.type='button';pickerButton.id='native-picker';
pickerButton.setAttribute('data-composer-navigation-target','reasoning');pickerButton.setAttribute('aria-haspopup','menu');
pickerButton.textContent='Native model fixture';box.closest('form').prepend(pickerButton);
const makeChoice=(family,bucket,effort)=>({bucket,modelSlug:family+'-thinking',thinkingEffort:effort,
 category:{modelVersion:family,shortLabel:family,modelLane:'thinking'},availability:{status:'available'},modelConfig:{title:family}});
const versions=[{id:'model1',displayTextForIntelligence:'Model 1',enabled:true},{id:'model2',displayTextForIntelligence:'Model 2',enabled:true}];
window.nativeChoices={model1:[makeChoice('model1',0,'standard'),makeChoice('model1',1,'extended')],model2:[makeChoice('model2',0,'standard')]};
window.nativeState={selectedVersionEntry:versions[0],bucketSelections:nativeChoices.model1,currentBucket:0,currentSelection:nativeChoices.model1[0]};
window.nativeProps={composerIntelligencePickerState:nativeState,modelsData:{versions}};
const rootState={current:null};const root={tag:3,stateNode:rootState,return:null};rootState.current=root;
const owner={tag:0,memoizedProps:nativeProps,return:root};root.child=owner;
function publishProps(){owner.memoizedProps=window.nativeProps;pickerButton.__reactFiber$fixture=owner;const panel=document.querySelector('[data-testid="composer-intelligence-picker-content"]');if(panel)panel.__reactFiber$fixture=owner;pickerButton.textContent='Fixture '+(window.nativeProps.composerIntelligencePickerState?.currentSelection?.thinkingEffort||'shell');}
window.nativeOwner=owner;window.nativeRoot=root;
function selectVersion(id){nativeState.selectedVersionEntry=versions.find(v=>v.id===id);nativeState.bucketSelections=nativeChoices[id];nativeState.currentBucket=0;nativeState.currentSelection=nativeChoices[id][0];renderPicker();}
function renderPicker(showVersions=false){document.querySelector('[data-testid="composer-intelligence-picker-content"]')?.remove();const panel=document.createElement('div');panel.setAttribute('data-testid','composer-intelligence-picker-content');panel.role='menu';panel.tabIndex=-1;
 if(showVersions){for(const v of versions){const row=document.createElement('button');row.type='button';row.role='menuitemradio';row.textContent=v.displayTextForIntelligence;row.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();selectVersion(v.id)}};panel.append(row)}}else{
 const toggle=document.createElement('button');toggle.type='button';toggle.role='menuitem';toggle.setAttribute('aria-expanded','false');toggle.textContent='Versions';toggle.onclick=()=>renderPicker(true);panel.append(toggle);
 const effort=document.createElement('button');effort.type='button';effort.role='menuitem';effort.setAttribute('aria-keyshortcuts','ArrowRight ArrowLeft');effort.textContent=nativeState.currentSelection.thinkingEffort;effort.onkeydown=e=>{if(!['ArrowRight','ArrowLeft'].includes(e.key))return;e.preventDefault();const i=nativeState.bucketSelections.findIndex(c=>c.bucket===nativeState.currentBucket)+(e.key==='ArrowRight'?1:-1);if(i>=0&&i<nativeState.bucketSelections.length){nativeState.currentSelection=nativeState.bucketSelections[i];nativeState.currentBucket=nativeState.currentSelection.bucket;renderPicker()}};panel.append(effort)}
 panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();panel.remove();publishProps()}});document.body.append(panel);publishProps();}
pickerButton.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();renderPicker()}});publishProps();
const toggle=document.createElement('div');toggle.id='chat-work';for(const value of ['chatgpt','work']){const radio=document.createElement('button');radio.type='button';radio.role='radio';radio.setAttribute('data-tpp-toggle-value',value);radio.setAttribute('aria-checked',String(value==='work'));radio.textContent=value;radio.onclick=()=>{for(const n of toggle.children)n.setAttribute('aria-checked',String(n===radio))};toggle.append(radio)}document.body.prepend(toggle);
