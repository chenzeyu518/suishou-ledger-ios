/* ---------------------- 19. 存储加固层（iOS / Android 两端共用同一份） ----------------------
   由各自的 scripts/sync-from-preview.js 整段注入到正式版 www/index.html。

   背景：账本原先只写在 WebView 的 localStorage 里。它属于「可被系统清理」的数据，
   重装、清理存储、系统回收都可能让它消失，而且没有任何副本 —— 一旦消失无从找回。

   本层把存储升级为三层，互为副本、不再有单点：
     1) Preferences（iOS UserDefaults / Android SharedPreferences）—— 主存储。
        与 WebView 存储物理位置不同，清理 WebView 数据不会波及，覆盖安装必保留；
     2) localStorage —— 镜像。保证浏览器里预览时可用，并作为首屏同步读取来源；
     3) 快照 —— 主存储中滚动保留最近 6 份。防止误清空 / 误导入 / 写入中断。

   启动时三处比对，取写入时间戳（rev）最新的一份；若主存储与镜像都为空、
   但存在非空快照，则自动恢复（此时不会有任何数据被覆盖）。
   导出升级为「写成 .json 文件」，可存进「文件」App、iCloud，或直接发给自己。

   两份工程里的本文件内容必须保持一致，改动需同步。
   ------------------------------------------------------------------------------ */

var NKEY = 'ledger_native_v1';    /* 原生主存储键 */
var SNAP = 'ledger_snap_v1_';     /* 快照键前缀 */
var SNAP_MAX = 6;                 /* 最多保留快照份数 */
var SNAP_GAP = 5 * 60 * 1000;     /* 两次快照最小间隔 5 分钟 */

function storeP(){
  var C = window.Capacitor;
  return (C && C.Plugins && C.Plugins.Preferences) ? C.Plugins.Preferences : null;
}
function storeSet(k, v){
  var p = storeP(); if (!p) return;
  try { var r = p.set({ key: k, value: v }); if (r && r.catch) r.catch(function(){}); } catch(e){}
}
function storeGet(k){
  var p = storeP(); if (!p) return Promise.resolve(null);
  try {
    return p.get({ key: k }).then(function(r){ return (r && r.value) || null; }).catch(function(){ return null; });
  } catch(e){ return Promise.resolve(null); }
}
function storeKeys(){
  var p = storeP(); if (!p) return Promise.resolve([]);
  try {
    return p.keys().then(function(r){ return (r && r.keys) || []; }).catch(function(){ return []; });
  } catch(e){ return Promise.resolve([]); }
}
function storeDel(k){
  var p = storeP(); if (!p) return;
  try { var r = p.remove({ key: k }); if (r && r.catch) r.catch(function(){}); } catch(e){}
}
function storeSnaps(){
  return storeKeys().then(function(ks){
    return ks.filter(function(k){ return k.indexOf(SNAP) === 0; }).sort().reverse();
  });
}
function storePrune(){
  storeSnaps().then(function(ks){ ks.slice(SNAP_MAX).forEach(storeDel); });
}

/* 打包 / 解包：带写入时间戳，多副本之间据此判断谁最新 */
function storePack(){
  return JSON.stringify({ app: '随手记账', v: 1, rev: Date.now(), bills: DB.bills, rules: DB.rules, budgets: DB.budgets });
}
function storeUnpack(txt){
  try { var v = typeof txt === 'string' ? JSON.parse(txt) : txt; return (v && v.bills) ? v : null; } catch(e){ return null; }
}
function storeAdopt(v){
  DB = { bills: v.bills || [], rules: v.rules || [], budgets: v.budgets || {} };
  save(); render();
}

/* ---------------- 接管保存：三层同时写 ---------------- */
var __storeSnapAt = 0;
save = function(){
  var txt = storePack();
  try { localStorage.setItem(KEY, txt); } catch(e){}
  storeSet(NKEY, txt);
  var now = Date.now();
  if (now - __storeSnapAt > SNAP_GAP){ __storeSnapAt = now; storeSet(SNAP + now, txt); storePrune(); }
  if (window.haptic) window.haptic();
};

/* ---------------- 多副本取最新 / 首次迁移 ---------------- */
function storeSync(){
  if (!storeP()) return Promise.resolve(false);
  return Promise.all([storeGet(NKEY), Promise.resolve(localStorage.getItem(KEY) || null)])
    .then(function(arr){
      var nv = storeUnpack(arr[0]), lv = storeUnpack(arr[1]);
      if (nv && (!lv || (nv.rev || 0) >= (lv.rev || 0))){
        /* 主存储更新（或镜像已空）：以主存储为准，避免被空镜像覆盖 */
        if (!lv || (nv.rev || 0) !== (lv.rev || 0)) { storeAdopt(nv); return true; }
      } else if (lv){
        /* 镜像更新或主存储缺失：把镜像补写进主存储 */
        storeSet(NKEY, arr[1]);
      }
      return storeRestore();
    })
    .catch(function(){ return false; });
}

