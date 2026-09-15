// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS, normalizeBehaviorProfile } from './personas.js';
import { sliderToTier } from './tier-slider.js';   // 零依赖模块，避免循环依赖
import { DEFAULT_TIME_CONTROL, normalizeTimeControl } from './time-control.js';
import { normalizeMomentWindows } from './moment-schedule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    timeoutMs: 60000,
    runTimeoutMs: 180000,
    maxRunTokens: 160000,                   // 同一 Agent 运行内所有模型调用的累计 Token 上限
    contextWindowTokens: 1000000,           // 当前模型上下文窗口，供批处理裁剪与预算预判
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token）—— 兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 远程价格表 URL（可选）：指向与 prices.json 相同结构的自托管 JSON。
    // 启动时拉取一次，之后每 24 小时自动刷新（失败过 3 小时重试）；
    // 拉取全程异步、失败不清表 —— 对正常使用零影响。
    // 远程条目按模型 id 覆盖内置表，内置表其余条目仍是兜底。
    priceRemoteUrl: '',
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 优先级最高 —— 一旦这里有记录，就不再用内置官方表，也不受全局默认单价影响。
    // 改动只存在这里，不会回写内置价格表（src/model-prices.js）。
    modelPrices: {}
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  providerKeys: {},      // providerId -> 真实 API Key（providers[] 里不存明文 Key）
  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // 可选：'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso'
    provider: 'bing',
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',     // Responses API 模型名：deepseek-v4-flash / deepseek-v4-pro
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    }
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false           // true 时图片下载允许内网地址（仅本地测试/自建图床）
  },
  // 外部 OneBot v11 服务
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: ''        // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    behaviorProfile: 'legacy',             // legacy | grounded，选择模板时一起切换
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: ''                         // 追加自定义规则（可选）
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 运行节奏
  wakeDelayMs: 10000,
  wakeDelayMinMs: 8000,
  wakeDelayMaxMs: 12000,
  drainDelayMs: 10000,
  maxBatchWaitMs: 20000,
  runtime: { mode: 'observe', paused: false },
  timeControl: DEFAULT_TIME_CONTROL,
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 对话线程试点：默认关闭，可从控制台动态切换，不影响旧触发模式。
  conversation: {
    mode: 'legacy',                  // legacy | threaded | lifecycle
    unifiedMode: true,               // false 时允许 groupModes 按群覆盖
    groupModes: {},                  // { [groupId]: legacy | threaded | lifecycle }
    continuationWindowMs: 180000,    // 机器人发言后，同一参与者确定性续接窗口
    threadTtlMs: 1800000,            // 线程空闲多久后关闭
    continuationContextCount: 100,   // threaded 续接唤醒时携带的历史消息条数
    silentIdleMs: 300000,            // lifecycle：沉默状态 5 分钟无消息即结束
    activeIdleMs: 1200000,           // lifecycle：活跃状态 20 分钟无消息即结束
    hardLifetimeMs: 1800000,         // lifecycle：绝对生命周期上限 30 分钟
    rolloverArmedMs: 600000,         // 活跃线程撞硬上限后，一次性任意消息触发期限
    lifecycleContextCount: 100,      // 生命周期首次运行携带的历史条数
    lifecycleRolloverInputTokens: 32000, // 上次实际输入达到此值时，下一批先换代
    maxTranscriptChars: 240000       // 生命周期追加式模型上下文硬预算
  },
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    hardSplitAt: 4000       // QQ 硬限制切分（0 = 不限制）
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25
  },
  // 每日群聊记忆总结与 QQ 空间动态
  dailyMoments: {
    enabled: false,
    hour: 23,                    // 上海时间
    minute: 30,
    scheduleWindows: null,       // null 保留固定时刻；数组为 {start, end, count}
    startupCatchup: true,        // 错过定时点后，服务恢复时补一次
    minMessagesPerGroup: 3,
    maxGroups: 12,
    maxMessagesPerGroup: 80,
    maxPromptChars: 120000,
    allowImages: true,
    maxImages: 1,
    visibility: 4,              // 1=所有人 4=好友 64=仅自己
    targetUins: [],
    maxResearchCalls: 4,
    maxRounds: 8
  },
  // 好友动态阅览、点赞评论与评论回复。默认关闭，启用后按上海时间周期轮询。
  qzoneInteractions: {
    enabled: false,
    startupCatchup: false,
    feedIntervalMinutes: 60,
    replyIntervalMinutes: 5,
    feedFetchCount: 30,
    ownPostCount: 10,
    maxAgeHours: 72,
    maxBatchItems: 20,
    maxLikesPerRun: 3,
    maxCommentsPerRun: 2,
    maxRepliesPerRun: 5,
    commentMaxChars: 60,
    replyMaxChars: 60,
    allowLikes: true,
    allowComments: true,
    allowReplies: true,
    actionDelayMinMs: 700,
    actionDelayMaxMs: 1800,
    maxDecisionRounds: 3
  },
  // 跨会话人物画像与好友关系试点。第一阶段只提供总开关；
  // 关闭时不得注册工具、注入提示词、启动任务或创建实验数据文件。
  // graduated 只控制独立产品入口，不改变 enabled 的运行语义。
  identityPilot: {
    enabled: false,
    graduated: false,
    incomingFriendRequest: {
      enabled: false,
      autoWhitelist: true,
      maxPending: 50
    },
    friendProposal: {
      enabled: false,
      graduated: false,
      activeDispatchEnabled: false,
      ownerUin: '',
      mode: 'triggered',
      minMessageCount: 50,
      cooldownDays: 30,
      maxPending: 10,
      triggered: {
        probability: 0.05,
        historyDays: 30,
        minMessages: 50,
        minActiveDays: 3,
        minDirectExchanges: 3,
        maxTriggerAgeMinutes: 10,
        friendStatusMaxAgeMinutes: 15,
        drawCooldownMinutes: 30,
        maxDrawsPerUserPerDay: 6,
        maxReviewsPerDay: 10,
        skipCooldownDays: 7,
        errorCooldownMinutes: 60,
        maxQueueAgeSeconds: 120,
        scoreThreshold: 70,
        weights: {
          quality: 40,
          interest: 30,
          reciprocity: 20,
          stability: 10
        }
      }
    }
  },
  // 黑话语料库试点。关闭时不建库、不扫描消息、不注册任务或改变模型请求。
  slangPilot: {
    enabled: false,
    graduated: false,
    ownerUin: '',
    minOccurrences: 3,
    minSpeakers: 2,
    windowHours: 72,
    maxPending: 100,
    perChatDailyLimit: 5,
    rejectCooldownDays: 14,
    maxEvidence: 12,
    webResearch: true,
    maxSearchResults: 5,
    maxFetchPages: 2,
    maxResearchRounds: 2
  },
  // 异常处理试点。关闭时不建库、不改变会话阻塞策略、不发送管理员告警。
  incidentPilot: {
    enabled: false,
    graduated: false,
    ownerUin: '',
    notifyWarnings: true,
    duplicateWindowMinutes: 10,
    unknownWritesBlockChat: false,
    retentionDays: 90
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    maxCollectPerHour: 10,
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // ── 上下文读取档位（决定本次唤醒读多少条历史）──
    // 档位是"累积生效"的：选 4 档时 1/2/3 档也都生效，按 4→3→2→1 顺序检查，
    // 第一个命中的决定读取条数。这个设置替代了原来的 pastStateLimit 固定值。
    contextTier: 4,             // 1=仅艾特 2=+关键词 3=+随机 4=全读
    atCount: 300,
    keywordCount: 100,
    keywords: [],               // 档2 的关键词表
    randomPercent: 10,          // 档3：y% 概率
    randomCount: 60,
    allCount: 300,
    batchLimit: 100,
    batchMaxChars: 32000,
    pastStateMaxChars: 24000,
    // ── 响应档位的作用范围 ──
    unifiedTier: true,          // true = 上方滑条对所有会话生效；false = 可按群单独设置
    groupSliderPos: {},         // { [群号]: 0~100 } 仅 unifiedTier=false 时生效；未设置的群/私聊跟随全局滑条
    keepSessionFiles: 2000
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }
  // 被屏蔽群员的消息在入口处直接丢弃——不存档、不触发会话、不作为提示词背景。
  // 机器人自己的消息不受影响。仅群聊有意义（私聊要屏蔽请直接用白名单/黑名单）。
  blocklist: {},
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    handoffEnabled: true,
    handoffTtlMinutes: 1440,
    handoffMaxChars: 4000,
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: ''                             // 专用模型 id（useChatModel=false 时生效）
  },
  // Linux Web 控制台
  server: {
    port: 3210,
    host: '127.0.0.1',
    strictPort: true,
    token: ''                 // 留空 = 只监听 127.0.0.1
  },
  ui: {
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效，这里只是跨设备/重装后保留用。
    theme: 'dark',
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000          // 界面轮询间隔
  }
};

