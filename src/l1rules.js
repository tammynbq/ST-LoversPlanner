// L1 提示詞裡「要回報哪些欄位」的規則和 JSON 格式，依設定 › 記錄項目自動產生。
// 沒勾的項目在提示詞裡完全不出現，模型也就不會回報。

import { currentLocale } from './i18n.js';
import { isTracked, trackedNoteTypes } from './settings.js';
import { NOTE_FIELDS } from './notes.js';

const TEXT = {
    'zh-TW': {
        time: 'time：這一段發生的故事內時間（例如「第三天 晚上」）。沒提到就延續上一層；完全無法判斷就留空字串。',
        location: 'location：發生的地點。沒提到就延續上一層；地點有移動可以寫「A → B」。',
        cast: 'characters：這一段出場的人物名字（陣列）。',
        summary: 'summary：不超過 {length} 字，1～3 句，只寫重點：誰做了什麼、結果如何、關係或情緒有什麼變化。',
        noScene: '不要再寫時間、地點（已經另外回報）。',
        noOpsDetail: '不要列出會記在 ops 裡的細節（例如物品數量）。',
        noComment: '不要評論，不要加入原文沒有的內容。',
        ops: 'ops：對照目前的記事清單，只記之後劇情還會用到的變化，寧缺勿濫：',
        opsAdd: '新增用 add，type 是 {types}。更新或結束已有的記事時，用清單裡方括號中的 id。',
        character: 'character：包括 {char} 和 {user} 在內的重要人物。記下之後會用到的個人資料：身份（identity）、和主角的關係（relation）、外貌（appearance）、當前衣著（outfit，換了衣服就更新）、狀態（status）、喜歡（likes）、不喜歡（dislikes）、習慣或重要經歷（note）。有新發現時用 update 補上，不要每層重複寫一樣的內容。人物不會被移除，只用 update 更新狀態（例如離開、死亡）。',
        item: 'item：只記 {char} 和 {user} 的所有物，其他人的東西不用記。一件東西一條，數量寫在 quantity（只寫數字）。在兩人之間轉手時用 update 改 holder；用掉一部分時用 update 改 quantity；全部用完、遺失、送給別人時用 complete，result 是 used／lost／gone。',
        promise: 'promise 是和別人的約定或承諾。履行用 complete 加 kept；被打破用 complete 加 broken。',
        todo: 'todo 是主角自己打算做的事。完成用 complete 加 done。',
        both: '同一件事不要同時記成 promise 和 todo。',
        noDup: '清單裡已經有的不要重複新增。沒有值得記的變化就讓 ops 是空陣列。',
        timeChapter: 'time：這一整段的故事內時間範圍（例如「第三天 → 第五天」）。完全無法判斷就留空字串。',
        locationChapter: 'location：這一整段主要的地點（有好幾個就用「、」分開）。',
        castChapter: 'characters：這一整段出場的主要人物名字（陣列）。',
        summaryChapter: 'summary：約 {length} 字，依時間順序寫這一整段的主要事件、人物關係和情緒的變化、約定和伏筆。',
        sep: '／',
    },
    'zh-CN': {
        time: 'time：这一段发生的故事内时间（例如「第三天 晚上」）。没提到就延续上一层；完全无法判断就留空字符串。',
        location: 'location：发生的地点。没提到就延续上一层；地点有移动可以写「A → B」。',
        cast: 'characters：这一段出场的人物名字（数组）。',
        summary: 'summary：不超过 {length} 字，1～3 句，只写重点：谁做了什么、结果如何、关系或情绪有什么变化。',
        noScene: '不要再写时间、地点（已经另外回报）。',
        noOpsDetail: '不要列出会记在 ops 里的细节（例如物品数量）。',
        noComment: '不要评论，不要加入原文没有的内容。',
        ops: 'ops：对照当前的记事清单，只记之后剧情还会用到的变化，宁缺毋滥：',
        opsAdd: '新增用 add，type 是 {types}。更新或结束已有的记事时，用清单里方括号中的 id。',
        character: 'character：包括 {char} 和 {user} 在内的重要人物。记下之后会用到的个人资料：身份（identity）、和主角的关系（relation）、外貌（appearance）、当前衣着（outfit，换了衣服就更新）、状态（status）、喜欢（likes）、不喜欢（dislikes）、习惯或重要经历（note）。有新发现时用 update 补上，不要每层重复写一样的内容。人物不会被移除，只用 update 更新状态（例如离开、死亡）。',
        item: 'item：只记 {char} 和 {user} 的所有物，其他人的东西不用记。一件东西一条，数量写在 quantity（只写数字）。在两人之间转手时用 update 改 holder；用掉一部分时用 update 改 quantity；全部用完、遗失、送给别人时用 complete，result 是 used／lost／gone。',
        promise: 'promise 是和别人的约定或承诺。履行用 complete 加 kept；被打破用 complete 加 broken。',
        todo: 'todo 是主角自己打算做的事。完成用 complete 加 done。',
        both: '同一件事不要同时记成 promise 和 todo。',
        noDup: '清单里已经有的不要重复新增。没有值得记的变化就让 ops 是空数组。',
        timeChapter: 'time：这一整段的故事内时间范围（例如「第三天 → 第五天」）。完全无法判断就留空字符串。',
        locationChapter: 'location：这一整段主要的地点（有好几个就用「、」分开）。',
        castChapter: 'characters：这一整段出场的主要人物名字（数组）。',
        summaryChapter: 'summary：约 {length} 字，按时间顺序写这一整段的主要事件、人物关系和情绪的变化、约定和伏笔。',
        sep: '／',
    },
    en: {
        time: 'time: when this happens in the story (e.g. "day three, evening"). If not mentioned, carry over from the previous floor; if impossible to tell, use an empty string.',
        location: 'location: where it happens. If not mentioned, carry over from the previous floor; for a change of place write "A → B".',
        cast: 'characters: names of the characters who appear (array).',
        summary: 'summary: at most {length} words, 1–3 sentences, only the essentials: who did what, how it turned out, and any change in the relationship or mood.',
        noScene: "Don't repeat the time or place (they are reported separately).",
        noOpsDetail: "Don't list details that belong in ops (such as item quantities).",
        noComment: "Don't comment and don't add anything that isn't in the text.",
        ops: 'ops: compare with the current notes and record only changes the story will need later. Less is more:',
        opsAdd: 'Use add with type {types} for new ones. To update or finish an existing note, use the id in square brackets from the list.',
        character: 'character: important characters, including {char} and {user}. Record personal details the story may need: identity, relationship to the leads (relation), appearance, current outfit (outfit; update it when they change clothes), status, likes, dislikes, and habits or key experiences (note). Use update to add new findings; don\'t repeat the same details every floor. Characters are never removed; only use update to change their status (e.g. left, died).',
        item: 'item: only things owned by {char} or {user}; other people\'s belongings are not recorded. One entry per item, with the count in quantity (a number only). When it changes hands between them, update holder; when part of it is used, update quantity; when all used up, lost or given to someone else, use complete with result used / lost / gone.',
        promise: 'promise is a commitment made with someone. Kept: complete + kept; broken: complete + broken.',
        todo: 'todo is something a lead plans to do. Finished: complete + done.',
        both: 'Never record the same thing as both a promise and a todo.',
        noDup: "Don't add anything that is already in the list. If nothing worth recording changed, leave ops as an empty array.",
        timeChapter: 'time: the span of story time this whole section covers (e.g. "day three → day five"). If impossible to tell, use an empty string.',
        locationChapter: 'location: the main places in this whole section (separate several with commas).',
        castChapter: 'characters: names of the main characters who appear in this whole section (array).',
        summaryChapter: 'summary: about {length} words, in order: the main events of this whole section, changes in relationships and mood, promises and foreshadowing.',
        sep: ' / ',
    },
};

