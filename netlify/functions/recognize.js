/**
 * Netlify Function —— 拍照识别中转
 *
 * 环境变量（Netlify 后台 Site configuration → Environment variables）：
 *   CF_ACCOUNT_ID  Cloudflare Account ID（必填）
 *   CF_API_TOKEN   有 Workers AI 权限的 API Token（必填）
 *   CF_MODEL       可选，默认 @cf/meta/llama-4-scout-17b-16e-instruct
 *   APP_TOKEN      可选，防白嫖
 *
 * 接口：
 *   GET  /api/recognize  → 健康检查
 *   POST /api/recognize  → { image: "data:image/jpeg;base64,...", hint? }
 */

const DEFAULT_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/*
 * Prompt 设计要点（经实测对比 4 种策略，识别准确率提升明显）：
 *   · 中英双语：英文指令对视觉模型更明确，中文约束名称输出
 *   · 强制分类检查：主食最容易被漏掉（藏在汤和配菜下面）
 *   · 强制拆分：不允许合并成"一碗XX汤"，必须逐项列出
 *   · 参照物标定：用碗口/筷子估算克数，避免份量偏小
 *
 * 实测对比（同一张汤粉照片）：
 *   原 prompt  → 只识别"韩式辣鱼汤 400g 420kcal"，漏掉米粉
 *   新 prompt  → 识别"米粉200g + 鱼片100g + 鸡蛋50g + 青菜20g + 汤底400g = 520kcal"
 */
const PROMPT = [
  'You are a professional nutritionist specializing in Asian cuisine.',
  'Analyze this food photo carefully.',
  '',
  'STEP 1 — Identify the meal STRUCTURE first:',
  '· Is it a bowl of soup/noodles? (liquid with noodles/vermicelli)',
  '· Is it a plate of rice with toppings? (盖浇饭 / 快餐 / 便当)',
  '· Is it multiple separate dishes? (几道菜 + 一碗饭)',
  '· Is it a single dish?',
  'Do NOT guess noodles if you only see rice. Look at the actual texture:',
  '  - Rice = 白色颗粒状，松散',
  '  - Noodles/vermicelli = 细长条状、半透明、卷曲',
  '  - If you see BOTH a rice plate and a separate soup bowl, they are SEPARATE items.',
  '',
  'STEP 2 — List EVERY ingredient separately. Do NOT merge into one dish name.',
  'Check all four categories:',
  '1. Staple/Carbs: rice (米饭), noodles (面条), vermicelli (粉丝/米粉), bread, bun',
  '2. Protein: egg, meat slices, meatballs, fish, tofu, shrimp, sausage, 卤味',
  '3. Vegetables: leafy greens, bean sprouts (豆芽), mushrooms (菇), seaweed, wood ear (木耳)',
  '4. Soup base & oil: broth (汤), chili oil, sesame oil, cooking oil',
  '',
  'STEP 3 — Estimate amounts with a reference object (plate size, bowl rim, chopsticks):',
  '- A normal bowl of cooked rice: 150~250g',
  '- A standard plate of rice for a meal: 200~300g',
  '- Soup in a small bowl: 200~400ml',
  '- Stir-fried dishes contain extra oil (+30~50% calories vs boiled)',
  '- Do NOT underestimate: a small handful of vermicelli is at least 150g',
  '',
  'Output JSON only, no explanation, no markdown:',
  '{"structure":"rice_bowl|soup_noodle|multi_dish|single_dish","items":[{"name":"食材中文名","portion":"份量描述","grams":200,"kcal":220,"kcal_low":180,"kcal_high":260,"confidence":0.85}],"total_kcal":520,"summary":"一句话描述这顿饭"}',
  '',
  'RULES:',
  '- name MUST be in Chinese',
  '- total_kcal MUST equal the sum of all items kcal',
  '- Include the soup as a separate item if it is in its own bowl',
  '- If a category is not present, just omit it (do not invent food)'
].join('\n');

const USER_HINT = [
  'First determine the meal structure (rice plate vs noodle soup vs multiple dishes), then list every ingredient separately with Chinese names.',
  'Be accurate about what you actually see — do not invent noodles if there are none.',
  'total_kcal must be the sum of all items.',
  'Output JSON only.'
].join(' ');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-app-token',
  'Access-Control-Max-Age': '86400'
};