function migrateConfig(parsed) {
  const out = structuredClone(parsed);
  if (
    out.identityPilot?.friendProposal
    && out.identityPilot.friendProposal.mode == null
  ) {
    // The experiment has moved to controller-owned message triggers. Existing
    // pilot configs without a mode follow the new path; "prompt" remains an
    // explicit rollback mode in the friend management page.
    out.identityPilot.friendProposal.mode = 'triggered';
  }
  if (out.wakeDelayMinMs == null && out.wakeDelayMaxMs == null && out.wakeDelayMs != null) {
    const legacy = Math.max(0, Number(out.wakeDelayMs) || 0);
    if (legacy === 10000) {
      out.wakeDelayMinMs = 8000;
      out.wakeDelayMaxMs = 12000;
    } else {
      out.wakeDelayMinMs = legacy;
      out.wakeDelayMaxMs = legacy;
    }
  }
  if (!out.onebot && out.snowluma) {
    out.onebot = {
      wsUrl: out.snowluma.wsUrl,
      httpUrl: out.snowluma.httpUrl,
      accessToken: out.snowluma.accessToken,
      httpAccessToken: out.snowluma.httpAccessToken
    };
  }
  if (!out.providerKeys && out.dshProviderKeys) out.providerKeys = out.dshProviderKeys;
  delete out.snowluma;
  delete out.dshProviderKeys;
  delete out.providersSourceYaml;
  delete out.providersImported;
  delete out.telemetry;
  if (out.server) {
    delete out.server.autoStart;
    delete out.server.closeToTray;
  }
  if (out.ui?.theme === '?') out.ui.theme = 'dark';
  return out;
}

