// 聊天畫面：每條 AI 訊息下面那個可以折疊的摘要區塊。操作按鈕都收在這裡面。

import { ctx, escapeHtml as esc, toast } from '../util.js';
import { getSettings, isTracked } from '../settings.js';
import { t } from '../i18n.js';
import { getChat, getEntry, isAiMessage, lastAiIndex } from '../chat.js';
import { enqueue, floorState, floorVersions, isActive, onSummaryChange, restoreVersion, sideFloor, skipFloor, unsideFloor, unskipFloor, writeSummary } from '../summarize.js';
import { describeOp, getNotes, onNotesChange, opType, setFloorOpUndone } from '../notes.js';
import { computeHidden } from '../hide.js';
import { calendarOn, calTracked } from '../calendar.js';
import { addMemory, memoriesOn } from '../memories.js';
import { floorOf, onSentChange, receiptOf } from '../sent.js';

const expanded = new Set(); // 展開中的樓層
const lastHtml = new WeakMap(); // 每個摘要區塊上次畫的內容
const editing = new Set(); // 正在手動編輯的樓層

export const STATUS_ICONS = {
    none: 'fa-regular fa-circle',
    queued: 'fa-solid fa-hourglass-half',
    busy: 'fa-solid fa-spinner fa-spin',
    ok: 'fa-solid fa-check',
    stale: 'fa-solid fa-triangle-exclamation',
    fail: 'fa-solid fa-circle-xmark',
    // 👻／⭐ 已經寫在文字裡。
    skip: '',
    side: '',
};

/** 每種狀態可以做的操作。摘要區塊和大視窗共用。 */
export function actionsFor(state, index = null) {
    // 粗略補建的樓層：沒有單層摘要，要細摘請到大視窗的那一章按「改成逐層細摘」。
    if (state === 'ok' && index !== null && getEntry(index)?.coarse) return [];
    switch (state) {
        case 'none': return ['summarize', 'skip', 'side'];
        case 'ok': return memoriesOn() ? ['edit', 'redo', 'skip', 'side', 'keep'] : ['edit', 'redo', 'skip', 'side'];
        case 'stale': return ['redo', 'edit', 'skip', 'side'];
        case 'fail': return ['retry', 'write', 'skip', 'side'];
        case 'skip': return ['unskip', 'side'];
        case 'side': return ['unside', 'sideredo', 'skip'];
        default: return [];
    }
}

/** 狀態的說明文字（沒有摘要內容時顯示）。 */
export function hintFor(index, state) {
    const entry = getEntry(index);
    switch (state) {
        case 'none': {
            const latest = index === lastAiIndex();
            const mode = getSettings().summary.mode;
            if (latest && mode === 'before') return t('sum.hint.latest');
            // 「正文結束後」模式下，最新一層還沒摘要通常是因為還在生成中。
            if (latest && mode === 'after' && getChat().length - 1 === index) return t('sum.hint.waitReply');
            return t('sum.hint.manual');
        }
        case 'skip': return t('sum.hint.skip');
        case 'side':
            if (entry?.error) return t('sum.hint.sideFail', { error: entry.error });
            // 標了小劇場但還沒讀（排隊時換了聊天、重新整理）：回憶和約定還沒記。
            return entry?.pending ? t('sum.hint.sidePending') : t('sum.hint.side');
        case 'fail': return t('sum.hint.fail', { error: entry?.error ?? '' });
        case 'stale': return t('sum.hint.stale');
        case 'ok': return entry?.coarse ? t('sum.hint.coarse') : '';
        default: return '';
    }
}

/** 「誰寫的」：模型名稱，手動改的寫「手動修改」。 */
export function byLabel(by) {
    if (!by) return '';
    return by === 'manual' ? t('ver.manual') : by;
}

/** 摘要下面那一行：「由 deepseek-chat 摘要」或「手動修改過」。 */
export function byLine(by) {
    return by === 'manual' ? t('ver.editedByHand') : t('ver.by', { by });
}

