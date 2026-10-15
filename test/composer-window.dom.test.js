'use strict';

/* =============================================================================
 * 写信弹窗「可拖动 / 可缩放 / 可最大化」—— 真实 jsdom + 完整 index.html + 完整 app.js
 *
 * 运行：
 *   NODE_PATH=C:\Users\Bingfeng\.workbuddy-ai\binaries\node\workspace\node_modules \
 *     <node.exe> test/composer-window.dom.test.js
 *
 * 退出码：0 = 全部通过；1 = 存在失败。
 *
 * 需求背景：回复 / 转发时弹窗正对着原邮件，想对照着写很别扭 —— 弹窗要能随手拖走、
 * 能放大、能最大化。
 *
 * ⚠️ jsdom 不做排版：getBoundingClientRect 恒为全 0。所以本套件**自己钉死** rect，
 * 验的是「位移 -> 新几何」的换算与夹取策略，不是浏览器里的真实像素。真实观感
 * （把手好不好抓、拖动跟不跟手）列入交付说明的「需人工确认」一节，不在这里假装测过。
 *
 * ⚠️ 内联 width/height 的优先级高于媒体查询 —— 这条是本功能最危险的回归点：
 * 桌面端拖成浮动窗口后再把窗口缩到移动端宽度，如果内联几何没被清掉，手机上就会
 * 出现一个「桌面尺寸、拖不动」的弹窗。W12 专门守这条。
 *
 * 本文件不修改 public/ 下任何源码。
 * ===========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
// QA_APP_JS / QA_APP_CSS / QA_INDEX_HTML 仅用于「变异验证」：指向人工构造的缺陷版本（放仓库外）。
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
const APP_CSS_PATH = process.env.QA_APP_CSS || path.join(ROOT, 'public', 'app.css');
const INDEX_PATH = process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html');

const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const APP_CSS = fs.readFileSync(APP_CSS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');
// 注释里会出现选择器名字（本文件的注释就解释过那个 id 漂移），做「不得出现某选择器」
// 这类否定断言前必须先去掉注释，否则会被自己的说明文字误判。
const CSS_NO_COMMENTS = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const FINGERPRINT = {
  'public/app.js': crypto.createHash('md5').update(APP_JS).digest('hex'),
  'public/app.css': crypto.createHash('md5').update(APP_CSS).digest('hex'),
  'public/index.html': crypto.createHash('md5').update(INDEX_HTML).digest('hex'),
};

/* ---------------------------------------------------------------------------
 * fetch 打桩
 * -------------------------------------------------------------------------*/

function makeStub() {
  const calls = [];
  const jsonRes = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });

  const fetchImpl = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    calls.push({ url, method: String((init && init.method) || 'GET').toUpperCase() });
    if (url.startsWith('/api/account')) {
      return Promise.resolve(jsonRes({ can_send: true, from_name: 'Me', from_address: 'me@example.com' }));
    }
    if (url.startsWith('/api/mailboxes')) {
      return Promise.resolve(jsonRes({ mailboxes: [{ mailbox: 'me@example.com' }] }));
    }
    if (url.startsWith('/api/counts')) {
      return Promise.resolve(jsonRes({ inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 }));
    }
    if (url.startsWith('/api/contacts')) return Promise.resolve(jsonRes({ contacts: [] }));
    if (url.startsWith('/api/folders/')) return Promise.resolve(jsonRes({ items: [], total: 0 }));
    if (url.startsWith('/api/messages')) return Promise.resolve(jsonRes({ message: null, items: [], total: 0 }));
    return Promise.resolve(jsonRes({}));
  };

  return { fetchImpl, calls };
}

/* ---------------------------------------------------------------------------
 * 启动实例
 * -------------------------------------------------------------------------*/

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }

const liveCtxs = [];

/**
 * cfg.width / cfg.height 视口尺寸。宽度必须在注入 app.js **之前**设好：
 * init() 里就会跑一次 syncLayout()（它会同步一次弹窗几何）。
 */
