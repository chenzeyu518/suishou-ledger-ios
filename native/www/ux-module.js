/* ---------------------- 20. 交互补充层：记录的删除与金额清空（两端共用） ----------------------
   由各自的 scripts/sync-from-preview.js 整段注入到正式版 www/index.html，位于存储层之后。

   解决的问题：记完一笔账之后，「怎么删掉它」不好找 ——
     · 保存后的提示只闪 4 秒，错过就没了；
     · 删除藏在「点进记录 → 编辑弹层 → 底部删除」三步之后，不容易发现。
   本层补三件事，且不改动原有渲染逻辑（用事件委托 + 覆写两个函数实现）：
     1) 保存成功的提示延长到 9 秒，并把「撤销」直接写成「删除」；
     2) 长按任意一条记录 → 弹出「编辑 / 删除」操作菜单；删除前再确认一次；
     3) 数字键盘的 ⌫ 键长按 = 一次清空金额（不用连按好几下）。
   另有提示文案注入：明细页搜索框下方显示「长按任一记录可编辑或删除」。

   两份工程里的本文件内容必须保持一致，改动需同步。
   ------------------------------------------------------------------------------ */

/* 安全注册事件（桩环境 / 老 WebView 里缺失也就跳过，不影响记账） */
function uxOn(el, type, fn, opt){
  try { if (el && el.addEventListener) el.addEventListener(type, fn, opt); } catch(e){}
}

/* ---------------- 0. 少量样式 ---------------- */
(function uxStyle(){
  try {
    var css = document.createElement('style');
    css.textContent = [
      '.brow{-webkit-touch-callout:none}',
      '.brow.lp-on{background:#EDF1FA}',
      '.ux-hint{font-size:11.5px;color:var(--sub);padding:0 2px 8px;display:flex;align-items:center;gap:6px}',
      '.undo .b{min-width:46px;text-align:right}',
      '.key.holdon{background:#D9E2F7}'
    ].join('');
    (document.head || document.body).appendChild(css);
  } catch(e){}
})();

/* ---------------- 1. 记账成功提示：延长到 9 秒，可直接删除 ---------------- */
showUndo = function(bill){
  try {
    var c = catOf(bill.type, bill.category);
    var olds = document.querySelectorAll ? document.querySelectorAll('.undo') : null;
    if (olds && olds.forEach) olds.forEach(function(x){ try { x.remove(); } catch(e){} });
    var el = document.createElement('div');
    el.className = 'undo';
    el.innerHTML = '<span>✅</span>'
      + '<span class="txt">已记账：' + esc(bill.note || c.name) + ' ¥' + money(bill.amount) + '</span>'
      + '<span class="b" onclick="undoBill(\'' + bill._id + '\',this)">删除</span>';
    document.body.appendChild(el);
    setTimeout(function(){ try { el.remove(); } catch(e){} }, 9000);
  } catch(e){}
};

/* ---------------- 2. 长按记录 → 编辑 / 删除 ---------------- */
function uxBillIdOf(el){
  if (!el || !el.getAttribute) return '';
  var d = el.getAttribute('data-id');
  if (d) return d;
  var oc = el.getAttribute('onclick') || '';
  var m = oc.match(/openDetail\('([^']+)'\)/);
  return m ? m[1] : '';
}
function uxFind(t, cls, max){
  var n = 0;
  while (t && n++ < (max || 6)){
    if (t.classList && t.classList.contains && t.classList.contains(cls)) return t;
    t = t.parentNode;
  }
  return null;
}
function uxBillById(id){
  for (var i = 0; i < DB.bills.length; i++) if (DB.bills[i]._id === id) return DB.bills[i];
  return null;
}
function uxRowLine(b, c){
  return '<div class="itrow" style="align-items:center"><div class="bd"><div class="l1">'
    + '<span class="ell">' + esc(b.note || c.name) + '</span>'
    + '<b class="num ' + (b.type === 'income' ? 't-income' : 't-expense') + '">'
    + (b.type === 'income' ? '+' : '-') + '¥' + money(b.amount) + '</b></div>'
    + '<div style="font-size:11.5px;color:var(--sub)">' + c.name + ' · ' + flabel(b.date) + ' ' + b.time + '</div></div></div>';
}
window.openRowMenu = function(id){
  var b = uxBillById(id); if (!b) return toast('这条记录已不存在');
  var c = catOf(b.type, b.category);
  openSheet('<div class="sh-h"><b>这笔记录</b><span onclick="closeSheet()">✕</span></div>'
    + '<div class="sh-b">' + uxRowLine(b, c)
    + '<div class="note">点「编辑」可以改金额、分类、日期、备注；点「删除」会把这笔从账本里移除，删除前还会再确认一次。</div>'
    + '</div>'
    + '<div class="sh-f">'
    + '<div class="btn btn-g" style="flex:1" onclick="closeSheet();openDetail(\'' + id + '\')">编辑</div>'
    + '<div class="btn btn-d" style="flex:1" onclick="askDelBill(\'' + id + '\')">删除</div>'
    + '</div>');
};
window.askDelBill = function(id){
  var b = uxBillById(id); if (!b) return toast('这条记录已不存在');
  var c = catOf(b.type, b.category);
  openSheet('<div class="sh-h"><b>确定删除这笔？</b><span onclick="closeSheet()">✕</span></div>'
    + '<div class="sh-b">' + uxRowLine(b, c)
    + '<div class="note">删除后账本与统计立即更新。本机快照仍保留最近 6 份，删错了可在「我的 → 备份与恢复」里找回。</div></div>'
    + '<div class="sh-f"><div class="btn btn-g" style="flex:1" onclick="closeSheet()">取消</div>'
    + '<div class="btn btn-d" style="flex:1" onclick="confirmDelBill(\'' + id + '\')">删除</div></div>');
};
window.confirmDelBill = function(id){
  var n = DB.bills.length;
  DB.bills = DB.bills.filter(function(x){ return x._id !== id; });
  if (DB.bills.length === n) return toast('这条记录已不存在');
  save(); closeSheet(); render();
  toast('已删除，可在「备份与恢复」里找回');
};
/* 编辑弹层底部的「删除」也改成先确认，避免误删 */
delBill = function(id){ window.askDelBill(id); };