function ago(at) {
    const m = Math.max(0, Math.round((Date.now() - (Number(at) || 0)) / 60000));
    if (m < 1) return t('ver.justNow');
    if (m < 60) return t('ver.minutes', { n: m });
    const h = Math.round(m / 60);
    return h < 48 ? t('ver.hours', { n: h }) : t('ver.days', { n: Math.round(h / 24) });
}

/**
 * 其他版本（重做、手動修改之前的）：可以展開比較，按「用這一版」換回來。
 * attr：按鈕要帶的屬性（摘要區塊用 data-lp-act，大視窗用 data-action）。
 */
export function versionsHtml(index, { panel = false } = {}) {
    const list = floorVersions(index);
    if (!list.length) return '';
    const btn = (k) => (panel
        ? `<button type="button" class="menu_button lp-btn lp-mini" data-action="sum-restore" data-index="${index}" data-k="${k}">${esc(t('ver.use'))}</button>`
        : `<button type="button" class="menu_button lp-btn lp-mini" data-lp-act="restore" data-k="${k}">${esc(t('ver.use'))}</button>`);
    const rows = list.map((v, k) => `
        <li class="lp-ver" data-ver="${k}">
          <div class="lp-row"><span class="lp-note">${esc([byLabel(v.by) || t('ver.unknown'), ago(v.at)].join('・'))}</span><span class="lp-spacer"></span>${btn(k)}</div>
          <div class="lp-ver-text">${esc(v.summary ?? '')}</div>
        </li>`).join('');
    return `<details class="lp-versions" data-role="versions"><summary>${esc(t('ver.title', { n: list.length }))}</summary><ul class="lp-ver-list">${rows}</ul></details>`;
}

const why = (reason, score) => {
    const label = ['pinnedMemory', 'random'].includes(reason) ? t(`sent.why.${reason}`) : t(`preview.why.${reason}`);
    return `<span class="lp-why${reason === 'vector' ? ' lp-why-vec' : ''}">${esc(typeof score === 'number' ? `${label} ${score}%` : label)}</span>`;
};

/** 「這一回送了什麼」：這則回覆生成時送出的記事、召回的舊樓層和想起的回憶（v0.13.30）。 */
export function sentHtml(index) {
    const r = receiptOf(index);
    if (!r) return '';
    const parts = [t('sent.notesPart', { sent: r.notesSent, total: r.notesTotal })];
    if (r.floors.length) parts.push(t('sent.floorsPart', { n: r.floors.length }));
    if (r.reminders.length) parts.push(t('sent.remPart', { n: r.reminders.length }));
    const list = (items) => `<ul>${items.join('')}</ul>`;
    let html = '';
    if (r.type === 'continue') html += `<div class="lp-note">${esc(t('sent.continue'))}</div>`;
    if (!r.filtered) html += `<div class="lp-sent-sec">${esc(t('sent.notesAll', { n: r.notesTotal }))}</div>`;
    else if (r.notes.length) {
        html += `<div class="lp-sent-sec">${esc(t('sent.notes', { sent: r.notesSent, skip: Math.max(0, r.notesTotal - r.notesSent) }))}</div>`;
        html += list(r.notes.map((n) => `<li>${n.type && n.type !== 'character' ? `${esc(t(`type.${n.type}`))}：` : ''}${esc(n.title)} ${why(n.reason, n.score)}</li>`));
    }
    if (r.floors.length) {
        html += `<div class="lp-sent-sec">${esc(t('sent.floors', { n: r.floors.length }))}</div>`;
        html += list(r.floors.map((f) => {
            const i = floorOf(f);
            const at = i === null ? `<span class="lp-note">${esc(t('sent.floorGone'))}</span>` : `<button type="button" class="lp-link" data-lp-act="sent-jump" data-floor="${i}">#${i}</button>`;
            return `<li>${at} ${esc(f.line)} ${why(f.reason, f.score)}</li>`;
        }));
    }
    if (r.reminders.length) {
        html += `<div class="lp-sent-sec">${esc(t('sent.reminders', { n: r.reminders.length }))}</div>`;
        html += list(r.reminders.map((m) => `<li>${esc(m.title)} ${why(m.reason === 'pinned' ? 'pinnedMemory' : 'random')}</li>`));
    }
    if (r.filtered && !r.notes.length && !r.floors.length && !r.reminders.length) html += `<div class="lp-note">${esc(t('sent.none'))}</div>`;
    const vector = r.vector === 'ok' ? t('sent.vector.ok', { n: r.fetched }) : r.vector === 'error' ? t('sent.vector.error', { error: r.error }) : t('sent.vector.off');
    html += `<div class="lp-sent-foot${r.vector === 'error' ? ' lp-warn' : ''}">${esc(vector)}<br>${esc(t('sent.tokens', { n: r.injectedTokens.toLocaleString(), saved: r.hiddenTokens.toLocaleString() }))}</div>`;
    return `<details class="lp-sent" data-role="sent"><summary>${esc(t('sent.title'))} <span class="lp-sent-sum">${esc(parts.join('・'))}</span></summary>${html}</details>`;
}

