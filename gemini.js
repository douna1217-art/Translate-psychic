// 这是一个 Vercel Serverless Function（部署到 Vercel 时会自动识别 /api 目录）。
// 作用：把浏览器发来的 prompt 转发给 Gemini，Key 只存在于服务器端环境变量里，
// 不会被打包进前端 JS，用户在浏览器里怎么看也看不到。
//
// 部署步骤（Vercel）：
// 1. 在 Vercel 项目的 Settings → Environment Variables 里添加：
//    名称: GEMINI_API_KEY   值: 你的真实 Key（注意，不要再加 VITE_ 前缀）
// 2. 本地开发调试：安装 vercel CLI 后运行 `vercel dev`（而不是 `npm run dev`），
//    这样 /api/gemini 才能在本地被正确调用。
//
// 如果你部署在 Netlify / 自己的服务器，思路完全一样：把下面这段逻辑
// 换成对应平台的函数写法，Key 依然只放在服务器端环境变量里即可。

const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: '只支持 POST 请求' })
    return
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: '服务器未配置 GEMINI_API_KEY' })
    return
  }

  const { prompt } = req.body || {}
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: '缺少 prompt 参数' })
    return
  }

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          response_mime_type: 'application/json',
        },
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      res.status(response.status).json({ error: 'Gemini API 请求失败', detail: data })
      return
    }

    res.status(200).json(data)
  } catch (error) {
    res.status(500).json({ error: '代理请求出错', detail: String(error) })
  }
}
