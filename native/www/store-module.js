/* ---------------------- 19. 存储加固层（iOS / Android 两端共用同一份） ----------------------
   由各自的 scripts/sync-from-preview.js 整段注入到正式版 www/index.html。

   背景：账本原先只写在 WebView 的 localStorage 里。它属于「可被系统清理」的数据，
   重装、清理存储、系统回收都可能让它消失，而且没有任何副本 —— 一旦消失无从找回。

   本层把存储升级为「四副本互备」，任何一份没了都能从其他副本长回来：
     1) 钥匙串保险柜（iOS Keychain，@autoload 原生插件 LedgerVault）—— 最高级别。
        iOS 上唯一在「卸载 App / 重新签名安装」之后仍然保留的本地存储，
        因此它是覆盖安装、重装、重签之后把账本找回来的最后一道保险。
     2) 系统级存储（iOS UserDefaults / Android SharedPreferences，@capacitor/preferences）。
        与 WebView 存储物理位置不同，清理 WebView 数据不会波及。
     3) 备份文件（iOS：Documents 目录，可在「文件」App 里看到并拷进 iCloud；
        Android：应用私有目录）。用户可见、可自行带走。
     4) 本机镜像（localStorage）—— 首屏同步读取来源，兼浏览器预览。
     另有滚动快照（保留最近 6 份）防误清空 / 误导入 / 写入中断。

   启动时四份比对，取写入时间戳（rev）最新的一份；主副本缺失时自动补写（自愈）；
   四份都空但存在非空快照时，自动从最近快照恢复。写入时四份同时落盘。

   两份工程里的本文件内容必须保持一致，改动需同步。
   ------------------------------------------------------------------------------ */

var NKEY = 'ledger_native_v1';      /* 系统级主存储键 */
var SNAP = 'ledger_snap_v1_';       /* 快照键前缀 */
var SNAP_MAX = 6;                   /* 最多保留快照份数 */
var SNAP_GAP = 5 * 60 * 1000;       /* 两次快照最小间隔 5 分钟 */
var LIVE_FILE = '随手记账-自动备份.json';  /* 文档目录里的常驻副本 */
var HEAVY_GAP = 10 * 1000;          /* 文件 / 钥匙串写入节流 10 秒 */

