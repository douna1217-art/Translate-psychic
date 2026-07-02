# Translate Psychic · 背单词 / 学中文 助手

一个查词 + 单词本 + 闪卡的学习工具，支持两种模式：
- **学英语**（中文母语）：英文 ↔ 中文双向查词，释义来自免费英语词典 API，AI 只负责翻译。
- **学中文**（English speaker）：输入英文/拼音/中文，AI 给出中文词汇讲解，界面用英文标签。

## 功能
- 查词：免费词典 API 保证权威、完整的英文释义；拼写错误会给"您是否要搜索"的建议。
- 单词本：可以新建/重命名/删除，支持在本子内直接查词加入、按文字筛选已有单词。
- 闪卡：任选一个单词本，一张一张翻卡片复习。
- 每个单词可以展开看详细释义、例句（自动高亮目标词），并有自由编辑的笔记框。
- 数据保存在浏览器 localStorage 里（换设备不会同步，这是纯前端应用的正常限制）。

## 本地开发

```bash
npm install
npm run dev
```

⚠️ 查词功能依赖 `/api/gemini` 这个后端接口，本地用 `npm run dev` 是访问不到的（Vite 自己的 dev server 不会跑 `/api` 目录）。本地要测试查词，需要用 Vercel CLI：

```bash
npm install -g vercel
vercel dev
```

## 部署到 Vercel

1. 在 [ai.google.dev](https://ai.google.dev/) 或 Google AI Studio 申请一个免费的 Gemini API Key。
2. 把这个项目推到 GitHub（一个新仓库即可）。
3. 去 [vercel.com](https://vercel.com) 用 GitHub 账号登录，点 "Add New… → Project"，选择这个仓库，直接点 Deploy（Vercel 会自动识别这是 Vite 项目）。
4. 部署完成后，去项目的 **Settings → Environment Variables**，添加：
   - Name: `GEMINI_API_KEY`
   - Value: 你的 Gemini Key
5. 加完环境变量后，去 **Deployments** 里对最新一次部署点 "Redeploy"（环境变量只在重新部署后生效）。
6. 打开 Vercel 分配的网址，测试查词功能是否正常。

## 项目结构

```
src/App.jsx        主应用（查词、单词本、闪卡全部在这个文件里）
src/utils/auth.js  密码哈希（仅用于演示登录，非真正安全的账号系统）
api/gemini.js      Vercel Serverless Function，代理 Gemini API，Key 只在服务器端
```

## 已知限制（如实说明）

- 登录/账号功能是纯前端演示：数据存在浏览器 localStorage，换设备或清缓存会丢失，也没有找回密码等功能。真正要给别人用，建议接入 Supabase / Firebase Auth 之类的服务。
- 数据不跨设备同步。
