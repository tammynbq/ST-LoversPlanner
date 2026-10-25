// 聊天畫面：每條 AI 訊息下面那個可以折疊的摘要區塊。操作按鈕都收在這裡面。

import { ctx, escapeHtml as esc, toast } from '../util.js';
import { getSettings, isTracked } from '../settings.js';
import { t } from '../i18n.js';
import { getChat, getEntry, isAiMessage, lastAiIndex } from '../chat.js';
import { enqueue, floorState, isActive, onSummaryChange, skipFloor, unskipFloor, writeSummary } from '../summarize.js';
import { describeOp, getNotes, onNotesChange, opType, setFloorOpUndone } from '../notes.js';
import { computeHidden } from '../hide.js';
import { calendarOn, calTracked } from '../calendar.js';
import { addMemory, memoriesOn } from '../memories.js';

const expanded = new Set(); // 展開中的樓層
const editing = new Set(); // 正在手動編輯的樓層

export const STATUS_ICONS = {
    none: 'fa-regular fa-circle',
    queued: 'fa-solid fa-hourglass-half',
    busy: 'fa-solid fa-spinner fa-spin',
    ok: 'fa-solid fa-check',
    stale: 'fa-solid fa-triangle-exclamation',
    fail: 'fa-solid fa-circle-xmark',
    skip: 'fa-solid fa-forward',
};

/** 每種狀態可以做的操作。摘要區塊和大視窗共用。 */
export function actionsFor(state, index = null) {
    // 粗略補建的樓層：沒有單層摘要，要細摘請到大視窗的那一章按「改成逐層細摘」。
    if (state === 'ok' && index !== null && getEntry(index)?.coarse) return [];
    switch (state) {
        case 'none': return ['summarize', 'skip'];
        case 'ok': return memoriesOn() ? ['edit', 'redo', 'skip', 'keep'] : ['edit', 'redo', 'skip'];
        case 'stale': return ['redo', 'edit', 'skip'];
        case 'fail': return ['retry', 'write', 'skip'];
        case 'skip': return ['unskip'];
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
        case 'fail': return t('sum.hint.fail', { error: entry?.error ?? '' });
        case 'stale': return t('sum.hint.stale');
        case 'ok': return entry?.coarse ? t('sum.hint.coarse') : '';
        default: return '';
    }
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

/** 目前會被隱藏的樓層（標示用）。renderAllBlocks 時算一次重複用。 */
let hiddenCache = null;
function hiddenNow() {
    return hiddenCache ?? computeHidden().hidden;
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
            let hint = summary && (state === 'stale' || state === 'fail') ? `<div class="lp-sum-hint">${esc(hintFor(index, state))}</div>` : '';
            if (state === 'ok' && entry?.repaired) hint = `<div class="lp-sum-hint lp-warn">${esc(t('sum.hint.repaired'))}</div>`;
            const scene = state === 'skip' ? '' : sceneHtml(entry);
            const text = summary ? `<div class="lp-sum-text">${esc(summary)}</div>` : `<div class="lp-sum-hint">${esc(hintFor(index, state))}</div>`;
            const changes = state === 'ok' || state === 'stale' ? changesHtml(index) : '';
            const actions = actionsFor(state, index).map((a) =>
                `<button type="button" class="menu_button lp-btn${['summarize', 'redo', 'retry'].includes(a) ? ' lp-primary' : ''}" data-lp-act="${a}">${esc(t(`act.${a}`))}</button>`).join('');
            body = `${hint}${scene}${text}${changes}${actions ? `<div class="lp-sum-actions">${actions}</div>` : ''}`;
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
    block.innerHTML = blockHtml(index);
}

export function renderBlock(index) {
    const el = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (el) renderMes(el);
}

export function renderAllBlocks() {
    hiddenCache = isActive() ? computeHidden().hidden : new Set();
    try {
        document.querySelectorAll('#chat .mes').forEach(renderMes);
    } finally {
        hiddenCache = null;
    }
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
    onSummaryChange(renderSoon);
    onNotesChange(renderSoon);

    const c = ctx();
    if (!c?.eventSource || !c.eventTypes) return;
    const ev = c.eventTypes;
    const one = (id) => renderBlock(Number(id));
    const all = () => setTimeout(renderAllBlocks, 0);
    c.eventSource.on(ev.CHARACTER_MESSAGE_RENDERED, one);
    c.eventSource.on(ev.MESSAGE_UPDATED, one);
    c.eventSource.on(ev.MESSAGE_SWIPED, one);
    c.eventSource.on(ev.MESSAGE_EDITED, one);
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
