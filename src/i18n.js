/**
 * 中文汉化层（localization）。
 *
 * 两件事：
 *   1. 中文主题词 → TradingView 英文主题 slug。TradingView 的搜索只认
 *      /scripts/<slug>/ 这种英文连字符路由，中文直接查会得到空 slug 而报错，
 *      所以中文查询必须先映射成英文主题。
 *   2. 集中放置中英文提示语，方便后续升级上游代码时对照维护。
 *
 * 维护提示：新增中文词只需在 TOPIC_ZH 里加一条，键为中文（可带空格），
 * 值为 TradingView 站点上真实存在的主题（即 /scripts/<值转连字符>/ 可访问）。
 */

/** 中文主题词 → TradingView 主题（英文，词间用空格，转 slug 时自动变连字符）。 */
export const TOPIC_ZH = {
  // 交易风格 / 策略类型
  趋势跟踪: 'trend following',
  趋势交易: 'trend following',
  趋势: 'trend following',
  剥头皮: 'scalping',
  短线交易: 'scalping',
  日内交易: 'day trading',
  波段交易: 'swing trading',
  均值回归: 'mean reversion',
  网格交易: 'grid trading',
  网格: 'grid trading',
  马丁格尔: 'martingale',
  套利: 'arbitrage',
  高频交易: 'high frequency trading',
  动量: 'momentum',
  动量交易: 'momentum trading',
  反转: 'reversal',
  反转交易: 'reversal',
  突破: 'breakout',
  突破策略: 'breakout',
  波动率: 'volatility',
  波动率突破: 'volatility breakout',
  多周期: 'multi timeframe',
  多时间框架: 'multi timeframe',

  // 指标 / 技术分析
  均线: 'moving average',
  移动平均线: 'moving average',
  指数均线: 'ema',
  布林带: 'bollinger bands',
  布林: 'bollinger bands',
  相对强弱: 'rsi',
  相对强弱指标: 'rsi',
  随机指标: 'stochastic oscillator',
  随机振荡: 'stochastic oscillator',
  一目均衡表: 'ichimoku cloud',
  云图: 'ichimoku cloud',
  斐波那契: 'fibonacci',
  斐波那契回撤: 'fibonacci retracement',
  艾略特波浪: 'elliott wave',
  谐波形态: 'harmonic patterns',
  背离: 'divergence',
  支撑阻力: 'support resistance',
  支撑与阻力: 'support resistance',
  供需: 'supply demand',
  供需区: 'supply demand',
  成交量: 'volume',
  成交量分布: 'volume profile',
  量价分析: 'volume',
  订单块: 'order blocks',
  订单流: 'order flow',
  流动性: 'liquidity',
  聪明钱: 'smart money',
  价格行为: 'price action',
  裸K: 'price action',
  蜡烛图形态: 'candlestick patterns',
  形态识别: 'chart patterns',
  图表形态: 'chart patterns',
  枢轴点: 'pivot points',
  虚拟机轴: 'pivot points',
  抛物转向: 'parabolic sar',
  超级趋势: 'supertrend',
  超级趋势指标: 'supertrend',
  平均真实波幅: 'atr',
  平均趋向指标: 'adx',
  资金流量: 'money flow',
  能量潮: 'obv',

  // 风险管理 / 组合
  止损: 'stop loss',
  止损策略: 'stop loss',
  止盈止损: 'risk management',
  风险管理: 'risk management',
  资金管理: 'position sizing',
  仓位管理: 'position sizing',
  追踪止损: 'trailing stop',
  移动止损: 'trailing stop',

  // 市场 / 标的
  加密货币: 'crypto',
  比特币: 'bitcoin',
  以太坊: 'ethereum',
  外汇: 'forex',
  股票: 'stocks',
  期货: 'futures',
  期权: 'options',
  指数: 'indices',
  黄金: 'gold',
};

/** 主题词说明（给 Agent 和用户看的提示，含可直接使用的中文词样例）。 */
export const TOPIC_HINT_ZH = '支持中文主题词，例如：趋势跟踪、剥头皮、订单块、均值回归、成交量分布、超级趋势、聪明钱、支撑阻力';

/** 判定字符串是否含中日韩汉字。 */
function hasChinese(str) {
  return /[\u4e00-\u9fff]/.test(str);
}

/** 归一化：去空白、小写，便于宽松匹配。 */
function normalize(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * 把用户传入的查询词翻译成 TradingView 主题。
 *
 * 返回值：
 *   { query, translated, matched }  translated=true 表示发生了中文→英文翻译
 * 若中文查询无法匹配任何已知主题，抛错并给出可用词样例（英文查询原样放行，
 * 以保证向后兼容和自由使用 /scripts/<任意slug>/ 的能力）。
 */
export function translateTopic(rawQuery) {
  const query = rawQuery == null ? rawQuery : String(rawQuery).trim();
  if (!query) return { query, translated: false, matched: null };

  const normalized = normalize(query);

  // 1) 精确匹配（含空格差异）
  for (const [zh, en] of Object.entries(TOPIC_ZH)) {
    if (normalize(zh) === normalized) {
      return { query: en, translated: en !== query, matched: zh };
    }
  }

  // 2) 中文查询做包含匹配，取最长命中键，避免 "趋势" 抢先命中 "趋势跟踪"
  if (hasChinese(query)) {
    let bestKey = null;
    for (const zh of Object.keys(TOPIC_ZH)) {
      const key = normalize(zh);
      if (normalized.includes(key) && (!bestKey || key.length > normalize(bestKey).length)) {
        bestKey = zh;
      }
    }
    if (bestKey) {
      return { query: TOPIC_ZH[bestKey], translated: true, matched: bestKey };
    }
    throw new Error(
      `无法把中文主题“${query}”映射到 TradingView 主题。${TOPIC_HINT_ZH}；` +
        `也可以直接使用英文主题（如 "trend following"）。` +
        ` (Unrecognised Chinese topic: no mapping for "${query}".)`
    );
  }

  // 3) 英文查询原样放行
  return { query, translated: false, matched: null };
}

/** 常用中文界面提示语，集中管理，避免散落在各处。 */
export const MSG = {
  error: '错误',
  cappedNote: 'TradingView 对宽泛搜索结果的数量上限是 1000 条，收窄主题词才能拿到更全的结果。',
  alreadyComplete: '该抓取任务已完成。',
  unknownHarvest: (id) => `未知的 harvest_id：${id}`,
  authorRequired: 'source="author" 时必须提供 username。',
  needIdOrUrl: '请提供 script_id_part 或 chart_url 其中之一。',
  harvestDone: '已完成。可以用 query_corpus 离线检索本次收集到的全部脚本。',
  harvestPaused: (id) =>
    `本次调用因时间预算用尽而暂停，这不是错误。再次调用 harvest_scripts 并传入 harvest_id="${id}" 即可从中断处继续。`,
  includeSourceCap: '因为 Pine 源码体积较大，include_source=true 时最多返回 3 条。',
  includeSourceHint: '设置 include_source=true（并配合较小的 limit）可获取完整 Pine 代码。',
};
