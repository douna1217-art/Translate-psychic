import { createClient } from "@supabase/supabase-js";

// Project URL 和 anon/publishable key 都是"公开"的，设计上就是给浏览器用的，
// 安全性由 Supabase 数据库里的 Row Level Security 规则来保证，不是靠这两个值保密。
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
