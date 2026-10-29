// 預設提示詞模板，三種語言各一份。使用者可以在「設定 › 進階」修改，
// 每個模板都能恢復成預設。{{...}} 是插件自己會替換的變數。
// L1 的 {{rules}}、{{format}} 依「設定 › 記錄項目」自動產生（見 l1rules.js）；
// {{previous}}、{{notes}} 連標題一起產生，沒勾相關項目時是空的。

import { currentLocale } from './i18n.js';
import { getSettings, saveSettings } from './settings.js';

export const TEMPLATE_KEYS = ['l1', 'l2', 'l3', 'recap', 'catchup', 'audit', 'diary', 'diaryConcise', 'diaryCompress'];

export const TEMPLATE_VARS = {
    l1: ['{{char}}', '{{user}}', '{{length}}', '{{content}}', '{{rules}}', '{{previous}}', '{{notes}}', '{{format}}'],
    l2: ['{{summaries}}', '{{length}}'],
    l3: ['{{chapters}}', '{{length}}'],
    recap: ['{{recap}}', '{{length}}'],
    catchup: ['{{char}}', '{{user}}', '{{length}}', '{{content}}', '{{rules}}', '{{previous}}', '{{notes}}', '{{format}}'],
    audit: ['{{char}}', '{{user}}', '{{content}}', '{{summary}}'],
    diary: ['{{char}}', '{{user}}', '{{date}}', '{{part}}', '{{length}}', '{{max}}', '{{content}}'],
    diaryConcise: ['{{char}}', '{{user}}', '{{date}}', '{{part}}', '{{length}}', '{{max}}', '{{content}}'],
    diaryCompress: ['{{char}}', '{{user}}', '{{date}}', '{{length}}', '{{max}}', '{{points}}', '{{diary}}', '{{style}}'],
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
        diary: `你是 {{char}} 和 {{user}} 的戀人手帳的記錄員，替他們寫每一天的日記。這份日記之後會代替原文，讓 {{char}} 記得兩人一起經歷過什麼：要記得發生了什麼事，也要記得當時的心情。它是戀人的回憶，不是報告，也不是小說。

下面是故事裡 {{date}} 這一天{{part}}的內容。有些是原文，有些是之前寫好的單層摘要（標「［摘要］」）。請用繁體中文、第三人稱寫成日記。

第一步，列 points：這一天之後還會用到的事，每條一句、具體（誰、做了什麼、說了什麼），標「重大」或「中等」，照時間順序，最多 12 條。快速看過最容易漏的是這些，請逐項找一遍：
- 約定和計畫：要做什麼、什麼時候、誰答應誰。
- 關係的變化：稱呼的改變（例如叫老公、未婚夫）、說出口的心意或承諾、兩人立下的規矩或默契、暗號、一直延續的梗。
- 對彼此家人、朋友的態度；新出現的人物和身分。
- 為對方做的事：照顧（買吃的、接送、按摩）、保護（包括用能力保護對方）、送的東西。這類一句帶過就好，但不要漏。
- 重要的物品（戒指、禮物）、第一次發生的事、身體或健康狀況、爭吵與和好、伏筆。

第二步，寫 summary：
- 這篇是 {{date}} 的日記。內容開頭可能接著前一天的事、結尾可能已經到隔天：前一天延續過來的寫成「前一晚……」一句帶過；原文說「第二天」「隔天」時，對照上下文判斷是不是就是 {{date}}；真的到了隔天的事寫「隔天早上……」。
- 照時間順序，每一條 points 都要寫進去；篇幅夠才寫其他的。
- 用自然的敘述寫，像在回憶這一天：句子之間有連接（因為、後來、於是、直到），讓人讀得出事情怎麼一步步發生。不要一條一條排列。
- 留住情感：重要的時刻帶一句當時的心情或那句話的分量，可以留一個透露在乎的小動作（例如「捧著她的臉」「笑著不介意」）。只寫原文看得出來的情緒，不要自己加。
- 不是小說：不描寫景色、衣服，不寫一連串的動作；小事一句帶過。
- 不要每句都標時間；只在換時段時寫（早上、下午、傍晚、晚上、隔天早上），或原文特別標明的重要時刻。不確定就不寫，不要推測。
- 親密場面只寫有發生和它的意義（例如第一次、說了什麼重要的話），不寫過程。
- 衣服、天氣、狀態欄數值不用寫，除非之後劇情會用到。
- 番外、小劇場、IF 線不是正劇，只寫一句「另有番外」。
- {{user}} 的 OOC（括號裡對 AI 的說明、要求、指示）不是劇情，不寫進日記。
- 不要加入原文沒有的事，不要評論。看不太懂的句子照原文的意思寫，不要猜成別的意思。
- 長度大約 {{length}} 字，最多不要超過 {{max}} 字；寫不下時先縮短「中等」的事，不要刪「重大」的事。
- 寫完再對一次 points：每一條都寫進去了嗎？約定有沒有寫清楚時間和誰答應誰？

範例（別的故事，只看寫法）：
{"points":["重大｜顧言第一次帶林曉回家見父母，父親冷淡、母親送她一只玉鐲","中等｜顧言替林曉擋下父親敬的酒，回程替她揉太陽穴","重大｜林曉說「我想跟你有個家」，顧言答應年底前一起看房","中等｜兩人約好以後吵架不過夜"],"time":"中午～深夜","location":"顧家、車上","summary":"中午顧言第一次帶林曉回家見父母。父親一直很冷淡，林曉緊張得手心冒汗，倒是母親拉著她聊了一下午，臨走還塞給她一只玉鐲。晚餐時父親舉杯敬她，顧言不動聲色地替她擋了下來。回程的車上，林曉看著窗外忽然說「我想跟你有個家」，顧言愣了一下，握住她的手答應年底前一起去看房，又替喝了兩杯、有點頭疼的她揉太陽穴。睡前兩人約好，以後吵架不過夜。"}

這一天的內容：
{{content}}

只輸出下面格式的 JSON，不要輸出其他文字：
{"points":["重大｜…","中等｜…"],"time":"這一天的時間範圍","location":"主要地點（最多 3 個，用、分開）","summary":"日記內容"}`,
        diaryConcise: `你是故事記錄員，負責替 {{char}} 和 {{user}} 的故事寫日記。這份日記之後會代替原文，讓 {{char}} 記得發生過什麼，所以要寫「之後還用得到的事」，不是寫小說。

下面是故事裡 {{date}} 這一天{{part}}的內容。有些是原文，有些是之前寫好的單層摘要（標「［摘要］」）。請用繁體中文、第三人稱寫成日記。

第一步，列 points：這一天之後還會用到的事，每條一句、具體（誰、做了什麼、說了什麼），標「重大」或「中等」，照時間順序，最多 12 條。快速看過最容易漏的是這些，請逐項找一遍：
- 約定和計畫：要做什麼、什麼時候、誰答應誰。
- 關係的變化：稱呼的改變、說出口的心意或承諾、兩人立下的規矩或默契、暗號、一直延續的梗。
- 對彼此家人、朋友的態度；新出現的人物和身分。
- 為對方做的事：照顧、保護（包括用能力保護對方）、送的東西。一句帶過，但不要漏。
- 重要的物品、第一次發生的事、身體或健康狀況、爭吵與和好、伏筆。

第二步，寫 summary：
- 這篇是 {{date}} 的日記。前一天延續過來的寫成「前一晚……」一句帶過；真的到了隔天的事寫「隔天早上……」。
- 照時間順序，每一條 points 都要寫進去；summary 不要照抄 points，同一件事用更短的說法，把相關的小事併成一句。
- 寫法要精簡：一句話放一件事，用「、」「；」把小事串起來，不要描寫動作、表情、景色。
- 不要每句都標時間；只在換時段時寫。不確定就不寫。
- 親密場面只寫有發生和它的意義，不寫過程。番外、小劇場、IF 線只寫一句「另有番外」。
- {{user}} 的 OOC（括號裡對 AI 的說明、要求、指示）不是劇情，不寫進日記。
- 不要加入原文沒有的事，不要評論。
- 長度大約 {{length}} 字，最多不要超過 {{max}} 字；寫不下時先縮短「中等」的事，不要刪「重大」的事。

這一天的內容：
{{content}}

只輸出下面格式的 JSON，不要輸出其他文字：
{"points":["重大｜…","中等｜…"],"time":"這一天的時間範圍","location":"主要地點（最多 3 個，用、分開）","summary":"日記內容"}`,
        diaryCompress: `你是 {{char}} 和 {{user}} 的戀人手帳的記錄員。這份日記之後會代替原文，讓 {{char}} 記得發生過什麼。

下面是故事裡 {{date}} 這一天的日記，以及要留下的重點。請把它重寫成一篇更短的日記，用繁體中文、第三人稱、照時間順序，長度大約 {{length}} 字，最多不要超過 {{max}} 字。

壓縮不是刪句子，是換更短的說法：
- 把過程換成結果、把原句換成轉述、把同類的小事併成一句（例如「替她暖手、擋風、做晚餐」）。
- 時間只留換時段的（早上、傍晚、晚上），不要每件事都標幾點幾分。

不能刪的（可以寫短，但要在）：
- 「重點」裡的每一條。
- 約定和計畫：做什麼、什麼時候、誰答應誰；兩人的規矩、默契、暗號；還沒解決的事。
- 稱呼和關係的變化、說出口的重要心意、第一次發生的事；名字、數字、日期；重要的物品；身體狀況。

前因後果要留：之後還會被提起的事，要留下「為什麼」和「是什麼」，不能只留結果。例如只寫「週五要算帳」不夠，要寫出帳上記的是什麼、為什麼記。

先刪的：動作、表情、景色的描寫；吃了什麼、家事、衣服、天氣的細節；重複的話；和後面沒有關係的小插曲。{{style}}

寫完自己檢查一次：一個沒看過原文的人只看這篇，能不能看懂每件事的來龍去脈？「重點」裡的每一條都還在嗎？

重點：
{{points}}

原本的日記：
{{diary}}

只輸出下面格式的 JSON，不要輸出其他文字：
{"summary":"日記內容"}`,
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
        diary: `你是 {{char}} 和 {{user}} 的恋人手帐的记录员，替他们写每一天的日记。这份日记之后会代替原文，让 {{char}} 记得两人一起经历过什么：要记得发生了什么事，也要记得当时的心情。它是恋人的回忆，不是报告，也不是小说。

下面是故事里 {{date}} 这一天{{part}}的内容。有些是原文，有些是之前写好的单层摘要（标「［摘要］」）。请用简体中文、第三人称写成日记。

第一步，列 points：这一天之后还会用到的事，每条一句、具体（谁、做了什么、说了什么），标「重大」或「中等」，照时间顺序，最多 12 条。快速看过最容易漏的是这些，请逐项找一遍：
- 约定和计划：要做什么、什么时候、谁答应谁。
- 关系的变化：称呼的改变（例如叫老公、未婚夫）、说出口的心意或承诺、两人立下的规矩或默契、暗号、一直延续的梗。
- 对彼此家人、朋友的态度；新出现的人物和身分。
- 为对方做的事：照顾（买吃的、接送、按摩）、保护（包括用能力保护对方）、送的东西。这类一句带过就好，但不要漏。
- 重要的物品（戒指、礼物）、第一次发生的事、身体或健康状况、争吵与和好、伏笔。

第二步，写 summary：
- 这篇是 {{date}} 的日记。内容开头可能接著前一天的事、结尾可能已经到隔天：前一天延续过来的写成「前一晚……」一句带过；原文说「第二天」「隔天」时，对照上下文判断是不是就是 {{date}}；真的到了隔天的事写「隔天早上……」。
- 照时间顺序，每一条 points 都要写进去；篇幅够才写其他的。
- 用自然的叙述写，像在回忆这一天：句子之间有连接（因为、后来、于是、直到），让人读得出事情怎么一步步发生。不要一条一条排列。
- 留住情感：重要的时刻带一句当时的心情或那句话的分量，可以留一个透露在乎的小动作（例如「捧著她的脸」「笑著不介意」）。只写原文看得出来的情绪，不要自己加。
- 不是小说：不描写景色、衣服，不写一连串的动作；小事一句带过。
- 不要每句都标时间；只在换时段时写（早上、下午、傍晚、晚上、隔天早上），或原文特别标明的重要时刻。不确定就不写，不要推测。
- 亲密场面只写有发生和它的意义（例如第一次、说了什么重要的话），不写过程。
- 衣服、天气、状态栏数值不用写，除非之后剧情会用到。
- 番外、小剧场、IF 线不是正剧，只写一句「另有番外」。
- {{user}} 的 OOC（括号里对 AI 的说明、要求、指示）不是剧情，不写进日记。
- 不要加入原文没有的事，不要评论。看不太懂的句子照原文的意思写，不要猜成别的意思。
- 长度大约 {{length}} 字，最多不要超过 {{max}} 字；写不下时先缩短「中等」的事，不要删「重大」的事。
- 写完再对一次 points：每一条都写进去了吗？约定有没有写清楚时间和谁答应谁？

范例（别的故事，只看写法）：
{"points":["重大｜顾言第一次带林晓回家见父母，父亲冷淡、母亲送她一只玉镯","中等｜顾言替林晓挡下父亲敬的酒，回程替她揉太阳穴","重大｜林晓说「我想跟你有个家」，顾言答应年底前一起看房","中等｜两人约好以后吵架不过夜"],"time":"中午～深夜","location":"顾家、车上","summary":"中午顾言第一次带林晓回家见父母。父亲一直很冷淡，林晓紧张得手心冒汗，倒是母亲拉著她聊了一下午，临走还塞给她一只玉镯。晚餐时父亲举杯敬她，顾言不动声色地替她挡了下来。回程的车上，林晓看著窗外忽然说「我想跟你有个家」，顾言愣了一下，握住她的手答应年底前一起去看房，又替喝了两杯、有点头疼的她揉太阳穴。睡前两人约好，以后吵架不过夜。"}

这一天的内容：
{{content}}

只输出下面格式的 JSON，不要输出其他文字：
{"points":["重大｜…","中等｜…"],"time":"这一天的时间范围","location":"主要地点（最多 3 个，用、分开）","summary":"日记内容"}`,
        diaryConcise: `你是故事记录员，负责替 {{char}} 和 {{user}} 的故事写日记。这份日记之后会代替原文，让 {{char}} 记得发生过什么，所以要写「之后还用得到的事」，不是写小说。

下面是故事里 {{date}} 这一天{{part}}的内容。有些是原文，有些是之前写好的单层摘要（标「［摘要］」）。请用简体中文、第三人称写成日记。

第一步，列 points：这一天之后还会用到的事，每条一句、具体（谁、做了什么、说了什么），标「重大」或「中等」，照时间顺序，最多 12 条。快速看过最容易漏的是这些，请逐项找一遍：
- 约定和计划：要做什么、什么时候、谁答应谁。
- 关系的变化：称呼的改变、说出口的心意或承诺、两人立下的规矩或默契、暗号、一直延续的梗。
- 对彼此家人、朋友的态度；新出现的人物和身分。
- 为对方做的事：照顾、保护（包括用能力保护对方）、送的东西。一句带过，但不要漏。
- 重要的物品、第一次发生的事、身体或健康状况、争吵与和好、伏笔。

第二步，写 summary：
- 这篇是 {{date}} 的日记。前一天延续过来的写成「前一晚……」一句带过；真的到了隔天的事写「隔天早上……」。
- 照时间顺序，每一条 points 都要写进去；summary 不要照抄 points，同一件事用更短的说法，把相关的小事并成一句。
- 写法要精简：一句话放一件事，用「、」「；」把小事串起来，不要描写动作、表情、景色。
- 不要每句都标时间；只在换时段时写。不确定就不写。
- 亲密场面只写有发生和它的意义，不写过程。番外、小剧场、IF 线只写一句「另有番外」。
- {{user}} 的 OOC（括号里对 AI 的说明、要求、指示）不是剧情，不写进日记。
- 不要加入原文没有的事，不要评论。
- 长度大约 {{length}} 字，最多不要超过 {{max}} 字；写不下时先缩短「中等」的事，不要删「重大」的事。

这一天的内容：
{{content}}

只输出下面格式的 JSON，不要输出其他文字：
{"points":["重大｜…","中等｜…"],"time":"这一天的时间范围","location":"主要地点（最多 3 个，用、分开）","summary":"日记内容"}`,
        diaryCompress: `你是 {{char}} 和 {{user}} 的恋人手帐的记录员。这份日记之后会代替原文，让 {{char}} 记得发生过什么。

下面是故事里 {{date}} 这一天的日记，以及要留下的重点。请把它重写成一篇更短的日记，用简体中文、第三人称、照时间顺序，长度大约 {{length}} 字，最多不要超过 {{max}} 字。

压缩不是删句子，是换更短的说法：
- 把过程换成结果、把原句换成转述、把同类的小事并成一句（例如「替她暖手、挡风、做晚餐」）。
- 时间只留换时段的（早上、傍晚、晚上），不要每件事都标几点几分。

不能删的（可以写短，但要在）：
- 「重点」里的每一条。
- 约定和计划：做什么、什么时候、谁答应谁；两人的规矩、默契、暗号；还没解决的事。
- 称呼和关系的变化、说出口的重要心意、第一次发生的事；名字、数字、日期；重要的物品；身体状况。

前因后果要留：之后还会被提起的事，要留下「为什么」和「是什么」，不能只留结果。例如只写「周五要算帐」不够，要写出帐上记的是什么、为什么记。

先删的：动作、表情、景色的描写；吃了什么、家事、衣服、天气的细节；重复的话；和后面没有关系的小插曲。{{style}}

写完自己检查一次：一个没看过原文的人只看这篇，能不能看懂每件事的来龙去脉？「重点」里的每一条都还在吗？

重点：
{{points}}

原本的日记：
{{diary}}

只输出下面格式的 JSON，不要输出其他文字：
{"summary":"日记内容"}`,
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
        diary: `You keep the lovers' journal of {{char}} and {{user}} and write a diary entry for each day. The diary will later replace the original text so that {{char}} remembers what the two of them went through: what happened, and how it felt. It is a couple's memory, not a report and not a novel.

Below is the content of {{date}}{{part}} in the story. Some of it is original text, some is per-floor summaries written earlier (marked "[summary]"). Write the diary in English, in the third person.

Step 1, list points: things from this day that will matter later, one concrete sentence each (who, did what, said what), marked "major" or "minor", in time order, at most 12. These are the easiest to miss on a quick read, so check for each:
- Promises and plans: what, when, who promised whom.
- Changes in the relationship: new ways of addressing each other (e.g. husband, fiancé), feelings or promises said aloud, rules or understandings between them, code words, running jokes.
- Attitudes toward each other's family and friends; new people and who they are.
- Things done for each other: care (buying food, picking up, massages), protection (including using powers), gifts. One line each, but do not leave them out.
- Important objects (rings, gifts), firsts, health or physical condition, fights and making up, foreshadowing.

Step 2, write the summary:
- This is the entry for {{date}}. The content may start with the end of the previous day and end in the next day: write what carries over from the previous day as one line ("The night before…"); when the text says "the next day", check whether that is {{date}} itself; things that really happen the next day go under "The next morning…".
- In time order, include every point; write other things only if there is room.
- Write natural narration, like remembering the day: connect sentences (because, later, so, until) so the reader can follow how things unfolded. Do not write a list.
- Keep the feelings: give important moments one line about how it felt or how much the words meant, and you may keep one small gesture that shows care (e.g. "cupped her face", "laughed it off"). Only feelings the text shows; do not add your own.
- Not a novel: no scenery or clothes, no chains of actions; small things in one line.
- Do not timestamp every sentence; only mark changes of time of day (morning, afternoon, evening, night, the next morning) or moments the text marks as important. If unsure, leave the time out; do not guess.
- Intimate scenes: only that they happened and what they meant (e.g. a first, important words), not the process.
- Clothes, weather and status-bar numbers are not needed unless the story will use them.
- Side stories, special chapters and IF lines are not the main story: write only "There was also a side story."
- {{user}}'s OOC (notes, requests or instructions to the AI, usually in brackets) is not part of the story; leave it out.
- Do not add anything that is not in the text, and do not comment. If a sentence is unclear, keep its original meaning; do not guess a different one.
- About {{length}} words, at most {{max}}; if it does not fit, shorten the minor points first; never drop major ones.
- When done, check the points again: is every one included? Do promises say when, and who promised whom?

Example (a different story, for style only):
{"points":["major|Gu Yan brought Lin Xiao home to meet his parents for the first time; his father was cold, his mother gave her a jade bracelet","minor|Gu Yan took the toast his father offered her, and rubbed her temples on the drive back","major|Lin Xiao said \\"I want a home with you\\"; Gu Yan promised they would look at flats before the end of the year","minor|They agreed never to go to bed angry"],"time":"noon to late night","location":"Gu family home, car","summary":"At noon Gu Yan brought Lin Xiao home to meet his parents for the first time. His father stayed cold the whole time and Lin Xiao's palms were sweating, but his mother chatted with her all afternoon and pressed a jade bracelet into her hand as they left. At dinner his father raised a glass to her, and Gu Yan quietly drank it for her. On the drive back Lin Xiao looked out of the window and suddenly said, \\"I want a home with you.\\" Gu Yan paused, took her hand and promised they would look at flats before the end of the year, then rubbed her temples, a little sore after two glasses. Before bed they agreed never to go to bed angry."}

The content of this day:
{{content}}

Output only JSON in the format below, nothing else:
{"points":["major|…","minor|…"],"time":"time range of the day","location":"main places (at most 3, comma-separated)","summary":"diary entry"}`,
        diaryConcise: `You are the story keeper for {{char}} and {{user}} and write a diary entry for each day. It will later replace the original text so that {{char}} remembers what happened, so write what will matter later; this is not a novel.

Below is the content of {{date}}{{part}} in the story. Some of it is original text, some is per-floor summaries written earlier (marked "[summary]"). Write the diary in English, in the third person.

Step 1, list points: things from this day that will matter later, one concrete sentence each, marked "major" or "minor", in time order, at most 12. Check for: promises and plans (what, when, who promised whom); changes in the relationship (ways of addressing each other, feelings or promises said aloud, rules, code words, running jokes); attitudes to family and friends, new people; things done for each other (care, protection, gifts); important objects, firsts, health, fights and making up, foreshadowing.

Step 2, write the summary:
- This is the entry for {{date}}. Write what carries over from the previous day as "The night before…", and what really happens the next day as "The next morning…".
- In time order, include every point; do not copy the points word for word; merge related small things into one sentence.
- Be concise: one event per sentence, small things joined with commas; no description of actions, expressions or scenery.
- Only mark changes of time of day. If unsure, leave the time out.
- Intimate scenes: only that they happened and what they meant. Side stories and IF lines: only "There was also a side story."
- {{user}}'s OOC (notes, requests or instructions to the AI) is not part of the story; leave it out.
- Do not add anything that is not in the text, and do not comment.
- About {{length}} words, at most {{max}}; shorten minor points first; never drop major ones.

The content of this day:
{{content}}

Output only JSON in the format below, nothing else:
{"points":["major|…","minor|…"],"time":"time range of the day","location":"main places (at most 3, comma-separated)","summary":"diary entry"}`,
        diaryCompress: `You keep the lovers' journal of {{char}} and {{user}}. This diary will replace the original text so that {{char}} remembers what happened.

Below are the diary entry for {{date}} and the points that must stay. Rewrite it as a shorter entry in English, third person, in time order, about {{length}} words, at most {{max}}.

Compressing is not deleting sentences; it is saying things more briefly:
- Turn processes into results, quotes into reported speech, and merge similar small things into one sentence (e.g. "warmed her hands, shielded her from the wind, made dinner").
- Keep only changes of time of day (morning, evening, night), not exact times for everything.

Must stay (shorter is fine, but present):
- Every one of the points.
- Promises and plans: what, when, who promised whom; rules, understandings and code words between them; anything unresolved.
- New ways of addressing each other, important feelings said aloud, firsts; names, numbers, dates; important objects; physical condition.

Keep causes and reasons: for anything that will come up later, keep the why and the what, not just the result. "They will settle the score on Friday" is not enough; say what is on the score and why.

Cut first: descriptions of actions, expressions and scenery; details of food, chores, clothes and weather; repetition; small episodes unrelated to what follows.{{style}}

When done, check: could someone who never read the original follow every event from this entry alone? Is every point still there?

Points:
{{points}}

Original entry:
{{diary}}

Output only JSON in the format below, nothing else:
{"summary":"diary entry"}`,
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
