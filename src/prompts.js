// 預設提示詞模板，三種語言各一份。使用者可以在「設定 › 進階」修改，
// 每個模板都能恢復成預設。{{...}} 是插件自己會替換的變數。

import { currentLocale } from './i18n.js';
import { getSettings, saveSettings } from './settings.js';

export const TEMPLATE_KEYS = ['l1', 'l2', 'l3', 'recap'];

export const TEMPLATE_VARS = {
    l1: ['{{char}}', '{{user}}', '{{length}}', '{{content}}', '{{notes}}'],
    l2: ['{{summaries}}', '{{length}}'],
    l3: ['{{chapters}}', '{{length}}'],
    recap: ['{{recap}}', '{{length}}'],
};

const L1_JSON_SPEC = `{
  "summary": "…",
  "ops": [
    { "op": "add", "type": "character|item|promise|todo", "data": { … } },
    { "op": "update", "id": "…", "data": { … } },
    { "op": "complete", "id": "…", "result": "done|kept|broken|used|lost|gone" }
  ]
}`;

const DEFAULTS = {
    'zh-TW': {
        l1: `你是故事記錄員，負責替 {{char}} 和 {{user}} 的故事寫摘要。

請用第三人稱、繁體中文，把下面這一段對話寫成約 {{length}} 字的摘要。只記發生了什麼、重要的決定和情緒轉折，不要評論，不要加入原文沒有的內容。

接著對照目前的記事清單，找出這段對話裡新出現、有變化、或已經結束的人物、物件、約定、待辦：
- 人物不會被移除，只更新狀態（例如離開、死亡）。
- 約定被打破時用 "broken"，不要當成完成。
- 沒有變化就讓 ops 是空陣列。

目前的記事清單：
{{notes}}

這一段對話：
{{content}}

只輸出下面格式的 JSON，不要輸出其他文字：
${L1_JSON_SPEC}`,
        l2: `把下面幾段摘要合併成一份約 {{length}} 字的章節總結。用第三人稱、繁體中文。
保留人物關係的變化、約定和伏筆，刪去重複的細節，依時間順序寫。

{{summaries}}

只輸出總結本身，不要加標題或說明。`,
        l3: `把下面幾份章節總結合併成一份約 {{length}} 字的卷總結。用第三人稱、繁體中文。
只保留主線和關係的重大轉折。

{{chapters}}

只輸出總結本身，不要加標題或說明。`,
        recap: `把下面這段前情提要濃縮成約 {{length}} 字。用第三人稱、繁體中文，保留兩人的關係和最重要的事件。

{{recap}}

只輸出濃縮後的內容。`,
    },
    'zh-CN': {
        l1: `你是故事记录员，负责替 {{char}} 和 {{user}} 的故事写摘要。

请用第三人称、简体中文，把下面这一段对话写成约 {{length}} 字的摘要。只记发生了什么、重要的决定和情绪转折，不要评论，不要加入原文没有的内容。

接着对照当前的记事清单，找出这段对话里新出现、有变化、或已经结束的人物、物件、约定、待办：
- 人物不会被移除，只更新状态（例如离开、死亡）。
- 约定被打破时用 "broken"，不要当成完成。
- 没有变化就让 ops 是空数组。

当前的记事清单：
{{notes}}

这一段对话：
{{content}}

只输出下面格式的 JSON，不要输出其他文字：
${L1_JSON_SPEC}`,
        l2: `把下面几段摘要合并成一份约 {{length}} 字的章节总结。用第三人称、简体中文。
保留人物关系的变化、约定和伏笔，删去重复的细节，按时间顺序写。

{{summaries}}

只输出总结本身，不要加标题或说明。`,
        l3: `把下面几份章节总结合并成一份约 {{length}} 字的卷总结。用第三人称、简体中文。
只保留主线和关系的重大转折。

{{chapters}}

只输出总结本身，不要加标题或说明。`,
        recap: `把下面这段前情提要浓缩成约 {{length}} 字。用第三人称、简体中文，保留两人的关系和最重要的事件。

{{recap}}

只输出浓缩后的内容。`,
    },
    en: {
        l1: `You are the story's record keeper for {{char}} and {{user}}.

Summarize the exchange below in English, in the third person, in about {{length}} words. Record only what happened, key decisions and emotional turns. Don't comment and don't add anything that isn't in the text.

Then compare it with the current notes and find characters, items, promises and to-dos that are new, changed or finished:
- Characters are never removed; only update their status (e.g. left, died).
- A broken promise uses "broken"; don't treat it as done.
- If nothing changed, leave ops as an empty array.

Current notes:
{{notes}}

The exchange:
{{content}}

Output only JSON in this format, with no other text:
${L1_JSON_SPEC}`,
        l2: `Merge the summaries below into one chapter summary of about {{length}} words, in English, in the third person.
Keep changes in relationships, promises and foreshadowing; drop repeated details; keep the order of events.

{{summaries}}

Output only the summary, with no title or explanation.`,
        l3: `Merge the chapter summaries below into one volume summary of about {{length}} words, in English, in the third person.
Keep only the main plot and major turns in the relationship.

{{chapters}}

Output only the summary, with no title or explanation.`,
        recap: `Condense the recap below to about {{length}} words, in English, in the third person. Keep the relationship and the most important events.

{{recap}}

Output only the condensed text.`,
    },
};

export function defaultTemplate(key, locale = currentLocale()) {
    return (DEFAULTS[locale] ?? DEFAULTS.en)[key];
}

/** 目前生效的模板：使用者改過的優先，否則用目前語言的預設。 */
export function getTemplate(key) {
    const custom = getSettings().prompts[key];
    return typeof custom === 'string' ? custom : defaultTemplate(key);
}

export function isTemplateModified(key) {
    return typeof getSettings().prompts[key] === 'string';
}

/** 存使用者的修改；和預設一模一樣時視為沒改，之後換語言會跟著換。 */
export function setTemplate(key, text) {
    getSettings().prompts[key] = text === defaultTemplate(key) ? null : text;
    saveSettings();
}

export function resetTemplate(key) {
    getSettings().prompts[key] = null;
    saveSettings();
}