/** 執行一個操作；回傳 true 表示需要進入編輯模式。 */
export function runAction(index, act) {
    switch (act) {
        case 'summarize':
        case 'redo':
        case 'retry':
            enqueue(index, { front: true });
            return false;
        case 'skip':
            skipFloor(index);
            return false;
        case 'unskip':
            unskipFloor(index);
            return false;
        case 'side':
        case 'sideredo':
            sideFloor(index);
            return false;
        case 'unside':
            unsideFloor(index);
            return false;
        case 'edit':
        case 'write':
            return true;
        case 'keep': {
            // 收藏成回憶：先用這一層的摘要，之後可以在回憶錄改。
            const e = getEntry(index);
            if (addMemory({ content: e?.summary ?? '', floor: index })) toast(t('mem.kept'), 'success');
            return false;
        }
        default:
            return false;
    }
}

/** 時間、地點、出場人物那一行。沒有就回傳空字串。 */
export function sceneHtml(entry) {
    if (!entry) return '';
    const items = [
        ['date', 'fa-regular fa-calendar', calendarOn() ? entry.date : ''],
        ['time', 'fa-regular fa-clock', isTracked('time') ? entry.time : ''],
        ['location', 'fa-solid fa-location-dot', isTracked('location') ? entry.location : ''],
        ['characters', 'fa-solid fa-user-group', isTracked('cast') ? (entry.characters ?? []).join('、') : ''],
    ].filter(([, , v]) => v);
    // 這一層的行事曆事件（行程、生理期、親熱、紀念日）。
    const events = (entry.events ?? []).filter((ev) => calTracked(ev.type)).map((ev) => `<span class="lp-scene-item lp-cal-chip">${esc(eventLabel(ev))}</span>`);
    if (!items.length && !events.length) return '';
    return `<div class="lp-scene">${items.map(([k, icon, v]) =>
        `<span class="lp-scene-item"><span class="${icon}" aria-hidden="true"></span><span class="lp-sr">${esc(t(`meta.${k}`))}：</span>${esc(v)}</span>`).join('')}${events.join('')}</div>`;
}

/** 一個行事曆事件的簡短文字（摘要區塊、行事曆分頁共用）。 */
export function eventLabel(ev) {
    switch (ev.type) {
        case 'plan': return `📌 ${ev.date ? `${ev.date.slice(5)} ` : ''}${ev.title}`;
        case 'period': return `🩸 ${t(ev.state === 'end' ? 'cal.periodEnd' : 'cal.periodStart')}`;
        case 'intimacy': return `💕 ${t('cal.intimacyN', { n: ev.count ?? 1 })}`;
        case 'anniversary': return `🎂 ${ev.date} ${ev.title}`;
        default: return '';
    }
}