async function boot(cfg = {}) {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { value: cfg.width === undefined ? 1024 : cfg.width, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: cfg.height === undefined ? 768 : cfg.height, configurable: true });

  const stub = makeStub();
  win.fetch = stub.fetchImpl; // 必须在注入 app.js 之前

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  let ready = false;
  for (let i = 0; i < 400; i++) {
    const nav = win.document.querySelector('#folder-nav');
    // 用 `> 0` 而不是写死项数：导航项数会随功能增删（本轮新增「草稿」就从 4 变 5），
    // 写死会让 boot 静默超时，18 个用例一起报「init() 未在预期时间内完成」这种假故障。
    if (nav && nav.children.length > 0 && typeof win.setupComposerWindow === 'function') { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 5);

  // 列表为空，预取本来也不会发请求；显式作废一次，避免将来加了 fixture 变成 flaky
  win.eval('prefetchGen++; prefetchActive = null;');

  const ctx = { dom, win, doc: win.document, stub, close() { try { dom.window.close(); } catch { /* ignore */ } } };
  liveCtxs.push(ctx);
  return ctx;
}

/* ---------------------------------------------------------------------------
 * 辅助
 * -------------------------------------------------------------------------*/

const evalIn = (ctx, expr) => ctx.win.eval(expr);
const el = (ctx, sel) => ctx.doc.querySelector(sel);
const geom = (ctx) => evalIn(ctx, 'composerGeom');
const maximized = (ctx) => evalIn(ctx, 'composerMaximized') === true;
const hasClass = (ctx, sel, cls) => el(ctx, sel).classList.contains(cls);
const styleOf = (ctx, sel, prop) => el(ctx, sel).style[prop];

/** jsdom 没有排版：把 #composer 的 rect 钉死成已知值。 */
function stubComposerRect(ctx, r) {
  Object.defineProperty(el(ctx, '#composer'), 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: r.left, top: r.top, width: r.width, height: r.height,
      right: r.left + r.width, bottom: r.top + r.height,
    }),
  });
}

function pointer(ctx, node, type, x, y, button = 0) {
  node.dispatchEvent(new ctx.win.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button,
  }));
}
/** 在标题栏 / 把手上起手拖动，并在 document 上派发移动与抬起 */
function drag(ctx, node, from, to) {
  pointer(ctx, node, 'pointerdown', from[0], from[1]);
  pointer(ctx, ctx.doc, 'pointermove', to[0], to[1]);
  pointer(ctx, ctx.doc, 'pointerup', to[0], to[1]);
}
function clickEl(ctx, sel) {
  el(ctx, sel).dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
async function openComposer(ctx) {
  clickEl(ctx, '#compose-btn');
  await ticks(ctx.win, 3);
}
function setWidth(ctx, w) {
  Object.defineProperty(ctx.win, 'innerWidth', { value: w, configurable: true });
  ctx.win.dispatchEvent(new ctx.win.Event('resize'));
}

/* ---------------------------------------------------------------------------
 * CSS 规则层断言工具（与 mobile-layout.dom.test.js 同一套结构化匹配）
 * -------------------------------------------------------------------------*/
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function ruleHas(cssText, selectors, decl) {
  const sel = (Array.isArray(selectors) ? selectors : [selectors]).map(escRe).join('\\s*,\\s*');
  return new RegExp(sel + '\\s*\\{[^{}]*' + decl + '\\s*(?:;[^{}]*)?\\}', 's').test(cssText);
}

/* ---------------------------------------------------------------------------
 * 用例运行器
 * -------------------------------------------------------------------------*/
const results = [];
let currentTest = '(boot)';
let pass = 0;
let fail = 0;

function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  results.push({ test: currentTest, ok: good, msg, detail });
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${detail === undefined ? '' : `  [${detail}]`}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }

async function test(name, fn, cfg) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot(cfg || {});
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    // 先让在途异步落定再拆窗口，否则回调在已关闭的 window 上跑会抛 unhandledRejection，
    // 整个套件连汇总行都打不出来。
    for (const c of liveCtxs) {
      try { await ticks(c.win, 5); } catch { /* 窗口已不可用，忽略 */ }
    }
    for (const c of liveCtxs.splice(0)) c.close();
  }
}

/* =============================================================================
 * 用例
 * ===========================================================================*/
