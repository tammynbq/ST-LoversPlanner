// 聊天畫面：每條 AI 訊息下面那個可以折疊的摘要區塊。操作按鈕都收在這裡面。

import { ctx, escapeHtml as esc } from '../util.js';
import { getSettings } from '../settings.js';
import { t } from '../i18n.js';
import { getChat, getEntry, isAiMessage, lastAiIndex } from '../chat.js';
import { enqueue, floorState, isActive, onSummaryChange, skipFloor, unskipFloor, writeSummary } from '../summarize.js';

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
export function actionsFor(state) {
    switch (state) {
        case 'none': return ['summarize', 'skip'];
        case 'ok': return ['edit', 'redo', 'skip'];
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
        default:
            return false;
    }
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
            body = `
              <textarea class="text_pole lp-sum-editor" aria-label="${esc(t('act.edit'))}" placeholder="${esc(t('sum.editPlaceholder'))}">${esc(summary)}</textarea>
              <div class="lp-sum-actions">
                <button type="button" class="menu_button lp-btn lp-primary" data-lp-act="save">${esc(t('act.save'))}</button>
                <button type="button" class="menu_button lp-btn" data-lp-act="cancel">${esc(t('act.cancel'))}</button>
              </div>`;
        } else {
            const hint = summary && (state === 'stale' || state === 'fail') ? `<div class="lp-sum-hint">${esc(hintFor(index, state))}</div>` : '';
            const text = summary ? `<div class="lp-sum-text">${esc(summary)}</div>` : `<div class="lp-sum-hint">${esc(hintFor(index, state))}</div>`;
            const actions = actionsFor(state).map((a) =>
                `<button type="button" class="menu_button lp-btn${['summarize', 'redo', 'retry'].includes(a) ? ' lp-primary' : ''}" data-lp-act="${a}">${esc(t(`act.${a}`))}</button>`).join('');
            body = `${hint}${text}${actions ? `<div class="lp-sum-actions">${actions}</div>` : ''}`;
        }
    }

    return `
      <button type="button" class="lp-sum-head" data-lp-act="toggle" aria-expanded="${open}">
        <span class="lp-sum-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span class="lp-badge lp-st-${state}"><span class="${STATUS_ICONS[state]}" aria-hidden="true"></span>${esc(t(`st.${state}`))}</span>
        <span class="lp-sum-preview">${open ? '' : esc(preview)}</span>
      </button>
      ${open ? `<div class="lp-sum-body">${body}</div>` : ''}`;
}

function renderMes(el) {
    const index = Number(el.getAttribute('mesid'));
    const msg = getChat()[index];
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
        const text = block.querySelector('.lp-sum-editor')?.value ?? '';
        if (!writeSummary(index, text)) return;
        editing.delete(index);
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

    onSummaryChange((index) => {
        if (index === null) renderAllBlocks();
        else renderBlock(index);
    });

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