/** 這一層造成的記事變化，每條可以撤銷／恢復。 */
export function changesHtml(index, { actions = true } = {}) {
    const { notes, perFloor } = getNotes();
    // 沒勾選要記錄的類型不顯示（資料還在）。
    const list = (perFloor.get(index) ?? []).filter(({ op }) => isTracked(opType(op, notes)));
    if (!list.length) return '';
    const rows = list.map(({ op, k, valid }) => {
        const undone = Boolean(op.undone);
        const label = !undone && !valid ? `${describeOp(op, notes)} ${t('changes.invalid')}` : describeOp(op, notes);
        const btn = !actions ? '' : undone
            ? `<button type="button" class="menu_button lp-btn lp-mini" data-lp-act="redo-op" data-k="${k}">${esc(t('changes.redo'))}</button>`
            : (valid ? `<button type="button" class="menu_button lp-btn lp-mini" data-lp-act="undo-op" data-k="${k}">${esc(t('changes.undo'))}</button>` : '');
        return `<li class="lp-change${undone ? ' lp-undone' : ''}${!undone && !valid ? ' lp-invalid' : ''}"><span>${esc(label)}</span>${btn}</li>`;
    }).join('');
    return `<div class="lp-changes"><div class="lp-changes-title">${esc(t('changes.title'))}</div><ul>${rows}</ul></div>`;
}

function editorHtml(entry) {
    const v = (x) => esc(x ?? '');
    // 沒勾選的欄位不顯示；儲存時沿用原本的值。
    const time = isTracked('time') ? `<label class="lp-field"><span class="lp-label">${esc(t('meta.time'))}</span><input type="text" class="text_pole" data-field="time" value="${v(entry?.time)}"></label>` : '';
    const location = isTracked('location') ? `<label class="lp-field"><span class="lp-label">${esc(t('meta.location'))}</span><input type="text" class="text_pole" data-field="location" value="${v(entry?.location)}"></label>` : '';
    const date = calendarOn() ? `<label class="lp-field"><span class="lp-label">${esc(t('meta.date'))}</span><input type="date" class="text_pole" data-field="date" value="${v(entry?.date)}"></label>` : '';
    const cast = isTracked('cast') ? `<label class="lp-field"><span class="lp-label">${esc(t('meta.characters'))}</span><input type="text" class="text_pole" data-field="characters" value="${v((entry?.characters ?? []).join('、'))}" placeholder="${esc(t('meta.charactersHint'))}"></label>` : '';
    return `
      ${time || location ? `<div class="lp-editor-grid">${time}${location}</div>` : ''}
      ${date}
      ${cast}
      <label class="lp-field"><span class="lp-label">${esc(t('meta.summary'))}</span><textarea class="text_pole lp-sum-editor" data-field="summary" placeholder="${esc(t('sum.editPlaceholder'))}">${v(entry?.summary)}</textarea></label>
      <div class="lp-sum-actions">
        <button type="button" class="menu_button lp-btn lp-primary" data-lp-act="save">${esc(t('act.save'))}</button>
        <button type="button" class="menu_button lp-btn" data-lp-act="cancel">${esc(t('act.cancel'))}</button>
      </div>`;
}

/**
 * 目前會被隱藏的樓層（只用來在摘要區塊上標「已隱藏」）。
 * v0.13.29 修：酒館打開聊天時每畫一則訊息就通知一次，以前每次都把整個聊天重算一遍，
 * 3000 多則的聊天（而且幾乎全部隱藏）會卡好幾分鐘。現在算一次記住，摘要、記事、訊息變了，或過了 2 秒才重算。
 * 送出時的攔截器不用這個，它每次都精確地重算。
 */
const HIDDEN_TTL_MS = 2000;
let hiddenCache = null; // { at, len, set }
function hiddenNow() {
    const len = getChat().length;
    if (hiddenCache && hiddenCache.len === len && Date.now() - hiddenCache.at < HIDDEN_TTL_MS) return hiddenCache.set;
    hiddenCache = { at: Date.now(), len, set: isActive() ? computeHidden().hidden : new Set() };
    return hiddenCache.set;
}
function invalidateHidden() {
    hiddenCache = null;
}