function fill(text, vars) {
    return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** 產生 {{rules}} 和 {{format}}。chapter：補建時一次讀一整段、寫成一章的版本。 */
export function buildL1Parts({ length, char, user, chapter = false }) {
    const T = TEXT[currentLocale()] ?? TEXT.en;
    const vars = { length, char, user };
    const types = trackedNoteTypes();
    const scene = ['time', 'location', 'cast'].filter(isTracked);

    const rules = [];
    for (const key of scene) rules.push(chapter ? T[`${key}Chapter`] : T[key]);
    const summarySub = [];
    if (isTracked('time') || isTracked('location')) summarySub.push(T.noScene);
    if (types.length) summarySub.push(T.noOpsDetail);
    summarySub.push(T.noComment);
    rules.push([fill(chapter ? T.summaryChapter : T.summary, vars), ...summarySub.map((x) => `   - ${x}`)].join('\n'));
    if (types.length) {
        const sub = [fill(T.opsAdd, { types: types.join(T.sep) })];
        for (const type of types) sub.push(fill(T[type], vars));
        if (types.includes('promise') && types.includes('todo')) sub.push(T.both);
        sub.push(T.noDup);
        rules.push([T.ops, ...sub.map((x) => `   - ${x}`)].join('\n'));
    }
    const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join('\n');

    // JSON 格式範例：只列有勾選的欄位和記事類型。
    const lines = ['{'];
    if (isTracked('time')) lines.push('  "time": "…",');
    if (isTracked('location')) lines.push('  "location": "…",');
    if (isTracked('cast')) lines.push('  "characters": ["…"],');
    if (types.length) {
        lines.push('  "summary": "…",', '  "ops": [');
        const ex = types.map((type) => {
            const data = NOTE_FIELDS[type].map((f) => `"${f}": ${f === 'quantity' ? '1' : '"…"'}`).join(', ');
            return `    { "op": "add", "type": "${type}", "data": { ${data} } }`;
        });
        ex.push('    { "op": "update", "id": "…", "data": { … } }');
        ex.push('    { "op": "complete", "id": "…", "result": "…" }');
        lines.push(ex.join(',\n'), '  ]');
    } else {
        lines.push('  "summary": "…"');
    }
    lines.push('}');
    return { rules: numbered, format: lines.join('\n') };
}
