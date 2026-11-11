import assert from 'node:assert/strict';
import test from 'node:test';
import { EchoTikSDK } from '../index.mjs';

test('复用已有CDP连接，启用Page后初始化，关闭SDK不关闭共享连接', async () => {
  const calls = [];
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor() { throw new Error('must not reconnect'); } };
  const connection = {
    async attachToEchoTikPage() { calls.push('attach'); return { sessionId: 'local-test-session' }; },
    async send(method) { calls.push(method); return { identifier: 'local-test-script' }; },
    async evaluate(_session, expression) {
      if (expression.includes('.dispose(')) return JSON.stringify({ ok: true });
      return JSON.stringify({ ok: true, captured: true, paused: false });
    },
    async detach() { calls.push('detach'); },
    close() { calls.push('close-shared-connection'); },
  };
  let sdk;
  try {
    sdk = await EchoTikSDK.open({ connection });
    assert.equal(sdk.status().ready, true);
    assert.ok(calls.indexOf('Page.enable') >= 0);
    assert.ok(calls.indexOf('Page.enable') < calls.indexOf('Page.addScriptToEvaluateOnNewDocument'));
    assert.ok(calls.indexOf('Page.addScriptToEvaluateOnNewDocument') < calls.indexOf('Page.reload'));
    await sdk.close();
    assert.ok(calls.includes('Page.removeScriptToEvaluateOnNewDocument'));
    assert.ok(calls.includes('detach'));
    assert.ok(!calls.includes('close-shared-connection'));
  } finally {
    await sdk?.close();
    globalThis.WebSocket = originalWebSocket;
  }
});

test('共享连接断开后状态立即不可用，读取不再发起请求', async () => {
  let open = true;
  let reads = 0;
  const connection = {
    isOpen: () => open,
    async attachToEchoTikPage() { return { sessionId: 'test-session' }; },
    async send() { return { identifier: 'test-script' }; },
    async evaluate(_session, expression) {
      if (expression.includes('.read(')) reads++;
      return JSON.stringify({ ok: true, captured: true, paused: false });
    },
    async detach() {},
  };
  const sdk = await EchoTikSDK.open({ connection });
  try {
    open = false;
    assert.equal(sdk.status().ready, false);
    await assert.rejects(sdk.rankings({ period: 'weekly', range: '20261012-20261018', country: 'MX' }),
      error => error.code === 'EDGE_CDP_CLOSED');
    assert.equal(reads, 0);
  } finally { await sdk.close(); }
});

test('显式六榜预算在SDK状态与页面桥保持一致，越界预算不连接页面',async()=>{
  const {runInNewContext}=await import('node:vm');
  const {BRIDGE_GLOBAL}=await import('../lib/constants.mjs');
  let remaining;
  const connection={async attachToEchoTikPage(){return {sessionId:'budget-test'};},async send(method,params){if(method==='Page.addScriptToEvaluateOnNewDocument'){const c={Headers,URL,URLSearchParams,fetch:async()=>{},location:{origin:'https://echotik.live',href:'https://echotik.live/board'}};runInNewContext(params.source,c);remaining=c[BRIDGE_GLOBAL].state().remaining;}return {identifier:'budget-script'};},async evaluate(){return JSON.stringify({ok:true,captured:true,paused:false});},async detach(){}};
  const sdk=await EchoTikSDK.open({connection,maxRequests:6});
  try{assert.equal(remaining,6);assert.equal(sdk.status().requests_remaining,6);assert.equal(sdk.status().max_new_requests,6);}finally{await sdk.close();}
  let touched=false;
  await assert.rejects(EchoTikSDK.open({maxRequests:9,connection:{attachToEchoTikPage(){touched=true;}}}),/BUDGET/);
  assert.equal(touched,false);
});
