// 強制彈窗：送出時發現有失敗或過期的樓層（沒辦法用摘要頂替，只好送原文），
// 列出來讓使用者選：重新摘要／手動寫／跳過。可以「稍後再說」，下次送出時會再提醒。

import { escapeHtml as esc } from '../util.js';
import { t } from '../i18n.js';
import { getEntry } from '../chat.js';
import { enqueue, floorState, onSummaryChange, skipFloor, writeSummary } from '../summarize.js';
import { onAttentionNeeded } from '../hide.js';
import { STATUS_ICONS } from './message.js';

let overlay = null;
let floors = []; // 這次彈窗列出的樓層
const writing = new Set(); // 正在手動寫的樓層
const resolvedBy = new Map(); // 樓層 → 使用者選了什麼（顯示用）

function isOpen() {
    return Boolean(overlay?.isConnected);
}

function rowHtml(index) {
    const state = floorState(index);
    const entry = getEntry(index);
    const pending = state === 'fail' || state === 'stale';
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
    } else if (pending) {
        body = `
          <div class="lp-sum-hint">${esc(reason)}</div>
          <div class="lp-sum-actions">
            <button type="button" class="menu_button lp-btn lp-primary" data-attn="retry" data-index="${index}">${esc(t('act.retry'))}</button>
            <button type="button" class="menu_button lp-btn" data-attn="write" data-index="${index}">${esc(t('act.write'))}</button>
            <button type="button" class="menu_button lp-btn" data-attn="skip" data-index="${index}">${esc(t('act.skip'))}</button>
          </div>`;
    } else {
        const how = resolvedBy.get(index);
        const text = state === 'queued' || state === 'busy' ? t('attn.queued') : t(how ? `attn.done.${how}` : 'attn.done.retry');
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
    const left = floors.filter((i) => ['fail', 'stale'].includes(floorState(i))).length;
    const dialog = overlay.querySelector('.lp-dialog');
    dialog.innerHTML = `
      <div class="lp-dialog-head">
        <div class="lp-title">${esc(left ? t('attn.title', { n: left }) : t('attn.allDone'))}</div>
        <div class="lp-note">${esc(t('attn.desc'))}</div>
      </div>
      <div class="lp-dialog-body">${floors.map(rowHtml).join('')}</div>
      <div class="lp-dialog-foot">
        <span class="lp-note">${esc(t('attn.laterHint'))}</span>
        <span class="lp-spacer"></span>
        <button type="button" class="menu_button lp-btn" data-attn="later">${esc(left ? t('attn.later') : t('panel.close'))}</button>
        ${left ? `<button type="button" class="menu_button lp-btn lp-primary" data-attn="retry-all">${esc(t('attn.retryAll'))}</button>` : ''}
      </div>`;
}

function close() {
    overlay?.remove();
    writing.clear();
    resolvedBy.clear();
    document.removeEventListener('keydown', onKeydown, true);
}

function onKeydown(e) {
    if (e.key === 'Escape' && isOpen()) {
        e.stopPropagation();
        close();
    }
}

function onClick(e) {
    const btn = e.target.closest('[data-attn]');
    if (!btn) return;
    const index = Number(btn.dataset.index);
    switch (btn.dataset.attn) {
        case 'retry':
            resolvedBy.set(index, 'retry');
            enqueue(index, { front: true });
            break;
        case 'skip':
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
            break;
        }
        case 'retry-all':
            for (const i of floors) {
                if (['fail', 'stale'].includes(floorState(i))) {
                    resolvedBy.set(i, 'retry');
                    enqueue(i);
                }
            }
            break;
        case 'later':
            close();
            return;
    }
    render();
}

export function showAttention(list) {
    if (!list?.length) return;
    if (isOpen()) {
        // 已經開著：把新的樓層併進來。
        floors = [...new Set([...floors, ...list])].sort((a, b) => a - b);
        render();
        return;
    }
    floors = [...list].sort((a, b) => a - b);
    overlay = document.createElement('div');
    overlay.className = 'lp-overlay lp-attention';
    overlay.innerHTML = '<div class="lp-dialog" role="dialog" aria-modal="true"></div>';
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
        else onClick(e);
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown, true);
    render();
    overlay.querySelector('.lp-dialog').setAttribute('aria-label', t('attn.title', { n: floors.length }));
    overlay.querySelector('[data-attn="retry"], [data-attn="later"]')?.focus();
}

export function initAttention() {
    onAttentionNeeded(showAttention);
    onSummaryChange(() => {
        // 正在手動寫的時候不重畫，免得打到一半的字不見。
        if (isOpen() && !writing.size) render();
    });
}
