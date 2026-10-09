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
                 > 票面没打合计时（外卖单常见），取各单项金额之和
     单项明细：   外卖单 / 超市小票逐品目拆行（品名 + *数量 + 行尾金额），
                 ≥2 项时在确认卡里逐行列出，可勾选、可改金额，支持按单项记 N 笔
     整行排除：  找零、税额、税率、折扣、优惠、单价、数量、余额、积分、
                 发票代码、发票号码、识别号、校验码、日期、电话等
     分类优先级：发票品目里的 *类别* 星号标记 > 品目/商户名关键词 > 页面通用词典
     日期：      2026年10月08日 / 2026-10-08 / 10月08日 / 下单时间:10-09 17:59；
                 抽不到才退回当天
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
  if (/美团外卖|饿了么|外卖小票|下单时间|出餐|门店新客/.test(flat)) return { key: 'waimai', name: '外卖小票' };
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
    /* 「合计:【*5】」这类括起来的数字是件数不是金额：去掉件数标记后行内再无数字则整行放弃 */
    if (/【\s*[*×xX]?\d+\s*】/.test(L) && !/\d/.test(L.replace(/【\s*[*×xX]?\d+\s*】/g, ''))) continue;

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

/* ---- 19.2b 单项明细（美团 / 饿了么外卖单、超市小票等逐品目金额） ---- */

