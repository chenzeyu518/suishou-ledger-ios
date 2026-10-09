/* ---------------------- 19. 发票 / 小票 拍照识别入账 ----------------------
   由 scripts/sync-from-preview.js 注入到正式版 www/index.html。
   iOS 与 Android 两端注入的是**同一份代码**，改动必须两端同步。

   分工：
     · 原生插件只负责「把照片上的字读出来」——
       iOS 用系统自带的 Vision，Android 用 ML Kit，都在本机离线完成，
       不上传图片、不联网、不申请无关权限；
     · 本文件负责「把读出来的字变成一笔账」——金额、日期、商户、收支方向、分类。

   解析口径（宁漏不错，拿不准就交给用户确认）：
     金额优先级：价税合计（小写）> 应付/实付/合计金额 > 合计/总计/应收/应付/票价
                 > 实收（若票面另有「找零」，用「实收 − 找零」校正）
     整行排除：  找零、税额、税率、折扣、优惠、单价、数量、余额、积分、
                 发票代码、发票号码、识别号、校验码、日期、电话等
     分类优先级：发票品目里的 *类别* 星号标记 > 品目/商户名关键词 > 页面通用词典
     日期：      2026年10月08日 / 2026-10-08 / 10月08日；抽不到才退回当天
   ------------------------------------------------------------------------------ */

/* ---------------- 19.1 词表 ---------------- */

/* 金额标签：分数越高越可信 */
var INV_AMT_LABELS = [
  { re: /价税合计|含税金额|价税总计/, s: 100 },
  { re: /（小写）|\(小写\)|小写/, s: 95 },
  { re: /应付金额|实付金额|支付金额|付款金额|订单金额|消费金额|交易金额|实收金额|应收金额|合计金额|总计金额|总金额|金额合计/, s: 90 },
  { re: /合计|总计|总额|应收|应付|实付|票价|小计金额/, s: 75 },
  { re: /实收|已收|收款|付款|现金/, s: 60 },
  { re: /金额/, s: 45 }
];

/* 命中这些词的行整行不作金额候选（除非同时含「价税合计 / 小写」） */
var INV_AMT_BAD = /(找零|找赎|找钱|抹零|税额|税率|折扣|优惠|减免|单价|数量|余额|积分|卡号|尾号|电话|识别号|发票代码|发票号码|日期|时间|校验码|机器编号|密码区|开票人|收款人|复核|版本|税号|开户行|账号)/;

var INV_NUM = /[¥￥]?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*元?/g;

/* 发票品目 / 商户名 → 分类：词的颗粒度要够大，避免误命中 */
var INV_CAT = [
  { k: 'canyin', re: /餐饮服务|餐费|餐饮|酒楼|餐厅|饭店|快餐|外卖|咖啡|茶饮|烘焙|糕点|食堂|团餐|聚餐/ },
  { k: 'jiaotong', re: /运输服务|客运|货运|出租车|网约车|滴滴|代驾|高速通行|过路费|通行费|停车费|停车|加油|燃油|成品油|充电服务|洗车|车辆维修|汽车维修|航空运输|铁路运输|铁路旅客|火车票|铁路电子|机票|行程单|民航|地铁|公交|打车|交通服务/ },
  { k: 'lvxing', re: /住宿服务|住宿费|客房|酒店|宾馆|民宿|旅游服务|旅游费|旅行社|度假|景区|携程|去哪儿|飞猪/ },
  { k: 'tongxun', re: /电信服务|通信服务|话费|流量费|宽带|移动通信|中国联通|中国电信|中国移动|手机费|通讯费/ },
  { k: 'juzhu', re: /物业|水费|自来水|电费|供电|燃气|天然气|供暖|取暖|房租|租金|房屋租赁|居民日常服务|家政|保洁|维修服务|装修|家装/ },
  { k: 'yiliao', re: /医疗服务|医疗|药品|诊疗|门诊|挂号|体检|口腔|牙科|药房|药店|卫生服务|住院/ },
  { k: 'jiaoyu', re: /教育服务|培训|学费|课程|图书|教材|考试费|驾校|文具|网课/ },
  { k: 'yule', re: /娱乐服务|文化服务|体育服务|电影|影院|演出|门票|健身|游戏|KTV|游乐|体育场馆/ },
  { k: 'chongwu', re: /宠物|动物医院|兽药/ },
  { k: 'renqing', re: /礼品|鲜花|婚庆|礼仪服务|礼金/ },
  { k: 'gouwu', re: /百货|超市|商场|服饰|服装|鞋帽|箱包|化妆品|日用品|家电|数码|电子产品|便利店|零售|办公用品|五金|家居|母婴|珠宝|食品|饮料|酒水|烟酒/ },
  { k: 'qita', re: /信息技术服务|软件服务|技术服务|咨询服务|设计服务|广告服务|商务服务|会议服务|印刷|修理修配|办公服务|其他服务|生活服务/ }
];

