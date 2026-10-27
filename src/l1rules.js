// L1 提示詞裡「要回報哪些欄位」的規則和 JSON 格式，依設定 › 記錄項目自動產生。
// 沒勾的項目在提示詞裡完全不出現，模型也就不會回報。

import { currentLocale } from './i18n.js';
import { charFields, getSettings, isTracked, trackedNoteTypes } from './settings.js';
import { NOTE_FIELDS } from './notes.js';
import { ACTIVE_CAL_TYPES, calendarOn, calTracked, normDate } from './calendar.js';
import { memoriesOn } from './memories.js';

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
        character: 'character：包括 {char} 和 {user} 在內的重要人物。每個欄位只寫屬於它的內容，不要混在一起：',
        charFields: {
            name: 'name：一個主要的名字',
            alias: 'alias：別稱、暱稱、別人怎麼稱呼他',
            identity: 'identity：身份、職業',
            age: 'age：年齡',
            birthday: 'birthday：生日',
            relUser: 'relUser：和 {user} 的關係（{user} 本人那條不用寫）',
            relChar: 'relChar：和 {char} 的關係（{char} 本人那條不用寫）',
            appearance: 'appearance：外貌和身體特徵（長相、身材、髮型、疤痕、刺青…），60 字內',
            outfit: 'outfit：當前衣著，40 字內，換了衣服就更新',
            status: 'status：會持續一段時間的狀態，用短詞組、20～40 字（例如「左臂受傷、感冒中、出差中」）。這一層正在做的事、說的話寫在 summary，不要寫在這裡；離開、死亡也寫在這裡。有變才更新，整段換掉，不要越寫越長',
            personality: 'personality：性格',
            likes: 'likes：喜歡的東西',
            dislikes: 'dislikes：討厭的東西',
            habits: 'habits：習慣、小動作、口頭禪',
            history: 'history：故事開始前的過去，或改變人生的大事，一件一句、60 字內。故事裡最近發生的事已經在摘要和回憶錄裡，不要寫進來',
            note: 'note：長期有用、上面欄位放不下的設定（過敏、秘密、忌諱、特殊能力…），40 字內。不要寫發生過的事（約會、告白、吵架…），那些已經在摘要和回憶錄裡；外貌、喜好等也不要寫在 note',
        },
        charMore: '有新發現時用 update 只補上變了的欄位，不要每層重複寫一樣的內容。人物不會被移除。清單裡標了「主角：」的就是 {user}／{char} 本人，更新他們的資料用那一條的 id，不要另外新增。',
        item: 'item：只記 {char} 和 {user} 的所有物，其他人的東西不用記。一件東西一條，數量寫在 quantity（只寫數字）。在兩人之間轉手時用 update 改 holder；用掉一部分時用 update 改 quantity；全部用完、遺失、送給別人時用 complete，result 是 used／lost／gone。',
        promise: 'promise（約定）：說好、答應、承諾將來要做的具體的事，對象是另一個人。算：明確約好的（「週六一起看電影」）、答應對方的請求、隨口但認真的「下次帶你去…」。不算：這一層裡馬上就做完的事、玩笑、假設、只是想想的願望（願望記成 todo）。沒有具體要做什麼的承諾（例如「我會一直陪著你」）不記成約定；值得珍藏的話收進 keepsakes，寫清楚是在什麼情況下、為什麼說的。with 寫誰答應誰（例如「{char}答應{user}」）。',
        todo: 'todo（待辦）：主角自己打算做、還沒做、沒有和別人約好的事（例如「想偷偷準備生日驚喜」「打算週末大掃除」）。',
        noteTitle: 'promise 和 todo 都要有 title：15 字內、看得出是什麼事的短標題（例如「看電影＋宵夜」，不要寫「晚上的約定」）；content：具體寫要做什麼，有提到的話連時間、地點、怎麼做、誰負責都寫進去，照原文的關鍵細節，100 字內（✗「約好晚上要做事」 ✓「今晚回家後一起看電影，{char}負責煮宵夜」）。原文沒說清楚做什麼的照原文寫，不要自己補；之後說清楚了再用 update 補上 content 和 title。對話最後說好的事最容易漏，請特別看最後幾段。',
        promiseCheck: '每一層都對照清單裡進行中的 promise 和 todo：這一層真的做到了才 complete（promise 用 kept，todo 用 done），加上 detail 用 50～100 字寫怎麼做到的；只是提起、準備中、還沒做到的不要 complete；明確取消、做不到、被違背才 complete 加 broken（detail 寫怎麼被打破的）；改期就用 update 改 when。',
        both: '同一件事不要同時記成 promise 和 todo。',
        due: 'when 照原文寫（例如「今晚」「明年秋天」）；due 是預定哪一天，用這一層的 date 換算成 YYYY-MM-DD（今晚、今天＝date；明天＝date 加一天；下週三、10月21日也換算好）。沒有確切哪一天就不寫 due；改期時 due 也一起改。有日期的安排一律記成 promise（和別人一起）或 todo（自己做），不另外記行程。',
        noDup: '清單裡已經有的不要重複新增。沒有值得記的變化就讓 ops 是空陣列。',
        timeChapter: 'time：這一整段的故事內時間範圍（例如「第三天 → 第五天」）。完全無法判斷就留空字串。',
        locationChapter: 'location：這一整段主要的地點，歸納成 1～2 個（用上一層的地名，例如「恋语市郊区・银杏林营地」，不要把每個小地點都列出來）。',
        castChapter: 'characters：這一整段出場的主要人物名字（陣列）。',
        summaryChapter: 'summary：約 {length} 字，依時間順序寫這一整段的主要事件、人物關係和情緒的變化、約定和伏筆。',
        date: 'date：這一層發生在故事裡的哪一天，格式 YYYY-MM-DD。原文寫了日期就照寫；沒寫就延續上一層的日期；過了夜（隔天、第二天早上）就加一天。{start}',
        dateChapter: 'date：這一整段的最後一天在故事裡是哪一天，格式 YYYY-MM-DD（推算方式同上：沒寫就延續，過夜加一天）。{start}',
        dateStart: '完全沒有線索時，從 {start} 開始算。',
        events: 'events：這一層和行事曆有關的事（陣列，沒有就是空陣列）：',
        evPlan: 'plan：約好或安排在某一天要做的事。date 是那一天（YYYY-MM-DD），title 簡短寫要做什麼。',
        evPeriod: 'period：{user} 的生理期。只有劇情明確提到才記（來了、開始、結束了），不要自己推測。開始用 state: "start"，結束用 state: "end"。',
        evIntimacy: 'intimacy：{char} 和 {user} 親熱（發生性行為），count 是這一層發生幾次。',
        evAnniversary: 'anniversary：紀念日或生日（每年重複），date 寫 MM-DD，title 寫是什麼日子（例如「小雨的生日」）。',
        keepsakes: 'keepsakes：真正值得珍藏、以後兩人可能會一起回想的時刻（第一次做某件事、告白、和好、很甜或很重要的對話、特別的約定或禮物）。大部分樓層沒有，寧缺勿濫，沒有就是空陣列。title 不超過 15 字；content 用一兩句寫清楚發生了什麼、說了什麼關鍵的話。',
        keepsakesTheater: '「小劇場」是番外，不是正劇：不要寫進 summary 和 ops；但裡面有意義的時刻可以收進 keepsakes，加上 "from": "theater"。',
        summarySide: 'summary：這一整層是「小劇場」（番外、IF 線），不是正劇。用一句話（不超過 50 字）寫這段小劇場在演什麼，只給使用者看，不會當成劇情。',
        keepsakesSide: '小劇場裡有意義的時刻可以收進 keepsakes（寧缺勿濫）。',
        opsSide: 'ops：只在小劇場裡明確說好、之後正劇也要算數的約定或待辦才用 add 新增；其他記事（人物、物件）不要動，也不要 update 或 complete。沒有就是空陣列。',
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
        character: 'character：包括 {char} 和 {user} 在内的重要人物。每个栏位只写属于它的内容，不要混在一起：',
        charFields: {
            name: 'name：一个主要的名字',
            alias: 'alias：别称、昵称、别人怎么称呼他',
            identity: 'identity：身份、职业',
            age: 'age：年龄',
            birthday: 'birthday：生日',
            relUser: 'relUser：和 {user} 的关系（{user} 本人那条不用写）',
            relChar: 'relChar：和 {char} 的关系（{char} 本人那条不用写）',
            appearance: 'appearance：外貌和身体特征（长相、身材、发型、疤痕、纹身…），60 字内',
            outfit: 'outfit：当前衣着，40 字内，换了衣服就更新',
            status: 'status：会持续一段时间的状态，用短词组、20～40 字（例如「左臂受伤、感冒中、出差中」）。这一层正在做的事、说的话写在 summary，不要写在这里；离开、死亡也写在这里。有变才更新，整段换掉，不要越写越长',
            personality: 'personality：性格',
            likes: 'likes：喜欢的东西',
            dislikes: 'dislikes：讨厌的东西',
            habits: 'habits：习惯、小动作、口头禅',
            history: 'history：故事开始前的过去，或改变人生的大事，一件一句、60 字内。故事里最近发生的事已经在摘要和回忆录里，不要写进来',
            note: 'note：长期有用、上面栏位放不下的设定（过敏、秘密、忌讳、特殊能力…），40 字内。不要写发生过的事（约会、告白、吵架…），那些已经在摘要和回忆录里；外貌、喜好等也不要写在 note',
        },
        charMore: '有新发现时用 update 只补上变了的栏位，不要每层重复写一样的内容。人物不会被移除。清单里标了「主角：」的就是 {user}／{char} 本人，更新他们的资料用那一条的 id，不要另外新增。',
        item: 'item：只记 {char} 和 {user} 的所有物，其他人的东西不用记。一件东西一条，数量写在 quantity（只写数字）。在两人之间转手时用 update 改 holder；用掉一部分时用 update 改 quantity；全部用完、遗失、送给别人时用 complete，result 是 used／lost／gone。',
        promise: 'promise（约定）：说好、答应、承诺将来要做的具体的事，对象是另一个人。算：明确约好的（「周六一起看电影」）、答应对方的请求、随口但认真的「下次带你去…」。不算：这一层里马上就做完的事、玩笑、假设、只是想想的愿望（愿望记成 todo）。没有具体要做什么的承诺（例如「我会一直陪着你」）不记成约定；值得珍藏的话收进 keepsakes，写清楚是在什么情况下、为什么说的。with 写谁答应谁（例如「{char}答应{user}」）。',
        todo: 'todo（待办）：主角自己打算做、还没做、没有和别人约好的事（例如「想偷偷准备生日惊喜」「打算周末大扫除」）。',
        noteTitle: 'promise 和 todo 都要有 title：15 字内、看得出是什么事的短标题（例如「看电影＋宵夜」，不要写「晚上的约定」）；content：具体写要做什么，有提到的话连时间、地点、怎么做、谁负责都写进去，照原文的关键细节，100 字内（✗「约好晚上要做事」 ✓「今晚回家后一起看电影，{char}负责煮宵夜」）。原文没说清楚做什么的照原文写，不要自己补；之后说清楚了再用 update 补上 content 和 title。对话最后说好的事最容易漏，请特别看最后几段。',
        promiseCheck: '每一层都对照清单里进行中的 promise 和 todo：这一层真的做到了才 complete（promise 用 kept，todo 用 done），加上 detail 用 50～100 字写怎么做到的；只是提起、准备中、还没做到的不要 complete；明确取消、做不到、被违背才 complete 加 broken（detail 写怎么被打破的）；改期就用 update 改 when。',
        both: '同一件事不要同时记成 promise 和 todo。',
        due: 'when 照原文写（例如「今晚」「明年秋天」）；due 是预定哪一天，用这一层的 date 换算成 YYYY-MM-DD（今晚、今天＝date；明天＝date 加一天；下周三、10月21日也换算好）。没有确切哪一天就不写 due；改期时 due 也一起改。有日期的安排一律记成 promise（和别人一起）或 todo（自己做），不另外记行程。',
        noDup: '清单里已经有的不要重复新增。没有值得记的变化就让 ops 是空数组。',
        timeChapter: 'time：这一整段的故事内时间范围（例如「第三天 → 第五天」）。完全无法判断就留空字符串。',
        locationChapter: 'location：这一整段主要的地点，归纳成 1～2 个（用上一层的地名，例如「恋语市郊区・银杏林营地」，不要把每个小地点都列出来）。',
        castChapter: 'characters：这一整段出场的主要人物名字（数组）。',
        summaryChapter: 'summary：约 {length} 字，按时间顺序写这一整段的主要事件、人物关系和情绪的变化、约定和伏笔。',
        date: 'date：这一层发生在故事里的哪一天，格式 YYYY-MM-DD。原文写了日期就照写；没写就延续上一层的日期；过了夜（隔天、第二天早上）就加一天。{start}',
        dateChapter: 'date：这一整段的最后一天在故事里是哪一天，格式 YYYY-MM-DD（推算方式同上：没写就延续，过夜加一天）。{start}',
        dateStart: '完全没有线索时，从 {start} 开始算。',
        events: 'events：这一层和行事历有关的事（数组，没有就是空数组）：',
        evPlan: 'plan：约好或安排在某一天要做的事。date 是那一天（YYYY-MM-DD），title 简短写要做什么。',
        evPeriod: 'period：{user} 的生理期。只有剧情明确提到才记（来了、开始、结束了），不要自己推测。开始用 state: "start"，结束用 state: "end"。',
        evIntimacy: 'intimacy：{char} 和 {user} 亲热（发生性行为），count 是这一层发生几次。',
        evAnniversary: 'anniversary：纪念日或生日（每年重复），date 写 MM-DD，title 写是什么日子（例如「小雨的生日」）。',
        keepsakes: 'keepsakes：真正值得珍藏、以后两人可能会一起回想的时刻（第一次做某件事、告白、和好、很甜或很重要的对话、特别的约定或礼物）。大部分楼层没有，宁缺毋滥，没有就是空数组。title 不超过 15 字；content 用一两句写清楚发生了什么、说了什么关键的话。',
        keepsakesTheater: '「小剧场」是番外，不是正剧：不要写进 summary 和 ops；但里面有意义的时刻可以收进 keepsakes，加上 "from": "theater"。',
        summarySide: 'summary：这一整层是「小剧场」（番外、IF 线），不是正剧。用一句话（不超过 50 字）写这段小剧场在演什么，只给用户看，不会当成剧情。',
        keepsakesSide: '小剧场里有意义的时刻可以收进 keepsakes（宁缺毋滥）。',
        opsSide: 'ops：只在小剧场里明确说好、之后正剧也要算数的约定或待办才用 add 新增；其他记事（人物、物品）不要动，也不要 update 或 complete。没有就是空数组。',
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
        character: 'character: important characters, including {char} and {user}. Put each detail only in the field it belongs to:',
        charFields: {
            name: 'name: one main name',
            alias: 'alias: other names, nicknames, what others call them',
            identity: 'identity: role, occupation',
            age: 'age',
            birthday: 'birthday',
            relUser: 'relUser: relationship to {user} (leave empty on {user}\'s own entry)',
            relChar: 'relChar: relationship to {char} (leave empty on {char}\'s own entry)',
            appearance: 'appearance: looks and physical features (face, build, hair, scars, tattoos…), at most 30 words',
            outfit: 'outfit: what they are wearing now, at most 20 words; update it when they change',
            status: 'status: a state that lasts a while, in short phrases of 10–20 words (e.g. "left arm injured, has a cold, away on a trip"). What happens or is said in this floor belongs in summary, not here; leaving or dying also goes here. Update only when it changes, replacing the whole value; never let it grow',
            personality: 'personality',
            likes: 'likes',
            dislikes: 'dislikes',
            habits: 'habits: habits, mannerisms, catchphrases',
            history: 'history: the past before the story began, or life-changing events, one short sentence each, at most 30 words. Recent events in the story are already in the summaries and memory book; don\'t put them here',
            note: 'note: lasting facts that fit no field above (allergies, secrets, taboos, special abilities…), at most 20 words. Never write events that happened (dates, confessions, fights…); they are already in the summaries and memory book. Never put looks or likes here either',
        },
        charMore: 'When you learn something new, update only the fields that changed; don\'t repeat the same details every floor. Characters are never removed. Entries marked "Lead:" are {user} / {char} themselves: update them by that id, never add another entry for them.',
        item: 'item: only things owned by {char} or {user}; other people\'s belongings are not recorded. One entry per item, with the count in quantity (a number only). When it changes hands between them, update holder; when part of it is used, update quantity; when all used up, lost or given to someone else, use complete with result used / lost / gone.',
        promise: 'promise: something concrete that someone agreed, said yes to, or committed to doing later, with another person. Counts: clear plans ("movie together on Saturday"), saying yes to a request, a casual but sincere "I\'ll take you to … next time". Doesn\'t count: something done within this same floor, jokes, hypotheticals, mere wishes (a wish is a todo). A vow with nothing concrete to do (e.g. "I\'ll always be by your side") is not a promise; if it is worth treasuring, put it in keepsakes and say in what situation and why it was said. with says who promised whom (e.g. "{char} promised {user}").',
        todo: 'todo: something a lead plans to do, hasn\'t done yet, and hasn\'t arranged with anyone (e.g. "secretly plan a birthday surprise", "clean the house this weekend").',
        noteTitle: 'Every promise and todo needs a title: a short label of at most 8 words that says what it is (e.g. "Movie + late-night snack", never "Tonight\'s plan"); content says concretely what will be done, including time, place, how, and who does what if mentioned, keeping the key details from the text, at most 50 words (✗ "agreed to do something tonight" ✓ "watch a movie together after getting home tonight; {char} makes a late-night snack"). If the text doesn\'t say what, write what it says and don\'t fill in; once the story makes it clear, update content and title. Plans made at the end of the conversation are the easiest to miss: read the last paragraphs carefully.',
        promiseCheck: 'Every floor, check the active promises and todos in the list: complete one only if it was actually done in this floor (kept for a promise, done for a todo), with detail of 50–100 words on how; if it was only mentioned, being prepared, or not done yet, don\'t complete it; use complete with broken only if it was clearly cancelled, impossible, or betrayed (detail says how); if it was rescheduled, update when.',
        both: 'Never record the same thing as both a promise and a todo.',
        due: 'Write when as the text says it (e.g. "tonight", "next autumn"); due is the planned day as YYYY-MM-DD, worked out from this floor\'s date (tonight/today = date; tomorrow = date + 1 day; also convert "next Wednesday", "October 21"). Leave out due if there is no specific day; when rescheduled, update due too. Anything arranged for a date is always a promise (with someone) or a todo (alone); never record it separately as a plan.',
        noDup: "Don't add anything that is already in the list. If nothing worth recording changed, leave ops as an empty array.",
        timeChapter: 'time: the span of story time this whole section covers (e.g. "day three → day five"). If impossible to tell, use an empty string.',
        locationChapter: 'location: the main places of this whole section, generalized to 1–2 (use the broader place name, e.g. "Riverside Campground" rather than every spot within it).',
        castChapter: 'characters: names of the main characters who appear in this whole section (array).',
        summaryChapter: 'summary: about {length} words, in order: the main events of this whole section, changes in relationships and mood, promises and foreshadowing.',
        date: 'date: which day in the story this floor happens, as YYYY-MM-DD. Use a date stated in the text; otherwise carry over the previous floor\'s date, adding one day when the night has passed (next day, next morning). {start}',
        dateChapter: 'date: the story date of the last day of this whole section, as YYYY-MM-DD (same reasoning: carry over, add a day when the night passes). {start}',
        dateStart: 'With no clue at all, start from {start}.',
        events: 'events: calendar-related things in this floor (array; empty if none):',
        evPlan: 'plan: something arranged for a particular day. date is that day (YYYY-MM-DD); title says briefly what.',
        evPeriod: 'period: {user}\'s menstrual period. Record it only when the story clearly mentions it (it started, it ended); never guess. Use state: "start" when it begins and state: "end" when it ends.',
        evIntimacy: 'intimacy: {char} and {user} being intimate (having sex); count is how many times in this floor.',
        evAnniversary: 'anniversary: an anniversary or birthday (repeats every year); date as MM-DD, title says what day it is (e.g. "Xiaoyu\'s birthday").',
        keepsakes: 'keepsakes: moments truly worth treasuring that the two might look back on later (a first time, a confession, making up, a very sweet or important conversation, a special promise or gift). Most floors have none; less is more; leave it as an empty array if none. title at most 8 words; content in one or two sentences says what happened and the key words said.',
        keepsakesTheater: 'The "side scene" is an extra, not the main story: keep it out of summary and ops, but meaningful moments from it may go into keepsakes with "from": "theater".',
        summarySide: 'summary: this whole floor is a "side scene" (an extra or IF line), not the main story. In one sentence (at most 25 words) say what the side scene is about; it is only shown to the user, never treated as the plot.',
        keepsakesSide: 'Meaningful moments in the side scene may go into keepsakes (less is more).',
        opsSide: 'ops: only add a promise or to-do that is clearly agreed in the side scene and should still count in the main story; leave other notes (characters, items) alone, and do not update or complete anything. Empty array if none.',
        sep: ' / ',
    },
};

