import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./utils/supabaseClient";

const defaultSettings = {
  showTranslation: true,
  showPronunciation: true,
  showExample: true,
  showTip: true,
  showForms: true,
  showSynonyms: false,
};

const settingLabels = {
  showTranslation: "显示翻译",
  showPronunciation: "显示音标",
  showExample: "显示例句",
  showTip: "显示学习提示",
  showForms: "显示词形变化",
  showSynonyms: "显示近义词",
};

const settingLabelsEn = {
  showTranslation: "Show translation",
  showPronunciation: "Show pronunciation",
  showExample: "Show examples",
  showTip: "Show learning tips",
  showForms: "Show word forms",
  showSynonyms: "Show synonyms",
};

function normalizeSearchTerm(term) {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}

// mode: "learn-zh" 的卡片里存的是中文，要用中文语音朗读，不然会被英文发音引擎读得完全不对
function speakWithBrowserTTS(word, lang) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = lang;
  const voices = window.speechSynthesis.getVoices();
  const bestVoice =
    voices.find((v) => v.lang === lang) || voices.find((v) => v.lang.replace("_", "-").startsWith(lang.split("-")[0]));
  if (bestVoice) utterance.voice = bestVoice;
  window.speechSynthesis.speak(utterance);
}

// 浏览器自带的语音合成音色参差不齐，经常读得很怪。优先用有道词典的真人发音音频
// （免费、不需要 key），播放失败（比如词组、生僻词没有对应音频）时才退回浏览器合成语音
function speakWord(word, mode) {
  if (!word) return;
  const lang = mode === "learn-zh" ? "zh-CN" : "en-US";
  if (mode !== "learn-zh" && typeof window !== "undefined") {
    const audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`);
    audio.onerror = () => speakWithBrowserTTS(word, lang);
    audio.play().catch(() => speakWithBrowserTTS(word, lang));
    return;
  }
  speakWithBrowserTTS(word, lang);
}

function extractJson(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

// 所有 AI 调用统一走后端的 /api/ai 代理（见项目根目录 api/ai.js，目前接的是智谱 GLM-4-Flash）。
// 真正的 API Key 只存在服务器端环境变量里，浏览器拿不到，避免被偷走。
// 加了个超时：AI 服务打不通或者很慢的时候，最多等 20 秒就放弃转去用免费翻译兜底，
// 不然查词会被卡住很久才降级，体感会很慢。
// （词形变化功能上线后 AI 单次要生成的内容变多了，实测正常响应经常要 15~18 秒，
// 超时定得太短会导致几乎每次都提前放弃、掉去免费翻译兜底，例句和学习提示全部丢失）
async function callAI(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      const errMsg = data.error || "AI 服务暂时不可用，请稍后再试";
      throw new Error(typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg));
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// 把例句中出现的目标单词/词组高亮显示。英文按词边界+简单变形匹配，中文按原样子串匹配（中文没有单词边界）
function highlightWord(sentence, word) {
  if (!sentence || !word) return sentence;
  const isCJK = /[\u4e00-\u9fff]/.test(word);

  if (isCJK) {
    const parts = sentence.split(word);
    const nodes = [];
    parts.forEach((part, i) => {
      nodes.push(<span key={`t-${i}`}>{part}</span>);
      if (i < parts.length - 1) {
        nodes.push(
          <mark key={`m-${i}`} className="bg-emerald-200 text-emerald-900 rounded px-0.5">
            {word}
          </mark>
        );
      }
    });
    return nodes;
  }

  const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return sentence;
  const splitRegex = new RegExp(`(\\b${escaped}\\w*)`, "gi");
  const matchTest = new RegExp(`^${escaped}\\w*$`, "i");
  return sentence.split(splitRegex).map((seg, i) =>
    matchTest.test(seg) ? (
      <mark key={i} className="bg-emerald-200 text-emerald-900 rounded px-0.5">{seg}</mark>
    ) : (
      <span key={i}>{seg}</span>
    )
  );
}

const wordCardCache = new Map();

// ① 免费英语词典 API：能访问时用它拿权威、完整的英文释义/例句/音标，几乎没有等待时间
// status: "ok"（查到了）| "notfound"（词典里没有这个词，可能是拼写错误）| "blocked"（请求失败/被拦截，比如当前沙盒环境访问不了外部地址）
async function fetchFreeDictionary(word) {
  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim().toLowerCase())}`
    );
    if (res.status === 404) return { status: "notfound" };
    if (!res.ok) return { status: "blocked" };
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : null;
    return entry ? { status: "ok", entry } : { status: "notfound" };
  } catch (error) {
    return { status: "blocked" };
  }
}

// 把拉长强调的英文单词（比如打字打嗨了的 "goooood"）压缩成正常写法："同一个字母连续出现3次以上"
// 在真实英语单词里几乎不会出现，压缩成2个基本能还原成本来的词，再拿去查 Datamuse 命中率高很多
function collapseRepeatedLetters(word) {
  return word.replace(/([a-zA-Z])\1{2,}/g, "$1$1");
}

// ② Datamuse 拼写建议 API：能访问时用它给"您是否要搜索"，比让 AI 猜更快更准。
// 同时顺手返回 exactMatch——原样这个词是不是本来就在 Datamuse 的词库里，
// 用来判断"这就是个真词，词典没收录而已"还是"这大概率是打错字/瞎打的"，
// 避免明显打错的输入被送去让 AI 硬编一个不存在的释义
async function fetchSpellingSuggestions(word) {
  try {
    const primaryRes = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&max=5`);
    if (!primaryRes.ok) return { status: "blocked", exactMatch: false, list: [] };
    const primaryData = await primaryRes.json();
    const exactMatch = primaryData.some((item) => item.word.toLowerCase() === word.toLowerCase());

    let extraData = [];
    const normalized = collapseRepeatedLetters(word);
    if (normalized.toLowerCase() !== word.toLowerCase()) {
      try {
        const extraRes = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(normalized)}&max=5`);
        if (extraRes.ok) extraData = await extraRes.json();
      } catch (error) {
        // 忽略，正常查询结果不受影响
      }
    }

    const seen = new Set([word.toLowerCase()]);
    const list = [];
    for (const item of [...extraData, ...primaryData]) {
      const w = item.word.toLowerCase();
      if (seen.has(w)) continue;
      seen.add(w);
      list.push(item.word);
    }
    return { status: "ok", exactMatch, list: list.slice(0, 5) };
  } catch (error) {
    return { status: "blocked", exactMatch: false, list: [] };
  }
}

// ③ Datamuse 近义词 API：免费、不需要 key，跟 AI 是否可用完全无关，所以稳定不会失效
async function fetchSynonyms(word) {
  try {
    const res = await fetch(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(word)}&max=8`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((item) => item.word);
  } catch (error) {
    return [];
  }
}

// 从词典条目里整理出常见释义（每个词性最多取2条，最多8条，保证完整又不过量）
function extractMeaningsFromDict(dictEntry) {
  const meanings = dictEntry.meanings || [];
  const collected = [];
  for (const m of meanings.slice(0, 4)) {
    const defs = (m.definitions || []).slice(0, 2);
    for (const d of defs) {
      collected.push({
        part_of_speech: m.partOfSpeech,
        english_definition: d.definition,
        example: d.example || "",
      });
    }
  }
  return collected.slice(0, 8);
}

// AI 只负责"翻译"这一件事——比从零生成快得多，而且是基于真实词典内容翻译，不会瞎编。
// 拆成两个小请求并发执行：一个给单词整体翻译+词形变化（内容少，回得快），一个给每条释义的
// 详细内容（例句、学习提示，本来就是耗时大头）。两个一起发出去，总耗时约等于较慢的那一个，
// 比塞进一个大请求里串行生成明显快
async function translateMeaningsWithAI(word, meanings) {
  if (meanings.length === 0) return { translation: "", items: [] };

  const listText = meanings
    .map((m, i) => `${i + 1}. [${m.part_of_speech}] ${m.english_definition}${m.example ? ` | 例句: ${m.example}` : ""}`)
    .join("\n");

  const formsPrompt = `给出英语单词 "${word}" 最常用的中文翻译（一两个词），以及它的词形变化。
只输出 JSON，不要多余文字或 markdown：
{
  "translation": "整个单词最常用的中文翻译（一两个词）",
  "other_forms": [ { "label": "这个词形的中文说法，比如 过去式/过去分词/现在分词/第三人称单数/复数/比较级/最高级", "form": "对应的英文词形" } ]（只列出这个词真实适用的词形变化，没有规律变化就返回空数组，不要瞎编）
}`;

  const itemsPrompt = `请把下面来自英语词典的释义翻译成自然、简洁的中文，供中国学生学英语使用。单词："${word}"。
${listText}

只输出 JSON，不要多余文字或 markdown：
{
  "items": [
    {
      "chinese_meaning": "简短中文词义",
      "definition_translation": "该条释义的中文翻译",
      "example": "一个简单、常见、贴近日常生活的英文例句，展示这个词义的用法。如果词典给的原例句已经足够常见简单就可以保留或轻微调整，如果原例句生僻/复杂/没有，就换成更口语化、日常场景的句子，但要保证词性和词义用法准确",
      "example_translation": "对应例句的中文翻译",
      "learning_tip": "生动有趣、朗朗上口的学习小贴士，25字以内。优先用和这个词相关的英语谚语、俗语、习语或经典搭配（比如 apple 可以用「An apple a day keeps the doctor away，一天一苹果，医生远离我」这种），配上对应的中文谚语或有趣的联想；如果实在没有相关谚语/习语，再退而用词根词缀、谐音或场景联想来帮助记忆"
    }
  ]
}
items 数组长度必须与上面编号数量一致，按顺序对应，不要合并或省略。`;

  const [formsText, itemsText] = await Promise.all([callAI(formsPrompt), callAI(itemsPrompt)]);
  const forms = extractJson(formsText);
  const parsedItems = extractJson(itemsText);
  return {
    translation: forms.translation || "",
    other_forms: forms.other_forms || [],
    items: parsedItems.items || [],
  };
}

// 免费、不需要 key 的翻译服务（MyMemory），在 Gemini 打不通时当降级方案用。
// langpair 例如 "en|zh-CN"（英译中）或 "zh-CN|en"（中译英）
async function translateTextFree(text, langpair) {
  if (!text) return "";
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langpair}`
    );
    if (!res.ok) return "";
    const data = await res.json();
    return data?.responseData?.translatedText || "";
  } catch (error) {
    return "";
  }
}

// AI 翻译不通时的降级：改用免费翻译服务逐条翻译。质量不如 AI（没有学习小贴士、词义更生硬），
// 但至少能让查到的词典内容正常显示中文，而不是直接报"找不到"。
// 单词本身的翻译和每条释义/例句的翻译互不依赖，全部一次性并发发出去，不用排队等，能省不少时间
async function translateMeaningsWithFreeFallback(word, meanings) {
  const translationPromise = translateTextFree(word, "en|zh-CN");
  const itemsPromise = Promise.all(
    meanings.map(async (m) => {
      const [definition_translation, example_translation] = await Promise.all([
        translateTextFree(m.english_definition, "en|zh-CN"),
        m.example ? translateTextFree(m.example, "en|zh-CN") : Promise.resolve(""),
      ]);
      return { definition_translation, example_translation };
    })
  );
  const [translation, rawItems] = await Promise.all([translationPromise, itemsPromise]);
  const items = rawItems.map((item) => ({ chinese_meaning: translation, ...item, learning_tip: "" }));
  return { translation, items };
}

// zh->en 场景：先用一个很小的 AI 调用把中文映射成最常用的英文单词，再复用同一套词典+翻译流程；
// AI 不通时降级用免费翻译服务直接把中文译成英文
async function mapChineseToEnglish(chineseWord) {
  try {
    const text = await callAI(
      `给出中文"${chineseWord}"最常用对应的英文单词。只输出 JSON：{"word":"xxx"}，不要多余文字。`,
      200
    );
    const parsed = extractJson(text);
    if (parsed.word) return parsed.word;
  } catch (error) {
    // 落到下面的免费降级方案
  }
  const fallback = await translateTextFree(chineseWord, "zh-CN|en");
  return fallback || null;
}