/* ---------------- 19.2 纯解析函数（无 DOM 依赖，可单测） ---------------- */

/** 商户名清洗：复用短信解析器的同一套口径（去括号后缀与公司后缀） */
function invTidy(s) {
  return (typeof smsTidy === 'function') ? smsTidy(s) : String(s == null ? '' : s).trim();
}

/** 票据类型：顺序有意义——火车票 / 机票同时也是「发票」，必须先判 */
function invDocType(flat) {
  if (/铁路电子客票|火车票|中国铁路|检票|铁路旅客/.test(flat)) return { key: 'train', name: '火车票' };
  if (/航空运输电子客票|航空电子客票|电子客票行程单|行程单/.test(flat)) return { key: 'flight', name: '机票行程单' };
  if (/出租车|的士|网约车|滴滴/.test(flat)) return { key: 'taxi', name: '出行票据' };
  if (/增值税|电子发票|普通发票|专用发票|发票代码|发票号码|数电票/.test(flat)) return { key: 'vat', name: '增值税发票' };
  if (/定额发票/.test(flat)) return { key: 'quota', name: '定额发票' };
  if (/收据|小票|结算单|消费清单|购物清单|POS/.test(flat)) return { key: 'receipt', name: '小票 / 收据' };
  return { key: 'receipt', name: '票据' };
}

/**
 * 金额识别：逐行给分，取分最高的一条。
 * 同分时优先「靠下的行」（合计通常在票面底部），再优先「同行靠左」（金额在税额左边）。
 */
function invAmount(lines) {
  var cands = [], i, j, m;
  for (i = 0; i < lines.length; i++) {
    var L = String(lines[i]).replace(/\s+/g, '');
    if (!L || L.length > 90) continue;
    if (INV_AMT_BAD.test(L) && !/价税合计|小写/.test(L)) continue;

    var ls = 0;
    for (j = 0; j < INV_AMT_LABELS.length; j++) {
      if (INV_AMT_LABELS[j].re.test(L) && INV_AMT_LABELS[j].s > ls) ls = INV_AMT_LABELS[j].s;
    }

    INV_NUM.lastIndex = 0;
    while ((m = INV_NUM.exec(L)) !== null) {
      var raw = m[1].replace(/,/g, '');
      var v = parseFloat(raw);
      if (isNaN(v) || v <= 0 || v > 9999999) continue;
      var dot = raw.indexOf('.');
      var dec = dot < 0 ? 0 : raw.length - dot - 1;
      if (dec > 2) continue;

      var s = ls;
      if (/[¥￥]/.test(m[0])) s += 30;
      if (dec === 2) s += 10; else if (dec === 1) s += 4; else s -= 8;
      if (dec === 0 && raw.length >= 5) s -= 45; /* 发票代码 / 识别号这类长整数 */
      if (s <= 0) continue;

      cands.push({ v: v, s: s, i: i, c: m.index, line: L });
    }
  }
  if (!cands.length) return null;
  cands.sort(function (a, b) { return (b.s - a.s) || (b.i - a.i) || (a.c - b.c); });
  return cands[0];
}

