#!/usr/bin/env node
/**
 * insert-detail-images.mjs — 把详情页分段图插入商品编辑页的富文本描述编辑器。
 *
 * 背景：TikTok 批量表没有详情图列，详情图只能进编辑器。HTTPS 页面拿不到本地
 * http 服务（混合内容被拦），所以图片按分块 base64 注入页面再构造 File。
 *
 * 用法：
 *   node tools/pod/listing/insert-detail-images.mjs \
 *     --pid 59366 --tab 3 --product 1738323889769383792 \
 *     --dir /abs/详情页5 [--apply]
 *
 * 默认只读：打印将要插入的文件与页面当前状态，不改页面。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { evalInTab } from './zhanfu-bridge.mjs';

const CHUNK = 90000;
const SELLER = 'https://seller-mx.tiktok.com';

function args() {
  const a = process.argv.slice(2);
  const get = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  return {
    pid: Number(get('pid', 0)) || null,
    tab: Number(get('tab', 0)) || null,
    product: get('product'),
    dir: get('dir'),
    apply: a.includes('--apply'),
    save: a.includes('--save'),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 统一成 JPEG 并返回 {b64, name, bytes}。尺寸过大时等比缩到 1440 长边。 */
function pickPython() {
  const candidates = [
    path.join(process.env.HOME || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),
    path.join(process.cwd(), '.venv-kb/bin/python'),
    'python3.12',
    'python3',
  ];
  for (const c of candidates) {
    if (c.includes('/') && !fs.existsSync(c)) continue;
    try {
      execFileSync(c, ['-c', 'import PIL'], { stdio: 'ignore' });
      return c;
    } catch { /* 下一个 */ }
  }
  return null;
}

function encode(file) {
  const py = pickPython();
  if (!py) throw new Error('PIL_PYTHON_UNAVAILABLE');
  const code = `
import sys,base64,io
from PIL import Image
p=sys.argv[1]
im=Image.open(p).convert('RGB')
w,h=im.size
m=max(w,h)
if m>1440:
    s=1440/m
    im=im.resize((int(w*s),int(h*s)),Image.LANCZOS)
buf=io.BytesIO()
im.save(buf,'JPEG',quality=88,optimize=True)
sys.stdout.write(base64.b64encode(buf.getvalue()).decode())
`;
  const b64 = execFileSync(py, ['-c', code, file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { b64, name: path.basename(file).replace(/\.[^.]+$/, '') + '.jpg', bytes: Buffer.from(b64, 'base64').length };
}

function pageStateScript() {
  return `(()=>{
    const ed=document.querySelector('[contenteditable="true"]');
    if(!ed) return JSON.stringify({err:'NO_EDITOR',url:location.href.slice(0,80)});
    const srcs=[...ed.querySelectorAll('img')].map(i=>i.src);
    return JSON.stringify({n:srcs.length,uniq:[...new Set(srcs)]});
  })()`;
}

const main = async () => {
  const a = args();
  if (!a.pid || !a.tab || !a.product || !a.dir) {
    console.error('USAGE: --pid <pid> --tab <index> --product <productId> --dir <absDir> [--apply] [--save]');
    process.exit(2);
  }
  const dir = path.resolve(a.dir);
  if (!fs.existsSync(dir)) { console.error('DIR_NOT_FOUND ' + dir); process.exit(2); }
  const files = fs.readdirSync(dir).filter((f) => /^D\d+.*\.(png|jpe?g)$/i.test(f)).sort();
  if (!files.length) { console.error('NO_DETAIL_IMAGES'); process.exit(2); }

  // 身份闸：必须是对应商品的编辑页
  const url = await evalInTab(a.pid, a.tab, `location.href`);
  if (!url.includes(SELLER) || !url.includes('/product/edit/' + a.product)) {
    console.error('EXACT_EDIT_PAGE_REQUIRED got=' + String(url).slice(0, 120));
    process.exit(1);
  }

  const before = JSON.parse(await evalInTab(a.pid, a.tab, pageStateScript()));
  console.log(JSON.stringify({ stage: 'precheck', product: a.product, files, current: { images: before.n, unique: before.uniq?.length } }, null, 1));
  if (!a.apply) { console.log('DRY_RUN — 加 --apply 才真正插入'); return; }

  for (const f of files) {
    const { b64, name, bytes } = encode(path.join(dir, f));
    const parts = [];
    for (let i = 0; i < b64.length; i += CHUNK) parts.push(b64.slice(i, i + CHUNK));

    await evalInTab(a.pid, a.tab, `window.__podImg={b64:[],name:${JSON.stringify(name)},phase:'accum'};'init'`);
    for (let i = 0; i < parts.length; i++) {
      await evalInTab(a.pid, a.tab, `window.__podImg.b64.push(${JSON.stringify(parts[i])});window.__podImg.b64.length`);
    }

    const prev = JSON.parse(await evalInTab(a.pid, a.tab, pageStateScript()));
    await evalInTab(a.pid, a.tab, `(async()=>{try{
      const ed=document.querySelector('[contenteditable="true"]');
      const box=ed.closest('.syl-editor');
      const btn=[...box.querySelectorAll('button')].find(b=>b.innerHTML.includes('file_image'));
      if(!btn)throw new Error('NO_IMAGE_BUTTON');
      btn.click();
      await new Promise(r=>setTimeout(r,700));
      const inp=box.querySelector('input[type=file][accept="image/*"]');
      if(!inp)throw new Error('NO_IMAGE_INPUT');
      const bin=atob(window.__podImg.b64.join(''));
      const arr=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
      const dt=new DataTransfer();
      dt.items.add(new File([arr],window.__podImg.name,{type:'image/jpeg'}));
      inp.files=dt.files;
      inp.dispatchEvent(new Event('change',{bubbles:true}));
      window.__podImg.phase='sent';
    }catch(e){window.__podImg.phase='err:'+String(e.message||e)}})();'fired'`);

    let added = false, state = prev;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      state = JSON.parse(await evalInTab(a.pid, a.tab, pageStateScript()));
      if ((state.uniq?.length || 0) > (prev.uniq?.length || 0)) { added = true; break; }
    }
    // 双处理器会插两张：按 src 去重，只留一张
    await evalInTab(a.pid, a.tab, `(()=>{const ed=document.querySelector('[contenteditable="true"]');const seen=new Set();let r=0;[...ed.querySelectorAll('img')].forEach(i=>{if(seen.has(i.src)){i.remove();r++}else seen.add(i.src)});return r})()`);
    await sleep(800);
    state = JSON.parse(await evalInTab(a.pid, a.tab, pageStateScript()));
    console.log(JSON.stringify({ file: f, bytes, inserted: added, total: state.n, unique: state.uniq.length }));
    if (!added) { console.error('INSERT_FAILED ' + f); process.exit(1); }
  }

  const after = JSON.parse(await evalInTab(a.pid, a.tab, pageStateScript()));
  console.log(JSON.stringify({ stage: 'inserted', images: after.n, unique: after.uniq.length, expected: files.length }, null, 1));

  if (a.save) {
    const clicked = await evalInTab(a.pid, a.tab, `(()=>{const b=[...document.querySelectorAll('button')].filter(x=>!x.disabled&&x.offsetParent!==null).find(x=>/^(Guardar|Guardar cambios|保存)$/.test((x.innerText||'').trim()));if(!b)return 'NO_SAVE_BTN';b.click();return 'clicked'})()`);
    console.log('save ' + clicked);
  }
};

main().catch((e) => { console.error('FAILED', String(e?.message || e).slice(0, 300)); process.exit(1); });