/* 这些行是票头票脚，不是商品 */
var INV_ITEM_BAD = /(合计|总计|总额|小计|实付|实收|应收|应付|支付|付款|找零|找赎|优惠|红包|满减|折扣|会员价|积分|抵扣|立减|券|发票|税号|税额|订单|编号|单号|流水|电话|手机|尾号|号码|地址|顾客|客户|门店|出餐|送达|下单|取餐|备注|转\d|条形码|条码|二维码|id[:：]|no[.：:#]|pos|收银|机号|打印机|本单|谢谢|惠顾|欢迎|现金|收款|扫码|刷卡|挂账|签单|微信|支付宝)/i;
/* 这些行是费用项，默认也算支出 */
var INV_ITEM_FEE = /(配送费|外送费|跑腿费|打包费|餐盒费|包装费|服务费)/;

/**
 * 逐行拆单项：品名 + 数量 + 行尾金额。
 * 难点是「*1 12.0」去空格后粘成「*112.0」——拆法：数量标记后的数字区，
 * 小数点把金额定位住，整数部分的首位给数量（数量个位数远比两位常见），
 * 其余是金额；「米饭【*2】4.0」这种有 】 隔开的，】后整段是金额。
 * 无数量标记的行要求金额带小数点，避免把「美团外卖 #32」这类票头当商品。
 * 行尾数字默认按「该项小计」理解；单价口径由合计校验决定（见 parseInvoiceText）。
 */
function parseInvoiceItems(lines) {
  var items = [], i;
  for (i = 0; i < lines.length; i++) {
    var rawL = String(lines[i]).trim();
    var L = rawL.replace(/[\s\u00a0]+/g, '');
    if (L.length < 3 || L.length > 60) continue;
    if (INV_ITEM_BAD.test(L)) continue;

    var qty = 1, amount = 0, name = '';
    var mSym = /[*×xX]/.exec(L);

    if (mSym && mSym.index > 0) {
      /* 数量标记之后：[【[] 数字区 []】] 尾随金额 */
      var mD = L.slice(mSym.index + 1).match(/^(?:【|\[)?([\d.]+)(?:】|\])?(.*)$/);
      if (!mD) continue;
      var D = mD[1], tail = (mD[2] || '').replace(/^[¥￥]/, '');
      var dot = D.indexOf('.');
      if (dot >= 0) {
        /* 数量与金额粘在一起：整数部分首位是数量，其余是金额（*112.0 → 1 份 12.0） */
        var I = D.slice(0, dot);
        if (I.length >= 2) { qty = +I.charAt(0) || 1; amount = parseFloat(I.slice(1) + '.' + D.slice(dot + 1)); }
        else { qty = 1; amount = parseFloat(D); }          /* *2.50 → 金额 2.50，无数量 */
      } else if (D.length >= 2) {
        qty = +D.charAt(0) || 1; amount = parseFloat(D.slice(1));   /* *24 → 2 份 4 元 */
      } else {
        qty = +D || 1; amount = parseFloat(tail) || 0;              /* *2 4 → 】或空格隔开的行尾金额 */
      }
      if (!(amount > 0) || amount > 99999) continue;
      name = L.slice(0, mSym.index);
    } else {
      var mTail = L.match(/[¥￥]?(\d{1,4}\.\d{1,2})元?$/);
      if (!mTail) continue;
      amount = parseFloat(mTail[1]);
      if (!(amount > 0) || amount > 99999) continue;
      name = L.slice(0, mTail.index);
    }

    name = name.replace(/[¥￥:：#＃（(【\[、,，.。\-—–_]+\s*$/, '').trim();
    if (!name || !/[\u4e00-\u9fa5A-Za-z]/.test(name)) continue;
    if (name.length > 24) name = name.slice(0, 24);

    items.push({ name: name, qty: qty, amount: amount, fee: INV_ITEM_FEE.test(name) });
  }
  return items;
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
  /* 外卖 / 团购小票：「下单时间:10-09 17:59」（本年同月日） */
  m = s.match(/(?:下单|交易|消费|打印)时间[:：]?(\d{1,2})-(\d{1,2})(?:\d{1,2}:\d{2})?/);
  if (m) {
    var mo3 = +m[1], d3 = +m[2];
    if (mo3 >= 1 && mo3 <= 12 && d3 >= 1 && d3 <= 31) {
      return { y: new Date().getFullYear(), m: mo3, d: d3, exact: true };
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
    if (/(发票|小票|收据|清单|消费|购物|欢迎|谢谢|惠顾|光临|日期|时间|电话|地址|编号|单号|序号|收银|找零|合计|金额|商品|数量|单价|会员|门店|客票|行程单|铁路|航空|出行|身份证|证件|姓名|座位|车厢|席别|NO|POS|[#＃]|美团|饿了么)/i.test(L)) continue;
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

  /* 单项明细：外卖单 / 超市小票的逐品目金额（≥2 项才启用单项模式） */
  var its = parseInvoiceItems(lines);
  var itsSum = 0, itsSumQty = 0, i2;
  for (i2 = 0; i2 < its.length; i2++) {
    itsSum = Math.round((itsSum + its[i2].amount) * 100) / 100;
    itsSumQty = Math.round((itsSumQty + its[i2].amount * its[i2].qty) * 100) / 100;
  }
  if (its.length >= 2 && amt && amt.s < 30 && !/(合计|总计|总额|小计|实付|实收|应付|应收|金额|价税|票价|支付|付款)/.test(amt.line)) {
    amt = null; amount = 0;   /* 命中的只是某个单项行（无任何金额标签），不是票面合计 */
  }
  if (its.length >= 2 && !amount) amount = itsSum;   /* 票面没打合计（如被裁掉），用单项之和兜底 */
  if (its.length >= 2 && amt && Math.abs(amount - itsSum) > 0.02 && Math.abs(amount - itsSumQty) <= 0.02) {
    /* 行尾数字其实是单价：合计 = 单价 × 数量，把每个单项乘回去 */
    for (i2 = 0; i2 < its.length; i2++) {
      its[i2].amount = Math.round(its[i2].amount * its[i2].qty * 100) / 100;
      its[i2].qty = 1;
    }
    itsSum = itsSumQty;
  }

  /* 门槛：必须至少命中一项「票据特征」，否则拍风景照也会生成一笔糊涂账 */
  var docSignal = /(发票|收据|小票|清单|结算|客票|行程单|票价|价税|税额|合计|商户|销售方|购买方|收银|会员|税号|实收|实付|找零|订单|POS|下单|送达|外卖)/.test(flat);
  if (!amount && !dt.exact && !docSignal && !goods) {
    return { ok: false, reason: '这张上面没找到票据信息，换一张更清楚的试试' };
  }

  var note = seller || invGoodsNote(goods) || doc.name;
  note = String(note).slice(0, 20);
  var category = invCategory(dense, note, goods, doc.name);

  /* 每个单项单独归类：品名词典 → 页面通用词典 → 整票分类兜底 */
  for (i2 = 0; i2 < its.length; i2++) {
    var hit = invCatHit(its[i2].name), inf2 = null;
    if (!hit) { try { inf2 = infer(its[i2].name, 'expense'); } catch (e) {} }
    its[i2].category = hit || (inf2 && inf2.type === 'expense' ? inf2.key : '') || category;
  }

  var warnings = [];
  if (!amount) warnings.push('没识别到金额，请手动填写后再入账');
  if (!dt.exact) warnings.push('没识别到日期，已按今天记账');
  if (!seller) warnings.push('没识别到商户名，可手动补充备注');
  if (its.length >= 2 && amt && Math.abs(amount - itsSum) > 0.02 && Math.abs(amount - itsSumQty) > 0.02) {
    warnings.push('单项相加（¥' + itsSum + '）与票面合计（¥' + amount + '）不一致，请核对');
  }
  if (its.length >= 2 && !amt) warnings.push('票面没有合计，金额按 ' + its.length + ' 个单项相加');

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
    items: its,
    itemsSum: itsSum,
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

var OCR = { step: 'pick', text: '', draft: null, err: '', from: '', pick: {} };

function openOcr() {
  OCR.step = 'pick'; OCR.text = ''; OCR.draft = null; OCR.err = ''; OCR.pick = {};
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

      ${ocrItemsHtml(d)}

      ${d.warnings.length ? `<div style="margin-top:12px;background:#FFF8F0;border-radius:10px;padding:11px 13px;font-size:11.5px;color:#B06A12;line-height:1.75">
        ${d.warnings.map(esc).join('<br>')}</div>` : ''}

      <div style="margin-top:12px;background:#F8F9FC;border-radius:10px;padding:11px 13px">
        <div style="font-size:11.5px;color:var(--sub)">识别到的原文（可核对）</div>
        <div style="font-size:11px;color:#7B8394;line-height:1.75;margin-top:6px;max-height:110px;overflow:auto;white-space:pre-wrap">${esc(d.raw)}</div>
      </div>
    </div>
    <div class="sh-f">
      <div class="btn btn-l" style="flex:1" onclick="openOcr()">重拍</div>
      ${ocrFooterBtns(d)}
    </div>`);
}

/** 确认卡里的单项明细区（≥2 项才出现），勾选 + 金额可改 */
function ocrItemsHtml(d) {
  if (!d.items || d.items.length < 2) return '';
  var sum = 0, rows = '', i;
  for (i = 0; i < d.items.length; i++) {
    if (OCR.pick[i] !== false) sum = Math.round((sum + toAmount(d.items[i].amount)) * 100) / 100;
  }
  for (i = 0; i < d.items.length; i++) {
    var it = d.items[i];
    var on = OCR.pick[i] !== false;
    var catName = '';
    try { catName = catOf(d.type, it.category).name; } catch (e) {}
    rows += `<div style="display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px dashed #E4E7EE">
      <span onclick="ocrPick(${i})" style="font-size:17px;line-height:1;color:${on ? '#3D7BFF' : '#C3C9D4'}">${on ? '☑' : '☐'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.name)}${it.qty > 1 ? '<span style="color:var(--sub);font-size:10.5px"> ×' + it.qty + '</span>' : ''}</div>
        <div style="font-size:10px;color:#98A0AE;margin-top:1px">${esc(catName || '')}</div>
      </div>
      <input type="number" inputmode="decimal" value="${it.amount}" oninput="ocrItemAmount(${i},this.value)"
        style="width:72px;text-align:right;font-size:12.5px;background:#fff;border:1px solid #E4E7EE;border-radius:8px;padding:5px 8px;color:var(--ink)">
    </div>`;
  }
  return `<div style="margin-top:12px;background:#F8F9FC;border-radius:10px;padding:11px 13px">
    <div style="display:flex;align-items:center;margin-bottom:4px">
      <div style="font-size:11.5px;color:var(--sub)">识别到 ${d.items.length} 个单项
        <b style="color:var(--ink)">选中合计 ¥${sum}</b></div>
      <span onclick="ocrPickAll()" style="margin-left:auto;font-size:11px;color:#3D7BFF">全选 / 清空</span>
    </div>${rows}</div>`;
}

/** 底部按钮：有明细时给「按单项入账」，否则普通确认 */
function ocrFooterBtns(d) {
  if (!d.items || d.items.length < 2) {
    return '<div class="btn btn-p" style="flex:2" onclick="ocrConfirm()">确认入账</div>';
  }
  var n = 0, i;
  for (i = 0; i < d.items.length; i++) if (OCR.pick[i] !== false) n++;
  return `<div class="btn btn-l" style="flex:1;font-size:12.5px" onclick="ocrConfirm()">按合计</div>
    <div class="btn btn-p" style="flex:2" onclick="ocrConfirmItems()">按单项入账（${n} 笔）</div>`;
}

/** 拍照 / 选图 → 原生 OCR → 解析 → 进确认卡 */
function ocrTake(from) {
  var cam = ocrCamera(), P = ocrPlugin();
  if (!cam || !cam.getPhoto || !P || !P.recognize) return toast('此功能需要在 App 内使用');

  OCR.from = from;
  OCR.step = 'busy'; OCR.err = ''; OCR.text = ''; OCR.draft = null; OCR.pick = {};
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

/** 明细勾选（undefined 视为选中，省得初始化） */
function ocrPick(i) {
  OCR.pick[i] = OCR.pick[i] === false;
  ocrSheet();
}

function ocrPickAll() {
  var d = OCR.draft;
  if (!d || !d.items) return;
  var allOn = true, i;
  for (i = 0; i < d.items.length; i++) if (OCR.pick[i] === false) { allOn = false; break; }
  for (i = 0; i < d.items.length; i++) OCR.pick[i] = allOn ? false : undefined;
  ocrSheet();
}

/** 单项金额只改状态不重渲染，输入不闪 */
function ocrItemAmount(i, v) {
  var d = OCR.draft;
  if (d && d.items && d.items[i]) d.items[i].amount = toAmount(v);
}

/** 按勾选的单项逐笔记账（一笔一个品名） */
function ocrConfirmItems() {
  var d = OCR.draft;
  if (!d) return;
  if (!d.items || d.items.length < 2) return ocrConfirm();

  var now = new Date();
  var date = d.date || dstr(now);
  var time = date === dstr(now) ? tstr(now) : '12:00';
  var ts = pdate(date).getTime() + (60 + now.getHours() * 60) * 60000;

  var bills = [], i;
  for (i = 0; i < d.items.length; i++) {
    if (OCR.pick[i] === false) continue;
    var a = toAmount(d.items[i].amount);
    if (!a || a <= 0) continue;
    bills.push({
      _id: uid(),
      type: d.type,
      amount: a,
      category: d.items[i].category || d.category,
      note: String(d.items[i].name).slice(0, 20),
      date: date,
      time: time,
      ts: ts,
      source: 'ocr',
      receipt: d.docName
    });
  }
  if (!bills.length) return toast('请先勾选要入账的单项');

  for (i = bills.length - 1; i >= 0; i--) DB.bills.unshift(bills[i]);
  save();
  OCR.draft = null; OCR.text = ''; OCR.pick = {};
  closeSheet();
  render();
  toast('已按单项入账 ' + bills.length + ' 笔');
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
