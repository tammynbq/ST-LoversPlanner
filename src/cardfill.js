// 📇 從人設填寫（v0.13.16，使用者要求）：讀角色卡（描述、性格）和使用者的 persona，請模型整理成主角人物的欄位。
// 一次呼叫填兩個人（{{char}}、{{user}}）。填好的欄位標成「來自人設」（notes.js 的 cardFields）：
// 送給角色時不送（角色卡本來就會送），摘要時給模型看，故事裡改了才更新。

import { ctx, LOG_PREFIX } from './util.js';
import { t } from './i18n.js';
import { charFields } from './settings.js';
import { generateText } from './llm.js';
import { parseJsonLenient } from './json.js';
import { ApiError } from './api/custom.js';
import { charFieldRules } from './l1rules.js';
import { fillFromCardManual } from './notes.js';

/** 每份人設最多送多少字（太長的角色卡截斷，免得一次花太多）。 */
const MAX_CARD = 8000;

/** 「會一直變」的欄位不從人設填（人設寫的是基本設定，不是現在的狀態）。 */
const SKIP = new Set(['status']);

function sub(text) {
    const c = ctx();
    const s = String(text ?? '').trim();
    try {
        return typeof c?.substituteParams === 'function' ? c.substituteParams(s) : s;
    } catch {
        return s;
    }
}

/** 角色卡和 persona 的文字：{ char, user }（沒有的是空字串）。 */
export function cardTexts() {
    const c = ctx();
    const ch = c?.characters?.[c?.characterId];
    const char = [ch?.description ?? ch?.data?.description, ch?.personality ?? ch?.data?.personality]
        .map(sub).filter(Boolean).join('\n\n').slice(0, MAX_CARD);
    const pu = c?.powerUserSettings ?? c?.power_user;
    const user = sub(pu?.persona_description ?? '').slice(0, MAX_CARD);
    return { char, user };
}

export function cardFillFields() {
    return charFields().filter((f) => !SKIP.has(f));
}

export function buildCardPrompt(texts = cardTexts()) {
    const c = ctx();
    const vars = { char: c?.name2 ?? '{{char}}', user: c?.name1 ?? '{{user}}' };
    const fields = cardFillFields();
    const example = `{ ${fields.map((f) => `"${f}": "…"`).join(', ')} }`;
    return t('prompt.card', {
        ...vars,
        fields: charFieldRules(fields, vars),
        charCard: texts.char || t('prompt.card.none'),
        persona: texts.user || t('prompt.card.none'),
        example,
    });
}

/** 模型回的 { char: {...}, user: {...} }。 */
export function parseCard(raw) {
    const parsed = parseJsonLenient(raw, { accept: (v) => v && typeof v === 'object' && (v.char || v.user) });
    const obj = parsed?.value;
    if (!obj) throw new ApiError('parse', String(raw ?? '').slice(0, 120));
    const allowed = new Set(cardFillFields());
    const pick = (x) => Object.fromEntries(Object.entries(x && typeof x === 'object' ? x : {})
        .filter(([f, v]) => allowed.has(f) && typeof v === 'string' && v.trim()));
    return { char: pick(obj.char), user: pick(obj.user) };
}

let busy = false;
export function cardFillBusy() {
    return busy;
}

/** 填寫：回傳 { added, updated }，或丟錯（沒有人設內容時 ApiError('nocard')）。 */
export async function fillFromCard() {
    if (busy) return null;
    const texts = cardTexts();
    if (!texts.char && !texts.user) throw new ApiError('nocard');
    busy = true;
    try {
        const raw = await generateText(buildCardPrompt(texts), { maxTokens: 3000, purpose: 'card' });
        const fills = parseCard(raw);
        // 沒有那份人設就不填那個人（免得模型自己編）。
        if (!texts.char) fills.char = {};
        if (!texts.user) fills.user = {};
        return fillFromCardManual(fills);
    } catch (e) {
        console.warn(LOG_PREFIX, '從人設填寫失敗', e);
        throw e;
    } finally {
        busy = false;
    }
}