function reply(obj, status) {
  return {
    statusCode: status || 200,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj)
  };
}

function parseLoose(text) {
  if (!text) throw new Error('模型没有返回内容');
  let t = String(text).trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  if (start < 0) throw new Error('模型返回里没有 JSON');

  // 先试完整的
  let end = t.lastIndexOf('}');
  if (end > start) {
    const slice = t.slice(start, end + 1);
    const attempts = [
      slice,
      slice.replace(/,\s*([}\]])/g, '$1'),
      slice.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"')
    ];
    for (const a of attempts) {
      try { return JSON.parse(a); } catch (e) { /* 继续 */ }
    }
  }

  /*
   * 兜底：输出被截断时（max_tokens 用尽），
   * 逐步回退到最后一个完整的 } 再尝试解析。
   * 这样即使 JSON 没写完，也能拿到部分结果。
   */
  for (let cut = end > start ? end : t.length; cut > start + 10; cut--) {
    if (t[cut] !== '}') continue;
    const slice = t.slice(start, cut + 1);
    try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')); } catch (e) { /* 继续回退 */ }
  }

  throw new Error('无法解析模型返回的 JSON（可能被截断）');
}

function normalize(raw) {
  const list = raw.items || raw.foods || raw.list || [];
  const items = (Array.isArray(list) ? list : []).map((it) => {
    const name = String(it.name || it.food || it.title || '未知食物').slice(0, 40);
    const kcal = Math.round(Number(it.kcal != null ? it.kcal : (it.calories != null ? it.calories : it.energy)) || 0);
    const grams = Math.round(Number(it.grams || it.weight || 0) || 0);
    let lo = Math.round(Number(it.kcal_low || 0) || 0);
    let hi = Math.round(Number(it.kcal_high || 0) || 0);
    if (!lo && !hi && kcal > 0) { lo = Math.round(kcal * 0.8); hi = Math.round(kcal * 1.2); }
    if (lo && hi && lo > hi) { const t = lo; lo = hi; hi = t; }
    return {
      name,
      portion: String(it.portion || it.amount || (grams ? grams + 'g' : '1份')),
      grams,
      kcal: Math.max(0, kcal),
      kcalLow: lo || null,
      kcalHigh: hi || null,
      confidence: Math.max(0, Math.min(1, Number(it.confidence || 0.7)))
    };
  }).filter((it) => it.kcal > 0 || it.grams > 0);   // 保留有克数的项（低卡食材也要显示）

  if (!items.length) throw new Error('未识别出食物，请换一张更清晰的饭菜照片');

  /*
   * 合计热量：优先用各项之和。
   *
   * 原因：模型有时会返回一个"整道菜"的 total_kcal（比如只算汤 420），
   * 但 items 已经拆分成了 7 项（实际 740）。这时用 raw.total_kcal 会严重偏低。
   * 所以当两者差距超过 30% 时，以各项之和为准。
   */
  const sum = items.reduce((a, b) => a + b.kcal, 0);
  const rawTotal = Math.round(Number(raw.total_kcal || 0) || 0);
  let total = sum;
  if (rawTotal > 0 && sum > 0) {
    const diff = Math.abs(rawTotal - sum) / Math.max(rawTotal, sum);
    // 差距小于 30% 时认为两者一致，取模型给的（可能更准）；否则用累加值
    total = diff <= 0.3 ? rawTotal : sum;
  } else if (rawTotal > 0) {
    total = rawTotal;
  }

  return { items, total_kcal: total, summary: String(raw.summary || '') };
}

