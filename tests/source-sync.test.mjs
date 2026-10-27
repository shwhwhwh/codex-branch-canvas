import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasService } from '../src/service.mjs';
import { completedConversation, syncCompletedConversation } from '../src/import.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CodexClient } from '../src/codex.mjs';
const turn = id => ({ id, status: 'completed', items: [
  { id: 'u'+id, type:'userMessage', content:[{type:'text',text:id}] },
  { id:'a'+id,type:'agentMessage',text:'answer '+id,phase:'final_answer' }
] });
const thread = (id, turns=['one']) => ({id,name:id,cwd:process.cwd(),turns:turns.map(turn)});
test('incremental source synchronization preserves branches, selection, jobs and atomic rollback', async () => {
  const service = new CanvasService({filename:':memory:',seed:false});
  try {
    const db = service.store.db;
    const first = syncCompletedConversation(db, completedConversation(thread('A')));
    const root = service.store.nodes(first.treeId)[0];
    const draft = service.store.createDraft(first.treeId,root.id,'keep me');
    service.store.queue('job',draft.id,'keep me');
    const second = syncCompletedConversation(db,completedConversation(thread('A',['one','two'])));
    assert.equal(first.treeId,second.treeId); assert.equal(second.added,1);
    assert.equal(service.store.tree(first.treeId).selectedId,draft.id);
    assert.equal(service.store.node(draft.id).status,'queued');
    assert.equal(syncCompletedConversation(db,completedConversation(thread('A',['one','two']))).added,0);
    const b = syncCompletedConversation(db,completedConversation(thread('B'))); assert.notEqual(b.treeId,first.treeId);
    const broken = completedConversation(thread('A',['one','two','three'])); broken.turns[2].items.push(broken.turns[2].items[0]);
    assert.throws(()=>syncCompletedConversation(db,broken),/UNIQUE/);
    assert.equal(service.store.nodes(first.treeId).length,3);
  } finally { await service.close(); }
});
test('MCP host metadata chooses the exact chat over stale tree and untrusted args; missing identity does not guess', async () => {
  const reads=[];
  const service = new CanvasService({filename:':memory:',seed:true,client:{
    readConversation:async id=>{reads.push(id);return thread(id);},close(){}
  }});
  const server = createMcpServer(service), client = new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const call = async (id, treeId) => (await client.callTool({name:'canvas_action',arguments:{action:'state',args:{followCurrent:true,treeId,sourceThreadId:'wrong'}},...(id?{_meta:{thread_id:id}}:{})}))._meta.canvas;
    const first = await call('A'); const second=await call('B',first.tree.id);
    assert.equal(first.sourceSync.sourceThreadId,'A'); assert.equal(second.sourceSync.sourceThreadId,'B');
    assert.notEqual(first.tree.id,second.tree.id);
    assert.equal((await call('A',second.tree.id)).tree.id,first.tree.id);
    assert.equal((await call(null,second.tree.id)).tree.id,second.tree.id);
    assert.deepEqual(reads,['A','B']);
  } finally {await client.close();await server.close();await service.close();}
});
test('paginated conversation reads all full-item pages without resuming or generating', async () => {
  const client = new CodexClient(), calls=[];
  client.connect=async()=>{};
  client.request=async(method,args)=>{
    calls.push({method,args});
    if(method==='thread/read')return {thread:{...thread('A',[]),historyMode:'paginated'}};
    return args.cursor ? {data:[turn('two')],nextCursor:null} : {data:[turn('one')],nextCursor:'next'};
  };
  assert.deepEqual((await client.readConversation('A')).turns.map(t=>t.id),['one','two']);
  assert.deepEqual(calls.map(c=>c.method),['thread/read','thread/turns/list','thread/turns/list']);
  assert(calls.slice(1).every(c=>c.args.itemsView==='full'&&c.args.sortDirection==='asc'));
});
test('empty conversations stay usable; unfinished answers are never imported', async () => {
  const service=new CanvasService({filename:':memory:',seed:false});
  try {
    const native=thread('empty',[]); native.turns.push({...turn('active'),status:'inProgress'});
    const result=syncCompletedConversation(service.store.db,completedConversation(native,{allowEmpty:true}));
    const nodes=service.store.nodes(result.treeId); assert.equal(nodes.length,1);assert.equal(nodes[0].status,'draft');
    assert.equal(nodes[0].answer,'');
    assert.equal(syncCompletedConversation(service.store.db,completedConversation(native,{allowEmpty:true})).treeId,result.treeId);
  }finally{await service.close();}
});
