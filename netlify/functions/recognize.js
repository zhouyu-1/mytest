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

const PROMPT = [
  '你是一名专业营养师与食物识别助手。',
  '请分析用户提供的餐食照片，识别出图中的每一种食物并估算热量。',
  '要求：',
  '1. 先找出图中可用于标定的参照物（餐盘直径、碗口、筷子、易拉罐、手掌、硬币等），用它换算每种食物的实际尺寸，再估算克数(g)；',
  '2. 若图中没有任何参照物，按常见份量给保守估计，并在 confidence 上体现不确定性；',
  '3. 结合中式家常菜/快餐/西餐常见做法给出每种食物的热量(kcal)，注意炒菜/煎炸通常含 8%~15% 的额外油脂热量；',
  '4. 若图片中有明确的包装标签文字，优先采用标签数值；',
  '5. 严格只输出一个 JSON 对象，不要输出任何解释文字或 markdown 代码块；',
  'JSON 结构：',
  '{"items":[{"name":"食物名","portion":"份量描述，如 1碗(150g)","grams":150,"kcal":232,"kcal_low":190,"kcal_high":280,"confidence":0.85}],',
  '"total_kcal":232,"summary":"一句话描述这顿饭"}',
  '其中 items 至少一项，kcal 为该种食物的总热量（整数），kcal_low/kcal_high 为合理区间，confidence 为 0-1 的小数。'
].join('\n');

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
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型返回里没有 JSON');
  const slice = t.slice(start, end + 1);
  try { return JSON.parse(slice); }
  catch (e) {
    try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')); }
    catch (e2) {
      try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"')); }
      catch (e3) { throw new Error('无法解析模型返回的 JSON'); }
    }
  }
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
  }).filter((it) => it.kcal > 0);

  if (!items.length) throw new Error('未识别出食物，请换一张更清晰的饭菜照片');

  const total = Math.round(Number(raw.total_kcal || 0)) || items.reduce((a, b) => a + b.kcal, 0);
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
              { type: 'text', text: hint + '识别这张照片里的食物并估算热量，只输出 JSON。' },
              { type: 'image_url', image_url: { url: image } }
            ]
          }
        ],
        max_tokens: 1200,
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