(function uxLongPress(){
  var timer = null, fired = false, sx = 0, sy = 0;
  function cancel(){ if (timer){ clearTimeout(timer); timer = null; } }
  uxOn(document, 'touchstart', function(e){
    var row = uxFind(e.target, 'brow');
    if (!row) return;
    var t = e.touches && e.touches[0]; if (!t) return;
    sx = t.clientX; sy = t.clientY; fired = false;
    cancel();
    timer = setTimeout(function(){
      timer = null; fired = true;
      try { if (navigator.vibrate) navigator.vibrate(18); } catch(x){}
      try { row.classList.add('lp-on'); } catch(x){}
      setTimeout(function(){ try { row.classList.remove('lp-on'); } catch(x){} }, 700);
      window.openRowMenu(uxBillIdOf(row));
    }, 550);
  }, { passive: true });
  uxOn(document, 'touchmove', function(e){
    var t = e.touches && e.touches[0]; if (!t) return;
    if (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12) cancel();
  }, { passive: true });
  uxOn(document, 'touchend', cancel, { passive: true });
  uxOn(document, 'touchcancel', cancel, { passive: true });
  /* 长按已经弹过菜单，屏蔽随之而来的 click，避免又打开编辑弹层 */
  uxOn(document, 'click', function(e){
    if (!fired) return;
    fired = false;
    if (e.stopPropagation) e.stopPropagation();
    if (e.preventDefault) e.preventDefault();
  }, true);
})();

/* ---------------- 3. 键盘 ⌫ 长按 = 一次清空金额 ---------------- */
(function uxKeyClear(){
  var timer = null;
  function cancel(){ if (timer){ clearTimeout(timer); timer = null; } }
  uxOn(document, 'touchstart', function(e){
    var t = e.target;
    if (!t || !t.closest) return;
    var key = t.closest('.key[data-key="del"]');
    if (!key) return;
    cancel();
    timer = setTimeout(function(){
      timer = null;
      S.buf = '0';
      var el = document.querySelector('.amtline .a');
      if (el) el.textContent = '0.00';
      toast('已清空金额');
    }, 500);
  }, { passive: true });
  uxOn(document, 'touchend', cancel, { passive: true });
  uxOn(document, 'touchmove', cancel, { passive: true });
  uxOn(document, 'touchcancel', cancel, { passive: true });
})();

/* ---------------- 4. 列表提示：长按可编辑 / 删除 ---------------- */
window.uxDecorate = function(){
  try {
    if (!document.querySelector) return;
    if (document.querySelector('#main .ux-hint')) return;
    var anchor = document.querySelector('#main .search');
    if (!anchor){
      var secs = document.querySelectorAll ? document.querySelectorAll('#main .sec') : null;
      for (var i = 0; secs && i < secs.length; i++){
        var s = secs[i];
        if (s.textContent && s.textContent.indexOf('最近记录') > -1){ anchor = s; break; }
      }
    }
    if (!anchor || !anchor.parentNode) return;
    var d = document.createElement('div');
    d.className = 'ux-hint';
    d.textContent = '长按任一记录，可编辑或删除';
    anchor.parentNode.insertBefore(d, anchor.nextSibling);
  } catch(e){}
};
(function uxWrapRender(){
  var raw = render;
  render = function(){
    raw.apply(null, arguments);
    window.uxDecorate();
  };
  window.uxDecorate();
})();
