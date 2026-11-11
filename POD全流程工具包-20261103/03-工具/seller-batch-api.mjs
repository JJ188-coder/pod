// TikTok Shop MX 批量发品 API 客户端（经站斧页面同源上下文执行）。
// 已实测：analysis 可直接调用；pre_check 有重复文件保护；publish 需页面版本上下文（见 PUBLISH_GATE）。
// 认证、Cookie、BDMS 签名全部留在浏览器内，本模块只下发 fetch/XHR 表达式，不导出任何凭据。
import { evalInTab } from './zhanfu-bridge.mjs';

export const ENDPOINTS = Object.freeze({
  uploadCreate: '/api/v1/product/excel/create/upload',      // POST multipart(file)
  uploadEdit: '/api/v1/product/excel/edit/upload',          // POST multipart(file)
  analysis: '/api/v1/product/excel/analysis',               // POST multipart(file)
  preCheck: '/api/v1/product/excel/pre_check',              // POST multipart(file[,wass_oid])
  publish: '/api/v1/product/excel/publish',                 // POST json — 见 PUBLISH_GATE
  reflect: '/api/v1/product/excel/reflect',                 // POST multipart
  templateCreate: '/api/v1/product/excel/template/create',  // POST json
  downloadTask: '/api/v1/product/excel/download_task/create',
  templateVersion: '/api/v1/product/excel_version/template/get', // GET
  uploadTaskList: '/api/v1/product/upload_task/list',
});

export const PUBLISH_GATE = Object.freeze({
  code: 12052588,
  message: 'This page is outdated. Please go to the latest page here: seller-mx.tiktok.com/product/batch/publish',
  meaning: 'publish 是写接口，需要页面版本/签名上下文；纯外部 XHR 被拒。analysis/pre_check 不受影响。',
  workaround: '最终 publish 由页面自身按钮触发（脚本注入文件后点一次），其余步骤可走 API。',
});

export const DUPLICATE_GATE = Object.freeze({
  code: 12001038,
  message: 'The uploaded file is a duplicate',
  meaning: '同一份文件（同 sha）重复上传会被平台拒绝；这是幂等保护，重跑前应先查导入历史而不是改文件。',
});

// 页面内通用助手：把本地服务上的文件按 multipart 提交，或提交 JSON。
const PAGE_HELPER = `
window.__sba = window.__sba || {};
window.__sba.postFile = function(uploadUrl, fileUrl, fileName, fields, timeoutMs){
  return new Promise(function(resolve){
    fetch(fileUrl).then(function(r){ if(!r.ok) throw new Error('LOCAL_FILE_'+r.status); return r.arrayBuffer(); })
    .then(function(buf){
      var fd=new FormData();
      fd.append('file', new File([buf], fileName, {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      Object.keys(fields||{}).forEach(function(k){ fd.append(k, fields[k]); });
      var x=new XMLHttpRequest(); x.open('POST', uploadUrl, true);
      x.timeout=timeoutMs||120000;
      x.onload=function(){ var j=null; try{j=JSON.parse(x.responseText);}catch(e){}
        resolve({http:x.status, code:j?j.code:null, message:j?(j.message||j.msg):String(x.responseText).slice(0,300), data:j?j.data:null}); };
      x.onerror=function(){ resolve({http:0,code:null,message:'NETWORK_ERROR'}); };
      x.ontimeout=function(){ resolve({http:0,code:null,message:'TIMEOUT'}); };
      x.send(fd);
    }).catch(function(e){ resolve({http:0,code:null,message:String(e&&e.message||e)}); });
  });
};
window.__sba.postJSON = function(url, body, timeoutMs){
  return new Promise(function(resolve){
    var x=new XMLHttpRequest(); x.open('POST', url, true);
    x.setRequestHeader('Content-Type','application/json'); x.timeout=timeoutMs||120000;
    x.onload=function(){ var j=null; try{j=JSON.parse(x.responseText);}catch(e){}
      resolve({http:x.status, code:j?j.code:null, message:j?(j.message||j.msg):String(x.responseText).slice(0,300), data:j?j.data:null}); };
    x.onerror=function(){ resolve({http:0,code:null,message:'NETWORK_ERROR'}); };
    x.ontimeout=function(){ resolve({http:0,code:null,message:'TIMEOUT'}); };
    x.send(JSON.stringify(body||{}));
  });
};
'ok';
`;

