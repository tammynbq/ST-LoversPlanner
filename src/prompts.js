// 預設提示詞模板，三種語言各一份。使用者可以在「設定 › 進階」修改，
// 每個模板都能恢復成預設。{{...}} 是插件自己會替換的變數。
// L1 的 {{rules}}、{{format}} 依「設定 › 記錄項目」自動產生（見 l1rules.js）；
// {{previous}}、{{notes}} 連標題一起產生，沒勾相關項目時是空的。

import { currentLocale } from './i18n.js';
import { getSettings, saveSettings } from './settings.js';

export const TEMPLATE_KEYS = ['l1', 'l2', 'l3', 'recap', 'catchup', 'audit'];

export const TEMPLATE_VARS = {
    l1: ['{{char}}', '{{user}}', '{{length}}', '{{content}}', '{{rules}}', '{{previous}}', '{{notes}}', '{{format}}'],
    l2: ['{{summaries}}', '{{length}}'],
    l3: ['{{chapters}}', '{{length}}'],
    recap: ['{{recap}}', '{{length}}'],
    catchup: ['{{char}}', '{{user}}', '{{length}}', '{{content}}', '{{rules}}', '{{previous}}', '{{notes}}', '{{format}}'],
    audit: ['{{char}}', '{{user}}', '{{content}}', '{{summary}}'],
};


const DEFAULTS = {
    'zh-TW': {
        l1: `你是故事記錄員，負責替 {{char}} 和 {{user}} 的故事做紀錄。

請讀下面這一段對話，用繁體中文、第三人稱回報：
{{rules}}

{{previous}}

{{notes}}

這一段對話：
{{content}}

只輸出下面格式的 JSON，不要輸出其他文字：
{{format}}`,
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
        catchup: `你是故事記錄員，負責替 {{char}} 和 {{user}} 的故事做紀錄。

下面是很長的一段舊對話（好幾層）。請用繁體中文、第三人稱，把這一整段寫成一份章節總結，並回報：
{{rules}}

{{previous}}

{{notes}}

這一段對話：
{{content}}

只輸出下面格式的 JSON，不要輸出其他文字：
{{format}}`,
        audit: `你是審稿員。下面是 {{char}} 和 {{user}} 故事裡的一段原文，以及別人替它寫的摘要。請對照原文檢查摘要：
- 有沒有寫錯（和原文矛盾、張冠李戴、把人物搞錯）
- 有沒有漏掉之後劇情會用到的重要事件或關係變化
- 時間、地點、出場人物對不對
措辭不同、比較簡略都沒關係，只挑真正的錯誤和重要遺漏。

原文：
{{content}}

摘要：
{{summary}}

只輸出下面格式的 JSON，不要輸出其他文字。沒有問題時 problems 是空陣列。problems 用繁體中文，每條一句話：
{ "ok": true, "problems": ["…"] }`,
    },
    'zh-CN': {
        l1: `你是故事记录员，负责替 {{char}} 和 {{user}} 的故事做记录。

请读下面这一段对话，用简体中文、第三人称回报：
{{rules}}

{{previous}}

{{notes}}

这一段对话：
{{content}}

只输出下面格式的 JSON，不要输出其他文字：
{{format}}`,
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
        catchup: `你是故事记录员，负责替 {{char}} 和 {{user}} 的故事做记录。

下面是很长的一段旧对话（好几层）。请用简体中文、第三人称，把这一整段写成一份章节总结，并回报：
{{rules}}

{{previous}}

{{notes}}

这一段对话：
{{content}}

只输出下面格式的 JSON，不要输出其他文字：
{{format}}`,
        audit: `你是审稿员。下面是 {{char}} 和 {{user}} 故事里的一段原文，以及别人替它写的摘要。请对照原文检查摘要：
- 有没有写错（和原文矛盾、张冠李戴、把人物搞错）
- 有没有漏掉之后剧情会用到的重要事件或关系变化
- 时间、地点、出场人物对不对
措辞不同、比较简略都没关系，只挑真正的错误和重要遗漏。

原文：
{{content}}

摘要：
{{summary}}

只输出下面格式的 JSON，不要输出其他文字。没有问题时 problems 是空数组。problems 用简体中文，每条一句话：
{ "ok": true, "problems": ["…"] }`,
    },
    en: {
        l1: `You are the story's record keeper for {{char}} and {{user}}.

Read the exchange below and report, in English and in the third person:
{{rules}}

{{previous}}

{{notes}}

The exchange:
{{content}}

Output only JSON in this format, with no other text:
{{format}}`,
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
        catchup: `You are the story keeper for {{char}} and {{user}}.

Below is a long stretch of an older conversation (several floors). Write this whole stretch as one chapter summary, in English and in the third person, and report:
{{rules}}

{{previous}}

{{notes}}

The conversation:
{{content}}

Output only JSON in the format below, nothing else:
{{format}}`,
        audit: `You are a proofreader. Below is a passage from the story of {{char}} and {{user}}, and a summary someone wrote for it. Check the summary against the passage:
- Is anything wrong (contradicts the passage, mixes people up, attributes actions to the wrong character)?
- Is an important event or change in the relationship missing that the story will need later?
- Are the time, place and characters present correct?
Different wording or brevity is fine; only report real errors and important omissions.

Passage:
{{content}}

Summary:
{{summary}}

Output only JSON in the format below, nothing else. Leave problems empty if there are none. Write problems in English, one sentence each:
{ "ok": true, "problems": ["…"] }`,
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