(async () => {
  console.log('写信弹窗「可拖动 / 可缩放 / 可最大化」—— 独立 jsdom 验证');
  console.log(`被测版本: app.js md5=${FINGERPRINT['public/app.js']}  app.css md5=${FINGERPRINT['public/app.css']}  index.html md5=${FINGERPRINT['public/index.html']}`);
  console.log(`被测文件: ${APP_JS_PATH}${process.env.QA_APP_JS ? '  ← QA_APP_JS 变异体' : ''}`);
  console.log(`被测样式: ${APP_CSS_PATH}${process.env.QA_APP_CSS ? '  ← QA_APP_CSS 变异体' : ''}`);

  /* ---- W1 环境自检 + 结构 ---- */
  await test('W1 环境自检：拖动接线已就绪，标题栏真的包着标题', async (ctx) => {
    ok(typeof ctx.win.setupComposerWindow === 'function', 'app.js 已注入且 setupComposerWindow 为全局函数');
    ok(typeof ctx.win.applyComposerGeom === 'function', 'applyComposerGeom 为全局函数（几何的唯一出口）');
    ok(typeof ctx.win.clampComposerGeom === 'function', 'clampComposerGeom 为全局函数（纯函数，可直接验策略）');

    const head = el(ctx, '#composer-head');
    ok(!!head, '#composer-head 存在（拖动热区）');
    ok(!!head && !!head.querySelector('#composer-title'), '⭐ #composer-title 在 #composer-head 内（拖动条必须包住标题行）');
    ok(!!el(ctx, '#composer-resize'), '#composer-resize 存在（右下角缩放把手）');
    ok(!!el(ctx, '#composer-max'), '#composer-max 存在（最大化按钮）');
    ok(!!el(ctx, '#composer-fit'), '#composer-fit 存在（恢复默认按钮）');

    // 本套件派发的是 MouseEvent（类型名写成 'pointerdown'）。一旦有人把处理器改成
    // `if (!(e instanceof PointerEvent)) return;`，jsdom 里 MouseEvent 不是 PointerEvent
    // -> 全部拖动断言会**静默空转**（看着还全绿）。所以这里直接在源码层把这条路堵死。
    ok(!/instanceof\s+PointerEvent/.test(APP_JS),
      '⭐ 源码不用 instanceof PointerEvent 判事件类型（那样写会让本套件的拖动断言全部空转）');
    info(`jsdom 的 PointerEvent: ${typeof ctx.win.PointerEvent}`);

    ok(geom(ctx) === null, '前置：初始没有浮动几何');
    ok(hasClass(ctx, '#composer-resize', 'hidden'), '前置：把手默认隐藏');
  });

  /* ---- W2 桌面端默认仍是居中自适应（负控制） ---- */
  await test('W2 桌面端打开弹窗后仍是默认居中布局（负控制）', async (ctx) => {
    await openComposer(ctx);
    ok(!hasClass(ctx, '#modal-mask', 'hidden'), '前置：弹窗已打开');
    ok(geom(ctx) === null, '没拖动前 composerGeom 保持 null');
    ok(!hasClass(ctx, '#composer', 'floating'), '⭐ 没拖动前不加 .floating（否则默认居中布局被 JS 抢走）');
    ok(styleOf(ctx, '#composer', 'left') === '', '没拖动前不写内联 left');
    ok(styleOf(ctx, '#composer', 'width') === '', '没拖动前不写内联 width');
    ok(!hasClass(ctx, '#modal-mask', 'composer-float'), '没拖动前遮罩不额外变淡');
    ok(hasClass(ctx, '#composer-resize', 'hidden'), '没拖动前把手不显示');
  });

  /* ---- W3 拖动标题栏 ---- */
  await test('W3 拖动标题栏：弹窗变浮动、按位移走、遮罩自动变淡', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });

    pointer(ctx, el(ctx, '#composer-head'), 'pointerdown', 400, 120);
    ok(evalIn(ctx, 'composerDrag !== null'), '前置：pointerdown 记下了拖动起点');
    ok(geom(ctx) === null, '只是按下还没移动 -> 仍不浮动');

    pointer(ctx, ctx.doc, 'pointermove', 450, 150); // +50 / +30
    const g = geom(ctx);
    ok(g && g.left === 250 && g.top === 130, '⭐ 位置按指针位移换算（200+50 / 100+30）', JSON.stringify(g));
    ok(hasClass(ctx, '#composer', 'floating'), '⭐ 拖动后加上 .floating');
    ok(styleOf(ctx, '#composer', 'left') === '250px', '内联 left 已落到元素上', styleOf(ctx, '#composer', 'left'));
    ok(styleOf(ctx, '#composer', 'top') === '130px', '内联 top 已落到元素上', styleOf(ctx, '#composer', 'top'));
    ok(styleOf(ctx, '#composer', 'width') === '760px', '尺寸被固化（拖动只改位置，不改大小）', styleOf(ctx, '#composer', 'width'));
    ok(styleOf(ctx, '#composer', 'height') === '600px', '高度同样被固化', styleOf(ctx, '#composer', 'height'));
    ok(hasClass(ctx, '#modal-mask', 'composer-float'), '⭐ 遮罩变淡（用户想对照后面的邮件）');
    ok(ctx.doc.body.classList.contains('composer-dragging'), '拖动中 body 带 .composer-dragging（禁文字选择）');

    const grip = el(ctx, '#composer-resize');
    ok(!grip.classList.contains('hidden'), '浮动后把手显示出来');
    ok(grip.style.left === '992px' && grip.style.top === '712px',
      '⭐ 把手贴在弹窗右下角（250+760-18 / 130+600-18）', `${grip.style.left}/${grip.style.top}`);

    pointer(ctx, ctx.doc, 'pointerup', 450, 150);
    ok(evalIn(ctx, 'composerDrag === null'), '抬起后拖动状态清空');
    ok(!ctx.doc.body.classList.contains('composer-dragging'), '抬起后 body 的类被摘掉');
  });

  /* ---- W4 点一下标题栏不算拖动（负控制） ---- */
  await test('W4 只点一下标题栏（位移 < 3px）不进入浮动（负控制）', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });
    drag(ctx, el(ctx, '#composer-head'), [400, 120], [401, 120]);
    ok(geom(ctx) === null, '⭐ 位移 1px 不算拖动，composerGeom 仍为 null');
    ok(!hasClass(ctx, '#composer', 'floating'), '⭐ 不进入浮动（否则「点一下遮罩就变淡」）');
    ok(!hasClass(ctx, '#modal-mask', 'composer-float'), '遮罩也不变淡');
  });

  /* ---- W5 标题栏上的按钮不触发拖动（负控制） ---- */
  await test('W5 在标题栏的按钮上按下不会拖动弹窗（负控制）', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });
    pointer(ctx, el(ctx, '#composer-max'), 'pointerdown', 900, 120);
    ok(evalIn(ctx, 'composerDrag === null'), '⭐ 点在按钮上不进入拖动（否则点最大化会把弹窗一起拖走）');
    pointer(ctx, ctx.doc, 'pointermove', 500, 400);
    ok(geom(ctx) === null, '后续 pointermove 也不该产生几何');
  });

  /* ---- W6 缩放把手 ---- */
  await test('W6 拖右下角把手：宽高按位移变化', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });
    drag(ctx, el(ctx, '#composer-head'), [400, 120], [410, 125]); // 先浮动到 210/105
    // jsdom 不会把内联样式反映回 rect，得手工「跟上」——否则缩放会从旧的 200/100 起算
    stubComposerRect(ctx, { left: 210, top: 105, width: 760, height: 600 });
    pointer(ctx, el(ctx, '#composer-resize'), 'pointerdown', 1000, 700);
    pointer(ctx, ctx.doc, 'pointermove', 1050, 750); // +50 / +50
    pointer(ctx, ctx.doc, 'pointerup', 1050, 750);
    const g = geom(ctx);
    ok(g && g.width === 810 && g.height === 650, '⭐ 宽高按位移换算（760+50 / 600+50）', JSON.stringify(g));
    ok(g && g.left === 210 && g.top === 105, '⭐ 缩放不动位置（左上角钉死）', JSON.stringify(g));
    ok(styleOf(ctx, '#composer', 'width') === '810px', '内联 width 同步更新', styleOf(ctx, '#composer', 'width'));
    const grip = el(ctx, '#composer-resize');
    ok(grip.style.left === '1002px' && grip.style.top === '737px',
      '把手跟着弹窗右下角移动', `${grip.style.left}/${grip.style.top}`);
  });

  /* ---- W6b 缩放不得把窗口撑出视口（否则窗口会被整体拽走） ---- */
  await test('W6b 放大到视口边缘：尺寸卡住、左上角一动不动（否则窗口自己乱跑）', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });
    drag(ctx, el(ctx, '#composer-head'), [400, 120], [450, 150]); // 浮动到 250/130
    stubComposerRect(ctx, { left: 250, top: 130, width: 760, height: 600 });
    pointer(ctx, el(ctx, '#composer-resize'), 'pointerdown', 1000, 700);
    pointer(ctx, ctx.doc, 'pointermove', 1500, 1200); // 想 +500 / +500，远超可用空间
    pointer(ctx, ctx.doc, 'pointerup', 1500, 1200);
    const g = geom(ctx);
    ok(g && g.left === 250 && g.top === 130,
      '⭐ 左上角一动不动（不这么做的话，窗口会先撑出屏幕再被整体拽回左上角）', JSON.stringify(g));
    ok(g && g.width === 774 && g.height === 638,
      '⭐ 尺寸卡在「当前位置到视口右下角」的可用空间（1024-250 / 768-130）', JSON.stringify(g));
  });

  /* ---- W7 最小尺寸夹取 ---- */
  await test('W7 缩放夹取：宽高不得小于最小值（否则正文挤成一条缝）', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });
    drag(ctx, el(ctx, '#composer-head'), [400, 120], [450, 150]);
    stubComposerRect(ctx, { left: 250, top: 130, width: 760, height: 600 }); // jsdom 不会自己跟
    pointer(ctx, el(ctx, '#composer-resize'), 'pointerdown', 1000, 700);
    pointer(ctx, ctx.doc, 'pointermove', 600, 300); // -400 / -400 -> 360x200
    pointer(ctx, ctx.doc, 'pointerup', 600, 300);
    const g = geom(ctx);
    ok(g && g.width === 420, '⭐ 宽度夹到 COMPOSER_MIN_W=420', JSON.stringify(g));
    ok(g && g.height === 320, '⭐ 高度夹到 COMPOSER_MIN_H=320', JSON.stringify(g));
  });

  /* ---- W8 位置夹取：整窗留在视口内 ---- */
  await test('W8 位置夹取：拖出屏幕后整窗仍留在视口内（右下角把手必须够得着）', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });

    // 往右下角外面拖
    pointer(ctx, el(ctx, '#composer-head'), 'pointerdown', 400, 120);
    pointer(ctx, ctx.doc, 'pointermove', 5000, 5000);
    let g = geom(ctx);
    ok(g && g.left === 264, '⭐ 右边界夹到 视口宽-窗宽（1024-760）', JSON.stringify(g));
    ok(g && g.top === 168, '⭐ 下边界夹到 视口高-窗高（768-600）', JSON.stringify(g));
    ok(g && g.left + g.width === 1024 && g.top + g.height === 768,
      '⭐ 右下角（缩放把手所在处）恰好落在视口边缘内 —— 只保证「标题栏露 80px」会让把手跑出屏幕，'
      + '真实 Chromium 实测过：那样 elementFromPoint 返回 null，把手点不到也拖不动', JSON.stringify(g));

    // 往左上角外面拖
    pointer(ctx, ctx.doc, 'pointermove', -5000, -5000);
    g = geom(ctx);
    ok(g && g.left === 0 && g.top === 0, '⭐ 左上角夹到 (0,0)', JSON.stringify(g));
    ok(g && g.width === 760 && g.height === 600, '位置夹取不影响尺寸', JSON.stringify(g));
    pointer(ctx, ctx.doc, 'pointerup', -5000, -5000);
  });

  /* ---- W9 最大化 / 还原 ---- */
  await test('W9 最大化：铺满视口留边距，再点一次回到原几何', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });

    clickEl(ctx, '#composer-max');
    let g = geom(ctx);
    ok(maximized(ctx) === true, 'composerMaximized = true');
    ok(g && g.left === 12 && g.top === 12, '最大化留 12px 边距', JSON.stringify(g));
    ok(g && g.width === 1000 && g.height === 744, '⭐ 铺满视口（1024-24 / 768-24）', JSON.stringify(g));
    ok(styleOf(ctx, '#composer', 'width') === '1000px', '内联 width 已铺开', styleOf(ctx, '#composer', 'width'));
    ok(el(ctx, '#composer-max').textContent === '⤡', '按钮图标切到「还原」', el(ctx, '#composer-max').textContent);
    ok(el(ctx, '#composer-max').getAttribute('title') === '还原大小', '按钮 title 同步');

    clickEl(ctx, '#composer-max');
    g = geom(ctx);
    ok(maximized(ctx) === false, 'composerMaximized 复位');
    ok(g && g.left === 200 && g.top === 100 && g.width === 760 && g.height === 600,
      '⭐ 还原回到最大化之前的几何', JSON.stringify(g));
    ok(el(ctx, '#composer-max').textContent === '⤢', '按钮图标切回「最大化」', el(ctx, '#composer-max').textContent);
  });

  /* ---- W10 恢复默认 ---- */
  await test('W10 恢复默认：清掉浮动几何，回到 CSS 的居中布局', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });
    clickEl(ctx, '#composer-max');
    ok(geom(ctx) !== null, '前置：已经浮动');

    clickEl(ctx, '#composer-fit');
    ok(geom(ctx) === null, '⭐ composerGeom 清空');
    ok(!hasClass(ctx, '#composer', 'floating'), '.floating 摘掉');
    ok(!hasClass(ctx, '#modal-mask', 'composer-float'), '遮罩恢复原来的浓度');
    ok(styleOf(ctx, '#composer', 'left') === '' && styleOf(ctx, '#composer', 'width') === '', '内联几何清空');
    ok(hasClass(ctx, '#composer-resize', 'hidden'), '把手重新隐藏');
    ok(maximized(ctx) === false, '最大化状态一并复位');
  });

  /* ---- W11 会话内记忆 ---- */
  await test('W11 会话内记忆：关掉再打开，浮动几何还在', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });
    drag(ctx, el(ctx, '#composer-head'), [400, 120], [450, 150]);
    ok(geom(ctx) !== null, '前置：已浮动');

    clickEl(ctx, '#composer-cancel'); // 空表单 -> 直接关
    await ticks(ctx.win, 3);
    ok(hasClass(ctx, '#modal-mask', 'hidden'), '前置：弹窗已关闭');

    await openComposer(ctx);
    ok(styleOf(ctx, '#composer', 'left') === '250px', '⭐ 重新打开后仍是上次拖到的位置', styleOf(ctx, '#composer', 'left'));
    ok(hasClass(ctx, '#composer', 'floating'), '重新打开后仍是浮动窗口');
  });

  /* ---- W12 跨断点：内联几何必须被清掉 ---- */
  await test('W12 跨断点：桌面端浮动后缩到移动端宽度，内联几何必须清掉', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });
    drag(ctx, el(ctx, '#composer-head'), [400, 120], [450, 150]);
    ok(styleOf(ctx, '#composer', 'width') === '760px', '前置：桌面端已写死内联宽度');

    setWidth(ctx, 375); // 缩到手机宽度（jsdom 无 matchMedia -> 回退到 innerWidth）
    ok(evalIn(ctx, 'isMobile()') === true, '前置：已判为移动端');
    ok(styleOf(ctx, '#composer', 'width') === '', '⭐ 内联 width 被清掉（否则会盖过媒体查询的全屏宽度）');
    ok(styleOf(ctx, '#composer', 'left') === '' && styleOf(ctx, '#composer', 'top') === '' && styleOf(ctx, '#composer', 'height') === '',
      '⭐ 内联 left/top/height 一并清掉');
    ok(!hasClass(ctx, '#composer', 'floating'), '.floating 摘掉（回到 CSS 的全屏布局）');
    ok(!hasClass(ctx, '#modal-mask', 'composer-float'), '遮罩恢复原浓度');
    ok(geom(ctx) !== null, '几何本身留着（切回桌面还能恢复，不必重新拖）');

    setWidth(ctx, 1024);
    ok(styleOf(ctx, '#composer', 'width') === '760px', '⭐ 切回桌面端，浮动几何恢复', styleOf(ctx, '#composer', 'width'));
    ok(hasClass(ctx, '#composer', 'floating'), '切回桌面端恢复浮动');
  });

  /* ---- W13 移动端打开弹窗 ---- */
  await test('W13 移动端：打开弹窗就是全屏，不写任何内联几何', async (ctx) => {
    ok(evalIn(ctx, 'isMobile()') === true, '前置：375 宽判为移动端');
    await openComposer(ctx);
    ok(!hasClass(ctx, '#modal-mask', 'hidden'), '前置：弹窗已打开');
    ok(styleOf(ctx, '#composer', 'width') === '' && styleOf(ctx, '#composer', 'height') === '',
      '⭐ 移动端不写内联宽高（让媒体查询的 100%/100% 生效）');
    ok(!hasClass(ctx, '#composer', 'floating'), '移动端不加 .floating');
    ok(hasClass(ctx, '#composer-resize', 'hidden'), '移动端把手保持隐藏');

    // 移动端即便强行派发拖动也不该产生几何（isMobile 早退）
    stubComposerRect(ctx, { left: 0, top: 0, width: 375, height: 667 });
    drag(ctx, el(ctx, '#composer-head'), [100, 60], [200, 160]);
    ok(geom(ctx) === null, '⭐ 移动端拖动被忽略（全屏下拖动只会和滚动打架）');
    ok(styleOf(ctx, '#composer', 'left') === '', '移动端仍无内联几何');
  }, { width: 375, height: 667 });

  /* ---- W14 遮罩点击行为没被新结构吞掉（负控制） ---- */
  await test('W14 新增的标题栏 / 把手没把「点遮罩空白关闭」吞掉（负控制）', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });

    // 点标题栏内部：不该关（target !== currentTarget）
    el(ctx, '#composer-head').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    ok(!hasClass(ctx, '#modal-mask', 'hidden'), '点标题栏 -> 弹窗不关闭');

    // 点遮罩空白（按下点也在遮罩上）：空表单 -> 直接关
    pointer(ctx, el(ctx, '#modal-mask'), 'pointerdown', 30, 30);
    el(ctx, '#modal-mask').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await ticks(ctx.win, 3);
    ok(hasClass(ctx, '#modal-mask', 'hidden'), '⭐ 点遮罩空白仍然关闭（新增 DOM 没破坏既有交互）');
  });

  /* ---- W17 拖动标题栏到遮罩上抬起，不能把弹窗关掉 ---- */
  await test('W17 在弹窗内按下、鼠标抬到遮罩上：不得被当成「点空白关闭」', async (ctx) => {
    await openComposer(ctx);
    stubComposerRect(ctx, { left: 200, top: 100, width: 760, height: 600 });

    // 真实浏览器里，mousedown 在弹窗内、mouseup 在遮罩上 -> click 派发到共同祖先（遮罩本身），
    // 于是 target === currentTarget 也成立。拖动标题栏天然就是这种手势。
    pointer(ctx, el(ctx, '#composer-head'), 'pointerdown', 400, 120);
    pointer(ctx, ctx.doc, 'pointermove', 900, 500); // 拖到弹窗外
    pointer(ctx, ctx.doc, 'pointerup', 900, 500);
    el(ctx, '#modal-mask').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await ticks(ctx.win, 3);
    ok(!hasClass(ctx, '#modal-mask', 'hidden'), '⭐ 拖动后鼠标落在遮罩上抬起 -> 弹窗不关闭');
    ok(hasClass(ctx, '#confirm-mask', 'hidden'), '也没有弹出「放弃」确认框（用户并没有要关闭）');

    // 负控制：紧接着一次真正的「按下就在遮罩上」，仍然要能关
    pointer(ctx, el(ctx, '#modal-mask'), 'pointerdown', 30, 30);
    el(ctx, '#modal-mask').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await ticks(ctx.win, 3);
    ok(hasClass(ctx, '#modal-mask', 'hidden'), '⭐ 负控制：真正的点空白仍然关闭（守卫没有把关闭路径一起堵死）');
  });

  /* ---- W15 静态规则层 ---- */
  await test('W15 静态规则层：浮动 / 把手 / 遮罩变淡，且移动端关掉拖动', async (ctx) => {
    ok(ruleHas(APP_CSS, '#composer-head', 'cursor:\\s*move'), '#composer-head 设了 cursor: move（可拖动的可见线索）');
    ok(ruleHas(APP_CSS, '#composer-head', 'touch-action:\\s*none'), '#composer-head touch-action: none（触摸拖动不顺带滚动）');
    ok(ruleHas(APP_CSS, '#composer.floating', 'overflow-y:\\s*auto'),
      '⭐ 浮动窗口内部可滚动（窗口压得比内容矮时兜底，别把发送按钮挤出去）');
    ok(ruleHas(APP_CSS, '.composer-resize', 'position:\\s*fixed'),
      '⭐ 把手用 fixed 定位（绝对定位会随内容滚动跑掉，窗口压矮后就点不到了）');
    ok(ruleHas(APP_CSS, '.composer-resize', 'cursor:\\s*nwse-resize'), '把手光标 nwse-resize');
    ok(ruleHas(APP_CSS, '#modal-mask.composer-float', 'background:\\s*rgba\\(20,\\s*24,\\s*32,\\s*\\.18\\)'),
      '⭐ 浮动时遮罩变淡（后面那封邮件才看得清）');
    ok(ruleHas(APP_CSS, '.composer-body-wrap', 'display:\\s*flex'),
      '⭐ 正文容器真的是 flex 列（原来写成 `#composer-body-wrap`，HTML 里却是 class -> 规则从未生效）');
    ok(!/#composer-body-wrap\b/.test(CSS_NO_COMMENTS),
      '⭐ 不得对 composer-body-wrap 用 id 选择器（HTML 里是 class；真实 Chromium 实测过：写成 id 时 computed display 是 block）');
    ok(ruleHas(APP_CSS, '#composer.floating .composer-body-wrap', 'flex:\\s*1\\s+1\\s+auto'),
      '⭐ 浮动时正文区吸收多余高度（否则最大化后下半屏全是空白，textarea 还卡在 180px）');
    ok(ruleHas(APP_CSS, ['#composer.floating #f-body', '#composer.floating .rich-editor'], 'flex:\\s*1\\s+1\\s+auto'),
      '⭐ 浮动时纯文本正文与富文本编辑器同样吸收高度');
    ok(ruleHas(APP_CSS, 'body.composer-dragging', 'user-select:\\s*none'), '拖动期间禁文字选择');

    // 移动端段落：拖动/缩放控件必须关掉
    const at = APP_CSS.indexOf('移动端适配');
    ok(at >= 0, 'app.css 里能找到「移动端适配」段落标记');
    const cssMobile = at >= 0 ? APP_CSS.slice(at) : '';
    const desktopCss = at >= 0 ? APP_CSS.slice(0, at) : APP_CSS;
    ok(ruleHas(cssMobile, ['.composer-grip', '.composer-tool', '.composer-resize'], 'display:\\s*none'),
      '⭐ 移动端隐藏抓手图标、最大化/恢复按钮与缩放把手');
    ok(ruleHas(cssMobile, '#composer-head', 'cursor:\\s*default'), '移动端标题栏不再是拖动光标');
    ok(ruleHas(cssMobile, '#composer-head', 'touch-action:\\s*auto'), '移动端标题栏恢复 touch-action: auto（该能滚）');

    // 负控制：桌面端不能把把手藏起来
    ok(!ruleHas(desktopCss, '.composer-resize', 'display:\\s*none'),
      '⭐ 负控制：桌面端不得隐藏缩放把手（藏了就等于没做这个功能）');
    ok(!ruleHas(desktopCss, '.composer-tool', 'display:\\s*none'), '负控制：桌面端不得隐藏标题栏按钮');

    info('以上为 CSS 规则层校验；拖动跟手度 / 把手可点性 / 真实像素观感未渲染验证（本机无浏览器自动化）');
  });

  /* ---- W16 纯函数层：夹取策略 ---- */
  await test('W16 clampComposerGeom 纯函数层：尺寸与位置的双向夹取', async (ctx) => {
    const call = (g, vp) => JSON.parse(evalIn(ctx, `JSON.stringify(clampComposerGeom(${JSON.stringify(g)}, ${JSON.stringify(vp)}))`));
    const vp = { width: 1024, height: 768 };

    let r = call({ left: 100, top: 100, width: 100, height: 100 }, vp);
    ok(r.width === 420 && r.height === 320, '⭐ 过小尺寸被抬到最小值', JSON.stringify(r));
    ok(r.left === 100 && r.top === 100, '合法位置不动', JSON.stringify(r));

    r = call({ left: 100, top: 100, width: 5000, height: 5000 }, vp);
    ok(r.width === 1000 && r.height === 744, '⭐ 过大尺寸被压到视口内（留 12px 边距）', JSON.stringify(r));
    ok(r.left === 24 && r.top === 24, '尺寸撑满后位置也被拉回「留 12px 边距」处', JSON.stringify(r));

    r = call({ left: 99999, top: 99999, width: 760, height: 600 }, vp);
    ok(r.left === 264 && r.top === 168, '右下越界被拉回：右下角贴住视口边缘', JSON.stringify(r));

    r = call({ left: -99999, top: -99999, width: 760, height: 600 }, vp);
    ok(r.left === 0 && r.top === 0, '左上越界被拉回 (0,0)', JSON.stringify(r));

    // 极小视口：不能让 min 把 max 顶翻（否则会出现「比视口还大的最小值」死循环式夹取）
    r = call({ left: 0, top: 0, width: 760, height: 600 }, { width: 320, height: 240 });
    ok(r.width === 420 && r.height === 320, '视口比最小值还小时仍返回最小值（不会算出负数或 NaN）', JSON.stringify(r));
    ok(r.left === 0 && r.top === 0, '这种退化情况下钉在左上角（maxLeft/maxTop 不得变成负数）', JSON.stringify(r));
    ok(Number.isFinite(r.left) && Number.isFinite(r.top), '位置仍为有限数', JSON.stringify(r));
  });

  /* ---- 汇总 ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: app.js md5=${FINGERPRINT['public/app.js']}  app.css md5=${FINGERPRINT['public/app.css']}  index.html md5=${FINGERPRINT['public/index.html']}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
