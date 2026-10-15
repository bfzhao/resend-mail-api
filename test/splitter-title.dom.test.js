'use strict';

/* =============================================================================
 * 列表/详情分隔条（可拖动）+ 浏览器标题栏未读数 —— 真实 jsdom + 完整 index.html + 完整 app.js
 *
 * 运行：
 *   NODE_PATH=C:\Users\Bingfeng\.workbuddy-ai\binaries\node\workspace\node_modules \
 *     <node.exe> test/splitter-title.dom.test.js
 *
 * 退出码：0 = 全部通过；1 = 存在失败。
 *
 * ⚠️ jsdom 不做排版：`getBoundingClientRect()` 恒为全 0，也没有 PointerEvent。
 *   所以本套件自己派发「带 clientX/pointerId 的合成事件」，验的是
 *   **位移 → 新几何的换算与夹取策略**，不是浏览器里的真实像素；真实观感（把手好不好抓、
 *   跟不跟手、cursor 是否变）列入交付说明的「需人工确认」一节，不在这里假装测过。
 *
 * ⚠️ 本功能最容易回归的一条：`state.listWidth` 存的是**用户期望宽度**，不是夹取后的实际值。
 *   否则「窗口缩小被夹一次 → 再放大就回不去」。S6 专门守这条。
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
// 注释里会出现选择器名字，做「不得出现某选择器」这类否定断言前必须先去掉注释。
const CSS_NO_COMMENTS = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const FINGERPRINT = {
  'public/app.js': crypto.createHash('md5').update(APP_JS).digest('hex'),
  'public/app.css': crypto.createHash('md5').update(APP_CSS).digest('hex'),
  'public/index.html': crypto.createHash('md5').update(INDEX_HTML).digest('hex'),
};

/* ---------------------------------------------------------------------------
 * fetch 打桩（counts 可变，供标题栏用例驱动）
 * -------------------------------------------------------------------------*/

function makeStub(state) {
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
    if (url.startsWith('/api/mailboxes')) return Promise.resolve(jsonRes({ mailboxes: [{ mailbox: 'me@example.com' }] }));
    if (url.startsWith('/api/counts')) return Promise.resolve(jsonRes(Object.assign({}, state.counts)));
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

async function boot(cfg = {}) {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { value: cfg.width === undefined ? 1280 : cfg.width, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: 800, configurable: true });
  if (cfg.matchMedia) win.matchMedia = cfg.matchMedia;
  // 预置持久化宽度：必须在注入 app.js **之前**写，否则验不到「boot 阶段就恢复」。
  // 不去覆写 localStorage 的方法（jsdom 的 Storage 实例属性不可重定义，见项目笔记）。
  if (cfg.seedListW != null) win.localStorage.setItem('inbox-list-w', String(cfg.seedListW));

  const state = { counts: Object.assign({ inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0, drafts_total: 0 }, cfg.counts) };
  const stub = makeStub(state);
  win.fetch = stub.fetchImpl; // 必须在注入 app.js 之前

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  let ready = false;
  for (let i = 0; i < 400; i++) {
    const nav = win.document.querySelector('#folder-nav');
    if (nav && nav.children.length > 0 && typeof win.setupSplitter === 'function') { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 5);

  const ctx = { dom, win, doc: win.document, stub, state, close() { try { dom.window.close(); } catch { /* ignore */ } } };
  liveCtxs.push(ctx);
  return ctx;
}

/* ---------------------------------------------------------------------------
 * 事件 / 断言辅助
 * -------------------------------------------------------------------------*/

/** jsdom 没有 PointerEvent：用普通 Event + 手工挂属性（处理器只读这几个字段）。 */
function pointerEvt(ctx, type, props = {}) {
  const e = new ctx.win.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { clientX: 0, clientY: 0, pointerId: 1, button: 0, detail: 1 }, props);
  return e;
}
function keyEvt(ctx, key, props = {}) {
  return new ctx.win.KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, props));
}

function el(ctx, sel) { return ctx.doc.querySelector(sel); }
const evalIn = (ctx, expr) => ctx.win.eval(expr);
const splitter = (ctx) => el(ctx, '#splitter');
const cssVar = (ctx) => ctx.doc.documentElement.style.getPropertyValue('--list-w');
const hasCustomClass = (ctx) => el(ctx, '#app').classList.contains('list-w-custom');
const isResizing = (ctx) => el(ctx, '#app').classList.contains('resizing');
const storedW = (ctx) => { try { return ctx.win.localStorage.getItem('inbox-list-w'); } catch { return null; } };