function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = migrateConfig(JSON.parse(text));
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

let currentConfig = null;
let saveTimers = new Map();
const timeControlListeners = new Set();

export function onTimeControlChange(listener) {
  timeControlListeners.add(listener);
  return () => timeControlListeners.delete(listener);
}

function notifyTimeControlChange() {
  for (const listener of timeControlListeners) listener();
}

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/** 所有实验画像能力的唯一总闸门。 */
export function identityPilotEnabled(cfg = getConfig()) {
  return cfg?.identityPilot?.enabled === true;
}

export function friendProposalEnabled(cfg = getConfig()) {
  return identityPilotEnabled(cfg) && cfg?.identityPilot?.friendProposal?.enabled === true;
}

export function triggeredFriendProposalEnabled(cfg = getConfig()) {
  return friendProposalEnabled(cfg)
    && cfg?.identityPilot?.friendProposal?.mode === 'triggered';
}

export function promptFriendProposalEnabled(cfg = getConfig()) {
  return friendProposalEnabled(cfg)
    && cfg?.identityPilot?.friendProposal?.mode !== 'triggered';
}

export function incomingFriendRequestEnabled(cfg = getConfig()) {
  return identityPilotEnabled(cfg)
    && cfg?.identityPilot?.incomingFriendRequest?.enabled === true;
}