function buildCardFromDict(englishWord, dictEntry, meanings, translationResult) {
  const phonetic =
    dictEntry.phonetic || (dictEntry.phonetics || []).map((p) => p.text).find(Boolean) || "";
  const items = translationResult.items || [];
  const senses = meanings.map((m, i) => ({
    part_of_speech: m.part_of_speech,
    english_definition: m.english_definition,
    // AI 会尽量把生僻的原例句换成更常见、更贴近日常的句子；免费兜底翻译没这个能力，就还是用词典原句
    example: items[i]?.example || m.example,
    chinese_meaning: items[i]?.chinese_meaning || "",
    definition_translation: items[i]?.definition_translation || "",
    example_translation: items[i]?.example_translation || "",
    learning_tip: items[i]?.learning_tip || "",
  }));
  return {
    id: Date.now(),
    word: englishWord,
    translation: translationResult.translation || senses[0]?.chinese_meaning || "",
    pronunciation: phonetic,
    otherForms: translationResult.other_forms || [],
    senses,
    notes: "",
    createdAt: Date.now(),
  };
}

// 降级方案：词典/拼写建议 API 访问不通时（比如当前沙盒环境），完全交给 AI 一次性生成。
// 拆成两个并发请求：一个专门判断"这是不是真词"+基本信息（内容少，回得快），一个专门生成
// 各条释义的详细内容（内容多，本来就是耗时大头）——两个一起发出去，总耗时不会叠加。
// 是否真词的判断交给第一个请求；第二个请求也顺手要求非真词时返回空数组兜底，双重保险
async function generateCardWithAIOnly(word, direction) {
  const metaPrompt = `你是英语词典编纂专家。用户输入了："${word}"（查询方向：${direction === "en->zh" ? "英文查中文" : "中文查英文"}）。

第一步先判断：这是不是一个真实存在、可识别的英文单词或常见短语？
- 如果是随机敲的字符、明显的乱码、或者根本不是任何语言里的真实词汇/短语，不要编造释义。此时只输出：{"not_found": true}
- 如果只是可能拼错了但看起来接近某个真实单词，同样输出 {"not_found": true}，不要猜测着硬给一个不相关的释义。

只有当它确实是一个真实、可识别的词/短语时，才输出：
{
  "word": "${direction === "zh->en" ? "对应的英文单词" : "原单词"}",
  "translation": "最常用的中文翻译（一两个词）",
  "pronunciation": "音标",
  "other_forms": [ { "label": "这个词形的中文说法，比如 过去式/过去分词/现在分词/第三人称单数/复数/比较级/最高级", "form": "对应的英文词形" } ]（只列出真实适用的词形变化，没有就返回空数组，不要瞎编）
}
只输出 JSON，不要多余文字或 markdown。`;

  const sensesPrompt = `你是英语词典编纂专家。如果 "${word}" 是一个真实存在、可识别的英文单词或常见短语，给出它常见的全部释义，覆盖日常和常见语境下会用到的词性和意思（通常2-5条，不要遗漏常见用法，但不要堆砌生僻义项）。如果它是随机字符/乱码/不是真实词汇，输出空数组。

只输出 JSON，不要多余文字或 markdown：
{
  "senses": [
    { "part_of_speech": "词性", "english_definition": "简短英文释义", "chinese_meaning": "简短中文词义", "definition_translation": "释义的中文翻译", "example": "简单常见、贴近日常生活的英文例句，避免生僻或过于书面的说法", "example_translation": "例句中文翻译", "learning_tip": "生动有趣的学习小贴士，25字以内，优先用相关的英语谚语/习语（配中文翻译），没有的话再用词根或联想记忆" }
  ]
}`;

  const [metaText, sensesText] = await Promise.all([callAI(metaPrompt), callAI(sensesPrompt)]);
  const parsed = extractJson(metaText);
  const sensesParsed = extractJson(sensesText);

  if (parsed.not_found || !sensesParsed.senses || sensesParsed.senses.length === 0) {
    return null;
  }

  return {
    id: Date.now(),
    word: parsed.word || word,
    translation: parsed.translation || "",
    pronunciation: parsed.pronunciation || "",
    otherForms: parsed.other_forms || [],
    senses: sensesParsed.senses || [],
    notes: "",
    createdAt: Date.now(),
  };
}

// 降级方案：拼写建议 API 访问不通时，让 AI 直接给出可能的正确拼写
async function getAISpellingSuggestions(word) {
  try {
    const text = await callAI(
      `"${word}" 看起来可能是拼写错误的英文单词。给出最多3个最可能的正确拼写。只输出 JSON：{"suggestions":["xxx","yyy"]}，如果它本身就是正确的常见词，返回空数组。`,
      200
    );
    const parsed = extractJson(text);
    return parsed.suggestions || [];
  } catch (error) {
    return [];
  }
}

// 学中文模式：面向英语母语学习者。目前没有接入免费的中文词典API，所以直接由AI生成，
// 但明确要求内容面向英语学习者（英文释义、英文学习提示），中文只作为目标语言出现在词/例句中
async function generateChineseCardWithAI(rawInput) {
  const prompt = `You are a Mandarin Chinese teacher for English-speaking learners. The learner typed: "${rawInput}" (this could be English, Pinyin, or Chinese characters).

First, judge: does this clearly correspond to a real, commonly used Chinese word or phrase?
- If the input is random characters, gibberish, or doesn't correspond to any real Chinese word/phrase, do NOT invent one. Instead output: {"not_found": true, "suggestions": ["up to 3 likely intended English words or Pinyin, if any come to mind"]}
- If it looks like a likely typo of something real, prefer returning not_found with suggestions rather than guessing an unrelated word.

Only if it clearly is a real, recognizable word/phrase, identify the most common Chinese word or phrase this refers to and explain it for an English-speaking learner.

Output ONLY JSON, no extra text or markdown:
{
  "word": "the Chinese word/phrase in Hanzi",
  "pinyin": "pinyin with tone marks",
  "gloss": "short 1-3 word English meaning",
  "senses": [
    {
      "part_of_speech": "noun / verb / adjective / etc. (in English)",
      "definition": "a concise English definition of this sense",
      "example": "a simple, common, everyday Chinese example sentence using the word (avoid obscure or overly formal/literary phrasing)",
      "example_gloss": "English translation of that example sentence",
      "learning_tip": "a fun, memorable tip under 25 words — prefer a related Chinese proverb/idiom (chengyu) or cultural fun fact if one fits naturally, otherwise fall back to a character/radical breakdown or mnemonic"
    }
  ]
}
Provide 1-3 of the most common senses only.`;

  const text = await callAI(prompt, 1000);
  const parsed = extractJson(text);

  if (parsed.not_found || !parsed.senses || parsed.senses.length === 0) {
    return { notFound: true, suggestions: parsed.suggestions || [] };
  }

  return {
    id: Date.now(),
    word: parsed.word || rawInput,
    pronunciation: parsed.pinyin || "",
    translation: parsed.gloss || "",
    senses: (parsed.senses || []).map((s) => ({
      part_of_speech: s.part_of_speech || "",
      example: s.example || "",
      example_translation: s.example_gloss || "",
      learning_tip: s.learning_tip || "",
      definition_translation: s.definition || "",
    })),
    notes: "",
    createdAt: Date.now(),
  };
}