const results = [];
let pass = 0;
let fail = 0;
let currentTest = '(boot)';
function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  results.push({ test: currentTest, ok: good, msg, detail });
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${detail === undefined ? '' : `  [${detail}]`}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }

async function test(name, fn, bootCfg) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot(bootCfg || {});
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    if (ctx) ctx.close();
  }
}

/* ===========================================================================
 * 用例
 * ===========================================================================*/
(async function main() {
  console.log('列表分隔条（可拖动）+ 标题栏未读数 —— 独立 jsdom 验证');
  console.log(`被测版本: ${Object.entries(FINGERPRINT).map(([k, v]) => `${k}=${v.slice(0, 8)}`).join('  ')}`);

  /* ---- S0 环境自检 ---- */
  await test('S0 环境自检：分隔条真的在 DOM 里、且夹在两栏之间', async (ctx) => {
    const sp = splitter(ctx);
    ok(!!sp, '#splitter 存在于 index.html');
    ok(typeof ctx.win.setupSplitter === 'function', 'setupSplitter 为全局函数（接线已执行）');
    const list = el(ctx, '#list-pane');
    const read = el(ctx, '#read-pane');
    ok(!!list && !!read, '#list-pane / #read-pane 都在');
    // 三者的 DOM 顺序必须是 list → splitter → read（否则分隔条画在错误的位置）
    const order = Array.from(el(ctx, '#main-split').children).filter((n) => n.id === 'list-pane' || n.id === 'splitter' || n.id === 'read-pane').map((n) => n.id);
    ok(order.join(' > ') === 'list-pane > splitter > read-pane', 'DOM 顺序：list-pane > splitter > read-pane', order.join(' > '));
    ok(el(ctx, '#splitter').parentNode === el(ctx, '#list-pane').parentNode,
      '分隔条与两栏在同一个 flex 容器里（否则 flex 布局算不到它）');
    ok(sp.getAttribute('role') === 'separator', 'role=separator（可访问性）', sp.getAttribute('role'));
    ok(sp.getAttribute('aria-orientation') === 'vertical', 'aria-orientation=vertical', sp.getAttribute('aria-orientation'));
    ok(sp.getAttribute('tabindex') === '0', 'tabindex=0（键盘可聚焦）', sp.getAttribute('tabindex'));
    ok(evalIn(ctx, 'typeof LIST_W_MIN') === 'number' && evalIn(ctx, 'typeof LIST_W_DEFAULT') === 'number',
      '宽度常量可观测（LIST_W_MIN / LIST_W_DEFAULT）');
    info(`LIST_W_DEFAULT=${evalIn(ctx, 'LIST_W_DEFAULT')} LIST_W_MIN=${evalIn(ctx, 'LIST_W_MIN')} 视口=${evalIn(ctx, 'viewportWidth()')}`);
  });

  /* ---- S1 初始态：默认宽度不写内联 ---- */
  await test('S1 初始态：不写内联宽度、不挂自定义类（交给 CSS 默认值）', async (ctx) => {
    ok(evalIn(ctx, 'state.listWidth') === null, 'state.listWidth 初始为 null', String(evalIn(ctx, 'state.listWidth')));
    ok(!hasCustomClass(ctx), '未挂 list-w-custom');
    ok(cssVar(ctx) === '', '--list-w 未内联（CSS 里的 :root 值生效）', JSON.stringify(cssVar(ctx)));
    ok(storedW(ctx) === null, 'localStorage 里没有残留宽度', JSON.stringify(storedW(ctx)));
  });

  /* ---- S2 拖动：位移 → 宽度 ---- */
  await test('S2 拖动：pointerdown/move/up 的位移换算与状态类', async (ctx) => {
    const sp = splitter(ctx);
    const start = evalIn(ctx, 'LIST_W_DEFAULT'); // jsdom rect 恒 0 -> 基准回退到默认值
    sp.dispatchEvent(pointerEvt(ctx, 'pointerdown', { clientX: 500, pointerId: 1 }));
    ok(isResizing(ctx), 'pointerdown 后 #app 带 resizing（拖动中）');
    sp.dispatchEvent(pointerEvt(ctx, 'pointermove', { clientX: 560, pointerId: 1 }));
    ok(evalIn(ctx, 'state.listWidth') === start + 60, `向右 60px -> 期望宽度 ${start + 60}`, String(evalIn(ctx, 'state.listWidth')));
    ok(hasCustomClass(ctx), '拖动后挂上 list-w-custom（覆盖 CSS 默认宽度）');
    ok(cssVar(ctx) === `${start + 60}px`, '--list-w 已写入内联变量', cssVar(ctx));
    sp.dispatchEvent(pointerEvt(ctx, 'pointermove', { clientX: 520, pointerId: 1 }));
    ok(evalIn(ctx, 'state.listWidth') === start + 20, '往回拖 -> 宽度跟着减小（不是只认第一次）', String(evalIn(ctx, 'state.listWidth')));
    sp.dispatchEvent(pointerEvt(ctx, 'pointerup', { clientX: 520, pointerId: 1 }));
    ok(!isResizing(ctx), 'pointerup 后 resizing 被移除');
    ok(storedW(ctx) === String(start + 20), 'pointerup 时写入 localStorage（拖动过程不写，避免抖动）', JSON.stringify(storedW(ctx)));
  });

  /* ---- S3 负控制：没按下时 move 不生效 ---- */
  await test('S3 负控制：没按下就直接 move -> 宽度不变', async (ctx) => {
    splitter(ctx).dispatchEvent(pointerEvt(ctx, 'pointermove', { clientX: 900, pointerId: 1 }));
    ok(evalIn(ctx, 'state.listWidth') === null, '未 pointerdown 的 move 被忽略', String(evalIn(ctx, 'state.listWidth')));
    ok(!hasCustomClass(ctx), '也没挂上自定义类');
    // 另一个 pointerId 的 move 同样必须被忽略（多点触控误拖）
    splitter(ctx).dispatchEvent(pointerEvt(ctx, 'pointerdown', { clientX: 500, pointerId: 7 }));
    splitter(ctx).dispatchEvent(pointerEvt(ctx, 'pointermove', { clientX: 900, pointerId: 8 }));
    ok(evalIn(ctx, 'state.listWidth') === null, '别的 pointerId 的 move 被忽略（多指误拖防护）', String(evalIn(ctx, 'state.listWidth')));
    splitter(ctx).dispatchEvent(pointerEvt(ctx, 'pointerup', { pointerId: 7 }));
  });

  /* ---- S4 夹取 ---- */
  await test('S4 夹取：再窄不低于下限，再宽不超过视口 70%', async (ctx) => {
    const min = evalIn(ctx, 'LIST_W_MIN');
    const max = evalIn(ctx, 'listWidthMax()');
    const sp = splitter(ctx);
    sp.dispatchEvent(pointerEvt(ctx, 'pointerdown', { clientX: 500, pointerId: 1 }));
    sp.dispatchEvent(pointerEvt(ctx, 'pointermove', { clientX: -5000, pointerId: 1 }));
    ok(cssVar(ctx) === `${min}px`, `拖到极左 -> 夹在下限 ${min}`, cssVar(ctx));
    sp.dispatchEvent(pointerEvt(ctx, 'pointermove', { clientX: 99999, pointerId: 1 }));
    ok(cssVar(ctx) === `${max}px`, `拖到极右 -> 夹在 70% 视口 ${max}`, cssVar(ctx));
    ok(max < evalIn(ctx, 'viewportWidth()'), '上限留出了详情栏空间（不是占满整个视口）', `${max} < ${evalIn(ctx, 'viewportWidth()')}`);
    sp.dispatchEvent(pointerEvt(ctx, 'pointerup', { pointerId: 1 }));
  });

  /* ---- S5 双击复位 ---- */
  await test('S5 双击分隔条 -> 复位默认宽度并清掉持久化', async (ctx) => {
    const sp = splitter(ctx);
    sp.dispatchEvent(pointerEvt(ctx, 'pointerdown', { clientX: 500, pointerId: 1 }));
    sp.dispatchEvent(pointerEvt(ctx, 'pointermove', { clientX: 640, pointerId: 1 }));
    sp.dispatchEvent(pointerEvt(ctx, 'pointerup', { pointerId: 1 }));
    ok(evalIn(ctx, 'state.listWidth') !== null, '前置：已有一个自定义宽度', String(evalIn(ctx, 'state.listWidth')));
    // 连击：第二次 pointerdown 的 detail = 2
    sp.dispatchEvent(pointerEvt(ctx, 'pointerdown', { clientX: 640, pointerId: 1, detail: 2 }));
    ok(evalIn(ctx, 'state.listWidth') === evalIn(ctx, 'LIST_W_DEFAULT'), '双击 -> 回到默认宽度', String(evalIn(ctx, 'state.listWidth')));
    ok(storedW(ctx) === String(evalIn(ctx, 'LIST_W_DEFAULT')), '并把默认值写进 localStorage', JSON.stringify(storedW(ctx)));
    ok(!isResizing(ctx), '双击不进入拖动状态（提前 return）');
  });

  /* ---- S6 期望值 vs 实际值（本功能最容易回归的一条） ---- */
  await test('S6 ⭐ 窗口缩小被夹后放大，必须回到「用户期望宽度」而不是被夹小后的值', async (ctx) => {
    const sp = splitter(ctx);
    sp.dispatchEvent(pointerEvt(ctx, 'pointerdown', { clientX: 500, pointerId: 1 }));
    sp.dispatchEvent(pointerEvt(ctx, 'pointermove', { clientX: 500 + 1000, pointerId: 1 }));
    sp.dispatchEvent(pointerEvt(ctx, 'pointerup', { pointerId: 1 }));
    const wantRaw = evalIn(ctx, 'state.listWidth');
    const maxAt1280 = evalIn(ctx, 'listWidthMax()');
    info(`期望宽度 = ${wantRaw}（内联变量 = ${cssVar(ctx)}，1280 下上限 = ${maxAt1280}）`);
    ok(wantRaw > maxAt1280, '⭐ 期望值记录了用户的原始拖动意图（大于当前夹取上限）', String(wantRaw));

    // 窗口缩到 600：可用上限变成 420，实际宽度被夹小，但**期望值不许被改写**
    Object.defineProperty(ctx.win, 'innerWidth', { value: 600, configurable: true });
    ctx.win.dispatchEvent(new ctx.win.Event('resize'));
    await ticks(ctx.win, 3);
    const clampedMax = evalIn(ctx, 'listWidthMax()');
    ok(clampedMax < maxAt1280, '前置：缩窗后上限确实变小了', `${clampedMax} < ${maxAt1280}`);
    ok(evalIn(ctx, 'state.listWidth') === wantRaw, '⭐ 缩窗后 state.listWidth 仍是期望值（未被夹小值覆盖）', String(evalIn(ctx, 'state.listWidth')));
    ok(cssVar(ctx) === `${clampedMax}px`, '实际内联宽度被夹到新的上限', cssVar(ctx));

    // 窗口放大回 1280：必须回到「1280 下的上限」，绝不能停在 420
    Object.defineProperty(ctx.win, 'innerWidth', { value: 1280, configurable: true });
    ctx.win.dispatchEvent(new ctx.win.Event('resize'));
    await ticks(ctx.win, 3);
    ok(cssVar(ctx) === `${maxAt1280}px`, '⭐⭐ 放大回原尺寸 -> 宽度恢复（不是停在缩窗时被夹的 420）', cssVar(ctx));
    ok(cssVar(ctx) !== `${clampedMax}px`, '⭐ 且确实不等于缩窗时的夹取值', `${cssVar(ctx)} vs ${clampedMax}px`);
  });

  /* ---- S7 持久化恢复 ---- */
  await test('S7 刷新后恢复上次宽度（boot 阶段就生效）', async (ctx) => {
    ok(evalIn(ctx, 'state.listWidth') === 700, 'boot 时已从 localStorage 读到 700', String(evalIn(ctx, 'state.listWidth')));
    ok(cssVar(ctx) === '700px', '内联变量在 init() 阶段就已应用（不是等用户拖一次才生效）', cssVar(ctx));
    ok(hasCustomClass(ctx), 'list-w-custom 已挂上');
  }, { seedListW: 700 });

  /* ---- S8 键盘 ---- */
  await test('S8 键盘：←/→ 步进、Shift 加速、Home 复位，且都 preventDefault', async (ctx) => {
    const sp = splitter(ctx);
    const base = evalIn(ctx, 'LIST_W_DEFAULT');
    let e = keyEvt(ctx, 'ArrowRight');
    sp.dispatchEvent(e);
    ok(evalIn(ctx, 'state.listWidth') === base + 16, 'ArrowRight -> +16', String(evalIn(ctx, 'state.listWidth')));
    ok(e.defaultPrevented, 'ArrowRight 已 preventDefault（否则页面会横向滚动）');
    e = keyEvt(ctx, 'ArrowLeft');
    sp.dispatchEvent(e);
    ok(evalIn(ctx, 'state.listWidth') === base, 'ArrowLeft -> -16（回到起点）', String(evalIn(ctx, 'state.listWidth')));
    e = keyEvt(ctx, 'ArrowRight', { shiftKey: true });
    sp.dispatchEvent(e);
    ok(evalIn(ctx, 'state.listWidth') === base + 50, 'Shift+ArrowRight -> +50（加速步进）', String(evalIn(ctx, 'state.listWidth')));
    e = keyEvt(ctx, 'Home');
    sp.dispatchEvent(e);
    ok(evalIn(ctx, 'state.listWidth') === base, 'Home -> 复位默认宽度', String(evalIn(ctx, 'state.listWidth')));
    e = keyEvt(ctx, 'a');
    sp.dispatchEvent(e);
    ok(e.defaultPrevented === false, '其它按键不被吞（负控制）', String(e.defaultPrevented));
  });

  /* ---- S9 移动端：不响应拖动 + CSS 隐藏 ---- */
  await test('S9 移动端：分隔条不显示，也不响应拖动', async (ctx) => {
    ok(evalIn(ctx, 'isMobile()') === true, '前置：375px 视口判定为移动端');
    const sp = splitter(ctx);
    sp.dispatchEvent(pointerEvt(ctx, 'pointerdown', { clientX: 500, pointerId: 1 }));
    ok(!isResizing(ctx), '移动端 pointerdown 不进入拖动（isMobile 提前 return）');
    sp.dispatchEvent(pointerEvt(ctx, 'pointermove', { clientX: 700, pointerId: 1 }));
    ok(evalIn(ctx, 'state.listWidth') === null, '移动端拖动不改变宽度', String(evalIn(ctx, 'state.listWidth')));
    // CSS：移动断点内必须把分隔条藏起来（单栏布局下它没有意义）
    const mq = /@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/.exec(CSS_NO_COMMENTS);
    ok(!!mq, 'app.css 里有 max-width:768px 断点');
    ok(mq && /#splitter\s*\{[^}]*display:\s*none/.test(mq[1]), '⭐ 该断点内 #splitter display:none（不会在手机上留一条拖不动的缝）',
      mq ? mq[1].replace(/\s+/g, ' ').slice(0, 80) : '');
  }, { width: 375, matchMedia: (q) => ({ matches: /max-width:\s*768px/.test(q) }) });

  /* ---- S10 CSS 契约 ---- */
  await test('S10 CSS 契约：分隔条命中区够宽、有可见竖线、列表栏不再自己画右边框', async (ctx) => {
    const block = (sel) => {
      const i = CSS_NO_COMMENTS.indexOf(`${sel} {`);
      if (i < 0) return null;
      return CSS_NO_COMMENTS.slice(i, CSS_NO_COMMENTS.indexOf('}', i));
    };
    const sp = block('#splitter');
    ok(!!sp, '#splitter 有样式规则');
    ok(sp && /cursor:\s*col-resize/.test(sp), 'cursor: col-resize（鼠标形状提示可拖）', sp && /cursor:\s*[a-z-]+/.exec(sp));
    // 命中区宽度写的是 flex-basis（`flex: 0 0 6px`），不是 width —— 太窄会抓不住
    const flex = sp && /flex:\s*0\s+0\s+(\d+)px/.exec(sp);
    ok(!!flex && Number(flex[1]) >= 5, `命中区宽度 ≥5px（太窄抓不住）`, flex && flex[1]);
    ok(/#splitter::before[\s\S]{0,200}?width:\s*1px/.test(CSS_NO_COMMENTS), '用 1px 伪元素画竖线（命中区宽但不占视觉宽度）');
    const list = block('#list-pane');
    ok(list && !/border-right/.test(list), '⭐ #list-pane 不再自己画 border-right（改由分隔条画，否则会出现两条线）',
      list ? list.replace(/\s+/g, ' ').slice(0, 70) : '');
    const custom = /#app\.list-w-custom\s+#list-pane\s*\{[^}]*--list-w/.test(CSS_NO_COMMENTS);
    ok(custom, '⭐ list-w-custom 类真的驱动了 #list-pane 宽度（否则拖动毫无视觉效果）');
    ok(/hover[\s\S]{0,120}?#splitter|#splitter:hover/.test(CSS_NO_COMMENTS), '有 hover 反馈（拖动前就能看出可交互）');
  });

  /* ---- S11 标题栏未读数 ---- */
  await test('S11 标题栏：无未读显示「收件箱」，有未读显示「(N) 收件箱」', async (ctx) => {
    ok(ctx.doc.title === '收件箱', '初始（未读 0）-> 纯「收件箱」', JSON.stringify(ctx.doc.title));
    ctx.state.counts.inbox_unread = 3;
    await evalIn(ctx, 'refreshCounts(true)');
    await ticks(ctx.win, 3);
    ok(ctx.doc.title === '(3) 收件箱', '未读 3 -> 「(3) 收件箱」', JSON.stringify(ctx.doc.title));
    const badge = el(ctx, '#folder-nav .folder-item[data-folder="inbox"] .folder-badge');
    ok(!!badge && badge.textContent === '3', '⭐ 标题与侧边栏徽标同源（都是 state.counts.inbox_unread）', badge && badge.textContent);
    ctx.state.counts.inbox_unread = 0;
    await evalIn(ctx, 'refreshCounts(true)');
    await ticks(ctx.win, 3);
    ok(ctx.doc.title === '收件箱', '未读清零 -> 标题回退纯「收件箱」（不残留「(0)」）', JSON.stringify(ctx.doc.title));
  });

  /* ---- S12 标题栏边界 ---- */
  await test('S12 标题栏边界：超 999 截断、切文件夹不覆盖标题', async (ctx) => {
    ctx.state.counts.inbox_unread = 1234;
    await evalIn(ctx, 'refreshCounts(true)');
    await ticks(ctx.win, 3);
    ok(ctx.doc.title === '(999+) 收件箱', '未读 >999 -> 「(999+) 收件箱」（与徽标同口径截断）', JSON.stringify(ctx.doc.title));
    const badge = el(ctx, '#folder-nav .folder-item[data-folder="inbox"] .folder-badge');
    ok(!!badge && badge.textContent === '999+', '徽标同样是 999+（两处口径一致）', badge && badge.textContent);

    // 切到「已发送」：renderNav 会重跑，标题不得被覆盖回默认值
    await evalIn(ctx, 'openFolder("sent")');
    await ticks(ctx.win, 5);
    ok(ctx.doc.title === '(999+) 收件箱', '⭐ 切文件夹后标题仍反映未读（不被 renderNav 覆盖成默认）', JSON.stringify(ctx.doc.title));

    ctx.state.counts.inbox_unread = 1;
    await evalIn(ctx, 'refreshCounts(true)');
    await ticks(ctx.win, 3);
    ok(ctx.doc.title === '(1) 收件箱', '未读 1 -> 「(1) 收件箱」（非 0 也走带括号分支）', JSON.stringify(ctx.doc.title));
  });

  /* ---- S13 标题栏：数字非法时不显示 NaN ---- */
  await test('S13 标题栏：计数缺失/非法 -> 回退「收件箱」，绝不出现 NaN', async (ctx) => {
    ctx.state.counts.inbox_unread = undefined;
    await evalIn(ctx, 'refreshCounts(true)');
    await ticks(ctx.win, 3);
    ok(ctx.doc.title === '收件箱', 'undefined -> 纯「收件箱」', JSON.stringify(ctx.doc.title));
    ok(!/NaN/.test(ctx.doc.title), '标题里没有 NaN');
    ctx.state.counts.inbox_unread = 'abc';
    await evalIn(ctx, 'refreshCounts(true)');
    await ticks(ctx.win, 3);
    ok(!/NaN/.test(ctx.doc.title), '非数字字符串也不产生 NaN', JSON.stringify(ctx.doc.title));
  });

  /* ---- 汇总 ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail === undefined ? '' : `  [${f.detail}]`}`);
  console.log(`\n被测版本: ${Object.entries(FINGERPRINT).map(([k, v]) => `${k}=${v.slice(0, 8)}`).join('  ')}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);
  for (const c of liveCtxs) c.close();
  process.exit(fail ? 1 : 0);
})();
