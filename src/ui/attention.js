// 生成前的彈窗：有失敗或過期的樓層（沒辦法用摘要頂替）時，先暫停生成，讓使用者選：
// 重新摘要／手動寫／跳過；處理完自動開始生成，也可以「先不管，照送原文繼續」或取消這次生成。

import { escapeHtml as esc } from '../util.js';
import { t } from '../i18n.js';
import { getEntry } from '../chat.js';
import { enqueue, floorState, onSummaryChange, skipFloor, writeSummary } from '../summarize.js';
import { setAttentionHandler } from '../hide.js';
import { STATUS_ICONS } from './message.js';

let overlay = null;
let floors = []; // 這次彈窗列出的樓層
let settle = null; // 回覆攔截器：'continue' | 'cancel'
let acted = false; // 使用者動過手（處理完才自動開始生成）
let autoTimer = null;
const writing = new Set(); // 正在手動寫的樓層
const resolvedBy = new Map(); // 樓層 → 使用者選了什麼（顯示用）

function isOpen() {
    return Boolean(overlay?.isConnected);
}

const isPending = (i) => ['fail', 'stale'].includes(floorState(i));
const isWorking = (i) => ['queued', 'busy'].includes(floorState(i));

function rowHtml(index) {
    const state = floorState(index);
    const entry = getEntry(index);
    const reason = state === 'fail' ? (entry?.error ?? '') : t('attn.stale');
    let body = '';
    if (writing.has(index)) {
        body = `
          <label class="lp-field"><span class="lp-label">${esc(t('meta.summary'))}</span>
            <textarea class="text_pole lp-sum-editor" data-attn-text placeholder="${esc(t('sum.editPlaceholder'))}">${esc(entry?.summary ?? '')}</textarea></label>
          <div class="lp-sum-actions">
            <button type="button" class="menu_button lp-btn lp-primary" data-attn="save" data-index="${index}">${esc(t('act.save'))}</button>
            <button type="button" class="menu_button lp-btn" data-attn="back" data-index="${index}">${esc(t('act.cancel'))}</button>
          </div>`;
    } else if (isPending(index)) {
        body = `
          <div class="lp-sum-hint">${esc(reason)}</div>
          <div class="lp-sum-actions">
            <button type="button" class="menu_button lp-btn lp-primary" data-attn="retry" data-index="${index}">${esc(t('act.retry'))}</button>
            <button type="button" class="menu_button lp-btn" data-attn="write" data-index="${index}">${esc(t('act.write'))}</button>
            <button type="button" class="menu_button lp-btn" data-attn="skip" data-index="${index}">${esc(t('act.skip'))}</button>
          </div>`;
    } else {
        const how = resolvedBy.get(index);
        const text = isWorking(index) ? t('attn.queued') : t(how ? `attn.done.${how}` : 'attn.done.retry');
        body = `<div class="lp-ok-text" role="status">${esc(text)}</div>`;
    }
    return `
      <div class="lp-floor-row">
        <div class="lp-floor-no">#${index}</div>
        <div class="lp-floor-main">
          <div><span class="lp-badge lp-st-${state}"><span class="${STATUS_ICONS[state]}" aria-hidden="true"></span>${esc(t(`st.${state}`))}</span></div>
          ${body}
        </div>
      </div>`;
}

