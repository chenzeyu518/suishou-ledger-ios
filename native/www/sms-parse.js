/* ---------------------- 18. 银行 / 支付短信文本解析（iOS 版） ----------------------
   由 scripts/sync-from-preview.js 注入到正式版 www/index.html。

   iOS 的沙箱不允许任何 App 读取短信收件箱，因此本模块不做任何系统读取、
   不申请任何权限，只负责一件事：把你从「信息」里复制粘贴进来的银行消费短信
   解析成账单草稿，交给「批量导入账单」的去重与入账流程。

   与 Android 版的原生短信自动入账共用同一套解析口径（那一版多了系统读取能力），
   两边改动需同步：
     - 先剔除「余额 / 可用额度 / 剩余」后面的数字，否则会把余额当成消费额；
     - 商户从「在星巴克消费」这类句式里抽，抽不到退而取「摘要 / 备注 / 用途」；
     - 验证码、纯余额提醒、营销短信、登录通知一律丢弃（宁漏不错）；
     - 粘贴文本没有短信时间戳，日期时间从正文里抽，抽不到才退回当天。
   ------------------------------------------------------------------------------ */

var SMS_NOISE = /(验证码|校验码|动态密码|动态码|密码|登录|注册|注销|解绑|挂失|积分|优惠券|优惠|活动|促销|问卷|邀请|即将|到期|逾期|账单已出|最低还款|额度提升|领取|点击|退订|拒收|回复TD)/;
var SMS_EXP = /(消费|支出|扣款|扣费|代扣|取现|转出|付款|支付)/;
var SMS_INC = /(工资|薪资|代发|收入|存入|转入|入账|到账|汇入|退款|退回|利息|分红|返现|收款)/;
var SMS_SURE_INC = /(退款|退回|工资|薪|入账|到账|收入|存入|转入|代发|利息|分红|返现)/;

/* 商户名清洗：去掉括号后缀与公司后缀（「瑞幸咖啡(北京)有限公司」→「瑞幸咖啡」） */
function smsTidy(s){
  return String(s == null ? '' : s)
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/(股份有限公司|有限责任公司|有限公司|科技有限公司|信息技术|网络科技|公司|集团|分公司|总部)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 粘贴文本没有短信自带的时间戳，从正文里抽日期时间；exact 表示日期是否来自正文 */
function smsTextDate(body){
  var s = String(body || '').replace(/\s+/g, '');
  var now = new Date();
  var t = s.match(/(\d{1,2}):(\d{2})/);
  var hh = t ? pad(+t[1]) : '12', mi = t ? t[2] : '00';
  var m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], hh: hh, mi: mi, exact: true };
  m = s.match(/(\d{1,2})[月/-](\d{1,2})日/);
  if (m) return { y: now.getFullYear(), m: +m[1], d: +m[2], hh: hh, mi: mi, exact: true };
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), hh: hh, mi: mi, exact: false };
}

/* 单条银行 / 支付短信 → 账单草稿；识别不了返回 null */
function parseBankSms(m){
  var body = String((m && m.body) || '');
  if (!body) return null;
  if (SMS_NOISE.test(body)) return null;

  var compact = body.replace(/\s+/g, '');
  var isExp = SMS_EXP.test(compact), isInc = SMS_INC.test(compact);
  if (!isExp && !isInc) return null;

  /* 先剔除「余额 / 可用额度 / 剩余」后的数字，否则会把余额当成消费金额 */
  var cleaned = compact.replace(
    /(余额|剩余|可用额度|额度|欠款|应还|积分|里程)[^\d]{0,4}\d+(?:,\d{3})*(?:\.\d{1,2})?/g,
    ' '
  );

  var re = /(?:人民币|RMB|¥|￥)?(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*元/g;
  var ams = [], k;
  while ((k = re.exec(cleaned)) !== null) {
    ams.push({ v: parseFloat(k[1].replace(/,/g, '')), i: k.index });
  }
  if (!ams.length) {
    /* 少数短信不写「元」，就近抓收支动词后的数字 */
    var m2 = cleaned.match(/(?:消费|支出|扣款|扣费|支付|取现|转出|收入|入账|到账|转入)(?:人民币|RMB|¥|￥)?(\d+(?:,\d{3})*\.\d{1,2})/);
    if (!m2) return null;
    ams.push({ v: parseFloat(m2[1].replace(/,/g, '')), i: 0 });
  }

  var type = (!isExp && isInc) ? 'income'
    : (isExp && !isInc) ? 'expense'
    : (SMS_SURE_INC.test(cleaned) ? 'income' : 'expense');

  /* 金额取「收支动词之后」最近的一个，取不到退回首尾 */
  var kwAt = type === 'expense' ? cleaned.search(SMS_EXP) : cleaned.search(SMS_INC);
  var pick = ams[0];
  if (kwAt > -1) {
    var after = ams.filter(function (a) { return a.i > kwAt; });
    pick = after.length ? after[0] : ams[ams.length - 1];
  }
  var amount = Math.round(pick.v * 100) / 100;
  if (!amount || amount <= 0 || amount > 500000) return null;

  /* 商户名 */
  var merchant = '';
  var pats = [
    /在([\u4e00-\u9fa5A-Za-z0-9·&()（）\-]{2,18}?)(?:消费|支出|扣款|扣费|支付|付款|取现|转出)/,
    /(?:商户名称|特约商户|商户|收款方|交易对方)[:：]?([\u4e00-\u9fa5A-Za-z0-9·&()（）\-]{2,18})/,
    /(?:向|于)([\u4e00-\u9fa5A-Za-z0-9·&()（）\-]{2,18}?)(?:消费|支付|付款|转账)/
  ];
  for (var pi = 0; pi < pats.length && !merchant; pi++) {
    var mr = cleaned.match(pats[pi]);
    if (mr && mr[1]) merchant = mr[1];
  }

  var bank = (body.match(/([\u4e00-\u9fa5]{2,6}银行)/) || [])[1] || '';
  var tail = (body.match(/尾号\s*(\d{3,4})/) || [])[1] || '';

  /* 银行短信常把用途写在「摘要 / 备注 / 用途」里，作为商户的兜底 */
  var brief = (compact.match(/(?:摘要|备注|用途|附言)[:：]?([\u4e00-\u9fa5A-Za-z0-9·]{2,12})/) || [])[1] || '';
  if (!merchant && brief) merchant = brief;
  if (merchant) merchant = smsTidy(merchant);

  var note = merchant ? (extractNote(merchant) || merchant) : (extractNote(cleaned) || '');
  if (!note) note = (bank ? bank.replace(/银行$/, '') + ' ' : '') + fbNote(type);

  var inf = infer(note, type) || infer(cleaned, type);
  var dt = smsTextDate(body);
  var d = (m && m.date) ? new Date(Number(m.date)) : new Date(dt.y, dt.m - 1, dt.d);
  var time = (m && m.date) ? tstr(d) : (dt.hh + ':' + dt.mi);

  return {
    smsId: String((m && m.id) || (Number(m && m.date) || '') + '|' + body.slice(0, 24)),
    type: type, amount: amount, note: note.slice(0, 20), bank: bank, tail: tail,
    date: dstr(d), time: time, dateGuessed: (m && m.date) ? false : !dt.exact,
    category: (inf && inf.type === type) ? inf.key : 'qita',
    raw: body.slice(0, 90),
    checked: true
  };
}

/* 判断一段文本像不像银行 / 支付短信：避免把普通账单行交给短信解析器 */
function looksLikeSms(s){
  return /(【|】|尾号|银行|信用卡|储蓄卡|借记卡|人民币)/.test(String(s || ''));
}