/* 主存储与镜像都为空时，从最近一份非空快照恢复（不会覆盖任何已有数据） */
function storeRestore(){
  if (DB.bills.length) return Promise.resolve(false);
  return storeSnaps().then(function(ks){
    var i = 0;
    function next(){
      if (i >= ks.length) return Promise.resolve(false);
      var k = ks[i++];
      return storeGet(k).then(function(t){
        var v = storeUnpack(t);
        if (v && v.bills && v.bills.length){
          storeAdopt(v);
          toast('已从本机快照恢复 ' + v.bills.length + ' 笔记录');
          return true;
        }
        return next();
      });
    }
    return next();
  });
}

/* ---------------- 导出：写成文件，可进「文件」App / iCloud / 发给别人 ---------------- */
function storePlugins(){ return (window.Capacitor && window.Capacitor.Plugins) || {}; }
function backupFileName(){
  var d = new Date();
  return '随手记账备份-' + dstr(d).replace(/-/g, '') + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
}
function storeCopy(txt){
  try {
    navigator.clipboard.writeText(txt).then(function(){ toast('备份已复制到剪贴板'); }, function(){ fallbackCopy(txt); });
  } catch(e){ fallbackCopy(txt); }
}
exportData = function(){
  var txt = storePack();
  var FS = storePlugins().Filesystem, SH = storePlugins().Share;
  if (!FS){ storeCopy(JSON.stringify(JSON.parse(txt), null, 2)); return; }
  FS.writeFile({ path: backupFileName(), data: txt, directory: 'DOCUMENTS', encoding: 'utf8' })
    .then(function(r){
      var uri = (r && r.uri) || '';
      if (SH && SH.share && uri){
        return SH.share({
          title: '随手记账备份',
          text: '账本备份文件，可存到「文件」App、iCloud，或直接发给自己。',
          url: uri, dialogTitle: '保存 / 分享备份'
        }).catch(function(){ toast('备份已保存（文件 App → 我的 iPhone → 随手记账）'); });
      }
      toast('备份已保存（文件 App → 我的 iPhone → 随手记账）');
    })
    .catch(function(){
      try { FS.writeFile({ path: backupFileName(), data: txt, directory: 'CACHE', encoding: 'utf8' }); } catch(e){}
      storeCopy(txt);
    });
};

