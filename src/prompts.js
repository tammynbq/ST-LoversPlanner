// 預設提示詞模板，三種語言各一份。使用者可以在「設定 › 進階」修改，
// 每個模板都能恢復成預設。{{...}} 是插件自己會替換的變數。
// L1 的 {{rules}}、{{format}} 依「設定 › 記錄項目」自動產生（見 l1rules.js）；
// {{previous}}、{{notes}} 連標題一起產生，沒勾相關項目時是空的。

import { currentLocale } from './i18n.js';
import { getSettings, saveSettings } from './settings.js';

export const TEMPLATE_KEYS = ['l1', 'l2', 'l3', 'recap', 'catchup'];

export const TEMPLATE_VARS = {
    l1: ['{{char}}', '{{user}}', '{{length}}', '{{content}}', '{{rules}}', '{{previous}}', '{{notes}}', '{{format}}'],
    l2: ['{{summaries}}', '{{length}}'],
    l3: ['{{chapters}}', '{{length}}'],
    recap: ['{{recap}}', '{{length}}'],
    catchup: ['{{char}}', '{{user}}', '{{length}}', '{{content}}', '{{rules}}', '{{previous}}', '{{notes}}', '{{format}}'],
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