/* ---------------- 插件访问（缺失时静默降级，不影响记账） ---------------- */
function storePlugins(){ return (window.Capacitor && window.Capacitor.Plugins) || {}; }
function storePlatform(){
  try { return (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web'; }
  catch(e){ return 'web'; }
}
function storeP(){ var p = storePlugins().Preferences; return p || null; }
function storeVaultP(){ var v = storePlugins().LedgerVault; return v || null; }
function storeFSP(){ var f = storePlugins().Filesystem; return f || null; }
function storeDir(){ return storePlatform() === 'ios' ? 'DOCUMENTS' : 'DATA'; }

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

/* ---------------- 备份文件副本（Documents / DATA） ---------------- */
function storeFileWrite(txt){
  var FS = storeFSP(); if (!FS) return;
  try {
    var r = FS.writeFile({ path: LIVE_FILE, data: txt, directory: storeDir(), encoding: 'utf8' });
    if (r && r.catch) r.catch(function(){});
  } catch(e){}
}
function storeFileRead(){
  var FS = storeFSP(); if (!FS) return Promise.resolve(null);
  try {
    return FS.readFile({ path: LIVE_FILE, directory: storeDir(), encoding: 'utf8' })
      .then(function(r){ return (r && r.data) || null; })
      .catch(function(){ return null; });
  } catch(e){ return Promise.resolve(null); }
}

/* ---------------- 钥匙串保险柜副本（iOS） ---------------- */
var __vaultState = 'unknown';   /* unknown | ok | empty | unavailable */
function storeVaultWrite(txt){
  var V = storeVaultP(); if (!V) { __vaultState = 'unavailable'; return; }
  try {
    var r = V.writeVault({ value: txt });
    if (r && r.then) r.then(function(){ __vaultState = 'ok'; }, function(){ __vaultState = 'unavailable'; });
  } catch(e){ __vaultState = 'unavailable'; }
}
function storeVaultRead(){
  var V = storeVaultP(); if (!V) { __vaultState = 'unavailable'; return Promise.resolve(null); }
  try {
    return V.readVault().then(function(r){
      var v = (r && r.value) || null;
      __vaultState = v ? 'ok' : 'empty';
      return v;
    }, function(){ __vaultState = 'unavailable'; return null; });
  } catch(e){ __vaultState = 'unavailable'; return Promise.resolve(null); }
}

/* ---------------- 打包 / 解包：带写入时间戳，多副本之间据此判断谁最新 ---------------- */
function storePack(){
  return JSON.stringify({ app: '随手记账', v: 1, rev: Date.now(), bills: DB.bills, rules: DB.rules, budgets: DB.budgets });
}
function storeUnpack(txt){
  try { var v = typeof txt === 'string' ? JSON.parse(txt) : txt; return (v && v.bills) ? v : null; } catch(e){ return null; }
}
function storeRev(txt){
  var v = storeUnpack(txt);
  return v ? (v.rev || 0) : -1;
}
function storeCount(txt){
  var v = storeUnpack(txt);
  return v && v.bills ? v.bills.length : 0;
}
function storeAdopt(v){
  DB = { bills: v.bills || [], rules: v.rules || [], budgets: v.budgets || {} };
  save(); render();
}

/* ---------------- 四份副本一起读 ---------------- */
function storeReadAll(){
  return Promise.all([
    storeGet(NKEY),
    Promise.resolve(localStorage.getItem(KEY) || null),
    storeFileRead(),
    storeVaultRead()
  ]).then(function(a){
    return { native: a[0] || null, mirror: a[1] || null, file: a[2] || null, vault: a[3] || null };
  });
}
/* 取 rev 最新且非空的一份；name 记录它来自哪个副本 */
function storeBest(p){
  var best = null, order = ['vault', 'native', 'file', 'mirror'];
  order.forEach(function(k){
    var txt = p[k]; if (!txt) return;
    var rev = storeRev(txt); if (rev < 0) return;
    if (!storeCount(txt)) return;               /* 空账本不算「有数据」，避免把清空操作顶回去 */
    if (!best || rev > best.rev) best = { name: k, rev: rev, txt: txt, v: storeUnpack(txt) };
  });
  return best;
}

/* ---------------- 写入：四副本同时落盘（重量级副本做节流） ---------------- */
var __storeSnapAt = 0, __heavyAt = 0, __pendingTxt = null, __flushTimer = null;
function storeWriteHeavy(txt){
  storeFileWrite(txt);
  storeVaultWrite(txt);
  __heavyAt = Date.now();
}
function storeFlush(){
  if (__pendingTxt){
    storeWriteHeavy(__pendingTxt);
    __pendingTxt = null;
  }
}
save = function(){
  var txt = storePack();
  try { localStorage.setItem(KEY, txt); } catch(e){}
  storeSet(NKEY, txt);
  if (Date.now() - __heavyAt > HEAVY_GAP){
    storeWriteHeavy(txt);
  } else {
    /* 节流：记住最后一次内容，稍后或离开页面时补写，避免频繁写文件与钥匙串 */
    __pendingTxt = txt;
    if (!__flushTimer && typeof setTimeout === 'function'){
      __flushTimer = setTimeout(function(){ __flushTimer = null; storeFlush(); }, HEAVY_GAP + 200);
    }
  }
  var now = Date.now();
  if (now - __storeSnapAt > SNAP_GAP){ __storeSnapAt = now; storeSet(SNAP + now, txt); storePrune(); }
  if (window.haptic) window.haptic();
};

/* ---------------- 启动同步：取最新 → 自愈补写 → 快照兜底 ---------------- */
function storeSync(){
  return storeReadAll().then(function(p){
    var best = storeBest(p);
    var cur = storeRev(p.mirror);              /* 内存里当前账本对应的 rev */
    var changed = false;

    if (!DB.bills.length && best){
      /* 本机可见数据为空（首次安装 / 存储被清 / 覆盖安装后沙盒被换），从其他副本恢复 */
      storeAdopt(best.v);
      changed = true;
      toast('已从本机备份恢复 ' + best.v.bills.length + ' 笔记录');
    } else if (best && best.rev > cur){
      /* 其他副本比内存里的更新（上一次写入被中断等），以更新的为准 */
      storeAdopt(best.v);
      changed = true;
    }

    /* 自愈：把当前确认过的内容补写进缺失或落后的副本，让四份重新一致
       （用同一份 txt，rev 保持一致，避免每次启动都误判「有更新的副本」） */
    var healTxt = storeRev(p.mirror) >= 0 ? p.mirror : (best ? best.txt : null);
    if (healTxt && storeCount(healTxt)){
      var hrev = storeRev(healTxt);
      if (storeRev(p.native) !== hrev) storeSet(NKEY, healTxt);
      if (storeRev(p.file) !== hrev) storeFileWrite(healTxt);
      if (storeRev(p.vault) !== hrev) storeVaultWrite(healTxt);
    }

    if (changed) return true;
    return storeRestore();
  }).catch(function(){ return false; });
}

/* 四副本都空时，从最近一份非空快照恢复 */
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

/* ---------------- 存储诊断：把四份副本的状态摊开给人看 ---------------- */
function storeDiag(){
  return storeReadAll().then(function(p){
    var rows = [];
    /* 钥匙串保险柜只在 iOS 存在（Android 的对应保障是系统自动备份） */
    if (storeVaultP() || storePlatform() === 'ios'){
      rows.push({ k: 'vault', name: '钥匙串保险柜', hint: '卸载 / 重装 App 后仍保留', txt: p.vault });
    }
    rows.push(
      { k: 'native', name: '系统级存储', hint: '清应用数据也不受影响', txt: p.native },
      { k: 'mirror', name: '本机镜像', hint: '打开即刻可用（网页存储）', txt: p.mirror },
      { k: 'file', name: '备份文件', hint: storeDir() === 'DOCUMENTS' ? '「文件」App → 我的 iPhone → 随手记账' : '应用私有目录', txt: p.file }
    );
    rows.forEach(function(r){ r.count = storeCount(r.txt); r.rev = storeRev(r.txt); });
    return rows;
  });
}
function storeRenderDiag(){
  var box = $('diagList'); if (!box) return;
  storeDiag().then(function(rows){
    box.innerHTML = rows.map(function(r){
      var ok = r.count > 0;
      var state = ok ? (r.count + ' 笔 · ' + sfmt2(r.rev)) : '空';
      if (r.k === 'vault' && __vaultState === 'unavailable') state = '不可用（本机型未启用）';
      var color = ok ? 'var(--primary)' : 'var(--sub)';
      return '<div class="itrow" style="align-items:center">'
        + '<div class="bd"><div class="l1"><span class="ell">' + r.name + '</span>'
        + '<b class="num" style="color:' + color + '">' + state + '</b></div>'
        + '<div class="t2" style="font-size:11.5px;color:var(--sub)">' + r.hint + '</div></div></div>';
    }).join('');
  }).catch(function(){
    box.innerHTML = '<div style="padding:14px;font-size:12.5px;color:var(--sub)">读取副本状态失败</div>';
  });
}
function storeHeal(){
  if (!DB.bills.length) return toast('当前账本为空，无需同步');
  var txt = storePack();
  storeWriteHeavy(txt);
  storeSet(NKEY, txt);
  storeSet(SNAP + Date.now(), txt);
  storePrune();
  toast('已把当前账本写入全部副本');
  setTimeout(storeRenderDiag, 300);
}

/* ---------------- 导出：写成文件，可进「文件」App / iCloud / 发给别人 ---------------- */
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
  var FS = storeFSP(), SH = storePlugins().Share;
  if (!FS){ storeCopy(JSON.stringify(JSON.parse(txt), null, 2)); return; }
  FS.writeFile({ path: backupFileName(), data: txt, directory: storeDir(), encoding: 'utf8' })
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

/* ---------------- 恢复中心：诊断 / 快照 / 备份文件 / 粘贴文本 ---------------- */
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
        var cnt = storeCount(t);
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
      + '恢复会把快照里的记录<b>合并</b>进当前账本（当前 ' + DB.bills.length + ' 笔），相同记录自动去重，不会丢现有数据。</div></div>'
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
  var FS = storeFSP();
  if (!FS){ box.innerHTML = '<div style="padding:14px;font-size:12.5px;color:var(--sub)">当前环境不支持读取备份文件</div>'; return; }
  FS.readdir({ path: '', directory: storeDir() }).then(function(r){
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
  var FS = storeFSP();
  if (!FS) return;
  FS.readFile({ path: name, directory: storeDir(), encoding: 'utf8' }).then(function(r){
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
function storeRefresh(){ storeRenderDiag(); storeRenderSnaps(); storeRenderFiles(); }

importData = function(){
  openSheet(
    '<div class="sh-h"><b>备份与恢复</b><span onclick="closeSheet()">✕</span></div>'
    + '<div class="sh-b">'
    +   '<div class="hint g" style="margin-bottom:12px"><span>🛡️</span><div><b>你的账本同时存在 4 份副本里</b>'
    +   '钥匙串保险柜（卸载重装也能找回）+ 系统级存储 + 备份文件 + 本机镜像，任一份丢失都会从其他副本自动长回来。</div></div>'
    +   '<div class="sec" style="margin:6px 0 8px">存储状态 <span class="more" onclick="storeHeal()">立即同步</span></div>'
    +   '<div class="card" id="diagList"><div style="padding:14px;font-size:12.5px;color:var(--sub)">读取中…</div></div>'
    +   '<div class="sec" style="margin:16px 0 8px">本机自动快照 <span class="more" onclick="storeRefresh()">刷新</span></div>'
    +   '<div class="card" id="snapList"><div style="padding:14px;font-size:12.5px;color:var(--sub)">读取中…</div></div>'
    +   '<div class="sec" style="margin:16px 0 8px">从备份文件恢复</div>'
    +   '<div class="card" id="fileList"><div style="padding:14px;font-size:12.5px;color:var(--sub)">读取中…</div></div>'
    +   '<div class="sec" style="margin:16px 0 8px">粘贴备份文本恢复</div>'
    +   '<textarea class="ta" id="impTa" placeholder=\'{"app":"随手记账",...}\'></textarea>'
    +   '<div class="note">粘贴导入与快照恢复都是「去重后追加」，不会覆盖或删除你现有的记录。</div>'
    + '</div>'
    + '<div class="sh-f"><div class="btn btn-g" style="flex:1" onclick="pasteTo(\'impTa\')">粘贴</div>'
    + '<div class="btn btn-p" style="flex:2" onclick="doImportJSON()">导入文本</div></div>'
  );
  storeRefresh();
};

/* ---------------- 启动：多副本取最新 → 自愈 → 兜底恢复 ---------------- */
function storeBoot(){
  try { storeSync().then(function(changed){ if (changed) render(); }); } catch(e){}
}
(function storeAutoBoot(){
  setTimeout(function(){ storeBoot(); }, 80);
  /* 离开页面 / 切到后台时，把节流中的内容补写进文件与钥匙串 */
  try {
    window.addEventListener('pagehide', storeFlush);
    document.addEventListener('visibilitychange', function(){ if (document.hidden) storeFlush(); });
  } catch(e){}
})();