/* ---------------- 恢复中心：快照 / 备份文件 / 粘贴文本 ---------------- */
function sfmt2(ts){
  var d = new Date(Number(ts) || 0);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function storeRenderSnaps(){
  var box = $('snapList'); if (!box) return;
  storeSnaps().then(function(ks){
    if (!ks.length){ box.innerHTML = '<div style="padding:14px;font-size:12.5px;color:var(--sub)">还没有快照，记第一笔账后会自动生成</div>'; return; }
    var rows = [];
    var n = 0;
    function step(){
      if (n >= ks.length){ box.innerHTML = rows.join(''); return; }
      var k = ks[n++];
      var ts = Number(k.slice(SNAP.length));
      storeGet(k).then(function(t){
        var v = storeUnpack(t);
        var cnt = v && v.bills ? v.bills.length : 0;
        if (cnt) rows.push(
          '<div class="itrow" style="align-items:center">'
          + '<div class="bd"><div class="l1"><span class="ell">' + sfmt2(ts) + '</span>'
          + '<b class="num">' + cnt + ' 笔</b></div></div>'
          + '<span class="more" onclick="storeUseSnap(\'' + k + '\')">恢复</span></div>');
        step();
      });
    }
    step();
  });
}
function storeUseSnap(k){
  storeGet(k).then(function(t){
    var v = storeUnpack(t);
    if (!v || !v.bills) return toast('该快照已损坏');
    var n = v.bills.length;
    openSheet('<div class="sh-h"><b>恢复这份快照</b><span onclick="closeSheet()">✕</span></div>'
      + '<div class="sh-b"><div class="note" style="padding-top:0">该快照包含 ' + n + ' 笔记录，来自 ' + sfmt2(Number(k.slice(SNAP.length))) + '。'
      + '恢复会<b>替换</b>当前账本（当前 ' + DB.bills.length + ' 笔），账单会去重后合并，不会丢现有记录。</div></div>'
      + '<div class="sh-f"><div class="btn btn-g" style="flex:1" onclick="closeSheet()">取消</div>'
      + '<div class="btn btn-p" style="flex:1" onclick="storeMergeSnap(\'' + k + '\')">恢复</div></div>');
  });
}
function storeMergeSnap(k){
  storeGet(k).then(function(t){
    var v = storeUnpack(t);
    if (!v || !v.bills) return toast('该快照已损坏');
    var seen = {};
    DB.bills.forEach(function(b){ seen[b.date + '|' + b.amount + '|' + b.note] = 1; });
    var add = 0;
    v.bills.forEach(function(b){
      var sig = b.date + '|' + b.amount + '|' + b.note;
      if (seen[sig]) return;
      seen[sig] = 1; add++;
      DB.bills.unshift(Object.assign({}, b, { _id: uid('r') }));
    });
    DB.bills.sort(function(a, b){ return (b.ts || 0) - (a.ts || 0); });
    save(); closeSheet(); render();
    toast(add ? '已从快照补回 ' + add + ' 笔' : '快照中的记录都已存在，无需补回');
  });
}
function storeRenderFiles(){
  var box = $('fileList'); if (!box) return;
  var FS = storePlugins().Filesystem;
  if (!FS){ box.innerHTML = '<div style="padding:14px;font-size:12.5px;color:var(--sub)">当前环境不支持读取备份文件</div>'; return; }
  FS.readdir({ path: '', directory: 'DOCUMENTS' }).then(function(r){
    var fs = ((r && r.files) || []).filter(function(f){ return /^随手记账备份-.*\.json$/.test(f.name); })
      .sort(function(a, b){ return String(b.name) < String(a.name) ? -1 : 1; });
    if (!fs.length){ box.innerHTML = '<div style="padding:14px;font-size:12.5px;color:var(--sub)">还没有备份文件，点上面「导出备份」即可生成</div>'; return; }
    box.innerHTML = fs.slice(0, 12).map(function(f){
      return '<div class="itrow" style="align-items:center"><div class="bd"><div class="l1">'
        + '<span class="ell" style="max-width:210px">' + esc(f.name.replace(/^随手记账备份-|\.json$/g, '')) + '</span>'
        + '<b class="num">' + Math.max(1, Math.round((f.size || 0) / 1024)) + ' KB</b></div></div>'
        + '<span class="more" onclick="storeUseFile(\'' + esc(f.name) + '\')">导入</span></div>';
    }).join('');
  }).catch(function(){
    box.innerHTML = '<div style="padding:14px;font-size:12.5px;color:var(--sub)">读取备份目录失败</div>';
  });
}
function storeUseFile(name){
  var FS = storePlugins().Filesystem;
  if (!FS) return;
  FS.readFile({ path: name, directory: 'DOCUMENTS', encoding: 'utf8' }).then(function(r){
    var v = storeUnpack(r && r.data);
    if (!v || !v.bills) return toast('文件不是有效的备份');
    var seen = {}, add = 0;
    DB.bills.forEach(function(b){ seen[b.date + '|' + b.amount + '|' + b.note] = 1; });
    v.bills.forEach(function(b){
      var sig = b.date + '|' + b.amount + '|' + b.note;
      if (seen[sig]) return;
      seen[sig] = 1; add++;
      DB.bills.unshift(Object.assign({}, b, { _id: uid('f'), source: 'import' }));
    });
    DB.bills.sort(function(a, b){ return (b.ts || 0) - (a.ts || 0); });
    save(); closeSheet(); render();
    toast(add ? '已从备份文件导入 ' + add + ' 笔' : '该备份的记录都已存在');
  }).catch(function(){ toast('读取备份文件失败'); });
}
function storeRefresh(){ storeRenderSnaps(); storeRenderFiles(); }

importData = function(){
  openSheet(
    '<div class="sh-h"><b>备份与恢复</b><span onclick="closeSheet()">✕</span></div>'
    + '<div class="sh-b">'
    +   '<div class="hint g" style="margin-bottom:12px"><span>🛡️</span><div><b>你的账本现在有三份副本</b>'
    +   '系统级存储（清应用数据也不受影响，覆盖安装必保留）+ 本机镜像 + 自动快照，启动时自动取最新的一份。</div></div>'
    +   '<div class="sec" style="margin:6px 0 8px">本机自动快照 <span class="more" onclick="storeRefresh()">刷新</span></div>'
    +   '<div class="card" id="snapList"><div style="padding:14px;font-size:12.5px;color:var(--sub)">读取中…</div></div>'
    +   '<div class="sec" style="margin:16px 0 8px">从备份文件恢复</div>'
    +   '<div class="card" id="fileList"><div style="padding:14px;font-size:12.5px;color:var(--sub)">读取中…</div></div>'
    +   '<div class="sec" style="margin:16px 0 8px">粘贴备份文本恢复</div>'
    +   '<textarea class="ta" id="impTa" placeholder=\'{"app":"随手记账",...}\'></textarea>'
    +   '<div class="note">粘贴导入为追加模式，不会覆盖或删除你现有的记录。</div>'
    + '</div>'
    + '<div class="sh-f"><div class="btn btn-g" style="flex:1" onclick="pasteTo(\'impTa\')">粘贴</div>'
    + '<div class="btn btn-p" style="flex:2" onclick="doImportJSON()">导入文本</div></div>'
  );
  storeRefresh();
};

/* ---------------- 启动：多副本取最新 → 迁移 → 兜底恢复 ---------------- */
function storeBoot(){
  try { storeSync().then(function(changed){ if (changed) render(); }); } catch(e){}
}
(function storeAutoBoot(){
  setTimeout(function(){ storeBoot(); }, 80);
})();
