#!/usr/bin/env node
/**
 * 只读 CDP 小工具：在已登录的 echotik.live 页面里执行一段表达式并打印结果。
 * 只用于本地调试与接口探测，不写入页面状态。
 *
 * 用法：
 *   node tools/cdp-eval.mjs --cdp http://127.0.0.1:9223 --expr 'document.title'
 *   node tools/cdp-eval.mjs --cdp http://127.0.0.1:9223 --file ./expr.js
 *   node tools/cdp-eval.mjs --cdp http://127.0.0.1:9223 --navigate 'https://echotik.live/...'
 */

import { readFile } from 'node:fs/promises';

const args = { cdp: 'http://127.0.0.1:9223', target: null, expr: null, file: null, navigate: null };
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
  if (!match) throw new Error(`未知参数：${token}`);
  const name = match[1];
  const value = match[2] !== undefined ? match[2] : process.argv[++i];
  if (name === 'cdp') args.cdp = value;
  else if (name === 'target') args.target = value;
  else if (name === 'expr') args.expr = value;
  else if (name === 'file') args.file = value;
  else if (name === 'navigate') args.navigate = value;
  else throw new Error(`未知参数：--${name}`);
}

const CDP = args.cdp.replace(/\/+$/, '');

class Cdp {
  #socket; #id = 1; #pending = new Map();
  static async connect(url) {
    const cdp = new Cdp();
    const socket = new WebSocket(url);
    cdp.#socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 握手超时')), 15_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 握手失败')); }, { once: true });
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) return;
      const pending = cdp.#pending.get(message.id);
      if (!pending) return;
      cdp.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'CDP 命令失败'));
      else pending.resolve(message.result);
    });
    return cdp;
  }
  send(method, params = {}, sessionId) {
    const id = this.#id++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 20_000);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#socket.send(JSON.stringify(message));
    });
  }
  close() { try { this.#socket.close(); } catch { /* ignore */ } }
}

const version = await (await fetch(`${CDP}/json/version`)).json();
const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
try {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const candidates = targetInfos.filter((t) => {
    if (t.type !== 'page') return false;
    try {
      const url = new URL(t.url);
      return url.hostname === 'echotik.live' || url.hostname.endsWith('.echotik.live');
    } catch { return false; }
  });
  if (candidates.length === 0) throw new Error('没有 echotik.live 页面');
  const target = args.target
    ? candidates.find((t) => `${t.url} ${t.title}`.includes(args.target))
    : candidates[0];
  if (!target) throw new Error(`没有匹配 --target 的页面：${args.target}`);

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);

  if (args.navigate) {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: args.navigate }, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  let expression = args.expr;
  if (args.file) expression = await readFile(args.file, 'utf8');
  if (!expression) expression = '({title: document.title, href: location.href})';

  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
  }, sessionId);

  if (result.exceptionDetails) {
    console.error('页面执行异常：', result.exceptionDetails.text ?? 'unknown');
    process.exitCode = 1;
  } else {
    const value = result.result?.value;
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
} finally {
  cdp.close();
}