function blockHtml(index) {
    const state = floorState(index);
    const entry = getEntry(index);
    const summary = state === 'skip' ? '' : (entry?.summary ?? '');
    const open = expanded.has(index) || editing.has(index);
    const preview = summary || hintFor(index, state);

    let body = '';
    if (open) {
        if (editing.has(index)) {
            body = editorHtml(state === 'skip' ? null : entry);
        } else {
            let hint = summary && ['stale', 'fail', 'side'].includes(state) ? `<div class="lp-sum-hint">${esc(hintFor(index, state))}</div>` : '';
            if (state === 'ok' && entry?.repaired) hint = `<div class="lp-sum-hint lp-warn">${esc(t('sum.hint.repaired'))}</div>`;
            const scene = state === 'skip' || state === 'side' ? '' : sceneHtml(entry);
            const text = summary ? `<div class="lp-sum-text">${esc(summary)}</div>` : `<div class="lp-sum-hint">${esc(hintFor(index, state))}</div>`;
            const changes = ['ok', 'stale', 'side'].includes(state) ? changesHtml(index) : '';
            const actions = actionsFor(state, index).map((a) =>
                `<button type="button" class="menu_button lp-btn${['summarize', 'redo', 'retry'].includes(a) || (a === 'sideredo' && entry?.error) ? ' lp-primary' : ''}" data-lp-act="${a}">${esc(t(`act.${a}`))}</button>`).join('');
            const by = summary && entry?.by ? `<div class="lp-note lp-sum-by">${esc(byLine(entry.by))}</div>` : '';
            body = `${hint}${scene}${text}${by}${changes}${actions ? `<div class="lp-sum-actions">${actions}</div>` : ''}${versionsHtml(index)}${sentHtml(index)}`;
        }
    }

    return `
      <button type="button" class="lp-sum-head" data-lp-act="toggle" aria-expanded="${open}">
        <span class="lp-sum-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span class="lp-badge lp-st-${state}"><span class="${STATUS_ICONS[state]}" aria-hidden="true"></span>${esc(t(`st.${state}`))}</span>
        <span class="lp-sum-preview">${open ? '' : esc(preview)}</span>
        ${getSettings().hide.markHidden && hiddenNow().has(index) ? `<span class="lp-hidden-tag">${esc(t('mes.hidden'))}</span>` : ''}
      </button>
      ${open ? `<div class="lp-sum-body">${body}</div>` : ''}`;
}

function renderMes(el) {
    const index = Number(el.getAttribute('mesid'));
    const msg = getChat()[index];
    // 被隱藏的使用者發言淡淡標示一下（AI 樓層的標示在摘要區塊裡）。
    const markUser = isActive() && getSettings().hide.markHidden && msg?.is_user && hiddenNow().has(index);
    el.classList.toggle('lp-hidden-user', Boolean(markUser));
    if (markUser) el.setAttribute('title', t('mes.hiddenUser'));
    else if (el.getAttribute('title') === t('mes.hiddenUser')) el.removeAttribute('title');
    let block = el.querySelector('.lp-sum');
    if (!isActive() || !Number.isInteger(index) || !isAiMessage(msg)) {
        block?.remove();
        return;
    }
    if (!block) {
        block = document.createElement('div');
        block.className = 'lp-sum';
        const anchor = el.querySelector('.mes_text');
        if (anchor) anchor.after(block);
        else (el.querySelector('.mes_block') ?? el).appendChild(block);
    }
    block.dataset.index = String(index);
    // 編輯中不要整個重畫，免得打到一半的字不見。
    if (editing.has(index) && block.querySelector('.lp-sum-editor')) return;
    // 內容沒變就不重寫（長聊天每次有變動都會全部重畫一輪，重寫 DOM 很花時間）。
    const html = blockHtml(index);
    if (block.dataset.lpHtml !== undefined && lastHtml.get(block) === html) return;
    lastHtml.set(block, html);
    block.dataset.lpHtml = '';
    block.innerHTML = html;
}

export function renderBlock(index) {
    const el = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (el) renderMes(el);
}

export function renderAllBlocks() {
    invalidateHidden();
    document.querySelectorAll('#chat .mes').forEach(renderMes);
}