exports.handler = async (event, context) => {
  const method = event.httpMethod;

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const env = process.env || {};
  const accountId = (env.CF_ACCOUNT_ID || '').trim();
  const apiToken = (env.CF_API_TOKEN || '').trim();
  const model = (env.CF_MODEL || '').trim() || DEFAULT_MODEL;
  const appToken = (env.APP_TOKEN || '').trim();

  /* ---------- 健康检查 ---------- */
  if (method === 'GET') {
    const configured = !!(accountId && apiToken);
    return reply({
      ok: configured,
      service: 'calorie-relay',
      engine: 'cloudflare-workers-ai-rest',
      model,
      aiBound: configured,
      node: process.version,
      message: configured ? undefined :
        '还没配置：请在 Netlify 后台 Site configuration → Environment variables 添加 CF_ACCOUNT_ID 和 CF_API_TOKEN，然后重新 Deploy'
    });
  }

  if (method !== 'POST') {
    return reply({ error: 'method', message: '只支持 GET / POST' }, 405);
  }

  /* ---------- 令牌校验 ---------- */
  if (appToken) {
    const h = event.headers || {};
    const got = (h['x-app-token'] || h['X-App-Token'] || '').trim();
    if (got !== appToken) {
      return reply({ error: 'auth', message: 'App 令牌不匹配' }, 401);
    }
  }

  if (!accountId || !apiToken) {
    return reply({
      error: 'config',
      message: '环境变量没配好：需要 CF_ACCOUNT_ID 和 CF_API_TOKEN'
    }, 500);
  }

  /* ---------- 解析请求体 ---------- */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return reply({ error: 'body', message: '请求体不是合法 JSON' }, 400);
  }

  const image = payload && payload.image;
  if (!image || typeof image !== 'string') {
    return reply({ error: 'body', message: '缺少 image 字段（base64 dataURL）' }, 400);
  }
  if (image.length > 8 * 1024 * 1024) {
    return reply({ error: 'body', message: '图片太大，请压缩后再试' }, 413);
  }

  const hint = payload.hint ? '场景提示：' + payload.hint + '\n' : '';

  /* ---------- 调 Cloudflare Workers AI ---------- */
  // 模型名含 @ 和 /，必须原样拼在路径里
  const url = 'https://api.cloudflare.com/client/v4/accounts/' +
    encodeURIComponent(accountId) + '/ai/run/' + model;

  let res, bodyText;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 24000);
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + apiToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: hint + USER_HINT },
              { type: 'image_url', image_url: { url: image } }
            ]
          }
        ],
        max_tokens: 2000,
        temperature: 0.1
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    bodyText = await res.text();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/abort/i.test(msg)) {
      return reply({ error: 'timeout', message: '识别超时，请重试或换一张小一点的图' }, 504);
    }
    return reply({ error: 'upstream', message: '调用 Cloudflare AI 失败：' + msg }, 502);
  }

  if (!res.ok) {
    if (res.status === 429 || /neuron|quota|exceed/i.test(bodyText)) {
      return reply({
        error: 'quota',
        message: '今天的免费额度用完了（Cloudflare 每天 10000 Neurons），明天 0 点后恢复'
      }, 429);
    }
    let detail = '';
    try {
      const j = JSON.parse(bodyText);
      detail = (j.errors && j.errors[0] && j.errors[0].message) || j.message || '';
    } catch (_) { detail = String(bodyText).slice(0, 200); }
    return reply({
      error: 'upstream',
      message: 'Cloudflare AI 返回 HTTP ' + res.status + (detail ? '：' + detail : '')
    }, 502);
  }

  /* ---------- 解析响应 ---------- */
  let cfJson;
  try { cfJson = JSON.parse(bodyText); }
  catch (e) { return reply({ error: 'upstream', message: 'Cloudflare 返回了非 JSON' }, 502); }

  if (cfJson.success === false) {
    const msg = (cfJson.errors && cfJson.errors[0] && cfJson.errors[0].message) || '未知错误';
    return reply({ error: 'upstream', message: 'Cloudflare AI 错误：' + msg }, 502);
  }

  const result = cfJson.result || {};
  let text = '';
  if (typeof result === 'string') text = result;
  else if (typeof result.response === 'string') text = result.response;
  else if (result.choices && result.choices[0]) {
    text = (result.choices[0].message && result.choices[0].message.content) || result.choices[0].text || '';
  }

  try {
    const out = normalize(parseLoose(text));
    return reply(out);
  } catch (e) {
    return reply({
      error: 'parse',
      message: '识别失败：' + ((e && e.message) || e) + '。可换一张更清晰的照片'
    }, 502);
  }
};
