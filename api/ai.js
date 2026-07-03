// 这是一个 Vercel Serverless Function（部署到 Vercel 时会自动识别 /api 目录）。
// 作用：把浏览器发来的 prompt 转发给智谱 AI 的 GLM-4-Flash 模型。
// 换成这个而不是 Gemini，是因为 GLM-4-Flash 免费额度宽松很多，而且是国内服务，访问稳定。
// Key 只存在于服务器端环境变量里，不会被打包进前端 JS，用户在浏览器里怎么看也看不到。
//
// 部署步骤（Vercel）：
// 1. 去 https://bigmodel.cn （智谱开放平台）注册账号、完成实名认证，领取免费 API Key
// 2. 在 Vercel 项目的 Settings → Environment Variables 里添加：
//    名称: ZHIPU_API_KEY   值: 你的真实 Key
// 3. 本地开发调试：安装 vercel CLI 后运行 `vercel dev`（而不是 `npm run dev`），
//    这样 /api/ai 才能在本地被正确调用。
//
// 如果之后想换别的 OpenAI 兼容服务（硅基流动 / DeepSeek 等），
// 通常只需要改下面的 API_URL、model 名字和对应的环境变量名。

const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const MODEL = 'glm-4-flash'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: '只支持 POST 请求' })
    return
  }

  const apiKey = process.env.ZHIPU_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: '服务器未配置 ZHIPU_API_KEY' })
    return
  }

  const { prompt } = req.body || {}
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: '缺少 prompt 参数' })
    return
  }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      res.status(response.status).json({ error: 'AI API 请求失败', detail: data })
      return
    }

    res.status(200).json(data)
  } catch (error) {
    res.status(500).json({ error: '代理请求出错', detail: String(error) })
  }
}