/** 從大視窗「跳到該樓」：捲過去並展開摘要（edit=true 時直接進入編輯）。回傳 false 表示那層還沒載入到畫面上。 */
export function revealFloor(index, { edit = false } = {}) {
    const el = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (!el) return false;
    expanded.add(index);
    if (edit) editing.add(index);
    renderMes(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (edit) el.querySelector('.lp-sum-editor')?.focus({ preventScroll: true });
    return true;
}

function onChatClick(e) {
    const btn = e.target.closest('.lp-sum [data-lp-act]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const block = btn.closest('.lp-sum');
    const index = Number(block.dataset.index);
    const act = btn.dataset.lpAct;
    if (act === 'toggle') {
        if (expanded.has(index) || editing.has(index)) {
            expanded.delete(index);
            editing.delete(index);
        } else {
            expanded.add(index);
        }
    } else if (act === 'save') {
        const entry = getEntry(index);
        // 畫面上沒有的欄位（沒勾選記錄）沿用原本的值。
        const field = (name, fallback) => block.querySelector(`[data-field="${name}"]`)?.value ?? fallback;
        const ok = writeSummary(index, {
            time: field('time', entry?.time ?? ''),
            location: field('location', entry?.location ?? ''),
            characters: field('characters', entry?.characters ?? []),
            date: field('date', entry?.date ?? ''),
            summary: field('summary', ''),
        });
        if (!ok) {
            block.querySelector('[data-field="summary"]')?.focus();
            return;
        }
        editing.delete(index);
    } else if (act === 'undo-op' || act === 'redo-op') {
        // 會連帶影響其他樓層和大視窗，交給 onNotesChange 重畫。
        setFloorOpUndone(index, Number(btn.dataset.k), act === 'undo-op');
        return;
    } else if (act === 'cancel') {
        editing.delete(index);
    } else if (act === 'restore') {
        restoreVersion(index, Number(btn.dataset.k));
    } else if (act === 'sent-jump') {
        if (!revealFloor(Number(btn.dataset.floor))) toast(t('sent.notLoaded'), 'info');
        return;
    } else if (runAction(index, act)) {
        editing.add(index);
        expanded.add(index);
        renderBlock(index);
        block.querySelector('.lp-sum-editor')?.focus();
        return;
    }
    renderBlock(index);
}

export function initMessageBlocks() {
    // 用 document 委派：#chat 在酒館裡會一直存在，但保險起見不直接綁它。
    document.addEventListener('click', onChatClick, true);

    // 一層的摘要或記事變了，其他樓層的「記事變化」也可能跟著變（例如引用的記事不見了），
    // 所以全部重畫；同一輪裡的多次變化合併成一次。
    let pending = false;
    const renderSoon = () => {
        if (pending) return;
        pending = true;
        queueMicrotask(() => {
            pending = false;
            renderAllBlocks();
        });
    };
    onSummaryChange(() => { invalidateHidden(); renderSoon(); });
    onNotesChange(() => { invalidateHidden(); renderSoon(); });
    onSentChange((index) => renderBlock(index));

    const c = ctx();
    if (!c?.eventSource || !c.eventTypes) return;
    const ev = c.eventTypes;
    const one = (id) => renderBlock(Number(id));
    const all = () => setTimeout(renderAllBlocks, 0);
    c.eventSource.on(ev.CHARACTER_MESSAGE_RENDERED, one);
    c.eventSource.on(ev.MESSAGE_UPDATED, (id) => { invalidateHidden(); one(id); });
    c.eventSource.on(ev.MESSAGE_SWIPED, (id) => { invalidateHidden(); one(id); });
    c.eventSource.on(ev.MESSAGE_EDITED, (id) => { invalidateHidden(); one(id); });
    // 新訊息送出後，前一層的提示（「等你送出下一句」）要更新。
    c.eventSource.on(ev.USER_MESSAGE_RENDERED, all);
    c.eventSource.on(ev.MESSAGE_DELETED, () => {
        expanded.clear();
        editing.clear();
        all();
    });
    c.eventSource.on(ev.CHAT_CHANGED, () => {
        expanded.clear();
        editing.clear();
        all();
    });
    if (ev.MORE_MESSAGES_LOADED) c.eventSource.on(ev.MORE_MESSAGES_LOADED, all);
}
