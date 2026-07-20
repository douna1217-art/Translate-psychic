# Translate Psychic · 背单词 / 学中文 助手

一个查词 + 单词本 + 闪卡的学习工具，支持两种模式：
- **学英语**（中文母语）：英文 ↔ 中文双向查词，释义来自免费英语词典 API，AI 只负责翻译。
- **学中文**（English speaker）：输入英文/拼音/中文，AI 给出中文词汇讲解，界面用英文标签。

## 功能
- 查词：免费词典 API 保证权威、完整的英文释义；拼写错误会给"您是否要搜索"的建议。
- 单词本：可以新建/重命名/删除，支持在本子内直接查词加入、按文字筛选已有单词。
- 闪卡：任选一个单词本，一张一张翻卡片复习。
- 每个单词可以展开看详细释义、例句（自动高亮目标词），并有自由编辑的笔记框。
- 数据默认存在浏览器 localStorage 里；登录账号后会自动同步到云端，换设备登录同一账号也能看到一样的单词本。

## 本地开发

```bash
npm install
npm run dev
```

⚠️ 查词功能依赖 `/api/ai` 这个后端接口，本地用 `npm run dev` 是访问不到的（Vite 自己的 dev server 不会跑 `/api` 目录）。本地要测试查词，需要用 Vercel CLI：

```bash
npm install -g vercel
vercel dev
```

即使 `/api/ai` 打不通，查词也不会完全失效——免费词典 API 查不到翻译时会自动降级用免费翻译服务兜底，只是没有 AI 生成的学习小贴士。

## 部署到 Vercel

1. 去 [bigmodel.cn](https://bigmodel.cn) （智谱开放平台）注册账号、完成实名认证，领取免费的 GLM-4-Flash API Key（用这个而不是 Gemini，是因为免费额度宽松很多，而且国内访问稳定，不用担心网络问题）。
2. 把这个项目推到 GitHub（一个新仓库即可）。
3. 去 [vercel.com](https://vercel.com) 用 GitHub 账号登录，点 "Add New… → Project"，选择这个仓库，直接点 Deploy（Vercel 会自动识别这是 Vite 项目）。
4. 部署完成后，去项目的 **Settings → Environment Variables**，添加：
   - Name: `ZHIPU_API_KEY`
   - Value: 你的智谱 Key
5. 加完环境变量后，去 **Deployments** 里对最新一次部署点 "Redeploy"（环境变量只在重新部署后生效）。
6. 同时检查一下 **Settings → Deployment Protection**，确认 "Vercel Authentication" 是关闭的——开着的话所有访客都要先登录 Vercel 才能看到网站。
7. 打开 Vercel 分配的网址，测试查词功能是否正常。

## 登录账号的云端数据同步

以前登录只是个演示——单词本、单词卡实际上还是存在浏览器 localStorage 里，换设备/清缓存就没了。现在改成了真正的云端同步：

- **没登录**：跟以前完全一样，数据只存本地。
- **登录后**：单词本、单词卡会同步进 Supabase 数据库，换设备登录同一个账号也能看到一样的内容。第一次登录时，如果账号里还没有数据、但本地已经攒了一些单词，会自动把本地内容"认领"到账号上，不会凭空丢失。

需要在 Supabase 建两张表：

1. 打开 Supabase 项目 → **SQL Editor** → New query，粘贴下面这段并运行：

   ```sql
   create table if not exists public.word_cards (
     id bigint primary key,
     user_id uuid not null references auth.users(id) on delete cascade,
     word text not null,
     translation text default '',
     pronunciation text default '',
     mode text not null,
     senses jsonb not null default '[]'::jsonb,
     other_forms jsonb not null default '[]'::jsonb,
     notes text default '',
     created_at timestamptz not null default now()
   );

   alter table public.word_cards enable row level security;

   create policy "Users manage their own cards" on public.word_cards
     for all
     to authenticated
     using (auth.uid() = user_id)
     with check (auth.uid() = user_id);

   create table if not exists public.word_books (
     id text primary key,
     user_id uuid not null references auth.users(id) on delete cascade,
     name text not null,
     word_ids bigint[] not null default '{}',
     created_at timestamptz not null default now()
   );

   alter table public.word_books enable row level security;

   create policy "Users manage their own books" on public.word_books
     for all
     to authenticated
     using (auth.uid() = user_id)
     with check (auth.uid() = user_id);
   ```

   RLS 规则保证每个人只能读写自己名下的数据，就算拿到 anon key 也看不到别人的单词本。

2. 不需要额外的环境变量——用的还是登录本来就要配置的 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`。
3. 建完表之后，注册/登录一个账号，查几个词、加进单词本，去 Supabase 的 **Table Editor** 里应该能看到 `word_cards` / `word_books` 里多了对应的行。

## 宣传首页的数据统计

首页会展示"多少人在用 / 累计查词次数 / 收藏单词数"，这些数字来自 Supabase 里的一张 `app_events` 表。没配置的话首页就不显示这个区块，不影响其他功能。

1. 打开你的 Supabase 项目 → 左侧菜单 **SQL Editor** → New query，粘贴下面这段并运行：

   ```sql
   create table if not exists public.app_events (
     id bigint generated always as identity primary key,
     event_type text not null,
     user_id uuid references auth.users(id) on delete set null,
     created_at timestamptz not null default now()
   );

   alter table public.app_events enable row level security;

   create policy "Allow insert for everyone" on public.app_events
     for insert
     to anon, authenticated
     with check (true);
   ```

   这张表只允许"插入"，不允许任何人直接"读取"——真实数据不会被人从前端扒走，首页看到的数字是后端用 service role key 单独汇总出来的。

2. 去 Supabase 项目 → **Settings → API**，找到 **service_role** 这个 key（跟登录用的 anon key 不是同一个，这个绝对不能写进前端代码，只能配进 Vercel 的环境变量）。
3. 去 Vercel 项目 → **Settings → Environment Variables**，添加：
   - Name: `SUPABASE_SERVICE_ROLE_KEY`
   - Value: 你复制的 service_role key
4. 添加完去 **Deployments** 对最新一次部署点 "Redeploy"。
5. 重新部署完，回到网站首页，正常使用一下查词/登录/加入单词本，刷新几次首页应该就能看到统计数字了。

## 项目结构

```
src/App.jsx        主应用（宣传首页、查词、单词本、闪卡全部在这个文件里）
src/utils/auth.js  密码哈希（仅用于演示登录，非真正安全的账号系统）
api/ai.js          Vercel Serverless Function，代理智谱 GLM-4-Flash，Key 只在服务器端
api/stats.js       Vercel Serverless Function，用 service role key 汇总首页展示的统计数字
```

## 已知限制（如实说明）

- 登录状态由 Supabase Auth 维护，是真实的账号系统；但没有找回密码、修改邮箱之类的完整账号管理功能。
- 没登录时数据只存本地，不会跨设备；登录后才会同步到云端。
- 云端同步用的是"整表覆盖"策略（每次改动会把这个账号的单词本/单词卡整体重新写一遍），实现简单、数据量小的时候没问题，但不适合数据量特别大或者需要精细的多设备实时协作场景。
