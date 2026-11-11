import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import * as source from '../lib/bridge.mjs';
import { BRIDGE_GLOBAL } from '../lib/constants.mjs';
import { RequestGovernor } from '../lib/governor.mjs';

async function fixture(script = source.BRIDGE_SOURCE) {
  let clock = 0;
  let requests = 0;
  class Clock extends Date { static now() { return clock; } }
  const nativeFetch = async () => { requests++; return {ok:true,status:200,text:async()=>'{"code":0,"data":[{"product_id":1737423637648869219}],"meta":{}}'}; };
  const context = vm.createContext({Date:Clock,Headers,URL,URLSearchParams,fetch:nativeFetch,location:{origin:'https://echotik.live',href:'https://echotik.live/products/leaderboard/top-sold'},setTimeout});
  vm.runInContext(script,context);
  await context.fetch('https://echotik.live/api/v1/data/products/product-category',{headers:{authorization:'LOCAL_TEST_SENTINEL','x-user-id':'LOCAL_TEST_USER'}});
  return {bridge:context[BRIDGE_GLOBAL],advance:()=>{clock+=1500;},calls:()=>requests};
}
function query(period,range) {
  return {path:'/api/v1/data/products/leaderboard/top-sold',country:'MX',params:[['time_type',period],['time_range',range],['page','1'],['product_categories[]','824328'],['product_categories[]','839944'],['product_categories[]','601226'],['order','sale_cnt'],['per_page','20']]};
}
test('single-day daily request reaches normal same-origin bridge; mismatched period shapes do not',async()=>{
  const f=await fixture();
  for(const [period,range] of [['daily','20261023-20261023'],['weekly','20261023'],['monthly','20261023']]) {
    const r=await f.bridge.read(query(period,range));assert.equal(r.ok,false);assert.equal(r.error,'INVALID_REQUEST');
  }
  assert.equal(f.calls(),1);
  const r=await f.bridge.read(query('daily','20261023'));
  assert.equal(r.ok,true);assert.equal(r.body.data[0].product_id,'1737423637648869219');assert.equal(f.calls(),2);
  assert.doesNotMatch(JSON.stringify(r)+JSON.stringify(f.bridge.state()),/LOCAL_TEST_SENTINEL|LOCAL_TEST_USER/);
});
test('explicit six-board budget stops the seventh call and retains interval guard',async()=>{
  assert.equal(typeof source.createBridgeSource,'function');
  assert.throws(()=>source.createBridgeSource({maxRequests:9}),/BUDGET/);
  const f=await fixture(source.createBridgeSource({maxRequests:6}));
  const first=await f.bridge.read(query('daily','20261023'));assert.equal(first.ok,true);
  const early=await f.bridge.read(query('daily','20261023'));assert.equal(early.error,'MIN_INTERVAL');
  for(let i=1;i<6;i++){f.advance();assert.equal((await f.bridge.read(query('daily','20261023'))).ok,true);}
  f.advance();assert.equal((await f.bridge.read(query('daily','20261023'))).error,'REQUEST_LIMIT');assert.equal(f.calls(),7);
});
test('governor accepts an explicit six-query plan while keeping default five and a bounded maximum',async()=>{
  let clock=0;const g=new RequestGovernor({maxRequests:6,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  let calls=0;
  for(let i=0;i<6;i++)await g.run(async()=>++calls);
  await assert.rejects(g.run(async()=>++calls),e=>e.code==='REQUEST_LIMIT');assert.equal(calls,6);assert.equal(g.remaining,0);
  assert.throws(()=>new RequestGovernor({maxRequests:9}),/BUDGET/);
});