/** 票面上的找零金额（小票专用） */
function invChange(lines) {
  for (var i = lines.length - 1; i >= 0; i--) {
    var L = String(lines[i]).replace(/\s+/g, '');
    if (!/(找零|找赎|找钱)/.test(L)) continue;
    var m = L.match(/(?:找零|找赎|找钱)[:：]?[¥￥]?(\d+(?:\.\d{1,2})?)/);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

/** 日期：先找带年份的完整写法，再找「10月08日」 */
function invDate(text) {
  var s = String(text).replace(/\s+/g, '');
  var m = s.match(/(20\d{2})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/);
  if (m) {
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { y: y, m: mo, d: d, exact: true };
  }
  m = s.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) {
    var mo2 = +m[1], d2 = +m[2];
    if (mo2 >= 1 && mo2 <= 12 && d2 >= 1 && d2 <= 31) {
      return { y: new Date().getFullYear(), m: mo2, d: d2, exact: true };
    }
  }
  return { exact: false };
}

/** 销售方（商户）名称：发票取「销售方 … 名称：」，小票退回首行店名 */
function invSeller(lines, flat) {
  var stop = /纳税人识别号|统一社会信用代码|税号|地址|电话|开户行|账号|银行|购买方|销售方|项目名称|金额|合计/;
  var pats = [
    /(?:销售方|销方|销货方|销货单位|开票单位|商户名称|商家名称|收款单位|收款方|商户)(?:信息)?(?:名称)?[:：]?([\u4e00-\u9fa5A-Za-z0-9（）()·&\-]{4,40})/,
    /名称[:：]([\u4e00-\u9fa5A-Za-z0-9（）()·&\-]{4,40})/
  ];
  for (var i = 0; i < pats.length; i++) {
    var m = flat.match(pats[i]);
    if (m && m[1]) {
      var name = m[1].split(stop)[0].replace(/^名称[:：]?/, '').trim();
      if (name.length >= 2) return name;
    }
  }

  /* 小票：取开头几行里最像店名的一行 */
  for (var k = 0; k < Math.min(lines.length, 8); k++) {
    var L = String(lines[k]).replace(/[\s:：]/g, '');
    if (L.length < 3 || L.length > 26) continue;
    if (/^[0-9]/.test(L)) continue;
    if (!/[\u4e00-\u9fa5]/.test(L)) continue;
    if (/^[A-Za-z]{1,3}\d{1,5}/.test(L)) continue;      /* 车次 / 航班号 */
    if (/[-—~～至]/.test(L)) continue;                   /* 出发地-到达地 */
    if (/[¥￥]/.test(L)) continue;                        /* 带金额的行不是店名 */
    if (/\d+\.\d/.test(L)) continue;
    if (/(发票|小票|收据|清单|消费|购物|欢迎|谢谢|惠顾|光临|日期|时间|电话|地址|编号|单号|序号|收银|找零|合计|金额|商品|数量|单价|会员|门店|客票|行程单|铁路|航空|出行|身份证|证件|姓名|座位|车厢|席别|NO|POS)/i.test(L)) continue;
    return L;
  }
  return '';
}

/** 发票品目短名：*餐饮服务*餐饮费 → 餐饮服务 */
function invGoodsNote(goods) {
  if (!goods) return '';
  var m = String(goods).match(/\*([^*]{1,20})\*/);
  return invTidy(m ? m[1] : goods);
}

function invCatHit(s) {
  if (!s) return '';
  for (var i = 0; i < INV_CAT.length; i++) if (INV_CAT[i].re.test(s)) return INV_CAT[i].k;
  return '';
}

/** 分类推断：星号品目最可靠，其次品目/商户名，最后退回页面通用词典 */
function invCategory(flat, note, goods, docName) {
  var stars = flat.match(/\*[^*\n]{2,20}\*/g);
  if (stars) {
    for (var i = 0; i < stars.length; i++) {
      var h = invCatHit(stars[i]);
      if (h) return h;
    }
  }
  var h2 = invCatHit(goods || '') || invCatHit(note || '') || invCatHit(docName || '');
  if (h2) return h2;
  try {
    var inf = infer(note, 'expense');
    if (inf && inf.type === 'expense') return inf.key;
  } catch (e) {}
  return 'qita';
}

/**
 * 主入口：OCR 文本 → 账单草稿
 * 永远返回 { ok, ... }；ok=false 时 reason 可直接展示给用户。
 */
function parseInvoiceText(text) {
  var raw = String(text == null ? '' : text);
  var clean = raw.replace(/[ \t\u00a0]+/g, ' ').trim();
  if (!clean) return { ok: false, reason: '没有读到文字，请把票据拍清楚一点再试' };

  var lines = clean.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
  /* OCR 会在字之间插空格（「销售方信息 名称：」），做字段抽取前必须先把行内空格去掉，
     但又不能把换行也去掉，否则每行是一行小票会连成一串。 */
  var dense = lines.join('\n').replace(/[ \t\u00a0]+/g, '');
  var flat = dense.replace(/\n/g, '');

  var amt = invAmount(lines);
  var amount = amt ? amt.v : 0;

  /* 小票常见写法：合计 11.50 / 实收 20.00 / 找零 8.50 —— 选中「实收」时用找零校正 */
  var chg = invChange(lines);
  if (amt && chg != null && chg > 0 && /实收|已收|收款|付款|现金/.test(amt.line) && amount > chg) {
    amount = Math.round((amount - chg) * 100) / 100;
  }

  var dt = invDate(clean);
  var doc = invDocType(flat);
  var seller = invTidy(invSeller(lines, flat));
  var invNo = (flat.match(/发票号码[:：]?(\d{6,24})/) || [])[1] || '';
  var goods = (dense.match(/\*[^*\n]{1,20}\*[^*\n]{1,20}/g) || []).slice(0, 3).join(' ');

  /* 门槛：必须至少命中一项「票据特征」，否则拍风景照也会生成一笔糊涂账 */
  var docSignal = /(发票|收据|小票|清单|结算|客票|行程单|票价|价税|税额|合计|商户|销售方|购买方|收银|会员|税号|实收|实付|找零|订单|POS)/.test(flat);
  if (!amount && !dt.exact && !docSignal && !goods) {
    return { ok: false, reason: '这张上面没找到票据信息，换一张更清楚的试试' };
  }

  var note = seller || invGoodsNote(goods) || doc.name;
  note = String(note).slice(0, 20);
  var category = invCategory(dense, note, goods, doc.name);

  var warnings = [];
  if (!amount) warnings.push('没识别到金额，请手动填写后再入账');
  if (!dt.exact) warnings.push('没识别到日期，已按今天记账');
  if (!seller) warnings.push('没识别到商户名，可手动补充备注');

  return {
    ok: true,
    docType: doc.key,
    docName: doc.name,
    type: 'expense',
    amount: amount,
    category: category,
    note: note,
    date: dt.exact ? (dt.y + '-' + pad(dt.m) + '-' + pad(dt.d)) : dstr(new Date()),
    dateGuessed: !dt.exact,
    seller: seller,
    invoiceNo: invNo,
    goods: goods,
    warnings: warnings,
    raw: raw.slice(0, 400)
  };
}

/* ---------------- 19.3 原生能力探测 ---------------- */

/** OCR 插件：iOS 叫 LedgerOCR，Android 叫 OcrReader，两端共用本文件故都探测 */
function ocrPlugin() {
  var C = window.Capacitor;
  if (!C || !C.Plugins) return null;
  return C.Plugins.LedgerOCR || C.Plugins.OcrReader || null;
}

function ocrCamera() {
  var C = window.Capacitor;
  if (!C || !C.Plugins) return null;
  return C.Plugins.Camera || null;
}

/** 把 Capacitor 的 webPath / file:// 路径还原成原生能直接打开的文件路径 */
function ocrNormPath(p) {
  if (!p) return '';
  p = String(p);
  var i = p.indexOf('_capacitor_file_');
  if (i >= 0) {
    p = p.slice(i + '_capacitor_file_'.length);
    try { p = decodeURIComponent(p); } catch (e) {}
    return p;
  }
  if (p.indexOf('file://') === 0) return p.slice(7);
  return p;
}

/* ---------------- 19.4 交互 ---------------- */

var OCR = { step: 'pick', text: '', draft: null, err: '', from: '' };

function openOcr() {
  OCR.step = 'pick'; OCR.text = ''; OCR.draft = null; OCR.err = '';
  window.__ocrDraw = ocrSheet;
  ocrSheet();
}

function ocrSheet() {
  var head = function (title) {
    return '<div class="sh-h"><b>' + title + '</b><span onclick="closeSheet()">✕</span></div>';
  };
  var supported = !!(ocrPlugin() && ocrPlugin().recognize && ocrCamera() && ocrCamera().getPhoto);

  if (OCR.step === 'pick') {
    openSheet(head('拍票入账') + `
      <div class="sh-b">
        <div class="hint g" style="margin-bottom:14px"><span>📷</span><div>
          <b>拍发票 / 小票，自动识别入账</b>
          识别在本机离线完成，照片不会上传到任何服务器，也不联网。
          支持增值税发票、电子发票、火车票、机票行程单、小票与收据。</div></div>
        ${supported ? `
        <div class="btn btn-p" style="font-size:14px" onclick="ocrTake('camera')">拍照识别</div>
        <div class="btn btn-l" style="margin-top:10px;font-size:14px" onclick="ocrTake('photos')">从相册选一张</div>` : `
        <div class="hint b" style="margin-bottom:0"><span>ℹ️</span><div>
          <b>此功能需要在 App 内使用</b>
          拍照识别依赖手机自带的文字识别能力，浏览器里没有这个接口。
          App 里打开「记账 → 拍票入账」即可使用。</div></div>`}
        <div class="note">拍摄要点：票面占满画面、四个角都进框、光线均匀、尽量正对不倾斜。
          拍发票时「价税合计（小写）」那一行不要被裁掉，识别率最高。</div>
      </div>`);
    return;
  }

  if (OCR.step === 'busy') {
    openSheet(`
      <div class="sh-b" style="padding:48px 16px;text-align:center">
        <div style="font-size:30px">🔍</div>
        <div style="font-size:14px;font-weight:600;margin-top:14px">正在识别票面…</div>
        <div class="note" style="text-align:center">本机离线识别，不用联网，稍等一两秒</div>
      </div>`);
    return;
  }

  if (OCR.step === 'fail') {
    openSheet(head('没能识别') + `
      <div class="sh-b">
        <div style="background:#FFF8F0;border-radius:10px;padding:12px 14px;font-size:12.5px;color:#B06A12;line-height:1.7">${esc(OCR.err || '识别失败')}</div>
        ${OCR.text ? `<div style="margin-top:12px;font-size:11.5px;color:var(--sub)">识别到的原文</div>
          <div style="font-size:11px;color:#7B8394;line-height:1.75;margin-top:6px;max-height:150px;overflow:auto;white-space:pre-wrap">${esc(OCR.text)}</div>` : ''}
        <div class="btn btn-p" style="margin-top:14px;font-size:14px" onclick="openOcr()">重拍一张</div>
        <div class="btn btn-l" style="margin-top:10px;font-size:14px" onclick="closeSheet();openImport()">改用粘贴账单导入</div>
      </div>`);
    return;
  }

  /* step === 'result'：确认卡 */
  var d = OCR.draft;
  var cats = catsOf(d.type);
  openSheet(head('确认入账 ' + d.docName) + `
    <div class="sh-b">
      <div class="fld"><label>金额</label>
        <input type="number" inputmode="decimal" value="${d.amount ? d.amount : ''}" placeholder="0.00"
          oninput="ocrField('amount',this.value)"></div>
      <div class="fld"><label>收支</label>
        <span class="mseg" style="margin-left:auto">
          <span class="${d.type === 'expense' ? 'on' : ''}" onclick="ocrType('expense')">支出</span>
          <span class="${d.type === 'income' ? 'on' : ''}" onclick="ocrType('income')">收入</span>
        </span></div>
      <div class="fld"><label>分类</label>
        <select onchange="ocrCat(this.value)" style="margin-left:auto;font-size:12.5px;background:#F6F7FB;border-radius:999px;padding:7px 12px;border:none">
          ${cats.map(function (c) { return `<option value="${c.key}" ${c.key === d.category ? 'selected' : ''}>${c.icon} ${c.name}</option>`; }).join('')}
        </select></div>
      <div class="fld"><label>备注</label>
        <input value="${esc(d.note)}" placeholder="商户或用途" oninput="ocrField('note',this.value)"></div>
      <div class="fld"><label>日期</label>
        <input type="date" value="${d.date}" onchange="ocrField('date',this.value)"></div>

      ${d.warnings.length ? `<div style="margin-top:12px;background:#FFF8F0;border-radius:10px;padding:11px 13px;font-size:11.5px;color:#B06A12;line-height:1.75">
        ${d.warnings.map(esc).join('<br>')}</div>` : ''}

      <div style="margin-top:12px;background:#F8F9FC;border-radius:10px;padding:11px 13px">
        <div style="font-size:11.5px;color:var(--sub)">识别到的原文（可核对）</div>
        <div style="font-size:11px;color:#7B8394;line-height:1.75;margin-top:6px;max-height:110px;overflow:auto;white-space:pre-wrap">${esc(d.raw)}</div>
      </div>
    </div>
    <div class="sh-f">
      <div class="btn btn-l" style="flex:1" onclick="openOcr()">重拍</div>
      <div class="btn btn-p" style="flex:2" onclick="ocrConfirm()">确认入账</div>
    </div>`);
}

/** 拍照 / 选图 → 原生 OCR → 解析 → 进确认卡 */
function ocrTake(from) {
  var cam = ocrCamera(), P = ocrPlugin();
  if (!cam || !cam.getPhoto || !P || !P.recognize) return toast('此功能需要在 App 内使用');

  OCR.from = from;
  OCR.step = 'busy'; OCR.err = ''; OCR.text = ''; OCR.draft = null;
  ocrSheet();

  Promise.resolve(cam.getPhoto({
    quality: 82,
    width: 1800,
    correctOrientation: true,
    source: from === 'camera' ? 'Camera' : 'Photos',
    resultType: 'uri'
  })).then(function (photo) {
    var p = ocrNormPath(photo && (photo.path || photo.webPath));
    if (!p) throw new Error('没能读取照片文件，请重试');
    return P.recognize({ path: p });
  }).then(function (r) {
    var text = (r && r.text) || '';
    OCR.text = text;
    var d = parseInvoiceText(text);
    if (!d || !d.ok) {
      OCR.step = 'fail';
      OCR.err = (d && d.reason) || '没能识别出票据内容';
    } else {
      OCR.draft = d;
      OCR.step = 'result';
    }
    ocrSheet();
  }).catch(function (e) {
    var msg = String((e && (e.message || e.errorMessage)) || e || '');
    if (/cancel|取消/i.test(msg)) {   /* 用户自己取消，别弹错误 */
      OCR.step = 'pick';
      return ocrSheet();
    }
    OCR.step = 'fail';
    OCR.err = msg || '识别失败，请重试';
    ocrSheet();
  });
}

function ocrType(t) {
  var d = OCR.draft;
  if (!d || d.type === t) return;
  d.type = t;
  d.category = catsOf(t)[0].key;
  ocrSheet();
}

function ocrCat(k) {
  if (OCR.draft) { OCR.draft.category = k; ocrSheet(); }
}

/** 表单字段走「只改状态不重渲染」，避免输入一个字符就被刷掉、键盘收起 */
function ocrField(k, v) {
  var d = OCR.draft;
  if (!d) return;
  if (k === 'amount') d.amount = toAmount(v);
  else d[k] = v;
}

function ocrConfirm() {
  var d = OCR.draft;
  if (!d) return;
  var amount = toAmount(d.amount);
  if (!amount || amount <= 0) return toast('请先填写金额');

  var now = new Date();
  var date = d.date || dstr(now);
  var bill = {
    _id: uid(),
    type: d.type,
    amount: amount,
    category: d.category,
    note: (d.note || catOf(d.type, d.category).name).slice(0, 20),
    date: date,
    time: date === dstr(now) ? tstr(now) : '12:00',
    ts: pdate(date).getTime() + (60 + now.getHours() * 60) * 60000,
    source: 'ocr',
    receipt: d.docName
  };
  DB.bills.unshift(bill);
  save();
  OCR.draft = null; OCR.text = '';
  closeSheet();
  render();
  showUndo(bill);
}
