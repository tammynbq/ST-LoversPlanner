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
    { "op": "add", "type": "character", "data": { "name": "…", "relation": "…", "status": "…", "likes": "…", "dislikes": "…", "note": "…" } },
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
4. summary：不超過 {{length}} 字，1～3 句，只寫重點：誰做了什麼、結果如何、關係或情緒有什麼變化。
   - 不要再寫時間、地點（已經在 time、location 裡）。
   - 不要列出物品數量、功法細節這類會記在 ops 裡的東西。
   - 不要評論，不要加入原文沒有的內容。
5. ops：對照目前的記事清單，只記之後劇情還會用到的變化，寧缺勿濫：
   - 新增用 add，type 是 character／item／promise／todo。更新或結束已有的記事時，用清單裡方括號中的 id。
   - character：包括 {{char}} 和 {{user}} 在內的重要人物。記下之後會用到的資訊：關係、狀態、喜歡（likes）、不喜歡（dislikes）、習慣或重要經歷（note）。有新發現時用 update 補上，不要每層重複寫一樣的內容。人物不會被移除，只用 update 更新狀態（例如離開、死亡）。
   - item：只記 {{char}} 和 {{user}} 的所有物，其他人的東西不用記。一件東西一條；同一種東西的數量寫在同一條裡（例如「下品靈石 ×10」）。得到、交給對方時用 update 更新 holder；用掉、遺失、送給別人時用 complete，result 是 used／lost／gone。
   - promise 是和別人的約定或承諾；todo 是主角自己打算做的事。同一件事不要同時記成兩種。
   - 約定履行用 complete 加 kept；被打破用 complete 加 broken。待辦完成用 complete 加 done。
   - 清單裡已經有的不要重複新增。沒有值得記的變化就讓 ops 是空陣列。

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
4. summary：不超过 {{length}} 字，1～3 句，只写重点：谁做了什么、结果如何、关系或情绪有什么变化。
   - 不要再写时间、地点（已经在 time、location 里）。
   - 不要列出物品数量、功法细节这类会记在 ops 里的东西。
   - 不要评论，不要加入原文没有的内容。
5. ops：对照当前的记事清单，只记之后剧情还会用到的变化，宁缺毋滥：
   - 新增用 add，type 是 character／item／promise／todo。更新或结束已有的记事时，用清单里方括号中的 id。
   - character：包括 {{char}} 和 {{user}} 在内的重要人物。记下之后会用到的信息：关系、状态、喜欢（likes）、不喜欢（dislikes）、习惯或重要经历（note）。有新发现时用 update 补上，不要每层重复写一样的内容。人物不会被移除，只用 update 更新状态（例如离开、死亡）。
   - item：只记 {{char}} 和 {{user}} 的所有物，其他人的东西不用记。一件东西一条；同一种东西的数量写在同一条里（例如「下品灵石 ×10」）。得到、交给对方时用 update 更新 holder；用掉、遗失、送给别人时用 complete，result 是 used／lost／gone。
   - promise 是和别人的约定或承诺；todo 是主角自己打算做的事。同一件事不要同时记成两种。
   - 约定履行用 complete 加 kept；被打破用 complete 加 broken。待办完成用 complete 加 done。
   - 清单里已经有的不要重复新增。没有值得记的变化就让 ops 是空数组。

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
4. summary: at most {{length}} words, 1–3 sentences, only the essentials: who did what, how it turned out, and any change in the relationship or mood.
   - Don't repeat the time or place (they are already in time and location).
   - Don't list item quantities or technique details; those belong in ops.
   - Don't comment and don't add anything that isn't in the text.
5. ops: compare with the current notes and record only changes the story will need later. Less is more:
   - Use add with type character / item / promise / todo for new ones. To update or finish an existing note, use the id in square brackets from the list.
   - character: important characters, including {{char}} and {{user}}. Record what the story will need later: relationship, status, likes, dislikes, and habits or key experiences (note). Use update to add new findings; don't repeat the same details every floor. Characters are never removed; only use update to change their status (e.g. left, died).
   - item: only things owned by {{char}} or {{user}}; other people's belongings are not recorded. One entry per item; put the quantity of the same kind in one entry (e.g. "spirit stone ×10"). When it changes hands between them, use update to change holder; when used up, lost or given to someone else, use complete with result used / lost / gone.
   - promise is a commitment made with someone; todo is something a lead plans to do. Never record the same thing as both.
   - A kept promise is complete + kept; a broken one is complete + broken. A finished to-do is complete + done.
   - Don't add anything that is already in the list. If nothing worth recording changed, leave ops as an empty array.

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
