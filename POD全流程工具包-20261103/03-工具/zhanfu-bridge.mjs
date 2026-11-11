// 站斧 PID 绑定桥：原版站斧没有标准 CDP，用 Apple Events 的 ExJa 在指定 tab 执行页面 JS。
// 本模块只做「发指令 + 取结果」，不含业务判断；所有写操作由调用方显式决定。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);

const JXA = `
ObjC.import('Foundation');
function fourCC(t){return t.split('').reduce(function(n,c){return n*256+c.charCodeAt(0);},0);}
var AED=$.NSAppleEventDescriptor;
function spec(want,form,sel,parent){var v=AED.recordDescriptor;v.setDescriptorForKeyword(AED.descriptorWithTypeCode(fourCC(want)),fourCC('want'));v.setDescriptorForKeyword(AED.descriptorWithEnumCode(fourCC(form)),fourCC('form'));v.setDescriptorForKeyword(sel,fourCC('seld'));v.setDescriptorForKeyword(parent||AED.nullDescriptor,fourCC('from'));return v.coerceToDescriptorType(fourCC('obj '));}
function property(n,p){return spec('prop','prop',AED.descriptorWithTypeCode(fourCC(n)),p);}
function send(pid,ec,ei,target,js){var e=AED.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(fourCC(ec),fourCC(ei),AED.descriptorWithProcessIdentifier(pid),-1,0);e.setParamDescriptorForKeyword(target,fourCC('----'));if(js!==undefined)e.setParamDescriptorForKeyword(AED.descriptorWithString(js),fourCC('JvSc'));var err=Ref();var r=e.sendEventWithOptionsTimeoutError(3,30,err);if(!r)throw new Error('APPLE_EVENT_FAILED: '+ObjC.unwrap(err[0].localizedDescription));var num=r.paramDescriptorForKeyword(fourCC('errn'));if(num&&Number(num.int32Value)){var d=r.paramDescriptorForKeyword(fourCC('errs'));throw new Error('APPLE_EVENT_'+Number(num.int32Value)+': '+(d?ObjC.unwrap(d.stringValue):''));}return r.paramDescriptorForKeyword(fourCC('----'));}
function text(d){return ObjC.unwrap(d.stringValue);}
function run(argv){
 var pid=Number(argv[0]), mode=argv[1];
 var w=spec('cwin','indx',AED.descriptorWithInt32(1));
 if(mode==='tabs'){
  var out={windowName:null,tabs:[]};
  try{out.windowName=text(send(pid,'core','getd',property('pnam',w)));}catch(e){}
  for(var i=1;i<=25;i++){
   var t=spec('CrTb','indx',AED.descriptorWithInt32(i),w);
   try{out.tabs.push({index:i,title:String(text(send(pid,'core','getd',property('pnam',t)))||''),url:String(text(send(pid,'core','getd',property('URL ',t)))||'')});}
   catch(e){if(/APPLE_EVENT_-1719|APPLE_EVENT_-1728/.test(String(e)))break;throw e;}
  }
  try{out.windowName=text(send(pid,'core','getd',property('pnam',w)));}catch(e){}
  return JSON.stringify(out);
 }
 if(mode==='eval'){
  var index=Number(argv[2]), expr=argv[3];
  var tab=spec('CrTb','indx',AED.descriptorWithInt32(index),w);
  return text(send(pid,'CrSu','ExJa',tab,expr));
 }
 throw new Error('MODE_REQUIRED');
}
`;

async function runJxa(args) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zf-'));
  const file = path.join(dir, 'bridge.js');
  await fs.writeFile(file, JXA, 'utf8');
  try {
    const { stdout } = await exec('osascript', ['-l', 'JavaScript', file, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
    return stdout.trim();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

export const SELLER_ORIGIN = 'https://seller-mx.tiktok.com';

/** 列出某个站斧实例的全部标签页（窗口名=店铺标识）。 */
export async function listTabs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('ZHANFU_PID_REQUIRED');
  return JSON.parse(await runJxa([String(pid), 'tabs']));
}

/** 在指定 tab 执行 JS 表达式（同步返回字符串）。seller 域外默认拒绝。 */
export async function evalInTab(pid, index, expression, { requireSellerOrigin = true } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('ZHANFU_PID_REQUIRED');
  if (!Number.isInteger(index) || index < 1) throw Error('ZHANFU_TAB_INDEX_REQUIRED');
  if (typeof expression !== 'string' || !expression.trim()) throw Error('ZHANFU_EXPRESSION_REQUIRED');
  if (requireSellerOrigin) {
    const { tabs } = await listTabs(pid);
    const tab = tabs.find(t => t.index === index);
    if (!tab) throw Error('ZHANFU_TAB_NOT_FOUND');
    if (!tab.url.startsWith(SELLER_ORIGIN)) throw Error('SELLER_ORIGIN_MISMATCH');
  }
  return runJxa([String(pid), 'eval', String(index), expression]);
}

/** 找到 seller-mx 上匹配 predicate 的标签页，返回 index。 */
export async function findTab(pid, predicate) {
  const { tabs, windowName } = await listTabs(pid);
  const hit = tabs.filter(t => t.url.startsWith(SELLER_ORIGIN)).find(t => predicate(t));
  return hit ? { ...hit, windowName } : null;
}

/** 起一个 127.0.0.1 CORS 文件服务，供页面 fetch 取本地上传件。 */
export async function serveLocalFiles(rootDir, port = 0) {
  const http = await import('node:http');
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Cache-Control': 'no-store',
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const name = path.basename(decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname));
    try {
      const buf = await fs.readFile(path.join(rootDir, name));
      res.writeHead(200, { ...CORS, 'Content-Length': buf.length });
      res.end(buf);
    } catch { res.writeHead(404, CORS); res.end('not found'); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise(r => server.close(r)) };
}
