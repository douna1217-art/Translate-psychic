// 这是一个 Vercel Serverless Function：汇总宣传首页要展示的"有多少人在用"这类数据。
// 用的是 Supabase 的 service role key（只在服务器端读取，浏览器拿不到），
// 这个 key 可以绕过 RLS 直接读表，普通用户用的 anon key 是读不到 app_events 原始记录的，
// 前端拿到的永远只是这里算好的汇总数字，保护了真实的用户数据不被随便扒到。
//
// 部署步骤（Vercel）：
// 1. 去 Supabase 项目后台 → Settings → API，复制 "service_role" 这个 key（不是 anon key！这个绝对不能出现在前端代码里）
// 2. 在 Vercel 项目的 Settings → Environment Variables 里添加：
//    名称: SUPABASE_SERVICE_ROLE_KEY   值: 你复制的 service_role key
// 3. 确认 VITE_SUPABASE_URL 这个环境变量已经配置好了（登录功能本来就需要它）
// 4. 还需要在 Supabase 里建一张 app_events 表，具体建表 SQL 见 README

import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceKey) {
    // 还没配置好也不报错，就当成"暂时没有数据"，首页不展示统计区块就好
    res.status(200).json({ totalUsers: 0, totalSearches: 0, totalWords: 0 })
    return
  }

  try {
    const supabase = createClient(supabaseUrl, serviceKey)

    const [signups, searches, wordsSaved] = await Promise.all([
      supabase.from('app_events').select('id', { count: 'exact', head: true }).eq('event_type', 'signup'),
      supabase.from('app_events').select('id', { count: 'exact', head: true }).eq('event_type', 'search'),
      supabase.from('app_events').select('id', { count: 'exact', head: true }).eq('event_type', 'word_saved'),
    ])

    res.status(200).json({
      totalUsers: signups.count ?? 0,
      totalSearches: searches.count ?? 0,
      totalWords: wordsSaved.count ?? 0,
    })
  } catch (error) {
    res.status(200).json({ totalUsers: 0, totalSearches: 0, totalWords: 0 })
  }
}