function render() {
    if (!overlay) return;
    const left = floors.filter(isPending).length;
    const working = floors.some(isWorking);
    const allDone = !left && !working;
    const dialog = overlay.querySelector('.lp-dialog');
    let foot;
    if (allDone) {
        foot = `<span class="lp-ok-text" role="status">${esc(t('attn.autoStart'))}</span><span class="lp-spacer"></span>
          <button type="button" class="menu_button lp-btn lp-primary" data-attn="continue">${esc(t('attn.start'))}</button>`;
    } else {
        foot = `<span class="lp-spacer"></span>
          <button type="button" class="menu_button lp-btn lp-danger" data-attn="cancel">${esc(t('attn.cancelGen'))}</button>
          <button type="button" class="menu_button lp-btn" data-attn="continue">${esc(t('attn.continueRaw'))}</button>
          ${left ? `<button type="button" class="menu_button lp-btn lp-primary" data-attn="retry-all">${esc(t('attn.retryAll'))}</button>` : ''}`;
    }
    dialog.innerHTML = `
      <div class="lp-dialog-head">
        <div class="lp-title">${esc(left ? t('attn.title', { n: left }) : t('attn.allDone'))}</div>
        <div class="lp-note">${esc(t('attn.desc'))}</div>
      </div>
      <div class="lp-dialog-body">${floors.map(rowHtml).join('')}</div>
      <div class="lp-dialog-foot">${foot}</div>`;

    // 都處理好了：稍等一下讓使用者看到結果，然後自動開始生成。
    clearTimeout(autoTimer);
    if (allDone && acted) autoTimer = setTimeout(() => finish('continue'), 800);
}

function finish(choice) {
    clearTimeout(autoTimer);
    overlay?.remove();
    overlay = null;
    writing.clear();
    resolvedBy.clear();
    acted = false;
    document.removeEventListener('keydown', onKeydown, true);
    const done = settle;
    settle = null;
    done?.(choice);
}

function onKeydown(e) {
    // Esc 等於「先不管，照送原文繼續」（不會取消生成）。
    if (e.key === 'Escape' && isOpen()) {
        e.stopPropagation();
        finish('continue');
    }
}

function onClick(e) {
    const btn = e.target.closest('[data-attn]');
    if (!btn) return;
    const index = Number(btn.dataset.index);
    switch (btn.dataset.attn) {
        case 'retry':
            acted = true;
            resolvedBy.set(index, 'retry');
            enqueue(index, { front: true });
            break;
        case 'skip':
            acted = true;
            resolvedBy.set(index, 'skip');
            skipFloor(index);
            break;
        case 'write':
            writing.add(index);
            render();
            overlay.querySelector('[data-attn-text]')?.focus();
            return;
        case 'back':
            writing.delete(index);
            break;
        case 'save': {
            const entry = getEntry(index);
            const text = btn.closest('.lp-floor-main').querySelector('[data-attn-text]')?.value ?? '';
            // 手動寫只填摘要；時間、地點、人物沿用原本的。
            if (!writeSummary(index, { time: entry?.time, location: entry?.location, characters: entry?.characters, summary: text })) return;
            writing.delete(index);
            resolvedBy.set(index, 'write');
            acted = true;
            break;
        }
        case 'retry-all':
            acted = true;
            for (const i of floors.filter(isPending)) {
                resolvedBy.set(i, 'retry');
                enqueue(i);
            }
            break;
        case 'continue':
            finish('continue');
            return;
        case 'cancel':
            finish('cancel');
            return;
    }
    render();
}

/** 跳出彈窗，回傳 Promise<'continue' | 'cancel'>。 */
export function askAboutFloors(list) {
    if (!list?.length) return Promise.resolve('continue');
    if (isOpen()) finish('continue'); // 理論上不會同時有兩次生成；保險起見先收掉舊的
    floors = [...new Set(list)].sort((a, b) => a - b);
    overlay = document.createElement('div');
    overlay.className = 'lp-overlay lp-attention';
    overlay.innerHTML = '<div class="lp-dialog" role="dialog" aria-modal="true"></div>';
    overlay.addEventListener('click', onClick);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown, true);
    render();
    overlay.querySelector('.lp-dialog').setAttribute('aria-label', t('attn.title', { n: floors.length }));
    overlay.querySelector('[data-attn="retry"], [data-attn="continue"]')?.focus();
    return new Promise((resolve) => { settle = resolve; });
}

export function initAttention() {
    setAttentionHandler(askAboutFloors);
    onSummaryChange(() => {
        // 正在手動寫的時候不重畫，免得打到一半的字不見。
        if (isOpen() && !writing.size) render();
    });
}