// 学中文模式的主查词入口：目前没有可靠的免费拼写建议来源，失败时直接返回notfound（不带建议）
// 用 Datamuse 的词频数据判断一个词是否"够常见"。即使词典里技术上查得到（比如 foo 是编程黑话），
// 如果频率很低，也顺手给出更常见的相近词作为"你是不是想找"的提示，而不是直接当作用户确定要查的词
async function checkWordFrequencyAndAlternatives(word) {
  try {
    const res = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&md=f&max=6`);
    if (!res.ok) return { lowConfidence: false, alternatives: [] };
    const data = await res.json();
    const exact = data.find((item) => item.word.toLowerCase() === word.toLowerCase());
    const freqTag = exact?.tags?.find((t) => t.startsWith("f:"));
    const freq = freqTag ? parseFloat(freqTag.slice(2)) : 0;

    // 频率低于阈值，且单词较短（更容易是缩写/打错），才提示替代词，避免打扰正常查词
    const isLowConfidence = word.length <= 5 && freq < 1;
    if (!isLowConfidence) return { lowConfidence: false, alternatives: [] };

    const alternatives = data
      .filter((item) => item.word.toLowerCase() !== word.toLowerCase())
      .slice(0, 4)
      .map((item) => item.word);

    return { lowConfidence: alternatives.length > 0, alternatives };
  } catch (error) {
    return { lowConfidence: false, alternatives: [] };
  }
}

async function lookupChineseWord(rawWord) {
  const cacheKey = `learn-zh:${normalizeSearchTerm(rawWord)}`;
  if (wordCardCache.has(cacheKey)) {
    return { type: "card", card: wordCardCache.get(cacheKey) };
  }
  try {
    const result = await generateChineseCardWithAI(rawWord);
    if (result.notFound || !result.word || !result.senses || result.senses.length === 0) {
      return { type: "notfound", word: rawWord, suggestions: result.suggestions || [] };
    }
    wordCardCache.set(cacheKey, result);
    return { type: "card", card: result };
  } catch (error) {
    console.error("查词失败:", error);
    return { type: "notfound", word: rawWord, suggestions: [] };
  }
}
async function lookupWord(rawWord) {
  const trimmed = rawWord.trim();
  // 不完全依赖下拉框选的方向：只要输入本身能看出是中文还是英文，就按实际输入灵活判断，
  // 避免"选了中译英，却手滑打了英文"之类的情况查不出结果
  const effectiveDirection = /[\u4e00-\u9fff]/.test(trimmed) ? "zh->en" : "en->zh";
  const cacheKey = `${effectiveDirection}:${normalizeSearchTerm(trimmed)}`;
  if (wordCardCache.has(cacheKey)) {
    return { type: "card", card: wordCardCache.get(cacheKey) };
  }

  let englishWord = trimmed;

  try {
    if (effectiveDirection === "zh->en") {
      const mapped = await mapChineseToEnglish(trimmed);
      if (mapped) englishWord = mapped;
    }

    const dictResult = await fetchFreeDictionary(englishWord);

    if (dictResult.status === "ok") {
      const meanings = extractMeaningsFromDict(dictResult.entry);
      // 顺手看看是不是一个生僻/低频词——这个检查跟翻译互不依赖，提前并发发出去，
      // 不用等翻译做完才开始，省一趟串行的等待
      const freqCheckPromise = checkWordFrequencyAndAlternatives(englishWord);
      let translationResult;
      try {
        translationResult = await translateMeaningsWithAI(englishWord, meanings);
      } catch (error) {
        // AI 打不通时，别把整个查词判成"找不到"——改用免费翻译服务兜底，
        // 让词典内容照样能显示出来
        translationResult = await translateMeaningsWithFreeFallback(englishWord, meanings);
      }
      const card = buildCardFromDict(englishWord, dictResult.entry, meanings, translationResult);
      wordCardCache.set(cacheKey, card);

      const freqCheck = await freqCheckPromise;
      return { type: "card", card, maybeSuggestions: freqCheck.lowConfidence ? freqCheck.alternatives : [] };
    }

    // dictResult.status 是 "notfound"（这份免费词典恰好没收录，不代表它不是真词——
    // 比如 "chinese" 这种常见词，dictionaryapi.dev 里就查不到）或 "blocked"（词典 API 访问不通）：
    // 先用免费、不依赖 AI 的 Datamuse 判断一下这到底是"词典没收录的真词"还是"很可能是打错字/瞎打的"
    // （比如 "goooood"）——明显是拼错的话直接给拼写建议，不要送去让 AI 硬编一个不存在的释义，
    // 这样既避免了 AI 偶尔不遵守指令瞎编内容，也省了一趟没必要的 AI 调用，更快
    const spelling = await fetchSpellingSuggestions(englishWord);
    if (spelling.status === "ok" && !spelling.exactMatch) {
      return { type: "notfound", word: englishWord, suggestions: spelling.list };
    }

    // 词典没收录，但 Datamuse 确认这是个真词（或者 Datamuse 也访问不通，没法判断）：
    // 让 AI 直接生成一份完整卡片兜底，而不是直接判定"找不到"
    let aiCard = null;
    try {
      aiCard = await generateCardWithAIOnly(englishWord, effectiveDirection);
    } catch (error) {
      aiCard = null; // AI 也打不通，落到下面的拼写建议
    }
    if (aiCard) {
      wordCardCache.set(cacheKey, aiCard);
      return { type: "card", card: aiCard };
    }

    // AI 也生成不出来：Datamuse 正常的话就用它的结果，打不通才轮到 AI 给拼写建议
    const suggestions = spelling.status === "ok" ? spelling.list : await getAISpellingSuggestions(englishWord);
    return { type: "notfound", word: englishWord, suggestions };
  } catch (error) {
    console.error("查词失败:", error);
    return { type: "notfound", word: englishWord, suggestions: [] };
  }
}

const bookAccents = [
  { bar: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { bar: "bg-sky-500", chip: "bg-sky-50 text-sky-700 border-sky-200" },
  { bar: "bg-amber-500", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  { bar: "bg-rose-500", chip: "bg-rose-50 text-rose-700 border-rose-200" },
  { bar: "bg-violet-500", chip: "bg-violet-50 text-violet-700 border-violet-200" },
  { bar: "bg-teal-500", chip: "bg-teal-50 text-teal-700 border-teal-200" },
];

function WordAccordionRow({ card, accent, bookId, onRemove, onUpdateNotes, uiLang }) {
  const [open, setOpen] = useState(false);
  const en = uiLang === "en";

  return (
    <div className="border border-[#E3ECE9] rounded-xl overflow-hidden bg-white">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-[#F8FAF9] transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${accent.bar}`} />
          <span className="font-semibold text-sm truncate">{card.word}</span>
          <span className="text-xs text-[#8B9997] truncate">{card.translation}</span>
        </span>
        <span className="text-xs text-[#8B9997] shrink-0">
          {open ? (en ? "Collapse ▲" : "收起 ▲") : en ? "Expand ▼" : "展开 ▼"}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-[#E3ECE9] bg-[#F8FAF9] space-y-3 text-sm">
          <div className="flex items-center justify-between">
            {card.pronunciation && <p className="text-xs text-[#8B9997]">{card.pronunciation}</p>}
            <button onClick={() => speakWord(card.word, card.mode)} className="text-xs text-emerald-700 hover:underline">
              {en ? "🔊 Listen" : "🔊 朗读"}
            </button>
          </div>

          {(card.senses || []).map((s, i) => (
            <div key={i} className="space-y-0.5">
              {s.part_of_speech && <p className="text-xs font-semibold text-[#8B9997]">{s.part_of_speech}</p>}
              {(s.english_definition || s.definition_translation) && (
                <p className="text-[#3E4E4C]">{s.english_definition || s.definition_translation}</p>
              )}
              {s.chinese_meaning && <p className="text-[#3E4E4C]">{s.chinese_meaning}</p>}
              {s.example && <p className="text-[#5B6B69]">{highlightWord(s.example, card.word)}</p>}
              {s.example_translation && <p className="text-xs text-[#8B9997]">{s.example_translation}</p>}
              {s.learning_tip && <p className="text-xs text-emerald-700">💡 {s.learning_tip}</p>}
            </div>
          ))}

          <div>
            <p className="text-xs font-semibold text-[#5B6B69] mb-1">
              {en ? "✏️ My notes" : "✏️ 我的笔记（想记什么都可以）"}
            </p>
            <textarea
              value={card.notes || ""}
              onChange={(e) => onUpdateNotes(card.id, e.target.value)}
              placeholder={
                en
                  ? "e.g. words easy to confuse, an example from class, your own memory trick…"
                  : "比如：容易和 xxx 搞混、老师上课举的例子、自己编的联想……"
              }
              className="w-full text-xs rounded-lg border border-[#D9E4E1] px-2.5 py-2 outline-none focus:ring-2 focus:ring-emerald-300 min-h-[56px]"
            />
          </div>

          <button
            onClick={() => onRemove(bookId, card.id)}
            className="text-xs text-[#8B9997] hover:text-red-500"
          >
            {en ? "Remove from notebook" : "从本子中移除"}
          </button>
        </div>
      )}
    </div>
  );
}

