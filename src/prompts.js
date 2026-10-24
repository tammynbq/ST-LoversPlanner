// 預設提示詞模板，三種語言各一份。使用者可以在「設定 › 進階」修改，
// 每個模板都能恢復成預設。{{...}} 是插件自己會替換的變數。

import { currentLocale } from './i18n.js';
import { getSettings, saveSettings } from './settings.js';

export const TEMPLATE_KEYS = ['l1', 'l2', 'l3', 'recap'];

export const TEMPLATE_VARS = {
    l1: ['{{char}}', '{{user}}', '{{length}}', '{{content}}', '{{notes}}', '{{previous}}'],
    l2: ['{{summaries}}', '{{length}}'],
    l3: ['{{chapters}}', '{{length}}'],
    recap: ['{{recap}}', '{{length}}'],
};

const L1_JSON_SPEC = `{
  "time": "…",
  "location": "…",
  "characters": ["…"],
  "summary": "…",
  "ops": [
    { "op": "add", "type": "character", "data": { "name": "…", "relation": "…", "status": "…", "note": "…" } },
    { "op": "add", "type": "item", "data": { "name": "…", "holder": "…", "status": "…" } },
    { "op": "add", "type": "promise", "data": { "content": "…", "with": "…", "when": "…" } },
    { "op": "add", "type": "todo", "data": { "content": "…" } },
    { "op": "update", "id": "…", "data": { "status": "…" } },
    { "op": "complete", "id": "…", "result": "kept" }
  ]
}`;

const DEFAULTS = {
    'zh-TW': {
        l1: `你是故事記錄員，負責替 {{char}} 和 {{user}} 的故事做紀錄。

請讀下面這一段對話，用繁體中文、第三人稱回報：
1. time：這一段發生的故事內時間（例如「第三天 晚上」）。沒提到就延續上一層；完全無法判斷就留空字串。
2. location：發生的地點。沒提到就延續上一層；地點有移動可以寫「A → B」。
3. characters：這一段出場的人物名字（陣列）。
4. summary：約 {{length}} 字的摘要。只記發生了什麼、重要的決定和情緒轉折，不要評論，不要加入原文沒有的內容。
5. ops：對照目前的記事清單，找出這段對話裡新出現、有變化、或已經結束的人物、物件、約定、待辦：
   - 新增用 add，type 是 character／item／promise／todo。更新或結束已有的記事時，用清單裡方括號中的 id。
   - 人物不會被移除，只用 update 更新狀態（例如離開、死亡）。
   - 物件用掉、遺失、送人時用 complete，result 是 used／lost／gone。
   - 約定履行用 complete 加 kept；被打破用 complete 加 broken。待辦完成用 complete 加 done。
   - 清單裡已經有的不要重複新增。沒有變化就讓 ops 是空陣列。

上一層：{{previous}}

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
        l1: `你是故事记录员，负责替 {{char}} 和 {{user}} 的故事做记录。

请读下面这一段对话，用简体中文、第三人称回报：
1. time：这一段发生的故事内时间（例如「第三天 晚上」）。没提到就延续上一层；完全无法判断就留空字符串。
2. location：发生的地点。没提到就延续上一层；地点有移动可以写「A → B」。
3. characters：这一段出场的人物名字（数组）。
4. summary：约 {{length}} 字的摘要。只记发生了什么、重要的决定和情绪转折，不要评论，不要加入原文没有的内容。
5. ops：对照当前的记事清单，找出这段对话里新出现、有变化、或已经结束的人物、物件、约定、待办：
   - 新增用 add，type 是 character／item／promise／todo。更新或结束已有的记事时，用清单里方括号中的 id。
   - 人物不会被移除，只用 update 更新状态（例如离开、死亡）。
   - 物件用掉、遗失、送人时用 complete，result 是 used／lost／gone。
   - 约定履行用 complete 加 kept；被打破用 complete 加 broken。待办完成用 complete 加 done。
   - 清单里已经有的不要重复新增。没有变化就让 ops 是空数组。

上一层：{{previous}}

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

Read the exchange below and report, in English and in the third person:
1. time: when this happens in the story (e.g. "day three, evening"). If not mentioned, carry over from the previous floor; if impossible to tell, use an empty string.
2. location: where it happens. If not mentioned, carry over from the previous floor; for a change of place write "A → B".
3. characters: names of the characters who appear (array).
4. summary: about {{length}} words. Record only what happened, key decisions and emotional turns. Don't comment and don't add anything that isn't in the text.
5. ops: compare with the current notes and find characters, items, promises and to-dos that are new, changed or finished:
   - Use add with type character / item / promise / todo for new ones. To update or finish an existing note, use the id in square brackets from the list.
   - Characters are never removed; only use update to change their status (e.g. left, died).
   - When an item is used up, lost or given away, use complete with result used / lost / gone.
   - A kept promise is complete + kept; a broken one is complete + broken. A finished to-do is complete + done.
   - Don't add anything that is already in the list. If nothing changed, leave ops as an empty array.

Previous floor: {{previous}}

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