export function friendRequestDispatchEnabled(cfg = getConfig()) {
  return friendProposalEnabled(cfg)
    && cfg?.identityPilot?.friendProposal?.activeDispatchEnabled === true;
}

export function slangPilotEnabled(cfg = getConfig()) {
  return cfg?.slangPilot?.enabled === true;
}

export function incidentPilotEnabled(cfg = getConfig()) {
  return cfg?.incidentPilot?.enabled === true;
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  const next = migrateConfig(deepMerge(getConfig(), patch));
  const oldTimeControl = JSON.stringify(getConfig().timeControl);
  next.persona.behaviorProfile = normalizeBehaviorProfile(next.persona.behaviorProfile);
  next.timeControl = normalizeTimeControl(next.timeControl);
  next.dailyMoments.scheduleWindows = normalizeMomentWindows(next.dailyMoments.scheduleWindows);
  if (!['observe', 'active'].includes(next.runtime?.mode)) throw new Error('Invalid runtime mode');
  if (!['legacy', 'threaded', 'lifecycle'].includes(next.conversation?.mode)) {
    throw new Error('Invalid conversation mode');
  }
  for (const mode of Object.values(next.conversation?.groupModes || {})) {
    if (!['legacy', 'threaded', 'lifecycle'].includes(mode)) {
      throw new Error('Invalid group conversation mode');
    }
  }
  next.api.maxRunTokens = Math.min(
    1000000,
    Math.max(20000, Math.round(Number(next.api.maxRunTokens) || DEFAULT_CONFIG.api.maxRunTokens))
  );
  next.api.contextWindowTokens = Math.min(
    2000000,
    Math.max(
      16000,
      Math.round(Number(next.api.contextWindowTokens) || DEFAULT_CONFIG.api.contextWindowTokens)
    )
  );
  let wakeMin = Math.min(
    20000,
    Math.max(0, Math.round(Number(next.wakeDelayMinMs) || 0))
  );
  let wakeMax = Math.min(
    20000,
    Math.max(0, Math.round(Number(next.wakeDelayMaxMs) || 0))
  );
  if (wakeMin > wakeMax) [wakeMin, wakeMax] = [wakeMax, wakeMin];
  next.wakeDelayMinMs = wakeMin;
  next.wakeDelayMaxMs = wakeMax;
  next.wakeDelayMs = Math.round((wakeMin + wakeMax) / 2);
  next.conversation.lifecycleRolloverInputTokens = Math.min(
    500000,
    Math.max(
      5000,
      Math.round(
        Number(next.conversation.lifecycleRolloverInputTokens)
        || DEFAULT_CONFIG.conversation.lifecycleRolloverInputTokens
      )
    )
  );
  const interactions = next.qzoneInteractions || {};
  next.qzoneInteractions = {
    ...interactions,
    enabled: interactions.enabled === true,
    startupCatchup: interactions.startupCatchup === true,
    feedIntervalMinutes: Math.min(1440, Math.max(5, Number(interactions.feedIntervalMinutes) || 60)),
    replyIntervalMinutes: Math.min(1440, Math.max(1, Number(interactions.replyIntervalMinutes) || 5)),
    feedFetchCount: Math.min(50, Math.max(1, Number(interactions.feedFetchCount) || 30)),
    ownPostCount: Math.min(30, Math.max(1, Number(interactions.ownPostCount) || 10)),
    maxAgeHours: Math.min(720, Math.max(1, Number(interactions.maxAgeHours) || 72)),
    maxBatchItems: Math.min(50, Math.max(1, Number(interactions.maxBatchItems) || 20)),
    maxLikesPerRun: Math.min(20, Math.max(0, Number(interactions.maxLikesPerRun) || 0)),
    maxCommentsPerRun: Math.min(10, Math.max(0, Number(interactions.maxCommentsPerRun) || 0)),
    maxRepliesPerRun: Math.min(20, Math.max(0, Number(interactions.maxRepliesPerRun) || 0)),
    commentMaxChars: Math.min(200, Math.max(5, Number(interactions.commentMaxChars) || 60)),
    replyMaxChars: Math.min(200, Math.max(5, Number(interactions.replyMaxChars) || 60)),
    allowLikes: interactions.allowLikes !== false,
    allowComments: interactions.allowComments !== false,
    allowReplies: interactions.allowReplies !== false,
    actionDelayMinMs: Math.min(10000, Math.max(0, Number(interactions.actionDelayMinMs) || 0)),
    actionDelayMaxMs: Math.min(15000, Math.max(0, Number(interactions.actionDelayMaxMs) || 0)),
    maxDecisionRounds: Math.min(5, Math.max(1, Number(interactions.maxDecisionRounds) || 3))
  };
  const identity = next.identityPilot || {};
  const incomingFriendRequest = identity.incomingFriendRequest || {};
  const friendProposal = identity.friendProposal || {};
  const triggered = friendProposal.triggered || {};
  const rawWeights = triggered.weights || {};
  const finiteNumber = (value, fallback) => (
    Number.isFinite(Number(value)) ? Number(value) : fallback
  );
  const clampNumber = (value, min, max, fallback) => Math.min(
    max,
    Math.max(min, finiteNumber(value, fallback))
  );
  const clampInteger = (value, min, max, fallback) =>
    Math.round(clampNumber(value, min, max, fallback));
  const weights = {
    quality: clampInteger(rawWeights.quality, 0, 100, 40),
    interest: clampInteger(rawWeights.interest, 0, 100, 30),
    reciprocity: clampInteger(rawWeights.reciprocity, 0, 100, 20),
    stability: clampInteger(rawWeights.stability, 0, 100, 10)
  };
  if (Object.values(weights).reduce((sum, value) => sum + value, 0) !== 100) {
    throw new Error('主动好友评估权重合计必须为 100');
  }
  next.identityPilot = {
    ...identity,
    enabled: identity.enabled === true,
    graduated: identity.graduated === true,
    incomingFriendRequest: {
      ...incomingFriendRequest,
      enabled: incomingFriendRequest.enabled === true,
      autoWhitelist: incomingFriendRequest.autoWhitelist !== false,
      maxPending: Math.min(
        500,
        Math.max(1, Math.round(Number(incomingFriendRequest.maxPending) || 50))
      )
    },
    friendProposal: {
      ...friendProposal,
      enabled: friendProposal.enabled === true,
      graduated: friendProposal.graduated === true,
      activeDispatchEnabled: friendProposal.enabled === true
        && friendProposal.activeDispatchEnabled === true,
      ownerUin: /^\d{5,15}$/.test(String(friendProposal.ownerUin || '').trim())
        ? String(friendProposal.ownerUin).trim()
        : '',
      mode: friendProposal.mode === 'prompt' ? 'prompt' : 'triggered',
      minMessageCount: Math.min(
        10000,
        Math.max(1, Math.round(Number(friendProposal.minMessageCount) || 50))
      ),
      cooldownDays: Math.min(
        365,
        Math.max(1, Math.round(Number(friendProposal.cooldownDays) || 30))
      ),
      maxPending: Math.min(
        100,
        Math.max(1, Math.round(Number(friendProposal.maxPending) || 10))
      ),
      triggered: {
        ...triggered,
        probability: clampNumber(triggered.probability, 0, 1, 0.05),
        historyDays: clampInteger(triggered.historyDays, 1, 365, 30),
        minMessages: clampInteger(triggered.minMessages, 0, 10000, 50),
        minActiveDays: clampInteger(triggered.minActiveDays, 0, 365, 3),
        minDirectExchanges: clampInteger(triggered.minDirectExchanges, 0, 1000, 3),
        maxTriggerAgeMinutes: clampInteger(
          triggered.maxTriggerAgeMinutes,
          1,
          1440,
          10
        ),
        friendStatusMaxAgeMinutes: clampInteger(
          triggered.friendStatusMaxAgeMinutes,
          1,
          1440,
          15
        ),
        drawCooldownMinutes: clampInteger(triggered.drawCooldownMinutes, 1, 10080, 30),
        maxDrawsPerUserPerDay: clampInteger(
          triggered.maxDrawsPerUserPerDay,
          1,
          1000,
          6
        ),
        maxReviewsPerDay: clampInteger(triggered.maxReviewsPerDay, 0, 1000, 10),
        skipCooldownDays: clampInteger(triggered.skipCooldownDays, 0, 365, 7),
        errorCooldownMinutes: clampInteger(
          triggered.errorCooldownMinutes,
          1,
          10080,
          60
        ),
        maxQueueAgeSeconds: clampInteger(triggered.maxQueueAgeSeconds, 5, 3600, 120),
        scoreThreshold: clampInteger(triggered.scoreThreshold, 0, 100, 70),
        weights
      }
    }
  };
  if (
    next.identityPilot.enabled
    && (
      next.identityPilot.friendProposal.enabled
      || next.identityPilot.incomingFriendRequest.enabled
    )
  ) {
    const ownerUin = next.identityPilot.friendProposal.ownerUin;
    if (!ownerUin) throw new Error('好友审批功能需要配置管理员 QQ');
    if (
      next.allowAllWhenEmpty !== true
      && !(next.allow?.private || []).map(String).includes(ownerUin)
    ) {
      throw new Error('审批管理员 QQ 必须同时加入私聊白名单');
    }
  }
  const incidentPilot = next.incidentPilot || {};
  next.incidentPilot = {
    ...incidentPilot,
    enabled: incidentPilot.enabled === true,
    graduated: incidentPilot.graduated === true,
    ownerUin: /^\d{5,15}$/.test(String(incidentPilot.ownerUin || '').trim())
      ? String(incidentPilot.ownerUin).trim()
      : '',
    notifyWarnings: incidentPilot.notifyWarnings !== false,
    duplicateWindowMinutes: Math.min(
      1440,
      Math.max(1, Math.round(Number(incidentPilot.duplicateWindowMinutes) || 10))
    ),
    unknownWritesBlockChat: incidentPilot.unknownWritesBlockChat === true,
    retentionDays: Math.min(
      3650,
      Math.max(1, Math.round(Number(incidentPilot.retentionDays) || 90))
    )
  };
  if (next.incidentPilot.enabled) {
    if (!next.incidentPilot.ownerUin) {
      throw new Error('异常处理试点需要配置告警管理员 QQ');
    }
    if (
      next.allowAllWhenEmpty !== true
      && !(next.allow?.private || []).map(String).includes(next.incidentPilot.ownerUin)
    ) {
      throw new Error('异常告警管理员 QQ 必须同时加入私聊白名单');
    }
  }
  const slangPilot = next.slangPilot || {};
  next.slangPilot = {
    ...slangPilot,
    enabled: slangPilot.enabled === true,
    graduated: slangPilot.graduated === true,
    ownerUin: /^\d{5,15}$/.test(String(slangPilot.ownerUin || '').trim())
      ? String(slangPilot.ownerUin).trim()
      : '',
    minOccurrences: Math.min(
      20,
      Math.max(2, Math.round(Number(slangPilot.minOccurrences) || 3))
    ),
    minSpeakers: Math.min(
      20,
      Math.max(1, Math.round(Number(slangPilot.minSpeakers) || 2))
    ),
    windowHours: Math.min(
      720,
      Math.max(1, Math.round(Number(slangPilot.windowHours) || 72))
    ),
    maxPending: Math.min(
      500,
      Math.max(1, Math.round(Number(slangPilot.maxPending) || 100))
    ),
    perChatDailyLimit: Math.min(
      50,
      Math.max(1, Math.round(Number(slangPilot.perChatDailyLimit) || 5))
    ),
    rejectCooldownDays: Math.min(
      365,
      Math.max(1, Math.round(Number(slangPilot.rejectCooldownDays) || 14))
    ),
    maxEvidence: Math.min(
      30,
      Math.max(3, Math.round(Number(slangPilot.maxEvidence) || 12))
    ),
    webResearch: slangPilot.webResearch !== false,
    maxSearchResults: Math.min(
      10,
      Math.max(1, Math.round(Number(slangPilot.maxSearchResults) || 5))
    ),
    maxFetchPages: Math.min(
      3,
      Math.max(0, Math.round(Number(slangPilot.maxFetchPages) || 0))
    ),
    maxResearchRounds: Math.min(
      3,
      Math.max(1, Math.round(Number(slangPilot.maxResearchRounds) || 2))
    )
  };
  if (next.slangPilot.enabled) {
    const ownerUin = next.slangPilot.ownerUin;
    if (!ownerUin) throw new Error('黑话语料库试点需要配置审批管理员 QQ');
    if (
      next.allowAllWhenEmpty !== true
      && !(next.allow?.private || []).map(String).includes(ownerUin)
    ) {
      throw new Error('黑话审批管理员 QQ 必须同时加入私聊白名单');
    }
  }
  if (!Number.isInteger(Number(next.server?.port)) || next.server.port < 1 || next.server.port > 65535) {
    throw new Error('Invalid server port');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(next.server.host) && !String(next.server.token || '').trim()) {
    throw new Error('A console token is required for LAN access');
  }
  currentConfig = next;

  // ── 响应档位：以滑条位置为唯一真相，派生 tier 与随机概率 ──
  // 前端只负责上报滑条位置（contextSliderPos），档位和概率一律由这里换算。
  // 这样即使前端算错、或者有人直接调接口只传位置，配置也不会自相矛盾。
  const posRaw = currentConfig?.store?.contextSliderPos;
  if (posRaw !== undefined && posRaw !== null) {
    const { tier, randomPercent } = sliderToTier(posRaw);
    currentConfig.store.contextTier = tier;
    currentConfig.store.randomPercent = randomPercent;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  if (oldTimeControl !== JSON.stringify(next.timeControl)) notifyTimeControlChange();
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
  notifyTimeControlChange();
}

/**
 * 取某个会话实际生效的 store 档位配置。
 * unifiedTier 开启 → 全局 store 原样返回；
 * 关闭 → 群聊查 groupSliderPos，有单独设置就换算出该群的 tier/randomPercent，
 * 其余字段（各档读取条数、关键词表）沿用全局值。私聊永远跟随全局档位。
 */
export function storeConfigForChat(chatKey) {
  const store = getConfig().store || {};
  if (store.unifiedTier !== false) return store;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return store;
  const pos = store.groupSliderPos?.[id];
  if (pos === undefined || pos === null) return store;
  const { tier, randomPercent } = sliderToTier(Number(pos));
  return { ...store, contextTier: tier, randomPercent };
}

/** 获取某个会话实际生效的对话引擎配置。私聊始终使用全局模式。 */
export function conversationConfigForChat(chatKey) {
  const conversation = getConfig().conversation || {};
  if (conversation.unifiedMode !== false) return conversation;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return conversation;
  const mode = conversation.groupModes?.[id];
  return ['legacy', 'threaded', 'lifecycle'].includes(mode)
    ? { ...conversation, mode }
    : conversation;
}

/** 防抖保存：高频小改动合并写盘。 */
export function scheduleConfigSave() {
  clearTimeout(saveTimers.get('cfg'));
  saveTimers.set('cfg', setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${CONFIG_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(getConfig(), null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE);
    } catch (error) {
      console.error('[config] 保存失败:', error);
    }
  }, 400));
}