async function ensureHelper(pid, index) {
  const r = await evalInTab(pid, index, PAGE_HELPER);
  if (r !== 'ok') throw Error('PAGE_HELPER_INSTALL_FAILED');
}

/** 轮询等待页面内的 Promise 结果（Apple Events 单次只取同步值）。 */
async function awaitPage(pid, index, key, { timeoutMs = 180000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await evalInTab(pid, index, `JSON.stringify(window.__sba_result && window.__sba_result.${key} || null)`);
    const value = JSON.parse(raw);
    if (value) return value;
    if (Date.now() > deadline) throw Error('PAGE_AWAIT_TIMEOUT');
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

async function runAsync(pid, index, key, kickoffExpr) {
  await evalInTab(pid, index, `
    window.__sba_result = window.__sba_result || {};
    delete window.__sba_result.${key};
    (function(){ ${kickoffExpr} })();
    'started';
  `);
  return awaitPage(pid, index, key);
}

/**
 * 解析并返回分析结果：product_count / sku_count / wass_oid。
 * 文件通过本地 127.0.0.1 服务传入页面，不经过 Apple Events 表达式，故不受 2MB 限制。
 */
export async function analyseXlsx(pid, index, { uploadUrl = ENDPOINTS.analysis, fileUrl, fileName, fields = {} } = {}) {
  await ensureHelper(pid, index);
  return runAsync(pid, index, 'analysis', `
    window.__sba.postFile(${JSON.stringify(uploadUrl)}, ${JSON.stringify(fileUrl)}, ${JSON.stringify(fileName)}, ${JSON.stringify(fields)})
      .then(function(v){ window.__sba_result.analysis = v; });
  `);
}

/** 预检。返回 {code:0} 表示通过；12001038 表示该文件曾被上传（幂等保护）。 */
export async function preCheckXlsx(pid, index, { fileUrl, fileName, wassOid } = {}) {
  await ensureHelper(pid, index);
  const fields = wassOid ? { wass_oid: wassOid } : {};
  return runAsync(pid, index, 'precheck', `
    window.__sba.postFile(${JSON.stringify(ENDPOINTS.preCheck)}, ${JSON.stringify(fileUrl)}, ${JSON.stringify(fileName)}, ${JSON.stringify(fields)})
      .then(function(v){ window.__sba_result.precheck = v; });
  `);
}

/**
 * 发布。当前实测被 PUBLISH_GATE 拒绝；保留实现以便页面上下文变化后可直接启用。
 * 调用方必须自己确认授权，并先用 analyseXlsx 读到 wass_oid。
 */
export async function publishXlsx(pid, index, { wassOid, extra = {} } = {}) {
  if (!wassOid) throw Error('WASS_OID_REQUIRED');
  await ensureHelper(pid, index);
  const body = { wass_oid: wassOid, ...extra };
  return runAsync(pid, index, 'publish', `
    window.__sba.postJSON(${JSON.stringify(ENDPOINTS.publish)}, ${JSON.stringify(body)})
      .then(function(v){ window.__sba_result.publish = v; });
  `);
}

/** 读商品管理页当前标签页的真实计数与首屏商品 ID。 */
export async function readProductManage(pid, index) {
  const raw = await evalInTab(pid, index, `JSON.stringify((()=>{
    const t=document.body.innerText||'';
    const tabs=[...new Set([...t.matchAll(/(在售|审核中|需要关注|已下架|草稿|已删除)\\s*(\\d+)?/g)].map(m=>m[1]+(m[2]?' '+m[2]:'')))];
    const ids=[...new Set([...t.matchAll(/ID:(\\d{16,20})/g)].map(m=>m[1]))];
    const total=(t.match(/总行数:\\s*(\\d+)/)||[])[1]||null;
    return {url:location.href.split('?')[0],tabs,ids,total};
  })())`);
  return JSON.parse(raw);
}