/** 故事開始日：設定裡填的，沒填就用今天（現實的日期）。 */
function startDate() {
    return normDate(getSettings().calendar?.start) || new Date().toISOString().slice(0, 10);
}

function fill(text, vars) {
    return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** 人物欄位的說明（「📇 從人設填寫」也用）：只列 fields 裡的。 */
export function charFieldRules(fields, vars) {
    const T = TEXT[currentLocale()] ?? TEXT.en;
    return fields.map((f) => `- ${fill(T.charFields[f], vars)}`).join('\n');
}

/** 產生 {{rules}} 和 {{format}}。chapter：補建時一次讀一整段、寫成一章的版本。side：⭐ 小劇場那一層。 */
export function buildL1Parts({ length, char, user, chapter = false, previousDate = '', theater = false, side = false }) {
    const T = TEXT[currentLocale()] ?? TEXT.en;
    const vars = { length, char, user };
    if (side) return sideParts(T, vars);
    const types = trackedNoteTypes();
    const scene = ['time', 'location', 'cast'].filter(isTracked);

    const rules = [];
    for (const key of scene) rules.push(chapter ? T[`${key}Chapter`] : T[key]);
    // 行事曆：故事裡的日期。
    const cal = calendarOn();
    if (cal) {
        const start = normDate(previousDate) ? '' : fill(T.dateStart, { start: startDate() });
        rules.push(fill(chapter ? T.dateChapter : T.date, { start }).trim());
    }
    const summarySub = [];
    if (isTracked('time') || isTracked('location')) summarySub.push(T.noScene);
    if (types.length) summarySub.push(T.noOpsDetail);
    summarySub.push(T.noComment);
    rules.push([fill(chapter ? T.summaryChapter : T.summary, vars), ...summarySub.map((x) => `   - ${x}`)].join('\n'));
    if (types.length) {
        const sub = [fill(T.opsAdd, { types: types.join(T.sep) })];
        for (const type of types) {
            if (type !== 'character') {
                sub.push(fill(T[type], vars));
                continue;
            }
            // 人物：逐欄說明（只列有勾選的欄位），免得模型把外貌寫進備註。
            const fields = charFields().map((f) => `     · ${fill(T.charFields[f], vars)}`);
            sub.push([fill(T.character, vars), ...fields, `     ${fill(T.charMore, vars)}`].join('\n'));
        }
        if (types.includes('promise') || types.includes('todo')) sub.push(fill(T.noteTitle, vars), T.promiseCheck);
        if (types.includes('promise') && types.includes('todo')) sub.push(T.both);
        // 預定日期要靠故事日期換算，沒開行事曆就不要求。
        if (cal && (types.includes('promise') || types.includes('todo'))) sub.push(T.due);
        sub.push(T.noDup);
        rules.push([T.ops, ...sub.map((x) => `   - ${x}`)].join('\n'));
    }
    const evTypes = cal ? ACTIVE_CAL_TYPES.filter(calTracked) : [];
    if (evTypes.length) {
        const key = { plan: 'evPlan', period: 'evPeriod', intimacy: 'evIntimacy', anniversary: 'evAnniversary' };
        rules.push([T.events, ...evTypes.map((x) => `   - ${fill(T[key[x]], vars)}`)].join('\n'));
    }
    // 回憶錄：讓模型挑值得珍藏的時刻。
    const keep = memoriesOn() && getSettings().memories?.auto;
    if (keep) rules.push([T.keepsakes, ...(theater ? [`   - ${T.keepsakesTheater}`] : [])].join('\n'));
    const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join('\n');

    // JSON 格式範例：只列有勾選的欄位和記事類型。
    const lines = ['{'];
    if (isTracked('time')) lines.push('  "time": "…",');
    if (isTracked('location')) lines.push('  "location": "…",');
    if (isTracked('cast')) lines.push('  "characters": ["…"],');
    if (cal) lines.push('  "date": "YYYY-MM-DD",');
    if (evTypes.length) {
        const ex = { plan: '{ "type": "plan", "date": "YYYY-MM-DD", "title": "…" }', period: '{ "type": "period", "state": "start" }', intimacy: '{ "type": "intimacy", "count": 1 }', anniversary: '{ "type": "anniversary", "date": "MM-DD", "title": "…" }' };
        lines.push(`  "events": [${evTypes.map((x) => ex[x]).join(', ')}],`);
    }
    if (keep) lines.push('  "keepsakes": [{ "title": "…", "content": "…" }],');
    if (types.length) {
        lines.push('  "summary": "…",', '  "ops": [');
        const ex = types.map((type) => {
            const fields = type === 'character' ? charFields() : NOTE_FIELDS[type].filter((f) => f !== 'due' || cal);
            const data = fields.map((f) => `"${f}": ${f === 'quantity' ? '1' : f === 'due' ? '"YYYY-MM-DD"' : '"…"'}`).join(', ');
            return `    { "op": "add", "type": "${type}", "data": { ${data} } }`;
        });
        ex.push('    { "op": "update", "id": "…", "data": { … } }');
        const dated = types.includes('promise') || types.includes('todo');
        ex.push(dated ? '    { "op": "complete", "id": "…", "result": "…", "detail": "…" }' : '    { "op": "complete", "id": "…", "result": "…" }');
        lines.push(ex.join(',\n'), '  ]');
    } else {
        lines.push('  "summary": "…"');
    }
    lines.push('}');
    return { rules: numbered, format: lines.join('\n') };
}

/**
 * ⭐ 小劇場（v0.13.15，使用者要求）：整層是番外，不寫進正劇。只要一句話的說明（給使用者看）、
 * 值得珍藏的回憶，和之後正劇也算數的約定／待辦（只能新增）。時間、地點、日期、人物、物件都不要。
 */
function sideParts(T, vars) {
    const types = trackedNoteTypes().filter((x) => x === 'promise' || x === 'todo');
    const keep = memoriesOn() && getSettings().memories?.auto;
    const rules = [T.summarySide];
    if (keep) rules.push([T.keepsakes, `   - ${T.keepsakesSide}`].join('\n'));
    if (types.length) rules.push([T.ops, ...[T.opsSide, fill(T.opsAdd, { types: types.join(T.sep) }), fill(T.noteTitle, vars), T.noDup].map((x) => `   - ${x}`)].join('\n'));
    const lines = ['{', '  "summary": "…"' + (keep || types.length ? ',' : '')];
    if (keep) lines.push('  "keepsakes": [{ "title": "…", "content": "…" }]' + (types.length ? ',' : ''));
    if (types.length) {
        const ex = types.map((type) => `    { "op": "add", "type": "${type}", "data": { ${NOTE_FIELDS[type].filter((f) => f !== 'due').map((f) => `"${f}": "…"`).join(', ')} } }`);
        lines.push('  "ops": [', ex.join(',\n'), '  ]');
    }
    lines.push('}');
    return { rules: rules.map((r, i) => `${i + 1}. ${r}`).join('\n'), format: lines.join('\n') };
}
