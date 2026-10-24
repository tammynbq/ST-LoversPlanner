// 寬鬆的 JSON 解析：模型的回覆常常被截斷，或字串裡直接換行，JSON.parse 就整段失敗。
// 這裡盡量救回能用的部分：修正字串裡的換行，再從尾巴往回找「切在這裡、補上括號就合法」的位置。

/**
 * 回傳 { value, repaired }；完全救不回來時回傳 null。
 * repaired 為 true 表示原文不是合法 JSON（被截斷或格式有誤），內容可能不完整。
 * accept(value)：判斷救回來的結果夠不夠用（例如一定要有 summary）。
 */
export function parseJsonLenient(text, { accept = () => true } = {}) {
    const src = String(text ?? '');
    const start = src.indexOf('{');
    if (start === -1) return null;
    const body = src.slice(start);

    const end = body.lastIndexOf('}');
    if (end !== -1) {
        try {
            return { value: JSON.parse(body.slice(0, end + 1)), repaired: false };
        } catch (e) { /* 往下修 */ }
    }

    // 逐字掃一遍：字串裡的換行、tab 改成跳脫字元；記下每個「可以切斷」的位置和當時還沒關的括號。
    let out = '';
    const stack = [];
    const cuts = [];
    let inStr = false;
    let escaped = false;
    for (const ch of body) {
        if (inStr) {
            if (escaped) { escaped = false; out += ch; continue; }
            if (ch === '\\') { escaped = true; out += ch; continue; }
            if (ch === '"') { inStr = false; out += ch; continue; }
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') continue;
            if (ch === '\t') { out += '\\t'; continue; }
            out += ch;
            continue;
        }
        if (ch === '"') { inStr = true; out += ch; continue; }
        if (ch === '{' || ch === '[') { stack.push(ch === '{' ? '}' : ']'); out += ch; continue; }
        if (ch === '}' || ch === ']') {
            stack.pop();
            out += ch;
            cuts.push({ len: out.length, stack: [...stack] });
            if (!stack.length) break;
            continue;
        }
        // 逗號前面是一個完整的值：可以切在逗號之前。
        if (ch === ',') cuts.push({ len: out.length, stack: [...stack] });
        out += ch;
    }

    const attempt = (str) => {
        try { return JSON.parse(str); } catch (e) { return undefined; }
    };
    const close = (st) => [...st].reverse().join('');

    // 1. 從尾巴往回找「切在完整的值後面」的位置（最多試 400 個，避免很長的回覆卡住）。
    //    這樣不會留下寫到一半的名字之類的殘片。
    let fallback;
    for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 400; k--) {
        const value = attempt(out.slice(0, cuts[k].len) + close(cuts[k].stack));
        if (value === undefined) continue;
        if (accept(value)) return { value, repaired: true };
        fallback ??= value;
        break;
    }
    // 2. 不夠用（例如被截在摘要中間）：直接補上引號和括號，保住那段字串的前半。
    const value = attempt(out + (inStr ? (escaped ? '\\"' : '"') : '') + close(stack));
    if (value !== undefined && accept(value)) return { value, repaired: true };
    return fallback !== undefined ? { value: fallback, repaired: true } : null;
}