function FlashcardOverlay({ book, cards, onClose, uiLang, onReview, onRate }) {
  const en = uiLang === "en";
  const words = useMemo(
    () => book.words.map((id) => cards.find((c) => c.id === id)).filter(Boolean),
    [book, cards]
  );
  const [order, setOrder] = useState(() => words.map((w) => w.id));
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    setOrder(words.map((w) => w.id));
    setIndex(0);
    setFlipped(false);
  }, [book.id]);

  const orderedWords = order.map((id) => words.find((w) => w.id === id)).filter(Boolean);
  const current = orderedWords[index];

  const goTo = (nextIndex) => {
    if (nextIndex < 0 || nextIndex >= orderedWords.length) return;
    setIndex(nextIndex);
    setFlipped(false);
  };

  const shuffle = () => {
    const shuffled = [...order];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    setOrder(shuffled);
    setIndex(0);
    setFlipped(false);
  };

  // 借鉴 Anki：翻开答案之后不是简单点"下一个"，而是自己评一下记不记得，
  // 决定这张卡下次该多久之后再出现
  const rate = (rating) => {
    onRate?.(current.id, rating);
    goTo(index + 1);
  };

  if (words.length === 0) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center space-y-3">
          <p className="text-sm text-[#5B6B69]">
            {en ? "This notebook has no words yet — add a few before studying." : "这个单词本还没有单词，先加几个词再来闪卡吧。"}
          </p>
          <button onClick={onClose} className="text-sm font-semibold bg-emerald-600 text-white rounded-lg px-4 py-2">
            {en ? "Close" : "关闭"}
          </button>
        </div>
      </div>
    );
  }

  const firstSense = current?.senses?.[0];
  const progress = ((index + 1) / orderedWords.length) * 100;

  return (
    <div className="fixed inset-0 bg-[#0F1917]/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-3xl p-6 max-w-lg w-full shadow-2xl animate-fade-in-up">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h3 className="font-bold">{book.name} · {en ? "Flashcards" : "闪卡"}</h3>
            <p className="text-xs text-[#8B9997]">{index + 1} / {orderedWords.length}</p>
          </div>
          <button onClick={onClose} className="text-[#8B9997] hover:text-red-500 text-lg leading-none">×</button>
        </div>

        <div className="h-1.5 w-full bg-[#E3ECE9] rounded-full mb-4 overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div
          className="[perspective:1400px] cursor-pointer select-none"
          onClick={() =>
            setFlipped((f) => {
              if (!f) onReview?.(); // 翻到答案那一面才算"看了一遍"，跟统计口径对上
              return !f;
            })
          }
        >
          <div
            className="relative min-h-[240px] rounded-2xl transition-transform duration-500 [transform-style:preserve-3d]"
            style={{
              transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
              transitionTimingFunction: "cubic-bezier(0.45, 0.05, 0.15, 1)",
            }}
          >
            {/* 正面 */}
            <div className="absolute inset-0 [backface-visibility:hidden] rounded-2xl border-2 border-dashed border-emerald-200 bg-[#F8FAF9] flex flex-col items-center justify-center text-center px-6 py-8">
              <p className="text-3xl font-bold">{current.word}</p>
              {current.pronunciation && <p className="text-sm text-[#8B9997] mt-2">{current.pronunciation}</p>}
              <p className="text-xs text-[#8B9997] mt-6">{en ? "Tap the card to reveal the answer" : "点击卡片查看答案"}</p>
            </div>

            {/* 背面 */}
            <div
              className="absolute inset-0 [backface-visibility:hidden] rounded-2xl border-2 border-emerald-300 bg-emerald-50 flex flex-col items-center justify-center text-center px-6 py-8 overflow-y-auto"
              style={{ transform: "rotateY(180deg)" }}
            >
              <div className="space-y-2">
                <p className="text-xl font-semibold text-emerald-700">{current.translation}</p>
                {firstSense?.example && (
                  <p className="text-sm text-[#3E4E4C]">{highlightWord(firstSense.example, current.word)}</p>
                )}
                {firstSense?.example_translation && (
                  <p className="text-xs text-[#8B9997]">{firstSense.example_translation}</p>
                )}
                {firstSense?.learning_tip && (
                  <p className="text-xs text-emerald-700 pt-1">💡 {firstSense.learning_tip}</p>
                )}
                {current.notes && (
                  <p className="text-xs text-[#5B6B69] pt-1 border-t border-[#E3ECE9] mt-2">✏️ {current.notes}</p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between mt-4 gap-2 flex-wrap">
          <button
            onClick={shuffle}
            className="text-xs font-semibold text-[#5B6B69] hover:text-emerald-700 border border-[#D9E4E1] rounded-lg px-3 py-1.5 hover:bg-emerald-50 transition-colors shrink-0"
          >
            {en ? "🔀 Shuffle" : "🔀 打乱顺序"}
          </button>

          {flipped ? (
            <div className="flex gap-1.5 flex-wrap justify-end">
              <button
                onClick={() => rate("again")}
                className="text-xs font-semibold bg-red-50 text-red-700 border border-red-200 rounded-lg px-2.5 py-1.5 hover:bg-red-100 transition-colors"
              >
                {en ? "Again" : "没记住"}
              </button>
              <button
                onClick={() => rate("hard")}
                className="text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 rounded-lg px-2.5 py-1.5 hover:bg-amber-100 transition-colors"
              >
                {en ? "Hard" : "有点难"}
              </button>
              <button
                onClick={() => rate("good")}
                className="text-xs font-semibold bg-emerald-600 text-white rounded-lg px-2.5 py-1.5 hover:bg-emerald-700 transition-colors"
              >
                {en ? "Good" : "记得"}
              </button>
              <button
                onClick={() => rate("easy")}
                className="text-xs font-semibold bg-sky-50 text-sky-700 border border-sky-200 rounded-lg px-2.5 py-1.5 hover:bg-sky-100 transition-colors"
              >
                {en ? "Easy" : "很简单"}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => goTo(index - 1)}
                disabled={index === 0}
                className="text-xs font-semibold border border-[#D9E4E1] rounded-lg px-3 py-1.5 disabled:opacity-40 hover:bg-[#F3F6F5] transition-colors"
              >
                {en ? "← Prev" : "← 上一个"}
              </button>
              <button
                onClick={() => goTo(index + 1)}
                disabled={index === orderedWords.length - 1}
                className="text-xs font-semibold bg-emerald-600 text-white rounded-lg px-3 py-1.5 disabled:opacity-40 hover:bg-emerald-700 transition-colors"
              >
                {en ? "Next →" : "下一个 →"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LibraryView({
  books,
  cards,
  onOpenBook,
  showCreateBook,
  bookNameDraft,
  onBookNameDraftChange,
  onConfirmCreateBook,
  onCancelCreateBook,
  onOpenCreateBook,
  renamingBookId,
  renameDraft,
  onRenameDraftChange,
  onStartRename,
  onConfirmRename,
  onCancelRename,
  confirmDeleteBookId,
  onRequestDelete,
  onCancelDelete,
  onPerformDelete,
  onStudy,
  uiLang,
}) {
  const en = uiLang === "en";
  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 bg-gradient-to-br from-white to-emerald-50/60 rounded-2xl p-6 shadow-sm border border-[#E3ECE9]">
        <div>
          <h2 className="text-xl font-bold">{en ? "My Notebooks" : "我的单词本库"}</h2>
          <p className="text-sm text-[#8B9997] mt-1">
            {books.length === 0
              ? en
                ? "No notebooks yet"
                : "还没有任何单词本"
              : en
              ? `${books.length} notebook${books.length === 1 ? "" : "s"} · ${cards.length} word${cards.length === 1 ? "" : "s"}`
              : `共 ${books.length} 个单词本 · ${cards.length} 个词条`}
          </p>
        </div>
        <button
          onClick={onOpenCreateBook}
          className="text-sm font-semibold bg-emerald-600 text-white rounded-xl px-5 py-2.5 hover:bg-emerald-700 transition-colors shadow-sm hover:shadow-md"
        >
          {en ? "+ New notebook" : "+ 新建单词本"}
        </button>
      </div>

      {showCreateBook && (
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
          <input
            autoFocus
            value={bookNameDraft}
            onChange={(e) => onBookNameDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConfirmCreateBook();
              if (e.key === "Escape") onCancelCreateBook();
            }}
            placeholder={en ? "Name your notebook, e.g. “Everyday words”" : "给新单词本起个名字，比如「日常词汇」"}
            className="flex-1 text-sm rounded-lg border border-emerald-300 px-3 py-2 outline-none focus:ring-2 focus:ring-emerald-300"
          />
          <button
            onClick={onConfirmCreateBook}
            className="text-xs font-semibold bg-emerald-600 text-white rounded-lg px-4 py-2 hover:bg-emerald-700"
          >
            {en ? "Create" : "创建"}
          </button>
          <button onClick={onCancelCreateBook} className="text-xs text-[#8B9997] hover:text-red-500 px-2">
            {en ? "Cancel" : "取消"}
          </button>
        </div>
      )}

      {books.length === 0 ? (
        <div className="bg-white rounded-2xl p-12 shadow-sm border border-dashed border-[#D9E4E1] text-center">
          <div className="text-4xl mb-3">📚</div>
          <p className="text-[#5B6B69] text-sm max-w-sm mx-auto">
            {en
              ? 'No notebooks yet. Click "New notebook" above, or add a word from the Search page and it’ll create your first one.'
              : '单词本是空的。点击上方"新建单词本"，或者在查词页点"加入单词本"会自动帮你创建第一个。'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {books.map((book, index) => {
            const accent = bookAccents[index % bookAccents.length];
            const isRenaming = renamingBookId === book.id;
            const isConfirmingDelete = confirmDeleteBookId === book.id;
            const dueCount = book.words
              .map((id) => cards.find((c) => c.id === id))
              .filter(Boolean)
              .filter(isDueForReview).length;

            return (
              <div
                key={book.id}
                className="bg-white rounded-2xl shadow-sm hover:shadow-md transition-shadow border border-[#E3ECE9] overflow-hidden flex flex-col"
              >
                <div className={`h-1.5 ${accent.bar}`} />
                <div className="p-5 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    {isRenaming ? (
                      <div className="flex-1 flex items-center gap-1">
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => onRenameDraftChange(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") onConfirmRename();
                            if (e.key === "Escape") onCancelRename();
                          }}
                          className="flex-1 text-sm font-bold rounded-lg border border-emerald-300 px-2 py-1 outline-none focus:ring-2 focus:ring-emerald-300"
                        />
                        <button onClick={onConfirmRename} className="text-emerald-700 text-sm px-1">✓</button>
                        <button onClick={onCancelRename} className="text-[#8B9997] text-sm px-1">×</button>
                      </div>
                    ) : (
                      <div>
                        <h3 className="font-bold text-lg leading-tight">{book.name}</h3>
                        <p className="text-xs text-[#8B9997] mt-0.5 flex items-center gap-1.5 flex-wrap">
                          <span>{en ? `${book.words.length} word${book.words.length === 1 ? "" : "s"}` : `${book.words.length} 个单词`}</span>
                          {dueCount > 0 && (
                            <span className="text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5 text-[10px] font-semibold">
                              {en ? `${dueCount} due` : `${dueCount} 个待复习`}
                            </span>
                          )}
                        </p>
                      </div>
                    )}

                    {!isRenaming && (
                      <div className="flex gap-1 shrink-0">
                        {isConfirmingDelete ? (
                          <>
                            <button
                              onClick={() => onPerformDelete(book.id)}
                              title={en ? "Confirm delete" : "确认删除"}
                              className="text-xs font-semibold text-red-600 hover:text-red-700 px-1.5 py-0.5"
                            >
                              {en ? "Confirm delete" : "确认删除"}
                            </button>
                            <button
                              onClick={onCancelDelete}
                              title={en ? "Cancel" : "取消"}
                              className="text-xs text-[#8B9997] hover:text-emerald-700 px-1.5 py-0.5"
                            >
                              {en ? "Cancel" : "取消"}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => onStartRename(book.id, book.name)}
                              title={en ? "Rename" : "重命名"}
                              className="text-xs text-[#8B9997] hover:text-emerald-700 px-1.5 py-0.5"
                            >
                              ✎
                            </button>
                            <button
                              onClick={() => onRequestDelete(book.id)}
                              title={en ? "Delete notebook" : "删除单词本"}
                              className="text-xs text-[#8B9997] hover:text-red-500 px-1.5 py-0.5"
                            >
                              🗑
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {!isRenaming && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => onOpenBook(book.id)}
                        className="text-sm font-semibold bg-[#1B2B2A] text-white rounded-lg px-4 py-2.5 hover:bg-[#0f1918]"
                      >
                        {en ? "Open →" : "打开单词本 →"}
                      </button>
                      {book.words.length > 0 && (
                        <button
                          onClick={() => onStudy(book.id)}
                          className="text-sm font-semibold bg-white border border-[#D9E4E1] text-[#3E4E4C] rounded-lg px-4 py-2.5 hover:bg-[#F3F6F5]"
                        >
                          {en ? "🎴 Flashcards" : "🎴 闪卡"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function BookDetailView({
  book,
  cards,
  onBack,
  isRenaming,
  renameDraft,
  onRenameDraftChange,
  onStartRename,
  onConfirmRename,
  onCancelRename,
  isConfirmingDelete,
  onRequestDelete,
  onCancelDelete,
  onPerformDelete,
  onRemoveWord,
  onUpdateNotes,
  addQuery,
  onAddQueryChange,
  onAddWord,
  addLoading,
  addNotFound,
  addSuggestions,
  uiLang,
  onStudy,
}) {
  const [filterQuery, setFilterQuery] = useState("");
  const en = uiLang === "en";
  const words = book.words.map((id) => cards.find((c) => c.id === id)).filter(Boolean);
  const filteredWords = filterQuery.trim()
    ? words.filter(
        (c) =>
          c.word.toLowerCase().includes(filterQuery.trim().toLowerCase()) ||
          (c.translation || "").toLowerCase().includes(filterQuery.trim().toLowerCase())
      )
    : words;

  return (
    <section className="fixed inset-0 z-40 bg-[#F3F6F5] overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 md:p-8 space-y-4">
        <button onClick={onBack} className="text-sm font-semibold text-[#5B6B69] hover:text-emerald-700">
          {en ? "← Back to notebooks" : "← 返回单词本库"}
        </button>

        <div className="bg-white rounded-2xl p-5 shadow-sm border border-[#E3ECE9]">
          <div className="flex items-start justify-between gap-2">
            {isRenaming ? (
              <div className="flex-1 flex items-center gap-1">
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => onRenameDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onConfirmRename();
                    if (e.key === "Escape") onCancelRename();
                  }}
                  className="flex-1 text-lg font-bold rounded-lg border border-emerald-300 px-2 py-1 outline-none focus:ring-2 focus:ring-emerald-300"
                />
                <button onClick={onConfirmRename} className="text-emerald-700 px-1">✓</button>
                <button onClick={onCancelRename} className="text-[#8B9997] px-1">×</button>
              </div>
            ) : (
              <div>
                <h2 className="text-xl font-bold">{book.name}</h2>
                <p className="text-xs text-[#8B9997] mt-0.5">
                  {en ? `${words.length} word${words.length === 1 ? "" : "s"}` : `${words.length} 个单词`}
                </p>
              </div>
            )}

            {!isRenaming && (
              <div className="flex gap-1 shrink-0 items-center">
                {words.length > 0 && (
                  <button
                    onClick={() => onStudy(book.id)}
                    className="text-xs font-semibold bg-[#1B2B2A] text-white rounded-lg px-3 py-1.5 hover:bg-[#0f1918] mr-1"
                  >
                    {en ? "🎴 Flashcards" : "🎴 闪卡"}
                  </button>
                )}
                {isConfirmingDelete ? (
                  <>
                    <button onClick={onPerformDelete} className="text-xs font-semibold text-red-600 px-1.5 py-0.5">
                      {en ? "Confirm delete" : "确认删除"}
                    </button>
                    <button onClick={onCancelDelete} className="text-xs text-[#8B9997] px-1.5 py-0.5">
                      {en ? "Cancel" : "取消"}
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={onStartRename} title={en ? "Rename" : "重命名"} className="text-xs text-[#8B9997] hover:text-emerald-700 px-1.5 py-0.5">
                      ✎
                    </button>
                    <button onClick={onRequestDelete} title={en ? "Delete notebook" : "删除单词本"} className="text-xs text-[#8B9997] hover:text-red-500 px-1.5 py-0.5">
                      🗑
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#E3ECE9] space-y-2">
          <p className="text-xs font-semibold text-[#5B6B69]">
            {en ? "Add a new word to this notebook" : "直接给这个本子加新词"}
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={addQuery}
              onChange={(e) => onAddQueryChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onAddWord()}
              placeholder={en ? "Type a word, press Enter to add" : "输入单词，回车直接加入本子"}
              className="flex-1 text-sm rounded-lg border border-[#D9E4E1] px-3 py-2 outline-none focus:ring-2 focus:ring-emerald-300"
            />
            <button
              onClick={onAddWord}
              disabled={addLoading}
              className="text-sm font-semibold bg-emerald-600 disabled:bg-emerald-300 text-white rounded-lg px-4 py-2 hover:bg-emerald-700"
            >
              {addLoading ? "…" : en ? "Search & add" : "查询并加入"}
            </button>
          </div>
          {addNotFound && (
            <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
              {en ? `No results for "${addNotFound}"` : `没有找到 "${addNotFound}"`}
              {addSuggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {addSuggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => onAddWord(s)}
                      className="text-xs font-semibold bg-white border border-amber-300 text-amber-800 rounded-full px-2.5 py-1 hover:bg-amber-100"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#E3ECE9] space-y-3">
          <input
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder={en ? "Search words in this notebook" : "在这个本子已有的词里搜索"}
            className="w-full text-sm rounded-lg border border-[#D9E4E1] px-3 py-2 outline-none focus:ring-2 focus:ring-emerald-300"
          />

          {filteredWords.length === 0 ? (
            <p className="text-xs text-[#8B9997] py-4 text-center">
              {words.length === 0
                ? en
                  ? "This notebook is empty — add a word above"
                  : "这个本子还是空的，上面加个词试试"
                : en
                ? "No matching words"
                : "没有匹配的词"}
            </p>
          ) : (
            <div className="space-y-2">
              {filteredWords.map((card) => (
                <WordAccordionRow
                  key={card.id}
                  card={card}
                  accent={bookAccents[0]}
                  bookId={book.id}
                  onRemove={onRemoveWord}
                  onUpdateNotes={onUpdateNotes}
                  uiLang={uiLang}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// 宣传首页：只在第一次进入时自动出现，之后可以从导航栏"首页"按钮再回来看。
// 主打卖点是"查完单词直接存进单词本"，不用再切换 App 单独记录。
function LandingPage({ uiLang, onEnter, stats, statsLoading }) {
  const en = uiLang === "en";
  const hasStats =
    !statsLoading &&
    stats &&
    (stats.totalUsers > 0 ||
      stats.totalSearches > 0 ||
      stats.totalWords > 0 ||
      stats.totalBooks > 0 ||
      stats.totalReviews > 0);

  const features = [
    {
      icon: "🔍",
      title: en ? "Search & save in one step" : "查词即整理",
      desc: en
        ? "Every word you look up can be saved straight into a notebook — no more switching apps just to write it down."
        : "查到的每个词，一键就能存进单词本——不用再切来切去，另外找地方抄写。",
    },
    {
      icon: "📚",
      title: en ? "Multiple notebooks" : "多个单词本分类",
      desc: en
        ? "Organize by course, unit, or topic. Even dozens of notebooks stay easy to navigate."
        : "按课程、单元、话题自由分类，就算建了几十个单词本，也能一眼找到想要的那本。",
    },
    {
      icon: "🎴",
      title: en ? "Flashcards that feel real" : "闪卡复习，像翻真卡片",
      desc: en
        ? "Tap to flip and reveal the answer — the animation feels just like flipping a real card. Perfect for a quick review while waiting for the bus."
        : "轻轻一点就翻面看答案，翻面动画做得跟真卡片一样自然；等车、课间的几分钟，也能把单词本过一遍。",
    },
  ];

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#EAF6F0] via-[#F3F6F5] to-[#F3F6F5] flex items-center justify-center p-4 md:p-8">
      <div className="max-w-3xl w-full space-y-10 text-center py-10">
        <div>
          <p className="text-xs tracking-widest text-emerald-600 font-semibold uppercase">Translate Psychic</p>
          <h1 className="text-3xl md:text-5xl font-bold mt-3 leading-tight">
            {en ? "Search a word, save it instantly." : "查完单词，一键存进单词本"}
          </h1>
          <p className="text-base md:text-lg text-[#5B6B69] mt-4 max-w-xl mx-auto">
            {en
              ? "No more switching between a dictionary and a notes app just to keep track of what you've looked up."
              : "不用再一边查词典一边打开备忘录抄写——查完单词直接加进单词本，告别“查完就忘记整理”的麻烦。"}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
          {features.map((f) => (
            <div key={f.title} className="bg-white rounded-2xl p-5 shadow-sm border border-[#E3ECE9]">
              <div className="text-2xl mb-2">{f.icon}</div>
              <h3 className="font-bold">{f.title}</h3>
              <p className="text-sm text-[#5B6B69] mt-1">{f.desc}</p>
            </div>
          ))}
        </div>

        {hasStats && (
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
            {stats.totalUsers > 0 && (
              <div>
                <p className="text-2xl font-bold text-emerald-700">{stats.totalUsers}</p>
                <p className="text-xs text-[#8B9997]">{en ? "students using it" : "位同学在用"}</p>
              </div>
            )}
            {stats.totalSearches > 0 && (
              <div>
                <p className="text-2xl font-bold text-emerald-700">{stats.totalSearches}</p>
                <p className="text-xs text-[#8B9997]">{en ? "searches so far" : "次累计查词"}</p>
              </div>
            )}
            {stats.totalWords > 0 && (
              <div>
                <p className="text-2xl font-bold text-emerald-700">{stats.totalWords}</p>
                <p className="text-xs text-[#8B9997]">{en ? "words saved" : "个单词被收藏"}</p>
              </div>
            )}
            {stats.totalBooks > 0 && (
              <div>
                <p className="text-2xl font-bold text-emerald-700">{stats.totalBooks}</p>
                <p className="text-xs text-[#8B9997]">{en ? "notebooks created" : "个单词本被创建"}</p>
              </div>
            )}
            {stats.totalReviews > 0 && (
              <div>
                <p className="text-2xl font-bold text-emerald-700">{stats.totalReviews}</p>
                <p className="text-xs text-[#8B9997]">{en ? "flashcard reviews" : "次闪卡复习"}</p>
              </div>
            )}
          </div>
        )}

        <button
          onClick={onEnter}
          className="text-base font-semibold bg-emerald-600 text-white rounded-xl px-8 py-3 hover:bg-emerald-700 transition-colors shadow-sm hover:shadow-md"
        >
          {en ? "Get started →" : "开始使用 →"}
        </button>
      </div>
    </div>
  );
}

// ================= 登录账号的云端数据同步 =================
// 没登录时：单词本和单词卡完全是本地 localStorage，跟以前一样。
// 登录后：改成以 Supabase 数据库里的数据为准，本地状态只是一份缓存/离线兜底。
// 卡片/单词本的 id 沿用前端一直在用的方案（Date.now() 数字 / book-时间戳 字符串），
// 这样"整表删掉重新写入"是安全、幂等的操作，不会导致 id 漂移、单词本里的引用失效。

function cardToDbRow(card, userId) {
  return {
    id: card.id,
    user_id: userId,
    word: card.word,
    translation: card.translation || "",
    pronunciation: card.pronunciation || "",
    mode: card.mode,
    senses: card.senses || [],
    other_forms: card.otherForms || [],
    notes: card.notes || "",
    srs: card.srs || null,
  };
}

function cardFromDbRow(row) {
  return {
    id: row.id,
    word: row.word,
    translation: row.translation || "",
    pronunciation: row.pronunciation || "",
    mode: row.mode,
    senses: row.senses || [],
    otherForms: row.other_forms || [],
    notes: row.notes || "",
    srs: row.srs || null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

function bookToDbRow(book, userId) {
  return { id: book.id, user_id: userId, name: book.name, word_ids: book.words || [] };
}

function bookFromDbRow(row) {
  return { id: row.id, name: row.name, words: row.word_ids || [] };
}

// 同步失败（比如表还没建好、网络问题）不应该影响本地正常使用，所以这里全部吞掉错误，
// 本地 state + localStorage 永远是可用的兜底
async function syncCardsToSupabase(userId, cards) {
  try {
    await supabase.from("word_cards").delete().eq("user_id", userId);
    if (cards.length > 0) {
      await supabase.from("word_cards").insert(cards.map((c) => cardToDbRow(c, userId)));
    }
  } catch (error) {
    // 忽略，本地数据不受影响
  }
}

async function syncBooksToSupabase(userId, books) {
  try {
    await supabase.from("word_books").delete().eq("user_id", userId);
    if (books.length > 0) {
      await supabase.from("word_books").insert(books.map((b) => bookToDbRow(b, userId)));
    }
  } catch (error) {
    // 忽略，本地数据不受影响
  }
}

// ================= 连续学习天数 =================
// 逻辑很像 Duolingo 的 streak：今天已经算过就不重复加，昨天学过今天接着学就 +1，
// 中间断了一天以上就从 1 重新开始。以本地时区的日期为准，不是严格 24 小时。
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function computeStreakUpdate(prev, today) {
  if (!prev?.lastDate) return { current: 1, longest: 1, lastDate: today };
  if (prev.lastDate === today) return prev;

  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;

  if (prev.lastDate === yesterday) {
    const current = prev.current + 1;
    return { current, longest: Math.max(prev.longest, current), lastDate: today };
  }
  return { current: 1, longest: Math.max(prev.longest, 1), lastDate: today };
}

// 登录/换设备时，本地和云端的连续天数可能不一致，取"最近学习日期更新的那份"作为基准
function mergeStreaks(a, b) {
  if (!a?.lastDate) return b || { current: 0, longest: 0, lastDate: "" };
  if (!b?.lastDate) return a;
  if (a.lastDate === b.lastDate) {
    return { current: Math.max(a.current, b.current), longest: Math.max(a.longest, b.longest), lastDate: a.lastDate };
  }
  return a.lastDate > b.lastDate ? a : b;
}

async function syncStreakToSupabase(userId, streak) {
  try {
    await supabase.from("study_streaks").upsert({
      user_id: userId,
      current_streak: streak.current,
      longest_streak: streak.longest,
      last_study_date: streak.lastDate || null,
    });
  } catch (error) {
    // 忽略，本地数据不受影响
  }
}

// ================= 间隔重复（借鉴 Anki 的简化版 SM-2） =================
// 每张卡片自己记一份 srs 状态：interval（下次复习间隔，单位天）、ease（简单度，越高间隔涨得越快）、
// reps（连续答对次数）、due（下次该复习的时间戳）。新卡片没有 srs，视为"从没学过，现在就该学"。
// 评分对应 Anki 经典的四个按钮：
//   again：完全不会——重置进度，明天再见
//   hard： 有点吃力——间隔涨得比较慢
//   good： 记得——按 ease 正常增长间隔
//   easy： 很简单——间隔涨得更快，顺便把 ease 提高
function nextSrsState(prevSrs, rating) {
  const s = prevSrs || { interval: 0, ease: 2.5, reps: 0 };
  let { interval, ease, reps } = s;

  if (rating === "again") {
    reps = 0;
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    const wasNew = reps === 0;
    reps += 1;
    if (rating === "hard") {
      interval = wasNew ? 1 : Math.max(1, Math.round(interval * 1.2));
      ease = Math.max(1.3, ease - 0.15);
    } else if (rating === "easy") {
      interval = wasNew ? 4 : Math.max(1, Math.round(interval * ease * 1.3));
      ease = ease + 0.15;
    } else {
      // good
      interval = wasNew ? 1 : Math.max(1, Math.round(interval * ease));
    }
  }

  return { interval, ease, reps, due: Date.now() + interval * 86400000 };
}

// 新卡片（没复习过）也算"待复习"——毕竟还没学过
function isDueForReview(card) {
  return !card.srs || card.srs.due <= Date.now();
}

export default function WordLearningApp() {
  const [sessionUser, setSessionUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");

  // 只有第一次进入才自动显示宣传首页；之后可以通过导航栏"首页"按钮随时再回去看
  const [showLanding, setShowLanding] = useState(() => !localStorage.getItem("has-visited-landing"));
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("search"); // "search": 查词页 | "library": 单词本库独立页面
  const [uiLang, setUiLang] = useState(() => localStorage.getItem("ui-lang") || "zh"); // 主界面文案语言，和"学习模式"（学习内容语言）是两回事
  const [learningMode, setLearningMode] = useState("learn-en"); // "learn-en": 母语中文学英语 | "learn-zh": 母语英文学中文
  const [direction, setDirection] = useState("en->zh");
  const [query, setQuery] = useState("");
  const [recentSearches, setRecentSearches] = useState([]);
  const [selectedWord, setSelectedWord] = useState(null);
  const [selectedSenseIndex, setSelectedSenseIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [spellSuggestions, setSpellSuggestions] = useState([]);
  const [maybeSuggestions, setMaybeSuggestions] = useState([]);
  const [notFoundWord, setNotFoundWord] = useState("");

  const [cards, setCards] = useState(() => {
    const stored = localStorage.getItem("word-cards");
    return stored ? JSON.parse(stored) : [];
  });
  const [books, setBooks] = useState(() => {
    const stored = localStorage.getItem("word-books");
    return stored ? JSON.parse(stored) : [];
  });
  const [settings, setSettings] = useState(() => {
    const stored = localStorage.getItem("word-settings");
    // 跟默认值合并一下，这样以后新加的显示偏好，老用户本地存的旧设置也不会漏掉
    return stored ? { ...defaultSettings, ...JSON.parse(stored) } : defaultSettings;
  });
  const [targetBookId, setTargetBookId] = useState("");
  const [synonyms, setSynonyms] = useState([]);
  const [streak, setStreak] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("study-streak")) || { current: 0, longest: 0, lastDate: "" };
    } catch (error) {
      return { current: 0, longest: 0, lastDate: "" };
    }
  });

  useEffect(() => setSelectedSenseIndex(0), [selectedWord?.word]);

  // 近义词来自 Datamuse（免费、不需要 key），只对学英语模式下的单词有意义
  useEffect(() => {
    if (!selectedWord || selectedWord.mode === "learn-zh") {
      setSynonyms([]);
      return;
    }
    let cancelled = false;
    fetchSynonyms(selectedWord.word).then((list) => {
      if (!cancelled) setSynonyms(list);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedWord?.word, selectedWord?.mode]);

  // 登录时把 cards/books 同步写到 Supabase，做了防抖——不然打字改笔记这种连续操作会疯狂触发写库
  const cardsSyncTimer = useRef(null);
  const booksSyncTimer = useRef(null);

  useEffect(() => {
    localStorage.setItem("word-cards", JSON.stringify(cards));
    if (!sessionUser) return;
    clearTimeout(cardsSyncTimer.current);
    cardsSyncTimer.current = setTimeout(() => syncCardsToSupabase(sessionUser.id, cards), 1200);
  }, [cards, sessionUser]);

  useEffect(() => {
    localStorage.setItem("word-books", JSON.stringify(books));
    if (!sessionUser) return;
    clearTimeout(booksSyncTimer.current);
    booksSyncTimer.current = setTimeout(() => syncBooksToSupabase(sessionUser.id, books), 1200);
  }, [books, sessionUser]);

  const streakSyncTimer = useRef(null);

  useEffect(() => {
    localStorage.setItem("study-streak", JSON.stringify(streak));
    if (!sessionUser) return;
    clearTimeout(streakSyncTimer.current);
    streakSyncTimer.current = setTimeout(() => syncStreakToSupabase(sessionUser.id, streak), 1200);
  }, [streak, sessionUser]);

  // 登录后：账号里已经有数据就用账号的（换设备也能看到一样的单词本）；
  // 账号是空的但本地已经攒了一些内容，就把本地内容"认领"到账号上，不会凭空丢失
  useEffect(() => {
    if (!sessionUser) return;
    let cancelled = false;
    (async () => {
      const [cardsRes, booksRes, streakRes] = await Promise.all([
        supabase.from("word_cards").select("*").eq("user_id", sessionUser.id),
        supabase.from("word_books").select("*").eq("user_id", sessionUser.id),
        supabase.from("study_streaks").select("*").eq("user_id", sessionUser.id).maybeSingle(),
      ]);
      if (cancelled) return;
      const remoteCards = cardsRes.data || [];
      const remoteBooks = booksRes.data || [];

      if (remoteCards.length === 0 && remoteBooks.length === 0) {
        if (cards.length > 0) syncCardsToSupabase(sessionUser.id, cards);
        if (books.length > 0) syncBooksToSupabase(sessionUser.id, books);
      } else {
        setCards(remoteCards.map(cardFromDbRow));
        setBooks(remoteBooks.map(bookFromDbRow));
      }

      const remoteStreak = streakRes.data
        ? {
            current: streakRes.data.current_streak || 0,
            longest: streakRes.data.longest_streak || 0,
            lastDate: streakRes.data.last_study_date || "",
          }
        : null;
      setStreak((localStreak) => mergeStreaks(localStreak, remoteStreak));
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionUser?.id]);

  useEffect(() => {
    localStorage.setItem("word-settings", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem("ui-lang", uiLang);
  }, [uiLang]);

  // 宣传首页上的使用数据，只有首页真正显示的时候才去请求，不用每次打开 App 都调用
  useEffect(() => {
    if (!showLanding) return;
    let cancelled = false;
    setStatsLoading(true);
    fetch("/api/stats")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showLanding]);

  // 真正的账号系统：登录状态由 Supabase 维护（浏览器里存的是一个安全令牌，不是密码）。
  // 打开网页时先问 Supabase "现在是谁登录着"，之后只要登录状态变化（登录/登出/token刷新）就同步更新。
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSessionUser(session?.user ?? null);
      setAuthLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionUser(session?.user ?? null);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  // 埋点：往 Supabase 的 app_events 表插入一条记录，用来在宣传首页展示"有多少人在用"这类数据。
  // 纯粹是统计用的，失败了也不影响正常使用，所以不 await、不抛错
  const logEvent = (eventType) => {
    supabase
      .from("app_events")
      .insert({ event_type: eventType, user_id: sessionUser?.id || null })
      .then(
        () => {},
        () => {}
      );
  };

  // 有实际学习行为（查词、复习闪卡）才算"今天学习过"，只是打开页面不算
  const recordStudyDay = () => setStreak((prev) => computeStreakUpdate(prev, todayStr()));

  const handleAuth = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      setAuthMessage(uiLang === "en" ? "Email and password are required" : "邮箱和密码都不能为空");
      return;
    }
    setAuthMessage("");

    if (authMode === "register") {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setAuthMessage(error.message);
        return;
      }
      logEvent("signup");
      setAuthMessage(
        uiLang === "en"
          ? "Sign-up successful! If email verification is on, check your inbox before logging in."
          : "注册成功！如果开启了邮箱验证，请去邮箱点确认链接后再登录。"
      );
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setAuthMessage(error.message);
    } else {
      setAuthMessage(uiLang === "en" ? "Signed in successfully" : "登录成功");
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  // 统一的"查词 + 写入 cards"逻辑：如果这个词（在当前学习模式下）已经存在，
  // 复用原来的 id 和笔记，只更新内容——这样单词本里存的 id 引用永远不会失效。
  // （之前的 bug：每次搜索都生成新 id，同名词会把旧条目整个替换掉，导致单词本里的引用找不到对应单词，看起来像"加不进去"）
  const searchAndUpsertCard = async (word) => {
    const result = learningMode === "learn-zh" ? await lookupChineseWord(word) : await lookupWord(word);
    if (result.type !== "card") {
      return { ok: false, word: result.word || word, suggestions: result.suggestions || [] };
    }
    logEvent("search");
    recordStudyDay();
    const rawCard = { ...result.card, mode: learningMode };
    let finalCard = rawCard;
    setCards((cur) => {
      const idx = cur.findIndex(
        (c) => c.mode === learningMode && c.word.toLowerCase() === rawCard.word.toLowerCase()
      );
      if (idx !== -1) {
        finalCard = { ...rawCard, id: cur[idx].id, notes: cur[idx].notes || rawCard.notes || "" };
        const next = [...cur];
        next[idx] = finalCard;
        return next;
      }
      finalCard = rawCard;
      return [rawCard, ...cur];
    });
    return { ok: true, card: finalCard, maybeSuggestions: result.maybeSuggestions || [] };
  };

  const handleSearch = async (overrideWord) => {
    const word = (overrideWord ?? query).trim();
    if (!word) return;
    setIsLoading(true);
    setSpellSuggestions([]);
    setMaybeSuggestions([]);

    const result = await searchAndUpsertCard(word);

    if (result.ok) {
      setSelectedWord(result.card);
      setSelectedSenseIndex(0);
      setQuery(result.card.word);
      setNotFoundWord("");
      setMaybeSuggestions(result.maybeSuggestions || []);
      setRecentSearches((cur) => {
        const norm = normalizeSearchTerm(result.card.word);
        const filtered = cur.filter((item) => normalizeSearchTerm(item) !== norm);
        return [result.card.word, ...filtered].slice(0, 5);
      });
    } else {
      setNotFoundWord(result.word);
      setSpellSuggestions(result.suggestions);
    }

    setIsLoading(false);
  };

  // 单词本详情页里"直接查词加入"用的状态和逻辑
  const [bookAddQuery, setBookAddQuery] = useState("");
  const [bookAddLoading, setBookAddLoading] = useState(false);
  const [bookAddNotFound, setBookAddNotFound] = useState("");
  const [bookAddSuggestions, setBookAddSuggestions] = useState([]);

  const handleAddWordToOpenBook = async (bookId, overrideWord) => {
    const word = (overrideWord ?? bookAddQuery).trim();
    if (!word) return;
    setBookAddLoading(true);
    setBookAddSuggestions([]);
    const result = await searchAndUpsertCard(word);
    if (result.ok) {
      addToBook(bookId, result.card.id);
      setBookAddQuery("");
      setBookAddNotFound("");
    } else {
      setBookAddNotFound(result.word);
      setBookAddSuggestions(result.suggestions);
    }
    setBookAddLoading(false);
  };

  // 新建单词本：用页面内的输入框代替 window.prompt（沙盒环境里浏览器弹窗经常被屏蔽，导致之前"新建"一直失败）
  const [showCreateBook, setShowCreateBook] = useState(false);
  const [openBookId, setOpenBookId] = useState(null);
  const [studyBookId, setStudyBookId] = useState(null);
  const [bookNameDraft, setBookNameDraft] = useState("");
  const [pendingCardId, setPendingCardId] = useState(null);

  const openCreateBook = (cardId = null) => {
    setPendingCardId(cardId);
    setBookNameDraft("");
    setShowCreateBook(true);
  };

  const cancelCreateBook = () => {
    setShowCreateBook(false);
    setPendingCardId(null);
    setBookNameDraft("");
  };

  const confirmCreateBook = () => {
    const name = bookNameDraft.trim();
    if (!name) return;
    const newBook = { id: `book-${Date.now()}`, name, words: pendingCardId ? [pendingCardId] : [] };
    setBooks((cur) => [...cur, newBook]);
    logEvent("book_created");
    setTargetBookId(newBook.id);
    cancelCreateBook();
  };

  const addToBook = (bookId, cardId) => {
    setBooks((cur) => {
      const book = cur.find((b) => b.id === bookId);
      if (book && !book.words.includes(cardId)) logEvent("word_saved");
      return cur.map((b) =>
        b.id === bookId ? { ...b, words: b.words.includes(cardId) ? b.words : [...b.words, cardId] } : b
      );
    });
  };

  const addWordToBook = (cardId) => {
    if (books.length === 0) {
      openCreateBook(cardId);
      return;
    }
    const bookId = targetBookId || books[0].id;
    addToBook(bookId, cardId);
  };

  // 重命名：点击铅笔图标后标题变成输入框，而不是弹窗
  const [renamingBookId, setRenamingBookId] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");

  const startRenameBook = (bookId, currentName) => {
    setRenamingBookId(bookId);
    setRenameDraft(currentName);
  };

  const confirmRenameBook = () => {
    const name = renameDraft.trim();
    if (!name) return;
    setBooks((cur) => cur.map((b) => (b.id === renamingBookId ? { ...b, name } : b)));
    setRenamingBookId(null);
  };

  const cancelRenameBook = () => setRenamingBookId(null);

  // 删除：先点一次进入"确定删除？"状态，再点一次才真正删除，而不是弹窗确认
  const [confirmDeleteBookId, setConfirmDeleteBookId] = useState(null);

  const requestDeleteBook = (bookId) => setConfirmDeleteBookId(bookId);
  const cancelDeleteBook = () => setConfirmDeleteBookId(null);

  const performDeleteBook = (bookId) => {
    setBooks((cur) => cur.filter((b) => b.id !== bookId));
    if (targetBookId === bookId) setTargetBookId("");
    if (openBookId === bookId) setOpenBookId(null);
    setConfirmDeleteBookId(null);
  };

  const removeWordFromBook = (bookId, cardId) => {
    setBooks((cur) =>
      cur.map((b) => (b.id === bookId ? { ...b, words: b.words.filter((id) => id !== cardId) } : b))
    );
  };

  const updateCardNotes = (cardId, notes) => {
    setCards((cur) => cur.map((c) => (c.id === cardId ? { ...c, notes } : c)));
    setSelectedWord((cur) => (cur && cur.id === cardId ? { ...cur, notes } : cur));
  };

  // 闪卡评分：借鉴 Anki 的间隔重复，根据"记不记得"调整这张卡下次该什么时候再复习
  const rateCard = (cardId, rating) => {
    setCards((cur) => cur.map((c) => (c.id === cardId ? { ...c, srs: nextSrsState(c.srs, rating) } : c)));
  };

  const handleSettingChange = (key) => setSettings((cur) => ({ ...cur, [key]: !cur[key] }));

  const sense = selectedWord?.senses?.[selectedSenseIndex];

  const enterApp = () => {
    localStorage.setItem("has-visited-landing", "1");
    setShowLanding(false);
  };

  if (showLanding) {
    return <LandingPage uiLang={uiLang} onEnter={enterApp} stats={stats} statsLoading={statsLoading} />;
  }

  return (
    <div
      className="min-h-screen w-full bg-gradient-to-b from-[#EAF6F0] via-[#F3F6F5] to-[#F3F6F5] text-[#1B2B2A] p-4 md:p-8"
      style={{ fontFamily: "'Segoe UI', system-ui, sans-serif" }}
    >
      <div className="max-w-6xl mx-auto space-y-6">

        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-br from-white to-emerald-50/60 rounded-2xl p-6 shadow-sm border border-[#E3ECE9]">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs tracking-widest text-emerald-600 font-semibold uppercase">Translate Psychic</p>
              {streak.current > 0 && (
                <span className="text-xs font-semibold bg-amber-100 text-amber-700 rounded-full px-2.5 py-0.5">
                  🔥 {uiLang === "en" ? `${streak.current}-day streak` : `连续学习 ${streak.current} 天`}
                </span>
              )}
            </div>
            <h1 className="text-2xl md:text-3xl font-bold mt-1">
              {uiLang === "en"
                ? learningMode === "learn-zh"
                  ? "Learn Chinese"
                  : "Vocab Buddy"
                : learningMode === "learn-zh"
                ? "学中文"
                : "背单词助手"}
            </h1>
            <p className="text-sm text-[#5B6B69] mt-2 max-w-md">
              {uiLang === "en"
                ? learningMode === "learn-zh"
                  ? "Type a word in English, Pinyin, or Chinese to see its meaning, pronunciation, and example sentences."
                  : "Type a word to see its translation, examples, and tips, and organize it into notebooks."
                : learningMode === "learn-zh"
                ? "输入英文、拼音或中文即可查看含义、拼音与例句。"
                : "输入单词即可查看翻译、例句与学习提示，并整理进多个独立单词本。"}
            </p>
          </div>
          <div className="w-full md:w-72">
            {authLoading ? (
              <div className="bg-[#F3F6F5] rounded-xl p-4 text-sm text-[#8B9997]">
                {uiLang === "en" ? "Checking sign-in status…" : "正在检查登录状态…"}
              </div>
            ) : sessionUser ? (
              <div className="bg-[#F3F6F5] rounded-xl p-4 text-sm">
                <strong className="block">{sessionUser.email}</strong>
                <p className="text-[#5B6B69] mt-1">{uiLang === "en" ? "Signed in" : "已登录"}</p>
                <button
                  onClick={handleLogout}
                  className="mt-3 text-xs font-medium text-emerald-700 hover:underline"
                >
                  {uiLang === "en" ? "Sign out" : "退出登录"}
                </button>
              </div>
            ) : (
              <form onSubmit={handleAuth} className="bg-[#F3F6F5] rounded-xl p-4 space-y-2">
                <h2 className="text-sm font-semibold">
                  {authMode === "login" ? (uiLang === "en" ? "Log in" : "登录") : uiLang === "en" ? "Sign up" : "注册"}
                </h2>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={uiLang === "en" ? "Email" : "邮箱"}
                  className="w-full text-sm rounded-lg border border-[#D9E4E1] px-3 py-1.5 outline-none focus:ring-2 focus:ring-emerald-300"
                />
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  placeholder={uiLang === "en" ? "Password" : "密码"}
                  className="w-full text-sm rounded-lg border border-[#D9E4E1] px-3 py-1.5 outline-none focus:ring-2 focus:ring-emerald-300"
                />
                <div className="flex items-center justify-between pt-1">
                  <button type="submit" className="text-xs font-semibold bg-emerald-600 text-white rounded-lg px-3 py-1.5 hover:bg-emerald-700">
                    {authMode === "login" ? (uiLang === "en" ? "Log in" : "登录") : uiLang === "en" ? "Sign up" : "注册"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}
                    className="text-xs text-[#5B6B69] hover:underline"
                  >
                    {uiLang === "en"
                      ? authMode === "login"
                        ? "Switch to sign up"
                        : "Switch to log in"
                      : `切换为${authMode === "login" ? "注册" : "登录"}`}
                  </button>
                </div>
                {authMessage && <p className="text-xs text-emerald-700">{authMessage}</p>}
              </form>
            )}
          </div>
        </header>

        {/* 导航条：首页 + 页面切换 + 学习模式 + 界面语言 */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-white rounded-2xl p-3 shadow-sm border border-[#E3ECE9]">
          <button
            onClick={() => setShowLanding(true)}
            className="self-start text-xs font-semibold rounded-full px-3 py-1.5 text-[#5B6B69] hover:bg-emerald-50 hover:text-emerald-700 transition-colors border border-[#D9E4E1] shrink-0"
          >
            {uiLang === "en" ? "🏠 Home" : "🏠 首页"}
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-[#8B9997] pl-1">{uiLang === "en" ? "Page" : "页面"}</span>
            <div className="flex gap-1 bg-[#F3F6F5] rounded-full p-1">
              <button
                onClick={() => {
                  setActiveTab("search");
                  setOpenBookId(null);
                }}
                className={`text-xs font-semibold rounded-full px-3 py-1.5 transition-colors ${
                  activeTab === "search" && !openBookId
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-[#5B6B69] hover:bg-emerald-50"
                }`}
              >
                {uiLang === "en" ? "🔍 Search" : "🔍 查词"}
              </button>
              <button
                onClick={() => setActiveTab("library")}
                className={`text-xs font-semibold rounded-full px-3 py-1.5 transition-colors ${
                  activeTab === "library" || openBookId
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-[#5B6B69] hover:bg-emerald-50"
                }`}
              >
                {uiLang === "en" ? "📚 Library" : "📚 单词本"}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-[#8B9997] pl-1">{uiLang === "en" ? "Mode" : "学习模式"}</span>
            <div className="flex gap-1 bg-[#F3F6F5] rounded-full p-1">
              <button
                onClick={() => setLearningMode("learn-en")}
                className={`text-xs font-semibold rounded-full px-3 py-1.5 transition-colors ${
                  learningMode === "learn-en" ? "bg-emerald-600 text-white shadow-sm" : "text-[#5B6B69] hover:bg-emerald-50"
                }`}
              >
                {uiLang === "en" ? "Learn English (from Chinese)" : "学英语 · 中文母语"}
              </button>
              <button
                onClick={() => setLearningMode("learn-zh")}
                className={`text-xs font-semibold rounded-full px-3 py-1.5 transition-colors ${
                  learningMode === "learn-zh" ? "bg-emerald-600 text-white shadow-sm" : "text-[#5B6B69] hover:bg-emerald-50"
                }`}
              >
                {uiLang === "en" ? "Learn Chinese (from English)" : "学中文 · 英文母语"}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:ml-auto flex-wrap">
            <span className="text-xs font-semibold text-[#8B9997] pl-1">{uiLang === "en" ? "Language" : "界面语言"}</span>
            <div className="flex gap-1 bg-[#F3F6F5] rounded-full p-1">
              <button
                onClick={() => setUiLang("zh")}
                className={`text-xs font-semibold rounded-full px-3 py-1.5 transition-colors ${
                  uiLang === "zh" ? "bg-emerald-600 text-white shadow-sm" : "text-[#5B6B69] hover:bg-emerald-50"
                }`}
              >
                中文
              </button>
              <button
                onClick={() => setUiLang("en")}
                className={`text-xs font-semibold rounded-full px-3 py-1.5 transition-colors ${
                  uiLang === "en" ? "bg-emerald-600 text-white shadow-sm" : "text-[#5B6B69] hover:bg-emerald-50"
                }`}
              >
                EN
              </button>
            </div>
          </div>
        </div>

        <main className="space-y-6">
          {openBookId && books.find((b) => b.id === openBookId) ? (
            <BookDetailView
                book={books.find((b) => b.id === openBookId)}
                cards={cards}
                onBack={() => setOpenBookId(null)}
                isRenaming={renamingBookId === openBookId}
                renameDraft={renameDraft}
                onRenameDraftChange={setRenameDraft}
                onStartRename={() => startRenameBook(openBookId, books.find((b) => b.id === openBookId).name)}
                onConfirmRename={confirmRenameBook}
                onCancelRename={cancelRenameBook}
                isConfirmingDelete={confirmDeleteBookId === openBookId}
                onRequestDelete={() => requestDeleteBook(openBookId)}
                onCancelDelete={cancelDeleteBook}
                onPerformDelete={() => performDeleteBook(openBookId)}
                onRemoveWord={removeWordFromBook}
                onUpdateNotes={updateCardNotes}
                addQuery={bookAddQuery}
                onAddQueryChange={setBookAddQuery}
                onAddWord={(overrideWord) => handleAddWordToOpenBook(openBookId, overrideWord)}
                addLoading={bookAddLoading}
                addNotFound={bookAddNotFound}
                addSuggestions={bookAddSuggestions}
                uiLang={uiLang}
                onStudy={setStudyBookId}
              />
          ) : (
            <>
              {activeTab === "search" && (
              <section id="search-section" className="max-w-2xl mx-auto bg-white rounded-2xl p-6 shadow-sm border border-[#E3ECE9] space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-lg">{uiLang === "en" ? "Search" : "查词"}</h2>
                <button
                  onClick={() => handleSearch()}
                  disabled={isLoading}
                  className="text-sm font-semibold bg-emerald-600 disabled:bg-emerald-300 text-white rounded-lg px-4 py-2 hover:bg-emerald-700 transition-colors"
                >
                  {isLoading
                    ? uiLang === "en"
                      ? "Searching…"
                      : "生成中…"
                    : uiLang === "en"
                    ? "Search"
                    : "查词并生成"}
                </button>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder={
                    learningMode === "learn-zh"
                      ? uiLang === "en"
                        ? "Type English, Pinyin, or 中文"
                        : "输入英文、拼音或中文"
                      : uiLang === "en"
                      ? "Type a word, e.g. apple"
                      : "输入单词，例如 apple"
                  }
                  className="flex-1 text-sm rounded-lg border border-[#D9E4E1] px-3 py-2 outline-none focus:ring-2 focus:ring-emerald-300"
                />
                {learningMode === "learn-en" && (
                  <select
                    value={direction}
                    onChange={(e) => setDirection(e.target.value)}
                    className="text-sm rounded-lg border border-[#D9E4E1] px-2 py-2"
                  >
                    <option value="en->zh">English → 中文</option>
                    <option value="zh->en">中文 → English</option>
                  </select>
                )}
              </div>

              <div>
                <h3 className="text-xs font-semibold text-[#5B6B69] mb-2">
                  {uiLang === "en" ? "Recent searches" : "最近搜索"}
                </h3>
                {recentSearches.length === 0 ? (
                  <p className="text-xs text-[#8B9997]">
                    {uiLang === "en" ? "No recent searches yet." : "最近没有搜索记录。"}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {recentSearches.map((item) => (
                      <div
                        key={item}
                        className="flex items-center gap-1 bg-[#F3F6F5] hover:bg-emerald-50 border border-[#E3ECE9] rounded-full pl-3 pr-1.5 py-1"
                      >
                        <button
                          onClick={() => {
                            setQuery(item);
                            handleSearch(item);
                          }}
                          className="text-xs"
                        >
                          {item}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setRecentSearches((cur) => cur.filter((i) => i !== item));
                          }}
                          aria-label={uiLang === "en" ? `Remove ${item}` : `删除 ${item}`}
                          title={uiLang === "en" ? "Remove" : "删除"}
                          className="text-[#8B9997] hover:text-red-500 text-xs leading-none px-0.5"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {spellSuggestions.length > 0 && (
                <div className="text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3">
                  {uiLang === "en" ? `No results for "${notFoundWord}" — did you mean:` : `没有找到 "${notFoundWord}"，您是否要搜索：`}
                  <div className="flex flex-wrap gap-2 mt-2">
                    {spellSuggestions.map((s) => (
                      <button
                        key={s}
                        onClick={() => {
                          setQuery(s);
                          handleSearch(s);
                        }}
                        className="text-xs font-semibold bg-white border border-amber-300 text-amber-800 rounded-full px-3 py-1 hover:bg-amber-100"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {spellSuggestions.length === 0 && notFoundWord && (
                <div className="text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3">
                  {uiLang === "en"
                    ? `No results for "${notFoundWord}"${
                        learningMode === "learn-en" ? ", and no similar spellings either. Try another word?" : ". Try another word?"
                      }`
                    : `没有找到 "${notFoundWord}"${learningMode === "learn-en" ? "，也没有类似的拼写建议，换个词试试？" : "，换个词试试？"}`}
                </div>
              )}

              {maybeSuggestions.length > 0 && selectedWord && (
                <div className="text-sm bg-sky-50 border border-sky-200 text-sky-800 rounded-xl px-4 py-3">
                  {uiLang === "en"
                    ? `"${selectedWord.word}" isn't very common — did you mean:`
                    : `"${selectedWord.word}" 不算常见，你是不是想找：`}
                  <div className="flex flex-wrap gap-2 mt-2">
                    {maybeSuggestions.map((s) => (
                      <button
                        key={s}
                        onClick={() => {
                          setQuery(s);
                          handleSearch(s);
                        }}
                        className="text-xs font-semibold bg-white border border-sky-300 text-sky-800 rounded-full px-3 py-1 hover:bg-sky-100"
                      >
                        {s}
                      </button>
                    ))}
                    <button
                      onClick={() => setMaybeSuggestions([])}
                      className="text-xs font-semibold text-sky-700 underline px-1"
                    >
                      {uiLang === "en" ? `No, I meant "${selectedWord.word}"` : `不，就是要查 "${selectedWord.word}"`}
                    </button>
                  </div>
                </div>
              )}

              {selectedWord && (
                <div className="bg-[#F8FAF9] rounded-xl p-4 border border-[#E3ECE9]">
                  <>
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="text-xl font-bold flex items-center gap-2">
                          {selectedWord.word}
                          <button
                            onClick={() => speakWord(selectedWord.word, selectedWord.mode)}
                            title={uiLang === "en" ? "Listen" : "朗读"}
                            className="text-base hover:scale-110 transition-transform"
                          >
                            🔊
                          </button>
                        </h3>
                        {settings.showPronunciation && (
                          <p className="text-sm text-[#5B6B69]">{selectedWord.pronunciation}</p>
                        )}
                      </div>
                      {settings.showTranslation && (
                        <span className="text-xs font-semibold bg-emerald-100 text-emerald-700 rounded-full px-3 py-1">
                          {selectedWord.translation}
                        </span>
                      )}
                    </div>

                    {settings.showForms && selectedWord.otherForms?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {selectedWord.otherForms.map((f, i) => (
                          <span
                            key={i}
                            className="text-xs bg-[#F3F6F5] text-[#5B6B69] rounded-full px-3 py-1 border border-[#E3ECE9]"
                          >
                            {f.label} <span className="font-semibold text-[#3E4E4C]">{f.form}</span>
                          </span>
                        ))}
                      </div>
                    )}

                    {selectedWord.senses?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {selectedWord.senses.map((s, i) => (
                          <button
                            key={i}
                            onClick={() => setSelectedSenseIndex(i)}
                            className={`text-xs rounded-full px-3 py-1 border ${
                              i === selectedSenseIndex
                                ? "bg-emerald-600 text-white border-emerald-600"
                                : "bg-white text-[#5B6B69] border-[#D9E4E1]"
                            }`}
                          >
                            {s.part_of_speech || (uiLang === "en" ? "Sense" : "释义")} {i + 1}
                          </button>
                        ))}
                      </div>
                    )}

                    {sense ? (
                      <div className="mt-3 space-y-1.5 text-sm">
                        {selectedWord.mode === "learn-zh" ? (
                          <>
                            <p><span className="text-[#8B9997]">Part of speech: </span>{sense.part_of_speech || "—"}</p>
                            <p><span className="text-[#8B9997]">Definition: </span>{sense.definition_translation}</p>
                            {settings.showExample && sense.example && (
                              <>
                                <p><span className="text-[#8B9997]">Example: </span>{highlightWord(sense.example, selectedWord.word)}</p>
                                {sense.example_translation && (
                                  <p><span className="text-[#8B9997]">Translation: </span>{sense.example_translation}</p>
                                )}
                              </>
                            )}
                            {settings.showTip && sense.learning_tip && (
                              <p className="pt-1 text-emerald-700">💡 {sense.learning_tip}</p>
                            )}
                          </>
                        ) : (
                          <>
                            <p><span className="text-[#8B9997]">词性：</span>{sense.part_of_speech || "——"}</p>
                            <p><span className="text-[#8B9997]">Definition：</span>{sense.english_definition}</p>
                            <p><span className="text-[#8B9997]">中文释义：</span>{sense.chinese_meaning}</p>
                            {settings.showExample && sense.example && (
                              <>
                                <p><span className="text-[#8B9997]">Example：</span>{highlightWord(sense.example, selectedWord.word)}</p>
                                {sense.example_translation && (
                                  <p><span className="text-[#8B9997]">例句翻译：</span>{sense.example_translation}</p>
                                )}
                              </>
                            )}
                            {settings.showTip && sense.learning_tip && (
                              <p className="pt-1 text-emerald-700">💡 {sense.learning_tip}</p>
                            )}
                          </>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-[#8B9997] mt-3">
                        {uiLang === "en" ? "No definition available." : "该词暂无可用释义。"}
                      </p>
                    )}

                    {settings.showSynonyms && synonyms.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-[#E3ECE9]">
                        <p className="text-xs font-semibold text-[#5B6B69] mb-1.5">
                          {uiLang === "en" ? "Synonyms" : "近义词"}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {synonyms.map((s) => (
                            <button
                              key={s}
                              onClick={() => {
                                setQuery(s);
                                handleSearch(s);
                              }}
                              className="text-xs font-semibold bg-white border border-[#D9E4E1] text-[#5B6B69] rounded-full px-3 py-1 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300 transition-colors"
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-3">
                      <p className="text-xs font-semibold text-[#5B6B69] mb-1">
                        ✏️ {uiLang === "en" ? "My notes" : "我的笔记（想记什么都可以）"}
                      </p>
                      <textarea
                        value={selectedWord.notes || ""}
                        onChange={(e) => updateCardNotes(selectedWord.id, e.target.value)}
                        placeholder={
                          uiLang === "en"
                            ? "Write anything you want to remember…"
                            : "比如：容易搞混的词、老师举的例子、自己编的联想……"
                        }
                        className="w-full text-sm rounded-lg border border-[#D9E4E1] px-3 py-2 outline-none focus:ring-2 focus:ring-emerald-300 min-h-[56px]"
                      />
                    </div>

                    <div className="flex items-center gap-2 mt-4 pt-3 border-t border-[#E3ECE9]">
                      {books.length > 0 && (
                        <select
                          value={targetBookId || books[0].id}
                          onChange={(e) => setTargetBookId(e.target.value)}
                          className="text-xs rounded-lg border border-[#D9E4E1] px-2 py-1.5"
                        >
                          {books.map((b) => (
                            <option key={b.id} value={b.id}>{b.name}</option>
                          ))}
                        </select>
                      )}
                      <button
                        onClick={() => addWordToBook(selectedWord.id)}
                        className="text-xs font-semibold bg-emerald-600 text-white rounded-lg px-3 py-1.5 hover:bg-emerald-700"
                      >
                        {uiLang === "en"
                          ? books.length === 0
                            ? "New notebook & add"
                            : "Add to notebook"
                          : books.length === 0
                          ? "新建单词本并加入"
                          : "加入单词本"}
                      </button>
                      {books.length > 0 && (
                        <button onClick={() => openCreateBook()} className="text-xs text-emerald-700 hover:underline">
                          {uiLang === "en" ? "+ New" : "+ 新建"}
                        </button>
                      )}
                    </div>

                    {showCreateBook && (
                      <div className="flex items-center gap-2 mt-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                        <input
                          autoFocus
                          value={bookNameDraft}
                          onChange={(e) => setBookNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") confirmCreateBook();
                            if (e.key === "Escape") cancelCreateBook();
                          }}
                          placeholder={uiLang === "en" ? "Name your notebook" : "给新单词本起个名字"}
                          className="flex-1 text-sm rounded-lg border border-emerald-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-emerald-300"
                        />
                        <button
                          onClick={confirmCreateBook}
                          className="text-xs font-semibold bg-emerald-600 text-white rounded-lg px-3 py-1.5 hover:bg-emerald-700"
                        >
                          {uiLang === "en" ? "Create" : "创建"}
                        </button>
                        <button onClick={cancelCreateBook} className="text-xs text-[#8B9997] hover:text-red-500 px-2">
                          {uiLang === "en" ? "Cancel" : "取消"}
                        </button>
                      </div>
                    )}
                  </>
                </div>
              )}

              <div>
                <h3 className="text-xs font-semibold text-[#5B6B69] mb-2">
                  {uiLang === "en" ? "Display options" : "显示偏好"}
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(defaultSettings).map(([key]) => (
                    <label key={key} className="flex items-center gap-2 text-sm text-[#3E4E4C]">
                      <input
                        type="checkbox"
                        checked={Boolean(settings[key])}
                        onChange={() => handleSettingChange(key)}
                        className="accent-emerald-600"
                      />
                      {uiLang === "en" ? settingLabelsEn[key] : settingLabels[key]}
                    </label>
                  ))}
                </div>
              </div>
              </section>
              )}

              {activeTab === "library" && (
              <section id="library-section" className="max-w-5xl mx-auto">
                <LibraryView
                  books={books}
                  cards={cards}
                  onOpenBook={(id) => {
                    setOpenBookId(id);
                    setBookAddQuery("");
                    setBookAddNotFound("");
                    setBookAddSuggestions([]);
                  }}
                  showCreateBook={showCreateBook}
                  bookNameDraft={bookNameDraft}
                  onBookNameDraftChange={setBookNameDraft}
                  onConfirmCreateBook={confirmCreateBook}
                  onCancelCreateBook={cancelCreateBook}
                  onOpenCreateBook={() => openCreateBook()}
                  renamingBookId={renamingBookId}
                  renameDraft={renameDraft}
                  onRenameDraftChange={setRenameDraft}
                  onStartRename={startRenameBook}
                  onConfirmRename={confirmRenameBook}
                  onCancelRename={cancelRenameBook}
                  confirmDeleteBookId={confirmDeleteBookId}
                  onRequestDelete={requestDeleteBook}
                  onCancelDelete={cancelDeleteBook}
                  onPerformDelete={performDeleteBook}
                  onStudy={setStudyBookId}
                  uiLang={uiLang}
                />
              </section>
              )}
            </>
          )}
        </main>

        {studyBookId && books.find((b) => b.id === studyBookId) && (
          <FlashcardOverlay
            book={books.find((b) => b.id === studyBookId)}
            cards={cards}
            onClose={() => setStudyBookId(null)}
            uiLang={uiLang}
            onReview={() => {
              logEvent("flashcard_reviewed");
              recordStudyDay();
            }}
            onRate={rateCard}
          />
        )}

      </div>
    </div>
  );
}
