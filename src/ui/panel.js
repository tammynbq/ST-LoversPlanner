// 大視窗：標題列 + 分頁（摘要／記事／已完成／設定）。
// 第一版只有設定頁是完整的，其他分頁先放「製作中」的說明。

import { ctx, escapeHtml as esc, hasCharacterChat, isGroupChat, isTauriTavern, LOG_PREFIX, toast } from '../util.js';
import { getPath, getSettings, isTracked, saveSettings, setPath } from '../settings.js';
import { currentLocale, detectHostLocale, LOCALE_NAMES, LOCALES, t } from '../i18n.js';
import { getTemplate, isTemplateModified, resetTemplate, setTemplate, TEMPLATE_KEYS, TEMPLATE_VARS } from '../prompts.js';
import { listModels, normalizeBaseUrl, testConnection } from '../api/custom.js';
import { testEmbedding } from '../api/embed.js';
import { warmVectors } from '../recall.js';
import { cleanForSummary, scanTags, setTagMode, tagMode } from '../filter.js';
import { getLoadedVersion } from '../update.js';
import {
    auditFloors, auditIssues, auditProgress, auditResults, fixAll, fixIssue, issueCount, pickAuditFloors, runChecks,
} from '../check.js';
import {
    abandonCatchup, fineFromFor, getCatchup, pauseCatchup, planCatchup, remaining, resumeCatchup, startCatchup,
} from '../catchup.js';
import {
    changeCharacterScope, changeChatScope, condenseRecap, deleteRecap, editRecap, effectiveScope, getLinkedSummary,
    getRecap, importFrom, lastCarry, onCarryChange, otherSnapshots, restoreRecapRaw, setSummarySource, undoCarry,
} from '../carry.js';
import { errorText } from '../errors.js';
import { getLastStats, onStatsChange, previewInjection } from '../hide.js';
import { aiIndices, getChat, getEntry } from '../chat.js';
import { hl, isExpanded, isSectionOpen, matches, setExpanded, setSectionOpen, terms, toggleExpanded, toggleSection } from './fold.js';
import {
    cancelQueue, enqueue, enqueueCompress, floorState, isActive, onSummaryChange, pendingCount, unsummarizedIndices,
} from '../summarize.js';
import { compressionDue, deleteChapter, editChapter, editVolume, structure } from '../compress.js';
import { actionsFor, eventLabel, hintFor, revealFloor, runAction, sceneHtml, STATUS_ICONS } from './message.js';
import {
    addManualEvent, buildCalendar, CAL_TYPES, calendarOn, calTracked, dayInfo, monthGrid, monthTitle, onCalendarChange,
    periodStatus, removeEvent, restoreRemoved, shiftMonth, upcoming, weekdayName,
} from '../calendar.js';
import {
    addNoteManual, changeQuantity, closedNotes, completeNoteManual, deleteNoteManual, getNotes, NOTE_FIELDS, NOTE_TYPES,
    noteTitle, NUMBER_FIELDS,
    notesOfType, onNotesChange, pinNoteManual, reopenNoteManual, resultLabel, typeLabel, updateNoteManual,
} from '../notes.js';
import {
    CHAR_SCOPE_VALUES, CHAT_SCOPE_VALUES, characterName, getCharacterScope, getChatScope, SCOPE_KINDS,
} from '../scope.js';

const TABS = ['summary', 'characters', 'items', 'notes', 'calendar', 'done', 'settings'];

/** 每個分頁放哪些記事類型（記事分頁＝約定＋待辦）。 */
const TAB_TYPES = { characters: ['character'], items: ['item'], notes: ['promise', 'todo'] };

/** 目前看得到的分頁：沒勾選記錄的類型，對應的分頁就不顯示。 */
function visibleTabs() {
    return TABS.filter((tab) => {
        if (TAB_TYPES[tab]) return TAB_TYPES[tab].some(isTracked);
        if (tab === 'done') return ['item', 'promise', 'todo'].some(isTracked);
        if (tab === 'calendar') return calendarOn();
        return true;
    });
}
const SUMMARY_FILTERS = ['all', 'none', 'fail', 'stale', 'skip'];
const SUMMARY_PAGE = 100;

/** 數字欄位的範圍。 */
const NUMBER_LIMITS = {
    'summary.ratioMin': [1, 100],
    'summary.ratioMax': [1, 100],
    'summary.minTokens': [1, 4000],
    'summary.maxTokens': [1, 4000],
    'compress.l1PerL2': [2, 100],
    'compress.l2PerL3': [2, 100],
    'compress.ratioMin': [1, 100],
    'compress.ratioMax': [1, 100],
    'inject.depth': [0, 100],
    'recall.recentFloors': [0, 20],
    'recall.memoryTopK': [0, 20],
    'recall.noteTopK': [0, 50],
    'recall.threshold': [0, 100],
    'carry.recapLength': [50, 4000],
    'calendar.periodCycle': [15, 60],
    'calendar.periodLength': [1, 15],
    'calendar.ahead': [0, 60],
};

/** 成對的上下限：下限比上限大時，把上限拉到和下限一樣。 */
const RANGE_PAIRS = [
    ['summary.ratioMin', 'summary.ratioMax'],
    ['summary.minTokens', 'summary.maxTokens'],
    ['compress.ratioMin', 'compress.ratioMax'],
];

const view = {
    tab: 'summary',
    openSections: new Set(['general']),
    notes: {
        editing: null, // 正在編輯的記事 id
        adding: null, // 正在新增的類型
        confirmClear: false,
    },
    sum: {
        filter: 'all',
        newest: true,
        limit: SUMMARY_PAGE,
        confirmBackfill: false,
        previewOpen: false,
        editing: null, // 正在編輯的章／卷 id
    },
    // 各分頁的篩選字串，以及總搜尋。
    query: { summary: '', characters: '', items: '', notes: '', done: '' },
    global: { open: false, query: '' },
    focusKey: null, // 重畫後捲到這個項目（總搜尋點結果時用）
    tpl: 'l1',
    confirmReset: false,
    resetDone: false,
    // 自訂 API：先改草稿，按「儲存」才寫進設定。
    custom: {
        draft: null, // { url, key, model }
        models: [],
        manual: false, // 模型改用手動輸入
        showKey: false,
        busy: false,
        status: null, // { type: 'ok' | 'error' | 'saved', text }
    },
    // 🩺 檢查：開著時取代分頁內容。list 是最近一次的結果（按修正時用 id 找回來）。
    check: { open: false, list: [], auditN: 5, message: null },
    // 行事曆：顯示哪個月（YYYY-MM）、選了哪天、新增表單。
    cal: { month: null, selected: null, addType: null },
    // 補建舊樓層的設定卡片。
    catchup: { open: false, from: null, to: null, fine: 30, block: null },
    // 從其他聊天匯入：選哪個聊天、帶哪些。
    imp: { src: null, kinds: null, result: null },
    // 向量模型：和自訂 API 一樣的草稿卡片。
    vector: { draft: null, models: [], manual: false, showKey: false, busy: false, status: null },
};

let overlay = null;
let panel = null;
let lastFocus = null;
let hooks = { onSettingChanged: () => {} };

export function setPanelHooks(h) {
    hooks = { ...hooks, ...h };
}

export function isPanelOpen() {
    return Boolean(overlay?.isConnected);
}

export function openPanel(tab) {
    if (tab && TABS.includes(tab)) view.tab = tab;
    if (!overlay) createShell();
    if (!overlay.isConnected) {
        lastFocus = document.activeElement;
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKeydown, true);
    }
    render();
    panel.querySelector('[data-action="close"]')?.focus();
}

export function closePanel() {
    if (!isPanelOpen()) return;
    overlay.remove();
    document.removeEventListener('keydown', onKeydown, true);
    view.confirmReset = false;
    view.resetDone = false;
    if (customDirty() || customDirty('vector')) toast(t('set.custom.unsavedOnClose'), 'warning');
    for (const which of ['custom', 'vector']) {
        view[which].draft = null;
        view[which].status = null;
        view[which].showKey = false;
    }
    view.notes.editing = null;
    view.notes.adding = null;
    view.notes.confirmClear = false;
    try { lastFocus?.focus?.(); } catch (e) { /* 元素可能已經不在 */ }
}

/** 聊天切換、語言切換等狀況下重畫（只有開著時才畫）。 */
export function refreshPanel() {
    if (isPanelOpen()) render();
}

function onKeydown(e) {
    // 記事表單裡按 Enter 直接儲存。
    if (e.key === 'Enter' && e.target?.dataset?.noteField !== undefined && !e.isComposing) {
        e.preventDefault();
        saveNoteForm(e.target.closest('[data-note-form]'));
        return;
    }
    if (e.key === 'Escape') {
        e.stopPropagation();
        closePanel();
    }
}

function createShell() {
    overlay = document.createElement('div');
    overlay.className = 'lp-overlay';
    panel = document.createElement('div');
    panel.className = 'lp-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    overlay.appendChild(panel);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePanel();
    });
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    panel.addEventListener('input', onInput);
    panel.addEventListener('toggle', onToggle, true);

    applyTauriSurface();
}

/** TauriTavern 手機版：讓宿主幫忙處理瀏海、系統列和鍵盤。 */
async function applyTauriSurface() {
    if (!isTauriTavern()) return;
    try {
        const kit = await import('/scripts/tauritavern/layout-kit.js');
        await kit.waitForHostReady?.();
        kit.applySurface?.(panel, kit.SURFACE?.FullscreenWindow);
        kit.applySurface?.(overlay, kit.SURFACE?.Backdrop);
    } catch (e) {
        console.warn(LOG_PREFIX, 'layout-kit 無法使用，改用一般排版', e);
    }
}

// ===== 畫面 =====

function render() {
    const body = panel.querySelector('.lp-body');
    const scrollTop = body ? body.scrollTop : 0;
    // 重畫時保住正在打的字（章／卷總結的編輯框）。
    const draftDigest = panel.querySelector('[data-digest-text]')?.value;
    // 正在搜尋框打字時，重畫後游標要留在原處。
    const active = document.activeElement;
    const searchFocus = active?.dataset?.search ? { scope: active.dataset.search, pos: active.selectionStart } : null;
    panel.setAttribute('aria-label', t('app.name'));
    panel.setAttribute('lang', currentLocale());
    panel.innerHTML = renderHeader() + renderTabs() + `<div class="lp-body">${renderBanner()}${renderTab()}</div>`;
    const newBody = panel.querySelector('.lp-body');
    if (newBody) newBody.scrollTop = scrollTop;
    const digestBox = panel.querySelector('[data-digest-text]');
    if (digestBox && draftDigest !== undefined) digestBox.value = draftDigest;
    if (searchFocus) {
        const box = panel.querySelector(`[data-search="${searchFocus.scope}"]`);
        if (box) {
            box.focus();
            try { box.setSelectionRange(searchFocus.pos, searchFocus.pos); } catch (e) { /* 有些輸入框不支援 */ }
        }
    }
    if (view.focusKey) {
        panel.querySelector(`[data-fold-key="${CSS.escape(view.focusKey)}"]`)?.scrollIntoView({ block: 'center' });
        view.focusKey = null;
    }
}

function renderHeader() {
    const c = ctx();
    let subtitle = '';
    if (hasCharacterChat()) {
        const chat = c.getCurrentChatId?.() ?? c.chatId ?? '';
        subtitle = t('panel.subtitle', { char: c.name2 ?? '', chat });
    }
    return `
    <div class="lp-header">
      <div class="lp-title-icon fa-solid fa-book-open" aria-hidden="true"></div>
      <div class="lp-title-text">
        <div class="lp-title">${esc(t('app.name'))}${subtitle ? ` <span class="lp-subtitle">· ${esc(subtitle)}</span>` : ''}</div>
        <div class="lp-stats">${esc(statsText())}</div>
      </div>
      ${checkButton()}
      <button type="button" class="lp-icon-btn${view.global.open ? ' lp-on' : ''}" data-action="global-toggle" aria-pressed="${view.global.open}" aria-label="${esc(t('search.global'))}" title="${esc(t('search.global'))}">
        <span class="fa-solid fa-magnifying-glass" aria-hidden="true"></span>
      </button>
      <button type="button" class="lp-icon-btn" data-action="close" aria-label="${esc(t('panel.close'))}" title="${esc(t('panel.close'))}">
        <span class="fa-solid fa-xmark" aria-hidden="true"></span>
      </button>
    </div>`;
}

function checkButton() {
    if (!isActive()) return '';
    let n = 0;
    try { n = issueCount([...runChecks(), ...auditIssues()]); } catch (e) { console.warn(LOG_PREFIX, '檢查失敗', e); }
    const label = n ? t('check.buttonN', { n }) : t('check.button');
    return `<button type="button" class="lp-icon-btn lp-check-btn${view.check.open ? ' lp-on' : ''}" data-action="check-toggle" aria-pressed="${view.check.open}" aria-label="${esc(label)}" title="${esc(label)}">
        <span class="fa-solid fa-stethoscope" aria-hidden="true"></span>${n ? `<span class="lp-count" data-role="check-count">${n > 99 ? '99+' : n}</span>` : ''}
      </button>`;
}

function statsText() {
    const st = getLastStats();
    if (!st) return t('panel.statsNone');
    if (st.reason) return t(`panel.stats.${st.reason}`);
    const main = st.hiddenFloors
        ? t('panel.stats', { floors: st.hiddenFloors, raw: st.hiddenTokens.toLocaleString(), injected: st.injectedTokens.toLocaleString() })
        : t('panel.statsNoneHidden');
    const extra = [];
    if (st.notesSent !== null && st.notesSent !== undefined) extra.push(t('panel.statsNotes', { n: st.notesSent, total: st.notesTotal }));
    if (st.memories) extra.push(t('panel.statsMemories', { n: st.memories }));
    if (st.vector === 'error') extra.push(t('panel.statsVectorError'));
    if (st.unsummarized) extra.push(t('panel.statsPending', { n: st.unsummarized }));
    return [main, ...extra].join('｜');
}

function renderTabs() {
    if (!visibleTabs().includes(view.tab)) view.tab = 'summary';
    const items = visibleTabs().map((tab) => {
        // 總搜尋開著時，沒有分頁是「目前的」。
        const on = view.tab === tab && !view.global.open;
        return `<button type="button" role="tab" class="lp-tab${on ? ' lp-on' : ''}" aria-selected="${on}" data-action="tab" data-tab="${tab}">${esc(t(`tab.${tab}`))}</button>`;
    }).join('');
    return `<div class="lp-tabs" role="tablist">${items}</div>`;
}

function renderBanner() {
    const s = getSettings();
    let msg = '';
    if (!s.enabled) msg = t('panel.disabled');
    else if (isGroupChat()) msg = t('panel.group');
    else if (!hasCharacterChat()) msg = t('panel.noChat');
    return msg ? `<div class="lp-banner" role="status">${esc(msg)}</div>` : '';
}

function renderTab() {
    if (view.check.open) return renderCheck();
    if (view.global.open) return renderGlobalSearch();
    switch (view.tab) {
        case 'summary': return renderSummaryTab();
        case 'characters':
        case 'items':
        case 'notes':
            return renderNotesTab(TAB_TYPES[view.tab].filter(isTracked));
        case 'calendar': return renderCalendarTab();
        case 'done': return renderDoneTab();
        case 'settings': return renderSettings();
        default: return '';
    }
}

// ===== 摘要分頁 =====

function matchesFilter(state, filter) {
    if (filter === 'all') return true;
    if (filter === 'none') return state === 'none' || state === 'queued' || state === 'busy';
    return state === filter;
}

function badge(state) {
    return `<span class="lp-badge lp-st-${state}"><span class="${STATUS_ICONS[state]}" aria-hidden="true"></span>${esc(t(`st.${state}`))}</span>`;
}

function floorKey(index) {
    return `floor:${getChat()[index]?.send_date ?? index}`;
}

/** 搜尋用：一層摘要的所有文字。 */
function floorText(index) {
    const e = getEntry(index);
    return [`#${index}`, e?.summary, e?.time, e?.location, (e?.characters ?? []).join(' ')].filter(Boolean).join(' ');
}

/** 一層摘要：平常只顯示一行，點開才有完整內容和按鈕。搜尋時符合的自動展開。 */
function summaryRow(index, state, query = '') {
    const entry = getEntry(index);
    const summary = state === 'skip' ? '' : (entry?.summary ?? '');
    const hint = hintFor(index, state);
    const key = floorKey(index);
    const open = isExpanded(key) || Boolean(query);
    const head = `
        <button type="button" class="lp-row-head" data-action="fold" data-key="${esc(key)}" aria-expanded="${open}">
          <span class="lp-sum-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
          <span class="lp-floor-no">#${index}</span>
          ${badge(state)}
          <span class="lp-row-preview">${open ? '' : hl(summary || hint, query)}</span>
        </button>`;
    if (!open) return `<div class="lp-floor-row lp-folded" data-fold-key="${esc(key)}">${head}</div>`;
    const showHint = hint && (!summary || state === 'stale' || state === 'fail');
    const actions = [...actionsFor(state, index), 'jump'].map((a) =>
        `<button type="button" class="menu_button lp-btn${['summarize', 'redo', 'retry'].includes(a) ? ' lp-primary' : ''}" data-action="sum-act" data-act="${a}" data-index="${index}">${esc(t(`act.${a}`))}</button>`).join('');
    return `
      <div class="lp-floor-row lp-unfolded" data-fold-key="${esc(key)}">
        ${head}
        <div class="lp-floor-main">
          ${state === 'skip' ? '' : sceneHtml(entry)}
          ${summary ? `<div class="lp-sum-text">${hl(summary, query)}</div>` : ''}
          ${showHint ? `<div class="lp-sum-hint">${esc(hint)}</div>` : ''}
          <div class="lp-sum-actions">${actions}</div>
        </div>
      </div>`;
}

/** 分頁上方的篩選框。 */
function searchBox(scope, placeholderKey = 'search.placeholder') {
    const value = scope === 'global' ? view.global.query : (view.query[scope] ?? '');
    return `
      <label class="lp-search">
        <span class="fa-solid fa-magnifying-glass" aria-hidden="true"></span>
        <span class="lp-sr">${esc(t(placeholderKey))}</span>
        <input type="search" class="text_pole" data-search="${scope}" value="${esc(value)}" placeholder="${esc(t(placeholderKey))}" autocomplete="off" spellcheck="false">
      </label>`;
}

function renderSummaryTab() {
    // 停用、群組聊天、沒開聊天時，上方的提示已經說明了。
    if (!isActive()) return '';
    const all = aiIndices();
    if (!all.length) return `<div class="lp-wip">${esc(t('sum.empty'))}</div>`;

    const states = new Map(all.map((i) => [i, floorState(i)]));
    const chips = SUMMARY_FILTERS.map((f) => {
        const n = all.filter((i) => matchesFilter(states.get(i), f)).length;
        const on = view.sum.filter === f;
        return `<button type="button" class="lp-chip${on ? ' lp-on' : ''}" data-action="sum-filter" data-filter="${f}" aria-pressed="${on}">${esc(t(`sum.filter.${f}`))} ${n}</button>`;
    }).join('');

    let list = all.filter((i) => matchesFilter(states.get(i), view.sum.filter));
    if (view.sum.newest) list = list.reverse();
    const shown = list.slice(0, view.sum.limit);

    const pending = pendingCount();
    const cu = getCatchup();
    let queueArea = '';
    if (pending) {
        const text = cu ? t('catchup.progress', { done: Math.max(0, cu.total - remaining()), total: cu.total, n: pending }) : t('sum.progress', { n: pending });
        queueArea = `<div class="lp-callout lp-row" role="status" data-role="catchup-progress"><span>${esc(text)}</span><span class="lp-spacer"></span>
          <button type="button" class="menu_button lp-btn" data-action="sum-stop">${esc(t(cu ? 'catchup.pause' : 'sum.stop'))}</button></div>`;
    } else if (cu) {
        const left = remaining();
        queueArea = `<div class="lp-callout lp-row" data-role="catchup-paused"><span>${esc(t('catchup.pausedBanner', { done: Math.max(0, cu.total - left), total: cu.total }))}${cu.error ? `<br><span class="lp-error-text">${esc(cu.error)}</span>` : ''}</span><span class="lp-spacer"></span>
          <button type="button" class="menu_button lp-btn lp-primary" data-action="catchup-resume">${esc(t('catchup.resume'))}</button>
          <button type="button" class="menu_button lp-btn" data-action="catchup-abandon">${esc(t('catchup.abandon'))}</button></div>`;
    } else {
        const todo = unsummarizedIndices();
        if (todo.length && view.catchup.open) queueArea = catchupCard(todo);
        else if (todo.length) {
            queueArea = `<div class="lp-row"><button type="button" class="menu_button lp-btn" data-action="backfill-ask">${esc(t('sum.backfill', { n: todo.length }))}</button></div>`;
        } else {
            // 沒有可以補建的也顯示按鈕（灰的），並說明原因，免得找不到。
            queueArea = `<div class="lp-row"><button type="button" class="menu_button lp-btn" data-action="backfill-ask" disabled>${esc(t('sum.backfill', { n: 0 }))}</button>
              <span class="lp-note">${esc(t('sum.backfill.none'))}</span></div>`;
        }
    }

    // 「全部」時照卷 → 章 → 各層折疊顯示；篩選時直接列出符合的樓層。
    let rows;
    let more = '';
    const query = view.query.summary;
    if (query) {
        rows = renderSummarySearch(states, query);
    } else if (view.sum.filter === 'all') {
        rows = renderTree(states);
    } else {
        rows = shown.length
            ? shown.map((i) => summaryRow(i, states.get(i))).join('')
            : `<div class="lp-wip">${esc(t('sum.emptyFilter'))}</div>`;
        more = list.length > shown.length
            ? `<button type="button" class="menu_button lp-btn lp-more" data-action="sum-more">${esc(t('sum.more', { n: list.length - shown.length }))}</button>`
            : '';
    }
    if (!pending && compressionDue()) {
        queueArea += `<div class="lp-row"><button type="button" class="menu_button lp-btn" data-action="compress-now">${esc(t('compress.now'))}</button></div>`;
    }

    // 送出預覽：先畫框，token 算好再填進去（fillPreview）。
    queueMicrotask(fillPreview);
    const preview = `
      <details class="lp-sec lp-preview" data-preview${view.sum.previewOpen ? ' open' : ''}>
        <summary><span class="lp-sec-title">${esc(t('preview.title'))}</span><span class="lp-sec-hint" data-role="preview-line">${esc(t('preview.counting'))}</span></summary>
        <div class="lp-sec-body" data-role="preview-body"><div class="lp-note">${esc(t('preview.counting'))}</div></div>
      </details>`;

    return `
      <div class="lp-summary">
        ${preview}
        ${recapCard()}
        ${searchBox('summary')}
        <div class="lp-row">
          <div class="lp-chips">${chips}</div>
          <span class="lp-spacer"></span>
          <button type="button" class="menu_button lp-btn" data-action="sum-sort">${esc(t(view.sum.newest ? 'sum.sort.newest' : 'sum.sort.oldest'))}</button>
        </div>
        ${queueArea}
        <div class="lp-floor-list">${rows}</div>
        ${more}
      </div>`;
}

// ===== 行事曆 =====

function renderCalendarTab() {
    if (!isActive()) return '';
    const cal = buildCalendar();
    const month = view.cal.month ?? (cal.today ?? new Date().toISOString().slice(0, 10)).slice(0, 7);
    view.cal.month = month;
    const { pad, days } = monthGrid(month);
    const head = Array.from({ length: 7 }, (_, k) => weekdayName(`2023-01-0${k + 1}`, 'narrow')); // 2023-01-01 是星期日
    const cells = [];
    for (let k = 0; k < pad; k++) cells.push('<span class="lp-cal-cell lp-cal-empty" aria-hidden="true"></span>');
    for (const d of days) {
        const info = dayInfo(cal, d);
        const marks = [];
        if (info.period) marks.push(`<span class="lp-cal-mark${info.period === 'predicted' ? ' lp-cal-pred' : ''}" aria-hidden="true">🩸</span>`);
        if (info.intimacy) marks.push(`<span class="lp-cal-mark" aria-hidden="true">💕${info.intimacy > 1 ? info.intimacy : ''}</span>`);
        if (info.plans.length) marks.push('<span class="lp-cal-mark" aria-hidden="true">📌</span>');
        if (info.anniversaries.length) marks.push('<span class="lp-cal-mark" aria-hidden="true">🎂</span>');
        const cls = ['lp-cal-cell', d === cal.today ? 'lp-cal-today' : '', d === view.cal.selected ? 'lp-on' : '', info.period === 'actual' ? 'lp-cal-period' : ''].filter(Boolean).join(' ');
        const label = [d, ...info.items.map(eventLabel), info.period === 'predicted' ? t('cal.predicted') : ''].filter(Boolean).join('，');
        cells.push(`<button type="button" class="${cls}" data-action="cal-day" data-date="${d}" aria-label="${esc(label)}" aria-pressed="${d === view.cal.selected}">
            <span class="lp-cal-num">${Number(d.slice(8))}</span><span class="lp-cal-marks">${marks.join('')}</span></button>`);
    }
    const nav = `
      <div class="lp-row lp-cal-nav">
        <button type="button" class="menu_button lp-btn" data-action="cal-month" data-delta="-1" aria-label="${esc(t('cal.prev'))}">‹</button>
        <span class="lp-cal-title" data-role="cal-title">${esc(monthTitle(month))}</span>
        <button type="button" class="menu_button lp-btn" data-action="cal-month" data-delta="1" aria-label="${esc(t('cal.next'))}">›</button>
        <span class="lp-spacer"></span>
        ${cal.today ? `<button type="button" class="menu_button lp-btn" data-action="cal-today">${esc(t('cal.gotoToday'))}</button>` : ''}
      </div>`;
    const grid = `<div class="lp-cal-grid" role="grid">${head.map((h) => `<span class="lp-cal-head">${esc(h)}</span>`).join('')}${cells.join('')}</div>`;
    return `<div class="lp-calendar">${calendarStatus(cal)}${nav}${grid}${calendarDay(cal)}</div>`;
}

/** 上方的狀態：今天、生理期、接下來的事。 */
function calendarStatus(cal) {
    if (!cal.today) return `<div class="lp-callout" data-role="cal-status">${esc(t('cal.noToday'))}</div>`;
    const lines = [`<div><b>${esc(t('cal.todayIs', { date: cal.today, weekday: weekdayName(cal.today, 'long') }))}</b></div>`];
    const p = periodStatus(cal);
    if (p?.kind === 'during') lines.push(`<div>🩸 ${esc(t('cal.status.during', { day: p.day }))}</div>`);
    else if (p?.kind === 'until') lines.push(`<div>🩸 ${esc(t('cal.status.until', { days: p.days, date: p.date, cycle: cal.cycle }))}</div>`);
    else if (p?.kind === 'late') lines.push(`<div class="lp-warn-text">🩸 ${esc(t('cal.status.late', { days: p.days }))}</div>`);
    const list = upcoming(cal);
    if (list.length) {
        const items = list.map((x) => {
            const when = x.in === 0 ? t('cal.today') : t('cal.inDays', { n: x.in });
            const what = x.kind === 'period' ? `🩸 ${t('cal.periodExpected')}` : x.kind === 'anniversary' ? `🎂 ${x.title}` : `📌 ${x.title}`;
            return `<li>${esc(`${x.date.slice(5)}（${when}）${what}`)}</li>`;
        }).join('');
        lines.push(`<div class="lp-label">${esc(t('cal.upcoming'))}</div><ul class="lp-recall-list">${items}</ul>`);
    }
    return `<div class="lp-callout lp-cal-status" data-role="cal-status">${lines.join('')}</div>`;
}

/** 選了某一天：當天的事（可以刪），以及新增表單。 */
function calendarDay(cal) {
    const d = view.cal.selected;
    if (!d) return `<div class="lp-note">${esc(t('cal.pickDay'))}</div>`;
    const info = dayInfo(cal, d);
    const rows = info.items.map((x) => {
        const src = x.source === 'floor'
            ? `<button type="button" class="lp-link" data-action="note-jump" data-index="${x.floor}">${esc(t('cal.fromFloor', { n: x.floor }))}</button>`
            : `<span class="lp-note">${esc(t('cal.manual'))}</span>`;
        const ref = x.source === 'manual' ? `data-id="${esc(x.id)}"` : `data-key="${esc(x.key)}"`;
        return `<li class="lp-cal-item"><span>${esc(eventLabel(x))}</span> ${src}
          <button type="button" class="menu_button lp-btn lp-mini lp-danger" data-action="cal-remove" data-source="${x.source}" ${ref}>${esc(t('cal.remove'))}</button></li>`;
    });
    if (info.period === 'predicted') rows.push(`<li class="lp-note">🩸 ${esc(t('cal.predicted'))}</li>`);
    else if (info.period === 'actual' && !info.items.some((x) => x.type === 'period')) rows.push(`<li class="lp-note">🩸 ${esc(t('cal.status.during', { day: info.periodDay }))}</li>`);
    const types = CAL_TYPES.filter(calTracked);
    const type = types.includes(view.cal.addType) ? view.cal.addType : types[0];
    let fields = '';
    if (type === 'plan' || type === 'anniversary') fields = `<input type="text" class="text_pole lp-grow" data-role="cal-title-input" placeholder="${esc(t(type === 'plan' ? 'cal.add.planPh' : 'cal.add.annivPh'))}" aria-label="${esc(t('cal.add.title'))}">`;
    else if (type === 'intimacy') fields = `<input type="number" class="text_pole lp-num" data-role="cal-count" min="1" max="20" value="1" aria-label="${esc(t('cal.add.count'))}">`;
    else if (type === 'period') fields = `<select class="text_pole lp-select" data-role="cal-state" aria-label="${esc(t('cal.add.state'))}"><option value="start">${esc(t('cal.periodStart'))}</option><option value="end">${esc(t('cal.periodEnd'))}</option></select>`;
    const typeSel = `<select class="text_pole lp-select" data-role="cal-type" aria-label="${esc(t('cal.add.type'))}">${types.map((x) => `<option value="${x}"${x === type ? ' selected' : ''}>${esc(t(`cal.type.${x}`))}</option>`).join('')}</select>`;
    return `
      <div class="lp-card lp-cal-day" data-role="cal-day">
        <div class="lp-scope-title">${esc(`${d}（${weekdayName(d, 'long')}）`)}</div>
        ${rows.length ? `<ul class="lp-recall-list">${rows.join('')}</ul>` : `<div class="lp-note">${esc(t('cal.empty'))}</div>`}
        ${types.length ? `<div class="lp-row">${typeSel}${fields}<button type="button" class="menu_button lp-btn lp-primary" data-action="cal-add">${esc(t('cal.add'))}</button></div>` : ''}
        ${cal.removedCount ? `<div class="lp-row"><span class="lp-note">${esc(t('cal.removedN', { n: cal.removedCount }))}</span><button type="button" class="menu_button lp-btn lp-mini" data-action="cal-restore">${esc(t('cal.restore'))}</button></div>` : ''}
      </div>`;
}

// ===== 🩺 檢查 =====

const CHECK_GROUPS = {
    gen: ['none', 'fail', 'stale', 'repaired', 'chapter-stale', 'chapter-fail', 'volume-stale', 'volume-fail', 'compressDue', 'catchupPaused', 'recapFail'],
    odd: ['empty', 'long', 'dup', 'noTime', 'noLocation'],
    notes: ['dupNote', 'zeroItem'],
    audit: ['audit', 'auditError'],
};
const FIX_LABEL = {
    none: 'check.fix.catchup', fail: 'check.fix.redo', stale: 'check.fix.redo', repaired: 'check.fix.redo', empty: 'check.fix.redo',
    long: 'check.fix.redo', dup: 'check.fix.redo', audit: 'check.fix.redo', auditError: null,
    'chapter-stale': 'check.fix.redo', 'chapter-fail': 'check.fix.redo', 'volume-stale': 'check.fix.redo', 'volume-fail': 'check.fix.redo',
    compressDue: 'check.fix.compress', catchupPaused: 'check.fix.resume', recapFail: 'check.fix.condense',
    dupNote: 'check.fix.merge', zeroItem: 'check.fix.used', noTime: null, noLocation: null,
};
const SEVERITY_ICON = { error: 'fa-solid fa-circle-xmark', warn: 'fa-solid fa-triangle-exclamation', info: 'fa-solid fa-circle-info' };

function checkRow(x) {
    const vars = { ...x, floor: x.floor ?? '', type: x.type ? typeLabel(x.type) : '', text: x.text ?? '' };
    const fixKey = FIX_LABEL[x.kind];
    const btns = [];
    if (fixKey) btns.push(`<button type="button" class="menu_button lp-btn lp-mini${x.autoFix ? ' lp-primary' : ''}" data-action="check-fix" data-id="${esc(x.id)}">${esc(t(fixKey))}</button>`);
    if (Number.isInteger(x.floor)) btns.push(`<button type="button" class="menu_button lp-btn lp-mini" data-action="check-jump" data-index="${x.floor}">${esc(t('act.jump'))}</button>`);
    let detail = '';
    if (x.problems?.length) detail = `<ul class="lp-recall-list">${x.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
    if (Array.isArray(x.floors) && x.kind !== 'none') {
        const links = x.floors.slice(0, 12).map((i) => `<button type="button" class="lp-link" data-action="check-jump" data-index="${i}">#${i}</button>`).join(' ');
        detail = `<div class="lp-note">${links}${x.floors.length > 12 ? ` ${esc(t('check.more', { n: x.floors.length - 12 }))}` : ''}</div>`;
    }
    return `<li class="lp-check-row lp-sev-${x.severity}" data-check="${esc(x.id)}">
        <span class="${SEVERITY_ICON[x.severity]}" aria-hidden="true"></span>
        <div class="lp-check-main"><div>${esc(t(`check.kind.${x.kind}`, vars))}</div>${detail}</div>
        <div class="lp-check-btns">${btns.join('')}</div>
      </li>`;
}

function renderCheck() {
    const head = `<div class="lp-global-head"><span class="lp-scope-title">🩺 ${esc(t('check.title'))}</span><span class="lp-spacer"></span>
      <button type="button" class="menu_button lp-btn" data-action="check-refresh">${esc(t('check.refresh'))}</button>
      <button type="button" class="menu_button lp-btn" data-action="check-toggle">${esc(t('panel.close'))}</button></div>`;
    if (!isActive()) return head;
    const list = [...runChecks(), ...auditIssues()];
    view.check.list = list;
    const count = (sev) => list.filter((x) => x.severity === sev).length;
    const auto = list.filter((x) => x.autoFix).length;
    const pending = pendingCount();
    const summary = list.length
        ? t('check.found', { error: count('error'), warn: count('warn'), info: count('info') })
        : t('check.allGood');
    const groups = Object.entries(CHECK_GROUPS).map(([g, kinds]) => {
        const items = list.filter((x) => kinds.includes(x.kind));
        if (!items.length) return '';
        return `<div class="lp-checkup-group">${esc(t(`check.group.${g}`))}</div><ul class="lp-check-list">${items.map(checkRow).join('')}</ul>`;
    }).join('');

    const prog = auditProgress();
    const results = auditResults();
    const okCount = [...results.values()].filter((r) => r.ok === true).length;
    const audit = `
      <div class="lp-card lp-check-audit" data-role="audit">
        <div class="lp-scope-title">${esc(t('check.audit.title'))}</div>
        <div class="lp-note">${esc(t('check.audit.desc'))}</div>
        <div class="lp-row">${inline('check.audit.n', { n: `<input type="number" class="text_pole lp-num" data-role="audit-n" min="1" max="50" step="1" value="${view.check.auditN}" aria-label="${esc(t('check.audit.n.aria'))}">` })}
          <button type="button" class="menu_button lp-btn" data-action="check-audit"${prog ? ' disabled' : ''}>${esc(t('check.audit.start'))}</button></div>
        ${prog ? `<div class="lp-note" role="status" data-role="audit-progress">${esc(t('check.audit.progress', { done: prog.done, total: prog.total }))}</div>` : ''}
        ${results.size ? `<div class="lp-note" data-role="audit-summary">${esc(t('check.audit.summary', { total: results.size, ok: okCount }))}</div>` : ''}
      </div>`;

    return `${head}
      <div class="lp-checkup">
        <div class="lp-row"><span data-role="check-summary">${esc(summary)}</span><span class="lp-spacer"></span>
          ${auto ? `<button type="button" class="menu_button lp-btn lp-primary" data-action="check-fix-all">${esc(t('check.fixAll', { n: auto }))}</button>` : ''}</div>
        ${view.check.message ? `<div class="lp-ok-text" role="status">${esc(view.check.message)}</div>` : ''}
        ${pending ? `<div class="lp-note" role="status">${esc(t('sum.progress', { n: pending }))}</div>` : ''}
        ${groups}
        ${audit}
      </div>`;
}

// ===== 摘要分頁：補建舊樓層 =====

function catchupValues(todo) {
    const c = view.catchup;
    const first = todo[0];
    const last = todo[todo.length - 1];
    const from = Number.isInteger(c.from) ? c.from : first;
    const to = Number.isInteger(c.to) ? c.to : last;
    const block = Number.isInteger(c.block) ? c.block : (Number(getSettings().compress.l1PerL2) || 10);
    const fine = Number.isInteger(c.fine) ? c.fine : 30;
    return { from, to, block, fine };
}

function catchupEstimate(todo) {
    const v = catchupValues(todo);
    const plan = planCatchup({ from: v.from, to: v.to, block: v.block, fineFrom: fineFromFor(v.from, v.to, v.fine) });
    return t('catchup.estimate', {
        floors: plan.floors, coarse: plan.coarse.length, fine: plan.fine.length, calls: plan.calls,
        tokens: plan.tokens.toLocaleString(),
    });
}

function catchupCard(todo) {
    const v = catchupValues(todo);
    const num = (key, value, min, max, label) =>
        `<input type="number" class="text_pole lp-num" data-cu="${key}" min="${min}" max="${max}" step="1" value="${value}" aria-label="${esc(label)}">`;
    const lastIndex = getChat().length - 1;
    const warn = getSettings().source === 'main' ? `<div class="lp-callout lp-warn">${esc(t('catchup.mainWarn'))}</div>` : '';
    return `
      <div class="lp-card lp-catchup" data-role="catchup">
        <div class="lp-scope-title">${esc(t('catchup.title'))}</div>
        <div class="lp-note">${esc(t('catchup.desc'))}</div>
        <div class="lp-row">${inline('catchup.range', { from: num('from', v.from, 0, lastIndex, t('catchup.from')), to: num('to', v.to, 0, lastIndex, t('catchup.to')) })}</div>
        <div class="lp-row">${inline('catchup.fine', { n: num('fine', v.fine, 0, 100000, t('catchup.fine.aria')) })}</div>
        <div class="lp-row">${inline('catchup.block', { n: num('block', v.block, 2, 100, t('catchup.block.aria')) })}</div>
        <div class="lp-note lp-catchup-estimate" data-role="cu-estimate">${esc(catchupEstimate(todo))}</div>
        ${warn}
        <div class="lp-row">
          <button type="button" class="menu_button lp-btn lp-primary" data-action="backfill-yes">${esc(t('catchup.start'))}</button>
          <button type="button" class="menu_button lp-btn" data-action="backfill-no">${esc(t('sum.backfill.no'))}</button>
        </div>
      </div>`;
}

// ===== 摘要分頁：前情提要 =====

function recapCard() {
    const recap = getRecap();
    const linked = getLinkedSummary();
    if (!recap && !linked) return '';
    const open = isSectionOpen('recap');
    const out = [];
    if (recap) {
        const busy = recap.status === 'busy';
        const status = busy ? `<span class="lp-badge lp-st-busy">${esc(t('recap.busy'))}</span>`
            : recap.status === 'fail' ? `<span class="lp-badge lp-st-fail">${esc(t('recap.fail'))}</span>`
                : `<span class="lp-badge lp-st-ok">${esc(t(recap.mode === 'condensed' ? 'recap.condensed' : 'recap.raw'))}</span>`;
        let body;
        if (view.sum.editing === 'recap') {
            body = `<textarea class="text_pole lp-sum-editor" data-digest-text aria-label="${esc(t('act.edit'))}">${esc(recap.text)}</textarea>
              <div class="lp-sum-actions">
                <button type="button" class="menu_button lp-btn lp-primary" data-action="recap-save">${esc(t('act.save'))}</button>
                <button type="button" class="menu_button lp-btn" data-action="digest-cancel">${esc(t('act.cancel'))}</button>
              </div>`;
        } else {
            const btn = (act, key, primary = false, disabled = false) => `<button type="button" class="menu_button lp-btn${primary ? ' lp-primary' : ''}" data-action="${act}"${disabled ? ' disabled' : ''}>${esc(t(key))}</button>`;
            body = `<div class="lp-recap-text">${esc(recap.text)}</div>
              ${recap.status === 'fail' ? `<div class="lp-error-text">${esc(recap.error ?? '')}</div>` : ''}
              <div class="lp-sum-actions">
                ${btn('recap-edit', 'act.edit', false, busy)}
                ${btn('recap-condense', 'recap.condense', recap.status === 'fail', busy)}
                ${recap.mode === 'condensed' && recap.raw ? btn('recap-raw', 'recap.useRaw', false, busy) : ''}
                ${lastCarry() ? btn('carry-undo', 'carry.undo', false, busy) : btn('recap-delete', 'recap.delete', false, busy)}
              </div>`;
        }
        out.push(`<div class="lp-recap" data-role="recap">
            <div class="lp-row"><span class="lp-label">${esc(t('recap.from', { chat: recap.source ?? '—' }))}</span>${status}</div>
            ${body}
          </div>`);
    }
    if (linked) {
        const text = linked.missing ? `<div class="lp-note">${esc(t('recap.linkMissing'))}</div>`
            : linked.lines.length ? `<div class="lp-recap-text">${linked.lines.map(esc).join('<br>')}</div>`
                : `<div class="lp-note">${esc(t('recap.linkEmpty'))}</div>`;
        out.push(`<div class="lp-recap lp-recap-linked" data-role="recap-linked">
            <div class="lp-row"><span class="lp-label">${esc(t('recap.linked', { chat: linked.source }))}</span><span class="lp-badge">${esc(t('recap.readonly'))}</span></div>
            ${text}
          </div>`);
    }
    return `
      <details class="lp-sec" data-recap${open ? ' open' : ''}>
        <summary><span class="lp-sec-title">📌 ${esc(t('recap.title'))}</span><span class="lp-sec-hint">${esc(t('recap.hint'))}</span></summary>
        <div class="lp-sec-body">${out.join('')}</div>
      </details>`;
}

// ===== 摘要分頁：卷 → 章 → 各層 =====

/** 群組開著嗎：「未壓縮」預設開，章和卷預設收起；都記住上次的狀態。 */
function groupOpen(id) {
    return id === 'loose' ? isSectionOpen('group:loose') : isExpanded(`group:${id}`);
}

function groupHead(id, title, kind, range, meta, state = null) {
    const open = groupOpen(id);
    const badgeHtml = state && state !== 'ok' ? badge(state) : '';
    return `
      <button type="button" class="lp-group-head" data-action="sum-group" data-group="${esc(id)}" aria-expanded="${open}">
        <span class="lp-sum-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span class="lp-group-title">${esc(title)}</span>
        <span class="lp-kind-tag">${esc(kind)}</span>
        <span class="lp-note">${esc(range)}</span>
        ${badgeHtml}
        <span class="lp-spacer"></span>
        <span class="lp-note lp-group-meta">${esc(meta)}</span>
      </button>`;
}

/** 章或卷的總結卡片：時間地點、內容、操作（重新壓縮、編輯）。 */
function digestCard(kind, data, state, query = '') {
    const id = data.id;
    if (view.sum.editing === id) {
        return `
          <div class="lp-digest" data-digest="${esc(id)}">
            <textarea class="text_pole lp-sum-editor" data-digest-text aria-label="${esc(t('act.edit'))}">${esc(data.summary ?? '')}</textarea>
            <div class="lp-sum-actions">
              <button type="button" class="menu_button lp-btn lp-primary" data-action="digest-save" data-kind="${kind}" data-id="${esc(id)}">${esc(t('act.save'))}</button>
              <button type="button" class="menu_button lp-btn" data-action="digest-cancel">${esc(t('act.cancel'))}</button>
            </div>
          </div>`;
    }
    const hint = state === 'stale' ? t(`${kind}.stale`) : state === 'fail' ? t('sum.hint.fail', { error: data.error ?? '' }) : '';
    return `
      <div class="lp-digest">
        ${sceneHtml({ time: data.time, location: data.location, characters: [] })}
        ${hint ? `<div class="lp-sum-hint${state === 'stale' ? ' lp-warn' : ''}">${esc(hint)}</div>` : ''}
        ${data.coarse ? `<div class="lp-note" data-role="coarse-tag">${esc(t('catchup.coarseChapter'))}</div>` : ''}
        ${data.summary ? `<div class="lp-sum-text">${hl(data.summary, query)}</div>` : ''}
        <div class="lp-sum-actions">
          <button type="button" class="menu_button lp-btn${state !== 'ok' ? ' lp-primary' : ''}" data-action="digest-redo" data-id="${esc(id)}">${esc(t('compress.redo'))}</button>
          ${data.coarse ? `<button type="button" class="menu_button lp-btn" data-action="digest-refine" data-id="${esc(id)}">${esc(t('catchup.refine'))}</button>` : ''}
          <button type="button" class="menu_button lp-btn" data-action="digest-edit" data-id="${esc(id)}">${esc(t('act.edit'))}</button>
        </div>
      </div>`;
}

function rangeText(indices) {
    const list = indices.filter((i) => i >= 0);
    if (!list.length) return '';
    return `#${Math.min(...list)}–#${Math.max(...list)}`;
}

function chapterGroup(c, states) {
    const id = c.data.id;
    const body = groupOpen(id)
        ? `<div class="lp-group-body">${digestCard('chapter', c.data, c.state)}${c.indices.filter((i) => i >= 0).sort((a, b) => (view.sum.newest ? b - a : a - b)).map((i) => summaryRow(i, states.get(i) ?? floorState(i))).join('')}</div>`
        : '';
    return `<div class="lp-group">${groupHead(id, t('chapter.label', { n: c.number }), 'L2', rangeText(c.indices), t('chapter.meta', { n: c.indices.length }), c.state)}${body}</div>`;
}

function digestText(label, data) {
    return [label, data.summary, data.time, data.location].filter(Boolean).join(' ');
}

/** 摘要分頁有搜尋字串時：列出符合的卷、章和各層（各層也照篩選標籤）。 */
function renderSummarySearch(states, query) {
    const st = structure();
    const blocks = [];
    for (const v of st.volumes) {
        const label = t('volume.label', { n: v.number });
        if (!matches(digestText(label, v.data), query)) continue;
        const indices = v.chapters.flatMap((c) => c.indices).filter((i) => i >= 0);
        blocks.push({ at: Math.min(...indices, Infinity), html: `<div class="lp-group" data-fold-key="group:${esc(v.data.id)}"><div class="lp-group-label">${esc(label)} <span class="lp-kind-tag">L3</span> <span class="lp-note">${esc(rangeText(indices))}</span></div>${digestCard('volume', v.data, v.state, query)}</div>` });
    }
    for (const c of st.chapters) {
        const label = t('chapter.label', { n: c.number });
        if (!matches(digestText(label, c.data), query)) continue;
        blocks.push({ at: Math.min(...c.indices.filter((i) => i >= 0), Infinity), html: `<div class="lp-group" data-fold-key="group:${esc(c.data.id)}"><div class="lp-group-label">${esc(label)} <span class="lp-kind-tag">L2</span> <span class="lp-note">${esc(rangeText(c.indices))}</span></div>${digestCard('chapter', c.data, c.state, query)}</div>` });
    }
    for (const [i, state] of states) {
        if (!matchesFilter(state, view.sum.filter) || !matches(floorText(i), query)) continue;
        blocks.push({ at: i, html: summaryRow(i, state, query) });
    }
    blocks.sort((a, b) => (view.sum.newest ? b.at - a.at : a.at - b.at));
    const count = `<div class="lp-note" role="status">${esc(t('search.count', { n: blocks.length }))}</div>`;
    return blocks.length ? count + blocks.map((b) => b.html).join('') : `<div class="lp-wip">${esc(t('search.none'))}</div>`;
}

function renderTree(states) {
    const st = structure();
    const blocks = []; // { at, html }：用最早的樓層排序
    // 未壓縮：不屬於任何章的樓層。
    const loose = [...states.keys()].filter((i) => !st.claimed.has(i));
    if (loose.length) {
        const sorted = [...loose].sort((a, b) => (view.sum.newest ? b - a : a - b));
        const shown = sorted.slice(0, view.sum.limit);
        const open = groupOpen('loose');
        const more = sorted.length > shown.length
            ? `<button type="button" class="menu_button lp-btn lp-more" data-action="sum-more">${esc(t('sum.more', { n: sorted.length - shown.length }))}</button>` : '';
        const n = Number(getSettings().compress.l1PerL2) || 10;
        blocks.push({
            at: Math.min(...loose),
            html: `<div class="lp-group">${groupHead('loose', t('group.loose'), 'L1', rangeText(loose), t('group.looseMeta', { n: loose.length, every: n }))}
              ${open ? `<div class="lp-group-body">${shown.map((i) => summaryRow(i, states.get(i))).join('')}${more}</div>` : ''}</div>`,
        });
    }
    for (const c of st.chapters) {
        if (st.claimedChapters.has(c.data.id)) continue;
        blocks.push({ at: Math.min(...c.indices.filter((i) => i >= 0), Infinity), html: chapterGroup(c, states) });
    }
    for (const v of st.volumes) {
        const id = v.data.id;
        const indices = v.chapters.flatMap((c) => c.indices);
        const chapters = [...v.chapters].sort((a, b) => (view.sum.newest ? b.number - a.number : a.number - b.number));
        const body = groupOpen(id)
            ? `<div class="lp-group-body">${digestCard('volume', v.data, v.state)}${chapters.map((c) => chapterGroup(c, states)).join('')}</div>`
            : '';
        blocks.push({
            at: Math.min(...indices.filter((i) => i >= 0), Infinity),
            html: `<div class="lp-group">${groupHead(id, t('volume.label', { n: v.number }), 'L3', rangeText(indices), t('volume.meta', { n: v.chapters.length }), v.state)}${body}</div>`,
        });
    }
    blocks.sort((a, b) => (view.sum.newest ? b.at - a.at : a.at - b.at));
    return blocks.map((b) => b.html).join('');
}

let summaryRefreshTimer = null;
function canAutoRefresh() {
    if (!isPanelOpen() || !(view.check.open || ['summary', 'notes', 'done', 'calendar'].includes(view.tab))) return false;
    // 正在填表單（記事、章／卷總結）時不重畫，免得打到一半的字不見。
    return !(view.notes.editing || view.notes.adding || view.sum.editing);
}

function scheduleRefresh() {
    if (!canAutoRefresh()) return;
    clearTimeout(summaryRefreshTimer);
    // 觸發時再檢查一次：排程之後使用者可能已經開始編輯了。
    summaryRefreshTimer = setTimeout(() => { if (canAutoRefresh()) render(); }, 80);
}
onSummaryChange(scheduleRefresh);
onNotesChange(scheduleRefresh);
onCarryChange(scheduleRefresh);
onCalendarChange(scheduleRefresh);
// 每次送出後更新標題列的統計（不整頁重畫）。
onStatsChange(() => {
    const el = isPanelOpen() ? panel.querySelector('.lp-stats') : null;
    if (el) el.textContent = statsText();
});

// ===== 記事分頁 =====

const SECTION_HINT = { character: 'notes.characterHint', promise: 'notes.promiseHint' };
const KIND_KEY = { character: 'characters', item: 'items', promise: 'promises', todo: 'todos' };

function floorLink(index, key) {
    return `<button type="button" class="lp-link" data-action="note-jump" data-index="${index}">${esc(t(key, { n: index }))}</button>`;
}

function noteTrace(note) {
    const parts = [];
    if (note.carried && note.createdFloor === null) parts.push(esc(t(note.source ? 'notes.carried' : 'notes.shared', { chat: note.source ?? '' })));
    else parts.push(note.createdFloor === null ? esc(t('notes.manualAdd')) : floorLink(note.createdFloor, 'notes.created'));
    if (note.updatedFloor !== null && note.updatedFloor !== note.createdFloor) parts.push(floorLink(note.updatedFloor, 'notes.updated'));
    if (note.state !== 'active') {
        parts.push(note.closedFloor === null ? esc(t('notes.closedManual')) : floorLink(note.closedFloor, 'notes.closed'));
    }
    return `<div class="lp-note-trace">${parts.join(' · ')}</div>`;
}

function noteForm(type, data, { id = null } = {}) {
    const fields = NOTE_FIELDS[type].map((f, i) => {
        const num = NUMBER_FIELDS.has(f);
        const attrs = num ? 'type="number" min="0" step="1" inputmode="numeric"' : 'type="text"';
        return `
      <label class="lp-field"><span class="lp-label">${esc(t(`field.${type}.${f}`))}</span>
        <input ${attrs} class="text_pole" data-note-field="${f}" value="${esc(data?.[f] ?? '')}"${i === 0 ? ' data-autofocus' : ''}></label>`;
    }).join('');
    return `
      <div class="lp-note-card lp-note-form" data-note-form="${id ?? ''}" data-type="${type}">
        <div class="lp-form-grid">${fields}</div>
        <div class="lp-sum-actions">
          <button type="button" class="menu_button lp-btn lp-primary" data-action="note-save">${esc(t('notes.act.save'))}</button>
          <button type="button" class="menu_button lp-btn" data-action="note-cancel">${esc(t('notes.act.cancel'))}</button>
        </div>
      </div>`;
}

function noteActions(note) {
    const btn = (act, key, extra = '') =>
        `<button type="button" class="menu_button lp-btn lp-mini" data-action="${act}" data-id="${note.id}"${extra}>${esc(t(key))}</button>`;
    const out = [btn('note-edit', 'notes.act.edit'),
        btn('note-pin', note.pinned ? 'notes.act.unpin' : 'notes.act.pin', ` data-on="${Boolean(note.pinned)}" aria-pressed="${Boolean(note.pinned)}"`)];
    if (note.type === 'item') out.push(btn('note-complete', 'notes.act.used', ' data-result="used"'));
    if (note.type === 'todo') out.push(btn('note-complete', 'notes.act.done', ' data-result="done"'));
    if (note.type === 'promise' && note.state === 'active') {
        out.push(btn('note-complete', 'notes.act.kept', ' data-result="kept"'));
        out.push(btn('note-complete', 'notes.act.broken', ' data-result="broken"'));
    }
    if (note.type === 'promise' && note.state === 'broken') out.push(btn('note-reopen', 'notes.act.reopen'));
    return `<div class="lp-sum-actions">${out.join('')}</div>`;
}

/** 搜尋用：一條記事的所有文字。 */
function noteText(note) {
    return [typeLabel(note.type), ...Object.values(note.data ?? {}), note.state !== 'active' ? resultLabel(note.result ?? note.state) : ''].filter(Boolean).join(' ');
}

/** 收起時那一行的副標：人物顯示身份／關係，物件顯示在誰手上，約定顯示和誰、時間。 */
function noteSub(note) {
    const d = note.data;
    if (note.type === 'character') return [d.identity, d.relation].filter(Boolean).join(' · ');
    if (note.type === 'item') return d.holder ?? '';
    if (note.type === 'promise') return [d.with, d.when].filter(Boolean).join(' · ');
    return '';
}

/** 記事卡片：平常只顯示一行，點開才有全部欄位和按鈕。搜尋時符合的自動展開。 */
function noteCard(note, query = '') {
    if (view.notes.editing === note.id) return noteForm(note.type, note.data, { id: note.id });
    const key = `note:${note.id}`;
    const open = isExpanded(key) || Boolean(query);
    const qtyTag = note.type === 'item' && note.data.quantity !== undefined ? `<span class="lp-qty-tag">×${esc(note.data.quantity)}</span>` : '';
    const broken = note.state === 'broken' ? `<span class="lp-badge lp-st-fail">${esc(resultLabel('broken'))}</span>` : '';
    const sub = noteSub(note);
    const head = `
        <button type="button" class="lp-row-head" data-action="fold" data-key="${esc(key)}" aria-expanded="${open}">
          <span class="lp-sum-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
          <span class="lp-note-title">${hl(noteTitle(note), query)}</span>
          ${note.pinned ? `<span class="lp-pin-tag" title="${esc(t('notes.pinned'))}" aria-label="${esc(t('notes.pinned'))}">📌</span>` : ''}${qtyTag}${broken}
          ${!open && sub ? `<span class="lp-row-preview">${hl(sub, query)}</span>` : ''}
        </button>`;
    if (!open) return `<div class="lp-note-card lp-folded${note.state === 'broken' ? ' lp-note-broken' : ''}" data-fold-key="${esc(key)}">${head}</div>`;
    const titleField = NOTE_FIELDS[note.type][0];
    const lines = NOTE_FIELDS[note.type]
        .filter((f) => f !== titleField && !NUMBER_FIELDS.has(f) && note.data[f])
        .map((f) => `<div class="lp-note-line"><span class="lp-label">${esc(t(`field.${note.type}.${f}`))}</span> ${hl(note.data[f], query)}</div>`)
        .join('');
    // 物件的數量：直接用 −／＋ 改。
    const qty = note.type === 'item' ? `
        <div class="lp-qty">
          <span class="lp-label">${esc(t('field.item.quantity'))}</span>
          <button type="button" class="menu_button lp-btn lp-mini lp-qty-btn" data-action="note-qty" data-delta="-1" data-id="${note.id}" aria-label="${esc(t('notes.qtyMinus'))}">−</button>
          <span class="lp-qty-val" aria-live="polite">${esc(note.data.quantity ?? '—')}</span>
          <button type="button" class="menu_button lp-btn lp-mini lp-qty-btn" data-action="note-qty" data-delta="1" data-id="${note.id}" aria-label="${esc(t('notes.qtyPlus'))}">＋</button>
        </div>` : '';
    return `
      <div class="lp-note-card${note.state === 'broken' ? ' lp-note-broken' : ''}" data-fold-key="${esc(key)}">
        ${head}
        ${qty}
        ${lines}
        ${noteTrace(note)}
        ${noteActions(note)}
      </div>`;
}

function renderNotesTab(types = NOTE_TYPES) {
    if (!isActive()) return '';
    const query = view.query[view.tab] ?? '';
    const sections = types.map((type) => {
        // 進行中的在前，被打破的約定在後。
        const all = notesOfType(type).sort((a, b) => (a.state === 'broken') - (b.state === 'broken'));
        const list = query ? all.filter((n) => matches(noteText(n), query)) : all;
        const hint = SECTION_HINT[type] ? `<span class="lp-note">${esc(t(SECTION_HINT[type]))}</span>` : '';
        const adding = view.notes.adding === type ? noteForm(type, {}) : '';
        const secKey = `sec:${type}`;
        // 搜尋時區塊一律打開，才看得到結果。
        const open = isSectionOpen(secKey) || Boolean(query) || Boolean(adding);
        const count = query ? t('search.countOf', { n: list.length, total: all.length }) : t('notes.count', { n: all.length });
        return `
          <section class="lp-note-section">
            <div class="lp-row">
              <button type="button" class="lp-sec-toggle" data-action="fold-sec" data-key="${secKey}" aria-expanded="${open}">
                <span class="lp-sum-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
                <span class="lp-scope-title">${esc(t(`kind.${KIND_KEY[type]}`))}</span>
                <span class="lp-note">${esc(count)}</span>
              </button>
              ${open ? hint : ''}
              <span class="lp-spacer"></span>
              <button type="button" class="menu_button lp-btn lp-mini" data-action="note-add" data-type="${type}">${esc(t('notes.add'))}</button>
            </div>
            ${adding}
            ${open ? `<div class="lp-card-grid">${list.map((n) => noteCard(n, query)).join('')}</div>` : ''}
          </section>`;
    }).join('');
    const empty = types.every((type) => !notesOfType(type).length) && !view.notes.adding
        ? `<div class="lp-wip">${esc(t('notes.empty'))}</div>` : '';
    const none = query && types.every((type) => !notesOfType(type).some((n) => matches(noteText(n), query)))
        ? `<div class="lp-wip">${esc(t('search.none'))}</div>` : '';
    return `${searchBox(view.tab)}${empty}${none}<div class="lp-notes-stack">${sections}</div>`;
}

// ===== 已完成分頁 =====

function renderDoneTab() {
    if (!isActive()) return '';
    const list = closedNotes();
    const query = view.query.done;
    const shown = query ? list.filter((n) => matches(noteText(n), query)) : list;
    const rows = shown.map((note) => {
        const key = `done:${note.id}`;
        const open = isExpanded(key) || Boolean(query);
        const head = `
          <button type="button" class="lp-row-head" data-action="fold" data-key="${esc(key)}" aria-expanded="${open}">
            <span class="lp-sum-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
            <span class="lp-chip-static">${esc(typeLabel(note.type))}</span>
            <span class="lp-note-title">${hl(noteTitle(note), query)}</span>
            <span class="lp-note">（${esc(resultLabel(note.result))}）</span>
          </button>`;
        if (!open) return `<div class="lp-floor-row lp-folded" data-fold-key="${esc(key)}">${head}</div>`;
        return `
          <div class="lp-floor-row lp-unfolded" data-fold-key="${esc(key)}">
            ${head}
            <div class="lp-floor-main">
              ${noteTrace(note)}
              <div class="lp-sum-actions">
                <button type="button" class="menu_button lp-btn lp-mini" data-action="note-reopen" data-id="${note.id}">${esc(t('done.restore'))}</button>
                <button type="button" class="menu_button lp-btn lp-mini lp-danger" data-action="note-delete" data-id="${note.id}">${esc(t('done.delete'))}</button>
              </div>
            </div>
          </div>`;
    }).join('');
    let clear = '';
    if (list.length && view.notes.confirmClear) {
        clear = `<div class="lp-callout lp-row"><span>${esc(t('done.clearConfirm', { n: list.length }))}</span><span class="lp-spacer"></span>
          <button type="button" class="menu_button lp-btn lp-danger" data-action="done-clear-yes">${esc(t('done.clearYes'))}</button>
          <button type="button" class="menu_button lp-btn" data-action="done-clear-no">${esc(t('done.clearNo'))}</button></div>`;
    } else if (list.length) {
        clear = `<div class="lp-row"><span class="lp-spacer"></span><button type="button" class="menu_button lp-btn lp-danger" data-action="done-clear-ask">${esc(t('done.clear'))}</button></div>`;
    }
    return `
      <div class="lp-summary">
        <div class="lp-note">${esc(t('done.intro'))}</div>
        ${list.length ? searchBox('done') : ''}
        ${!list.length ? `<div class="lp-wip">${esc(t('done.empty'))}</div>` : shown.length ? `<div class="lp-floor-list">${rows}</div>` : `<div class="lp-wip">${esc(t('search.none'))}</div>`}
        ${clear}
      </div>`;
}

// ===== 總搜尋 =====

const GLOBAL_LIMIT = 30;

function resultButton({ tab, key, title, sub = '', query }) {
    return `
      <button type="button" class="lp-result" data-action="goto" data-tab="${tab}" data-key="${esc(key)}">
        <span class="lp-result-title">${hl(title, query)}</span>
        ${sub ? `<span class="lp-result-sub">${hl(sub, query)}</span>` : ''}
      </button>`;
}

function resultGroup(label, items) {
    if (!items.length) return '';
    const more = items.length > GLOBAL_LIMIT ? `<div class="lp-note">${esc(t('search.more', { n: items.length - GLOBAL_LIMIT }))}</div>` : '';
    return `
      <section class="lp-result-group">
        <div class="lp-scope-title">${esc(label)} <span class="lp-note">${esc(t('notes.count', { n: items.length }))}</span></div>
        ${items.slice(0, GLOBAL_LIMIT).join('')}${more}
      </section>`;
}

/** 一次搜摘要、章／卷總結和所有記事；點結果就跳到那個分頁並展開那一項。 */
function renderGlobalSearch() {
    const query = view.global.query;
    const head = `<div class="lp-global-head">${searchBox('global', 'search.globalPlaceholder')}
      <button type="button" class="menu_button lp-btn" data-action="global-toggle">${esc(t('panel.close'))}</button></div>`;
    if (!isActive()) return head;
    if (!query.trim()) return `${head}<div class="lp-wip">${esc(t('search.globalHint'))}</div>`;

    const groups = [];
    const st = structure();
    const digests = [];
    for (const v of st.volumes) {
        const label = t('volume.label', { n: v.number });
        if (matches(digestText(label, v.data), query)) digests.push(resultButton({ tab: 'summary', key: `group:${v.data.id}`, title: label, sub: v.data.summary, query }));
    }
    for (const c of st.chapters) {
        const label = t('chapter.label', { n: c.number });
        if (matches(digestText(label, c.data), query)) digests.push(resultButton({ tab: 'summary', key: `group:${c.data.id}`, title: label, sub: c.data.summary, query }));
    }
    groups.push(resultGroup(t('search.groupDigests'), digests));
    const floors = aiIndices().reverse()
        .filter((i) => getEntry(i)?.summary && matches(floorText(i), query))
        .map((i) => resultButton({ tab: 'summary', key: floorKey(i), title: `#${i}`, sub: getEntry(i).summary, query }));
    groups.push(resultGroup(t('search.groupFloors'), floors));
    const tabOf = { character: 'characters', item: 'items', promise: 'notes', todo: 'notes' };
    for (const type of NOTE_TYPES) {
        if (!isTracked(type)) continue;
        const items = notesOfType(type)
            .filter((n) => matches(noteText(n), query))
            .map((n) => resultButton({ tab: tabOf[type], key: `note:${n.id}`, title: noteTitle(n), sub: matchedFields(n, query) || noteSub(n), query }));
        groups.push(resultGroup(t(`kind.${KIND_KEY[type]}`), items));
    }
    const done = closedNotes()
        .filter((n) => matches(noteText(n), query))
        .map((n) => resultButton({ tab: 'done', key: `done:${n.id}`, title: noteTitle(n), sub: `${typeLabel(n.type)}（${resultLabel(n.result)}）`, query }));
    groups.push(resultGroup(t('tab.done'), done));
    const body = groups.join('');
    return `${head}${body || `<div class="lp-wip">${esc(t('search.none'))}</div>`}`;
}

/** 總搜尋結果的副標：列出哪些欄位符合（標題本身符合的不重複列）。 */
function matchedFields(note, query) {
    const titleField = NOTE_FIELDS[note.type][0];
    return NOTE_FIELDS[note.type]
        .filter((f) => f !== titleField && note.data[f] && terms(query).some((x) => String(note.data[f]).toLowerCase().includes(x)))
        .map((f) => `${t(`field.${note.type}.${f}`)}：${note.data[f]}`)
        .join('｜');
}

/** 點了總搜尋的結果：切到那個分頁、用同樣的字篩選、展開並捲到那一項。 */
function gotoResult({ tab, key }) {
    view.global.open = false;
    view.tab = tab;
    if (tab in view.query) view.query[tab] = view.global.query;
    setExpanded(key, true);
    view.focusKey = key;
    render();
}

function saveNoteForm(form) {
    const data = {};
    form.querySelectorAll('[data-note-field]').forEach((input) => { data[input.dataset.noteField] = input.value; });
    const type = form.dataset.type;
    const id = form.dataset.noteForm;
    const ok = id ? updateNoteManual(id, data) : addNoteManual(type, data);
    if (!ok) {
        toast(t('notes.titleRequired', { field: t(`field.${type}.${NOTE_FIELDS[type][0]}`) }), 'warning');
        form.querySelector('[data-note-field]')?.focus();
        return;
    }
    view.notes.editing = null;
    view.notes.adding = null;
    render();
}

// ===== 記憶範圍 =====

function scopeTable(which, values, current) {
    const head = `<span></span>${values.map((v) => `<span class="lp-label">${esc(t(`scope.${v}`))}</span>`).join('')}`;
    const rows = SCOPE_KINDS.map((kind) => {
        const cells = values.map((v) => {
            const aria = `${t(`kind.${kind}`)}: ${t(`scope.${v}`)}`;
            return `<label class="lp-radio-cell"><input type="radio" name="lp-scope-${which}-${kind}" data-scope="${which}" data-kind="${kind}" value="${v}"${current[kind] === v ? ' checked' : ''} aria-label="${esc(aria)}"></label>`;
        }).join('');
        return `<span class="lp-scope-kind">${esc(t(`kind.${kind}`))}</span>${cells}`;
    }).join('');
    return `<div class="lp-scope-grid">${head}${rows}</div>`;
}

function renderScope() {
    if (!hasCharacterChat() || isGroupChat()) return `<div class="lp-note">${esc(t('set.scope.noChat'))}</div>`;
    return `
      <div class="lp-scope-block">
        <div class="lp-scope-title">${esc(t('set.scope.char'))}</div>
        <div class="lp-note">${esc(t('set.scope.char.note', { name: characterName() }))}</div>
        ${scopeTable('char', CHAR_SCOPE_VALUES, getCharacterScope())}
      </div>
      <div class="lp-scope-block">
        <div class="lp-scope-title">${esc(t('set.scope.chat'))}</div>
        <div class="lp-note">${esc(t('set.scope.chat.note'))}</div>
        ${scopeTable('chat', CHAT_SCOPE_VALUES, getChatScope())}
        ${summarySourcePicker()}
      </div>
      <div class="lp-scope-block">
        <div class="lp-scope-title">${esc(t('set.carry.title'))}</div>
        ${radio('lp-recap-mode', 'carry.recapMode', 'condense', t('set.carry.condense'))}
        ${radio('lp-recap-mode', 'carry.recapMode', 'raw', t('set.carry.raw'))}
        ${getSettings().carry.recapMode === 'condense' ? `<div class="lp-row">${inline('set.carry.length', { n: numberInput('carry.recapLength', t('set.carry.length.aria')) })}</div>` : ''}
        <div class="lp-note">${esc(t('set.carry.note'))}</div>
      </div>
      ${importBlock()}`;
}

/** 摘要設成即時共用時：選要讀哪個聊天的摘要。 */
function summarySourcePicker() {
    if (effectiveScope('summary') !== 'share') return '';
    const linked = getLinkedSummary();
    const list = otherSnapshots();
    if (!list.length) return `<div class="lp-note">${esc(t('set.scope.noSource'))}</div>`;
    const opts = list.map((x) => `<option value="${esc(x.id)}"${linked?.source === x.id ? ' selected' : ''}>${esc(snapshotLabel(x))}</option>`).join('');
    return `<div class="lp-row"><label class="lp-label" for="lp-sum-src">${esc(t('set.scope.source'))}</label>
      <select id="lp-sum-src" class="text_pole lp-select" data-role="summary-source">${linked?.source ? '' : `<option value="">—</option>`}${opts}</select></div>`;
}

function snapshotLabel(x) {
    const date = x.at ? new Date(x.at).toLocaleString() : '';
    return t('import.option', { chat: x.id, floors: x.floors ?? 0, notes: x.notes?.length ?? 0, date });
}

/** 從其他聊天匯入。 */
function importBlock() {
    const list = otherSnapshots();
    const imp = view.imp;
    if (!imp.kinds) {
        const cs = getCharacterScope();
        imp.kinds = new Set(SCOPE_KINDS.filter((k) => cs[k] !== 'none'));
    }
    if (!list.some((x) => x.id === imp.src)) imp.src = list[0]?.id ?? null;
    const undo = lastCarry() ? `<div class="lp-row"><span class="lp-note">${esc(t('import.last', { chat: lastCarry().source }))}</span>
      <button type="button" class="menu_button lp-btn" data-action="carry-undo">${esc(t('carry.undo'))}</button></div>` : '';
    let body;
    if (!list.length) {
        body = `<div class="lp-note">${esc(t('import.none'))}</div>`;
    } else {
        const opts = list.map((x) => `<option value="${esc(x.id)}"${x.id === imp.src ? ' selected' : ''}>${esc(snapshotLabel(x))}</option>`).join('');
        const kinds = SCOPE_KINDS.map((k) => `<label class="lp-check"><input type="checkbox" data-import-kind="${k}"${imp.kinds.has(k) ? ' checked' : ''}><span>${esc(t(`kind.${k}`))}</span></label>`).join('');
        body = `
          <div class="lp-row"><select class="text_pole lp-select lp-grow" data-role="import-src" aria-label="${esc(t('import.title'))}">${opts}</select></div>
          <div class="lp-track-group">${kinds}</div>
          <div class="lp-row"><button type="button" class="menu_button lp-btn lp-primary" data-action="import-run">${esc(t('import.run'))}</button>
          ${imp.result ? `<span class="lp-ok-text" role="status">${esc(imp.result)}</span>` : ''}</div>`;
    }
    return `
      <div class="lp-scope-block" data-role="import">
        <div class="lp-scope-title">${esc(t('import.title'))}</div>
        <div class="lp-note">${esc(t('import.desc'))}</div>
        ${body}
        ${undo}
      </div>`;
}

// ===== 設定頁 =====

/** 把 t() 字串裡的 {name} 換成 HTML（例如數字欄位），其他文字照常跳脫。 */
function inline(key, html) {
    const markers = Object.fromEntries(Object.keys(html).map((k) => [k, `@@${k}@@`]));
    let out = esc(t(key, markers));
    for (const [k, v] of Object.entries(html)) out = out.replace(`@@${k}@@`, v);
    return out;
}

function checkbox(path, label, rerender = false) {
    const on = Boolean(getPath(getSettings(), path));
    return `<label class="lp-check"><input type="checkbox" data-path="${path}"${rerender ? ' data-rerender' : ''}${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;
}

function numberInput(path, ariaLabel) {
    const [min, max] = NUMBER_LIMITS[path];
    const val = getPath(getSettings(), path);
    return `<input type="number" class="text_pole lp-num" data-path="${path}" data-kind="number" min="${min}" max="${max}" step="1" value="${esc(val)}" aria-label="${esc(ariaLabel)}">`;
}

function select(path, id, options, rerender = false) {
    const cur = getPath(getSettings(), path);
    const opts = options.map(([value, label]) =>
        `<option value="${esc(value)}"${value === cur ? ' selected' : ''}>${esc(label)}</option>`).join('');
    return `<select id="${id}" class="text_pole lp-select" data-path="${path}"${rerender ? ' data-rerender' : ''}>${opts}</select>`;
}

function radio(name, path, value, label) {
    const on = getPath(getSettings(), path) === value;
    return `<label class="lp-check"><input type="radio" name="${name}" data-path="${path}" data-rerender value="${esc(value)}"${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;
}

function section(id, title, hint, content) {
    const open = view.openSections.has(id);
    return `<details class="lp-sec" data-sec="${id}"${open ? ' open' : ''}>
      <summary><span class="lp-sec-title">${esc(title)}</span><span class="lp-sec-hint">${esc(hint)}</span></summary>
      <div class="lp-sec-body">${content}</div>
    </details>`;
}

/** 最新 2 個 AI 樓層裡用到的標籤，每個選「讀／不讀／只讀」。 */
function tagScanner() {
    if (!isActive()) return '';
    const chat = getChat();
    const latest = aiIndices().slice(-2).map((i) => chat[i]?.mes ?? '');
    const tags = scanTags(latest);
    const body = tags.length
        ? `<ul class="lp-tag-list">${tags.map((x) => {
            const { mode, builtin } = tagMode(x.name);
            const opts = ['read', 'skip', 'only'].map((m) => `<option value="${m}"${m === mode ? ' selected' : ''}>${esc(t(`set.filter.mode.${m}`))}</option>`).join('');
            return `<li class="lp-tag-row" data-tag-row="${esc(x.name)}">
                <div class="lp-tag-main"><code>&lt;${esc(x.name)}&gt;</code>${x.count > 1 ? ` <span class="lp-note">×${x.count}</span>` : ''}${builtin ? ` <span class="lp-note">${esc(t(`set.filter.builtin.${builtin}`))}</span>` : ''}
                  ${x.sample ? `<div class="lp-note lp-tag-sample">${esc(x.sample)}…</div>` : ''}</div>
                <select class="text_pole lp-select" data-role="tag-mode" data-tag="${esc(x.name)}" aria-label="${esc(t('set.filter.mode.aria', { tag: x.name }))}">${opts}</select>
              </li>`;
        }).join('')}</ul>`
        : `<div class="lp-note">${esc(t('set.filter.scan.none'))}</div>`;
    return `<div class="lp-card lp-tag-scan" data-role="tag-scan">
        <div class="lp-scope-title">${esc(t('set.filter.scan.title'))}</div>
        <div class="lp-note">${esc(t('set.filter.scan.desc'))}</div>
        ${body}
      </div>`;
}

function renderSettings() {
    const s = getSettings();
    const hostName = LOCALE_NAMES[detectHostLocale()];

    const general = `
      ${checkbox('enabled', t('set.enabled'), true)}
      ${checkbox('update.autoReload', t('set.update.autoReload'))}
      <div class="lp-note">${esc(t('set.update.note'))}</div>
      <div class="lp-row">
        <label class="lp-label" for="lp-lang">${esc(t('set.language'))}</label>
        ${select('language', 'lp-lang', [['auto', t('set.language.auto', { name: hostName })], ...LOCALES.map((l) => [l, LOCALE_NAMES[l]])], true)}
      </div>
      <div class="lp-note">${esc(t('set.language.note'))}</div>
      <div class="lp-note" data-role="version">${esc(t('set.version', { version: getLoadedVersion() ?? '?' }))}</div>`;

    const model = `
      ${radio('lp-source', 'source', 'main', t('set.source.main'))}
      ${radio('lp-source', 'source', 'custom', t('set.source.custom'))}
      ${s.source === 'custom' ? renderCustom() : ''}`;

    const summary = `
      <div class="lp-row">
        <label class="lp-label" for="lp-mode">${esc(t('set.summary.mode'))}</label>
        ${select('summary.mode', 'lp-mode', ['after', 'manual', 'before'].map((m) => [m, t(`set.summary.mode.${m}`)]))}
      </div>
      ${checkbox('summary.includeUser', t('set.summary.includeUser'), true)}
      ${s.summary.includeUser ? '' : `<div class="lp-callout lp-warn">${esc(t('set.summary.includeUser.warn'))}</div>`}
      <div class="lp-row">${inline('set.summary.ratio', { min: numberInput('summary.ratioMin', 'min %'), max: numberInput('summary.ratioMax', 'max %') })}</div>
      <div class="lp-row">${inline('set.summary.tokens', { min: numberInput('summary.minTokens', 'min tokens'), max: numberInput('summary.maxTokens', 'max tokens') })}</div>
      <div class="lp-note">${esc(t('set.summary.note'))}</div>`;

    const textInput = (path, id, placeholder) =>
        `<input id="${id}" type="text" class="text_pole lp-grow" data-path="${path}" value="${esc(getPath(s, path) ?? '')}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">`;
    const filter = `
      <div class="lp-note">${esc(t('set.filter.desc'))}</div>
      ${checkbox('filter.thinking', t('set.filter.thinking'))}
      ${checkbox('filter.status', t('set.filter.status'))}
      ${checkbox('filter.html', t('set.filter.html'))}
      ${tagScanner()}
      <label class="lp-field" for="lp-filter-tags"><span class="lp-label">${esc(t('set.filter.tags'))}</span>
        ${textInput('filter.tags', 'lp-filter-tags', t('set.filter.tags.ph'))}</label>
      <label class="lp-field" for="lp-filter-only"><span class="lp-label">${esc(t('set.filter.only'))}</span>
        ${textInput('filter.only', 'lp-filter-only', t('set.filter.only.ph'))}</label>
      <div class="lp-note">${esc(t('set.filter.only.note'))}</div>
      <details class="lp-preview-raw">
        <summary>${esc(t('set.filter.test'))}</summary>
        <textarea class="text_pole lp-sum-editor" data-role="filter-test" placeholder="${esc(t('set.filter.test.ph'))}" aria-label="${esc(t('set.filter.test'))}"></textarea>
        <div class="lp-label">${esc(t('set.filter.test.result'))}</div>
        <pre class="lp-preview-text" data-role="filter-result"></pre>
      </details>`;

    const trackItem = (key) => checkbox(`track.${key}`, t(`track.${key}`), true);
    const track = `
      <div class="lp-note">${esc(t('set.track.desc'))}</div>
      <div class="lp-track-group"><span class="lp-label">${esc(t('set.track.scene'))}</span>${['time', 'location', 'cast'].map(trackItem).join('')}</div>
      <div class="lp-track-group"><span class="lp-label">${esc(t('set.track.notes'))}</span>${['character', 'item', 'promise', 'todo'].map(trackItem).join('')}</div>`;

    const c = s.calendar;
    const calendar = `
      ${checkbox('calendar.enabled', t('set.cal.enabled'), true)}
      <div class="lp-note">${esc(t('set.cal.desc'))}</div>
      ${c.enabled ? `
        <div class="lp-track-group"><span class="lp-label">${esc(t('set.cal.track'))}</span>${CAL_TYPES.map((x) => checkbox(`calendar.track.${x}`, t(`cal.type.${x}`), true)).join('')}</div>
        <label class="lp-field" for="lp-cal-start"><span class="lp-label">${esc(t('set.cal.start'))}</span>
          <input id="lp-cal-start" type="date" class="text_pole" data-path="calendar.start" value="${esc(c.start ?? '')}"></label>
        <div class="lp-note">${esc(t('set.cal.start.note'))}</div>
        ${c.track.period ? `<div class="lp-row">${inline('set.cal.period', { cycle: numberInput('calendar.periodCycle', t('set.cal.cycle')), length: numberInput('calendar.periodLength', t('set.cal.length')) })}</div>
        <div class="lp-note">${esc(t('set.cal.period.note'))}</div>` : ''}
        ${checkbox('calendar.inject', t('set.cal.inject'), true)}
        ${c.inject ? `<div class="lp-row">${inline('set.cal.ahead', { n: numberInput('calendar.ahead', t('set.cal.ahead.aria')) })}</div>` : ''}` : ''}`;

    const compressAuto = checkbox('compress.auto', t('set.compress.auto'));
    const compress = `
      ${compressAuto}
      <div class="lp-row">${inline('set.compress.l2', { n: numberInput('compress.l1PerL2', 'L1 → L2') })}</div>
      <div class="lp-row">${inline('set.compress.l3', { n: numberInput('compress.l2PerL3', 'L2 → L3') })}</div>
      <div class="lp-row">${inline('set.compress.ratio', { min: numberInput('compress.ratioMin', 'min %'), max: numberInput('compress.ratioMax', 'max %') })}</div>
      <div class="lp-note">${esc(t('set.compress.note'))}</div>`;

    const hide = `
      <div>${esc(t('set.hide.desc'))}</div>
      ${checkbox('hide.markHidden', t('set.hide.mark'))}
      <div class="lp-note">${esc(t('set.hide.note'))}</div>`;

    const scope = renderScope();

    const inject = `
      <div class="lp-row">
        <label class="lp-label" for="lp-pos">${esc(t('set.inject.position'))}</label>
        ${select('inject.position', 'lp-pos', ['before_recent', 'in_chat', 'in_prompt', 'before_prompt'].map((p) => [p, t(`set.inject.pos.${p}`)]), true)}
        ${s.inject.position === 'in_chat' ? `<span class="lp-label">${esc(t('set.inject.depth'))}</span>${numberInput('inject.depth', t('set.inject.depth'))}` : ''}
      </div>
      <div class="lp-note">${esc(t('set.inject.note'))}</div>`;

    const r = s.recall;
    const vectorOn = r.vector.enabled;
    const recall = `
      ${checkbox('recall.notes', t('set.recall.notes'), true)}
      <div class="lp-note">${esc(t('set.recall.notes.desc'))}</div>
      ${r.notes ? `<div class="lp-row">${inline('set.recall.recent', { n: numberInput('recall.recentFloors', t('set.recall.recent.aria')) })}</div>` : ''}
      ${checkbox('recall.memory', t('set.recall.memory'), true)}
      <div class="lp-note">${esc(t('set.recall.memory.desc'))}</div>
      ${r.memory ? `<div class="lp-row">${inline('set.recall.memoryTopK', { n: numberInput('recall.memoryTopK', t('set.recall.memoryTopK.aria')) })}</div>` : ''}
      <div class="lp-track-group">
        <span class="lp-label">${esc(t('set.vector.title'))}</span>
        ${checkbox('recall.vector.enabled', t('set.vector.enabled'), true)}
      </div>
      <div class="lp-note">${esc(t('set.vector.desc'))}</div>
      ${vectorOn ? `
        <div class="lp-callout">${esc(t('set.vector.recommend'))}</div>
        ${renderCustom('vector')}
        <div class="lp-row">${inline('set.vector.threshold', { n: numberInput('recall.threshold', t('set.vector.threshold.aria')) })}</div>
        ${r.notes ? `<div class="lp-row">${inline('set.vector.noteTopK', { n: numberInput('recall.noteTopK', t('set.vector.noteTopK.aria')) })}</div>` : ''}
        <div class="lp-note">${esc(t('set.vector.thresholdNote'))}</div>
        <div class="lp-row">
          <button type="button" class="menu_button lp-btn" data-action="vector-warm"${view.vector.busy || !r.vector.url || !r.vector.model ? ' disabled' : ''}>${esc(t('set.vector.warm'))}</button>
          <span class="lp-note">${esc(t('set.vector.warm.desc'))}</span>
        </div>` : ''}`;

    const advanced = renderTemplates();

    return `<div class="lp-settings">
      ${section('general', t('sec.general'), t('sec.general.hint'), general)}
      ${section('model', t('sec.model'), t(`set.source.current.${s.source}`), model)}
      ${section('summary', t('sec.summary'), t('sec.summary.hint'), summary)}
      ${section('filter', t('sec.filter'), t('sec.filter.hint'), filter)}
      ${section('track', t('sec.track'), t('sec.track.hint'), track)}
      ${section('calendar', t('sec.calendar'), t(s.calendar.enabled ? 'sec.calendar.on' : 'sec.calendar.off'), calendar)}
      ${section('compress', t('sec.compress'), t('sec.compress.hint'), compress)}
      ${section('hide', t('sec.hide'), t('sec.hide.hint'), hide)}
      ${section('scope', t('sec.scope'), t('sec.scope.hint'), scope)}
      ${section('recall', t('sec.recall'), t(r.vector.enabled ? 'sec.recall.hint.vector' : 'sec.recall.hint'), recall)}
      ${section('inject', t('sec.inject'), t('sec.inject.hint'), inject)}
      ${section('advanced', t('sec.advanced'), t('sec.advanced.hint'), advanced)}
    </div>`;
}

// ===== 自訂 API／向量模型：同一種卡片 =====
// 先改草稿，按「儲存」才寫進設定。which：'custom'（自訂 API）或 'vector'（向量模型）。

function apiState(which) {
    return view[which];
}

function savedApi(which) {
    const s = getSettings();
    return which === 'vector' ? s.recall.vector : s.custom;
}

function customDraft(which = 'custom') {
    const st = apiState(which);
    if (!st.draft) {
        const saved = savedApi(which);
        st.draft = { url: saved.url ?? '', key: saved.key ?? '', model: saved.model ?? '' };
    }
    return st.draft;
}

function customDirty(which = 'custom') {
    const d = apiState(which).draft;
    if (!d) return false;
    const saved = savedApi(which);
    return ['url', 'key', 'model'].some((k) => (d[k] ?? '') !== (saved[k] ?? ''));
}

function customStatusHtml(which = 'custom') {
    const c = apiState(which);
    if (c.busy) return `<span class="lp-note" role="status">${esc(t('set.custom.busy'))}</span>`;
    const parts = [];
    if (c.status) {
        const cls = c.status.type === 'error' ? 'lp-error-text' : 'lp-ok-text';
        parts.push(`<span class="${cls}" role="status">${esc(c.status.text)}</span>`);
    }
    if (customDirty(which)) parts.push(`<span class="lp-warn-text">${esc(t('set.custom.dirty'))}</span>`);
    return parts.join('');
}

function renderCustom(which = 'custom') {
    const c = apiState(which);
    const d = customDraft(which);
    const id = (x) => `lp-${which}-${x}`;
    const api = `data-api="${which}"`;
    let modelField;
    if (!c.manual && c.models.length) {
        // 已儲存的模型不在清單裡時也列出來，免得被默默換掉。
        const list = d.model && !c.models.includes(d.model) ? [d.model, ...c.models] : c.models;
        const opts = [
            `<option value="">${esc(t('set.custom.pick'))}</option>`,
            ...list.map((m) => `<option value="${esc(m)}"${m === d.model ? ' selected' : ''}>${esc(m)}</option>`),
            `<option value="__manual__">${esc(t('set.custom.manual'))}</option>`,
        ].join('');
        modelField = `<select id="${id('model')}" class="text_pole lp-grow" data-draft="model" ${api}>${opts}</select>`;
    } else {
        const ph = which === 'vector' ? 'BAAI/bge-m3' : t('set.custom.modelPlaceholder');
        modelField = `<input id="${id('model')}" type="text" class="text_pole lp-grow" data-draft="model" ${api} value="${esc(d.model)}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false">`;
    }
    const disabled = c.busy ? ' disabled' : '';
    return `
      <div class="lp-card lp-custom" data-api-card="${which}">
        <label class="lp-field" for="${id('url')}"><span class="lp-label">${esc(t('set.custom.url'))}</span>
          <input id="${id('url')}" type="url" inputmode="url" class="text_pole" data-draft="url" ${api} value="${esc(d.url)}" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false"></label>
        <div class="lp-field">
          <label class="lp-label" for="${id('key')}">${esc(t('set.custom.key'))}</label>
          <div class="lp-inline">
            <input id="${id('key')}" type="${c.showKey ? 'text' : 'password'}" class="text_pole lp-grow" data-draft="key" ${api} value="${esc(d.key)}" autocomplete="off" spellcheck="false">
            <button type="button" class="menu_button lp-btn" data-action="toggle-key" ${api} aria-pressed="${c.showKey}">${esc(t(c.showKey ? 'set.custom.keyHide' : 'set.custom.keyShow'))}</button>
          </div>
        </div>
        <div class="lp-field">
          <label class="lp-label" for="${id('model')}">${esc(t('set.custom.model'))}</label>
          <div class="lp-inline">
            ${modelField}
            <button type="button" class="menu_button lp-btn" data-action="fetch-models" ${api}${disabled}>${esc(t('set.custom.fetch'))}</button>
          </div>
        </div>
        <div class="lp-row">
          <button type="button" class="menu_button lp-btn" data-action="test-${which}"${disabled}>${esc(t('set.custom.test'))}</button>
          <button type="button" class="menu_button lp-btn lp-primary" data-action="save-${which}"${disabled}>${esc(t('set.custom.save'))}</button>
          <span class="lp-custom-status" data-role="${which}-status">${customStatusHtml(which)}</span>
        </div>
        <div class="lp-note lp-warn">${esc(t('set.custom.warn'))}</div>
      </div>`;
}

/** 跑一個連線動作：期間按鈕變灰、顯示「連接中」，結束後顯示結果。 */
async function runCustom(task, which = 'custom') {
    const c = apiState(which);
    c.busy = true;
    c.status = null;
    render();
    try {
        c.status = { type: 'ok', text: await task() };
    } catch (e) {
        console.warn(LOG_PREFIX, which === 'vector' ? '向量模型連線失敗' : '自訂 API 連線失敗', e);
        c.status = { type: 'error', text: errorText(e) };
    } finally {
        c.busy = false;
        if (isPanelOpen()) render();
    }
}

function viaText(via) {
    return via === 'backend' ? t('set.custom.via') : '';
}

function fetchModels(which = 'custom') {
    return runCustom(async () => {
        const { models: all, via } = await listModels(customDraft(which));
        // 向量模型：名字裡有 embed／bge／e5 之類的排前面，比較好找。
        const models = which === 'vector'
            ? [...all.filter(isEmbeddingName), ...all.filter((m) => !isEmbeddingName(m))]
            : all;
        apiState(which).models = models;
        apiState(which).manual = models.length === 0;
        return models.length ? t('set.custom.models', { n: models.length, via: viaText(via) }) : t('set.custom.noModels');
    }, which);
}

function isEmbeddingName(m) {
    return /embed|bge|e5-|gte|m3e|jina|nomic|minilm/i.test(m);
}

function testCustom() {
    return runCustom(async () => {
        const r = await testConnection(customDraft());
        return r.kind === 'reply'
            ? t('set.custom.ok', { reply: r.reply, via: viaText(r.via) })
            : t('set.custom.okModels', { n: r.count, via: viaText(r.via) });
    });
}

function testVector() {
    return runCustom(async () => {
        const { dims } = await testEmbedding(customDraft('vector'));
        return t('set.vector.ok', { dims });
    }, 'vector');
}

function saveCustom(which = 'custom') {
    const d = customDraft(which);
    const s = getSettings();
    const value = { url: normalizeBaseUrl(d.url).replace(/\/embeddings$/, ''), key: d.key.trim(), model: d.model.trim() };
    if (which === 'vector') Object.assign(s.recall.vector, value);
    else s.custom = value;
    saveSettings();
    apiState(which).draft = { ...value };
    apiState(which).status = { type: 'saved', text: t('set.custom.saved') };
    render();
}

function warmUp() {
    return runCustom(async () => {
        const { total, fetched } = await warmVectors();
        return t('set.vector.warmed', { total, fetched });
    }, 'vector');
}

function renderTemplates() {
    const key = view.tpl;
    const chips = TEMPLATE_KEYS.map((k) =>
        `<button type="button" class="lp-chip${k === key ? ' lp-on' : ''}" data-action="tpl" data-tpl="${k}" aria-pressed="${k === key}">${esc(t(`tpl.${k}`))}</button>`).join('');
    const modified = isTemplateModified(key);
    let resetArea;
    if (view.confirmReset) {
        resetArea = `<span class="lp-warn-text">${esc(t('tpl.reset.confirm', { name: t(`tpl.${key}`) }))}</span>
          <button type="button" class="menu_button lp-btn" data-action="reset-yes">${esc(t('tpl.reset.yes'))}</button>
          <button type="button" class="menu_button lp-btn" data-action="reset-no">${esc(t('tpl.reset.no'))}</button>`;
    } else {
        resetArea = `${view.resetDone ? `<span class="lp-ok-text" role="status">${esc(t('tpl.reset.done'))}</span>` : ''}
          <button type="button" class="menu_button lp-btn" data-action="reset-ask" data-role="tpl-reset"${modified ? '' : ' disabled'}>${esc(t('tpl.reset'))}</button>`;
    }
    return `
      <div class="lp-chips">${chips}</div>
      <textarea class="text_pole lp-template" data-template="${key}" aria-label="${esc(t(`tpl.${key}`))}" spellcheck="false">${esc(getTemplate(key))}</textarea>
      <div class="lp-row lp-tpl-foot">
        <span class="lp-note">${esc(t('tpl.vars', { vars: TEMPLATE_VARS[key].join(' ') }))}</span>
        <span class="lp-chip-static" data-role="tpl-modified"${modified ? '' : ' hidden'}>${esc(t('tpl.modified'))}</span>
        <span class="lp-spacer"></span>
        ${resetArea}
      </div>`;
}

// ===== 事件 =====

function onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
        case 'close':
            closePanel();
            return;
        case 'tab':
            view.tab = btn.dataset.tab;
            view.check.open = false;
            view.notes.editing = null;
            view.notes.adding = null;
            view.notes.confirmClear = false;
            render();
            panel.querySelector(`[data-tab="${view.tab}"]`)?.focus();
            return;
        case 'tpl':
            view.tpl = btn.dataset.tpl;
            view.confirmReset = false;
            view.resetDone = false;
            render();
            return;
        case 'reset-ask':
            view.confirmReset = true;
            view.resetDone = false;
            render();
            return;
        case 'reset-no':
            view.confirmReset = false;
            render();
            return;
        case 'reset-yes':
            resetTemplate(view.tpl);
            view.confirmReset = false;
            view.resetDone = true;
            render();
            return;
        case 'toggle-key': {
            const which = btn.dataset.api ?? 'custom';
            view[which].showKey = !view[which].showKey;
            render();
            panel.querySelector(`[data-action="toggle-key"][data-api="${which}"]`)?.focus();
            return;
        }
        case 'fetch-models':
            fetchModels(btn.dataset.api ?? 'custom');
            return;
        case 'test-custom':
            testCustom();
            return;
        case 'save-custom':
            saveCustom();
            return;
        case 'test-vector':
            testVector();
            return;
        case 'save-vector':
            saveCustom('vector');
            return;
        case 'vector-warm':
            warmUp();
            return;
        case 'import-run': {
            if (!view.imp.src) return;
            const kinds = Object.fromEntries(SCOPE_KINDS.map((k) => [k, view.imp.kinds.has(k) ? 'copy' : 'none']));
            importFrom(view.imp.src, kinds).then((r) => {
                view.imp.result = r ? t('import.done', { notes: r.notes, summary: r.summary ? t('import.withRecap') : '' }) : '';
                if (isPanelOpen()) render();
            });
            return;
        }
        case 'carry-undo':
            undoCarry();
            view.imp.result = null;
            toast(t('carry.undone'), 'info');
            render();
            return;
        case 'recap-edit':
            view.sum.editing = 'recap';
            render();
            panel.querySelector('[data-digest-text]')?.focus();
            return;
        case 'recap-save':
            editRecap(panel.querySelector('[data-digest-text]')?.value ?? '');
            view.sum.editing = null;
            render();
            return;
        case 'recap-condense':
            condenseRecap();
            render();
            return;
        case 'recap-raw':
            restoreRecapRaw();
            render();
            return;
        case 'recap-delete':
            deleteRecap();
            render();
            return;
        case 'note-pin':
            pinNoteManual(btn.dataset.id, btn.dataset.on !== 'true');
            render();
            return;
        case 'sum-filter':
            view.sum.filter = btn.dataset.filter;
            view.sum.limit = SUMMARY_PAGE;
            render();
            return;
        case 'sum-sort':
            view.sum.newest = !view.sum.newest;
            render();
            return;
        case 'sum-more':
            view.sum.limit += SUMMARY_PAGE;
            render();
            return;
        case 'sum-group': {
            const id = btn.dataset.group;
            if (id === 'loose') toggleSection('group:loose');
            else toggleExpanded(`group:${id}`);
            render();
            return;
        }
        case 'fold':
            toggleExpanded(btn.dataset.key);
            render();
            return;
        case 'fold-sec':
            toggleSection(btn.dataset.key);
            render();
            return;
        case 'cal-month':
            view.cal.month = shiftMonth(view.cal.month, Number(btn.dataset.delta));
            render();
            return;
        case 'cal-today':
            view.cal.month = null;
            view.cal.selected = buildCalendar().today;
            render();
            return;
        case 'cal-day':
            view.cal.selected = view.cal.selected === btn.dataset.date ? null : btn.dataset.date;
            render();
            return;
        case 'cal-add': {
            const box = panel.querySelector('[data-role="cal-day"]');
            const type = box?.querySelector('[data-role="cal-type"]')?.value;
            const ok = addManualEvent({
                type, date: type === 'anniversary' ? view.cal.selected.slice(5) : view.cal.selected,
                title: box?.querySelector('[data-role="cal-title-input"]')?.value ?? '',
                count: box?.querySelector('[data-role="cal-count"]')?.value,
                state: box?.querySelector('[data-role="cal-state"]')?.value,
            });
            if (!ok) {
                box?.querySelector('[data-role="cal-title-input"]')?.focus();
                return;
            }
            render();
            return;
        }
        case 'cal-remove':
            removeEvent({ source: btn.dataset.source, id: btn.dataset.id, key: btn.dataset.key });
            render();
            return;
        case 'cal-restore':
            restoreRemoved();
            render();
            return;
        case 'check-toggle':
            view.check.open = !view.check.open;
            view.check.message = null;
            if (view.check.open) view.global.open = false;
            render();
            return;
        case 'check-refresh':
            view.check.message = null;
            render();
            return;
        case 'check-fix': {
            const x = view.check.list.find((i) => i.id === btn.dataset.id);
            if (x?.kind === 'none') {
                view.check.open = false;
                view.tab = 'summary';
                view.catchup = { open: true, from: null, to: null, fine: 30, block: null };
            } else if (x) {
                fixIssue(x);
                view.check.message = t('check.fixedOne');
            }
            render();
            return;
        }
        case 'check-fix-all':
            view.check.message = t('check.fixedAll', { n: fixAll(view.check.list) });
            render();
            return;
        case 'check-jump':
            onSummaryAction(Number(btn.dataset.index), 'jump');
            return;
        case 'check-audit': {
            const floors = pickAuditFloors(view.check.auditN);
            if (!floors.length) {
                view.check.message = t('check.audit.nothing');
                render();
                return;
            }
            auditFloors(floors, () => { if (isPanelOpen() && view.check.open) render(); });
            return;
        }
        case 'global-toggle':
            view.check.open = false;
            view.global.open = !view.global.open;
            render();
            if (view.global.open) panel.querySelector('[data-search="global"]')?.focus();
            return;
        case 'goto':
            gotoResult(btn.dataset);
            return;
        case 'compress-now':
            enqueueCompress();
            render();
            return;
        case 'digest-redo':
            view.sum.editing = null;
            enqueueCompress(btn.dataset.id);
            render();
            return;
        case 'digest-edit':
            view.sum.editing = btn.dataset.id;
            render();
            panel.querySelector('[data-digest-text]')?.focus();
            return;
        case 'digest-cancel':
            view.sum.editing = null;
            render();
            return;
        case 'digest-save': {
            const text = panel.querySelector('[data-digest-text]')?.value ?? '';
            const ok = btn.dataset.kind === 'volume' ? editVolume(btn.dataset.id, text) : editChapter(btn.dataset.id, text);
            if (!ok) return;
            view.sum.editing = null;
            render();
            return;
        }
        case 'sum-act':
            onSummaryAction(Number(btn.dataset.index), btn.dataset.act);
            return;
        case 'sum-stop':
            if (getCatchup()) pauseCatchup();
            else cancelQueue();
            render();
            return;
        case 'backfill-ask':
            view.catchup = { open: true, from: null, to: null, fine: 30, block: null };
            render();
            return;
        case 'backfill-no':
            view.catchup.open = false;
            render();
            return;
        case 'backfill-yes': {
            const todo = unsummarizedIndices();
            if (!todo.length) return;
            const v = catchupValues(todo);
            view.catchup.open = false;
            startCatchup({ from: Math.min(v.from, v.to), to: Math.max(v.from, v.to), fineCount: v.fine, block: v.block });
            render();
            return;
        }
        case 'catchup-resume':
            resumeCatchup();
            render();
            return;
        case 'catchup-abandon':
            abandonCatchup();
            render();
            return;
        case 'digest-refine': {
            // 粗略的章改成逐層細摘：先拿掉這一章（那幾層會先送原文），再一層一層摘要。
            const ch = structure().chapters.find((c) => c.data.id === btn.dataset.id);
            if (!ch) return;
            deleteChapter(ch.data.id);
            ch.indices.filter((i) => i >= 0).forEach((i) => enqueue(i));
            render();
            return;
        }
        case 'note-add':
            view.notes.adding = btn.dataset.type;
            view.notes.editing = null;
            render();
            panel.querySelector('[data-autofocus]')?.focus();
            return;
        case 'note-edit':
            view.notes.editing = btn.dataset.id;
            view.notes.adding = null;
            render();
            panel.querySelector('[data-autofocus]')?.focus();
            return;
        case 'note-cancel':
            view.notes.editing = null;
            view.notes.adding = null;
            render();
            return;
        case 'note-save':
            saveNoteForm(btn.closest('[data-note-form]'));
            return;
        case 'note-complete':
            completeNoteManual(btn.dataset.id, btn.dataset.result);
            render();
            return;
        case 'note-reopen':
            reopenNoteManual(btn.dataset.id);
            render();
            return;
        case 'note-delete':
            deleteNoteManual(btn.dataset.id);
            render();
            return;
        case 'note-qty':
            changeQuantity(btn.dataset.id, Number(btn.dataset.delta));
            render();
            return;
        case 'note-jump':
            onSummaryAction(Number(btn.dataset.index), 'jump');
            return;
        case 'done-clear-ask':
            view.notes.confirmClear = true;
            render();
            return;
        case 'done-clear-no':
            view.notes.confirmClear = false;
            render();
            return;
        case 'done-clear-yes':
            closedNotes().forEach((n) => deleteNoteManual(n.id));
            view.notes.confirmClear = false;
            render();
            return;
    }
}

function clampNumber(path, raw) {
    const [min, max] = NUMBER_LIMITS[path] ?? [-Infinity, Infinity];
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return getPath(getSettings(), path);
    return Math.min(max, Math.max(min, n));
}

function fixRanges(changedPath) {
    const s = getSettings();
    for (const [lo, hi] of RANGE_PAIRS) {
        const a = getPath(s, lo);
        const b = getPath(s, hi);
        if (a > b) {
            // 改的是上限就把下限拉下來，否則把上限拉上去。
            if (changedPath === hi) setPath(s, lo, b);
            else setPath(s, hi, a);
        }
    }
}

function onSummaryAction(index, act) {
    if (act === 'jump' || act === 'edit' || act === 'write') {
        const edit = act !== 'jump';
        closePanel();
        if (!revealFloor(index, { edit })) toast(t('sum.notLoaded'), 'info');
        return;
    }
    runAction(index, act);
    render();
}

function onChange(e) {
    const el = e.target;
    if (el.dataset?.scope) {
        if (!el.checked) return;
        if (el.dataset.scope === 'char') changeCharacterScope(el.dataset.kind, el.value);
        else changeChatScope(el.dataset.kind, el.value);
        render();
        return;
    }
    if (el.dataset?.role === 'tag-mode') {
        setTagMode(el.dataset.tag, el.value);
        render();
        return;
    }
    if (el.dataset?.role === 'cal-type') {
        view.cal.addType = el.value;
        render();
        return;
    }
    if (el.dataset?.role === 'summary-source') {
        setSummarySource(el.value);
        render();
        return;
    }
    if (el.dataset?.role === 'import-src') {
        view.imp.src = el.value;
        return;
    }
    if (el.dataset?.importKind) {
        if (el.checked) view.imp.kinds.add(el.dataset.importKind);
        else view.imp.kinds.delete(el.dataset.importKind);
        return;
    }
    const path = el.dataset?.path;
    if (!path) return;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'radio') {
        if (!el.checked) return;
        value = el.value;
    } else if (el.dataset.kind === 'number') value = clampNumber(path, el.value);
    else value = el.value;

    setPath(getSettings(), path, value);
    fixRanges(path);
    saveSettings();
    // 改了「摘要時跳過的內容」：試試看的結果跟著更新。
    if (path.startsWith('filter.')) {
        const test = panel.querySelector('[data-role="filter-test"]');
        const out = panel.querySelector('[data-role="filter-result"]');
        if (test && out) out.textContent = cleanForSummary(test.value);
    }
    hooks.onSettingChanged(path, value);
    if (el.dataset.rerender !== undefined) {
        render();
    } else if (el.dataset.kind === 'number') {
        // 不整頁重畫（會打斷連續調整），只把被夾住或被連動的數字寫回欄位。
        panel.querySelectorAll('input[data-kind="number"]').forEach((input) => {
            input.value = String(getPath(getSettings(), input.dataset.path));
        });
    }
}

let searchTimer = null;

function onInput(e) {
    const el = e.target;
    if (el.dataset?.search) {
        const scope = el.dataset.search;
        if (scope === 'global') view.global.query = el.value;
        else view.query[scope] = el.value;
        // 打字時稍等一下再重畫，不要每個字都重畫。
        clearTimeout(searchTimer);
        searchTimer = setTimeout(render, 150);
        return;
    }
    if (el.dataset?.role === 'audit-n') {
        const n = Math.round(Number(el.value));
        if (Number.isFinite(n)) view.check.auditN = Math.min(50, Math.max(1, n));
        return;
    }
    if (el.dataset?.role === 'filter-test') {
        const out = panel.querySelector('[data-role="filter-result"]');
        if (out) out.textContent = cleanForSummary(el.value);
        return;
    }
    if (el.dataset?.cu) {
        const n = Math.round(Number(el.value));
        view.catchup[el.dataset.cu] = Number.isFinite(n) && el.value !== '' ? n : null;
        const box = panel.querySelector('[data-role="cu-estimate"]');
        if (box) box.textContent = catchupEstimate(unsummarizedIndices());
        return;
    }
    if (el.dataset?.draft) {
        const field = el.dataset.draft;
        const which = el.dataset.api ?? 'custom';
        if (field === 'model' && el.value === '__manual__') {
            view[which].manual = true;
            customDraft(which).model = '';
            render();
            panel.querySelector(`#lp-${which}-model`)?.focus();
            return;
        }
        customDraft(which)[field] = el.value;
        view[which].status = null;
        const status = panel.querySelector(`[data-role="${which}-status"]`);
        if (status) status.innerHTML = customStatusHtml(which);
        return;
    }
    if (el.dataset?.template) {
        setTemplate(el.dataset.template, el.value);
        const modified = isTemplateModified(el.dataset.template);
        const chip = panel.querySelector('[data-role="tpl-modified"]');
        if (chip) chip.hidden = !modified;
        const reset = panel.querySelector('[data-role="tpl-reset"]');
        if (reset) reset.disabled = !modified;
        if (view.resetDone) {
            view.resetDone = false;
            panel.querySelector('.lp-ok-text')?.remove();
        }
    }
}

let previewSeq = 0;

/** 算「現在送出的話」各部分的 token，填進摘要分頁最上面的預覽框。 */
async function fillPreview() {
    const seq = ++previewSeq;
    let p;
    try {
        p = await previewInjection();
    } catch (e) {
        console.warn(LOG_PREFIX, '預覽計算失敗', e);
        return;
    }
    // 算的期間畫面重畫過，就以最新那次為準。
    if (seq !== previewSeq || !isPanelOpen()) return;
    const line = panel.querySelector('[data-role="preview-line"]');
    const body = panel.querySelector('[data-role="preview-body"]');
    if (!line || !body) return;
    const n = (x) => Number(x || 0).toLocaleString();
    line.textContent = p.text
        ? t('preview.line', { total: n(p.tokens.total), raw: n(p.tokens.hiddenRaw) })
        : t('preview.nothing');
    const row = (label, value, cls = '') => `<div class="lp-preview-row${cls}"><span>${esc(label)}</span><span class="lp-preview-num">${esc(value)}</span></div>`;
    const sm = p.parts.summaries;
    const rows = [];
    if (sm.recap) rows.push(row(t('preview.recap'), `${n(p.tokens.recap)} tokens`));
    if (sm.volumes) rows.push(row(t('preview.volumes', { n: sm.volumes }), `${n(p.tokens.volumes)} tokens`));
    if (sm.chapters) rows.push(row(t('preview.chapters', { n: sm.chapters }), `${n(p.tokens.chapters)} tokens`));
    rows.push(row(t('preview.summaries', { n: sm.floors }), `${n(p.tokens.floors)} tokens`));
    if (p.parts.calendar.text) rows.push(row(t('preview.calendar'), `${n(p.tokens.calendar)} tokens`));
    if (p.parts.memories.count) rows.push(row(t('preview.memories', { n: p.parts.memories.count }), `${n(p.tokens.memories)} tokens`));
    const sel = p.selection;
    for (const [type, info] of Object.entries(p.parts.notes)) {
        const label = sel?.filtered
            ? t('preview.notesOf', { kind: t(`kind.${KIND_KEY[type]}`), n: info.count, total: info.total })
            : t('preview.notes', { kind: t(`kind.${KIND_KEY[type]}`), n: info.count });
        rows.push(row(label, `${n(p.tokens[type])} tokens`));
    }
    rows.push(row(t('preview.total'), `${n(p.tokens.total)} tokens`, ' lp-preview-total'));
    rows.push(row(t('preview.saved', { n: p.hiddenFloors }), `${n(p.tokens.hiddenRaw)} tokens`));
    body.innerHTML = `
      <div class="lp-note">${esc(t('preview.desc'))}</div>
      <div class="lp-preview-table">${rows.join('')}</div>
      ${recallDetails(sel)}
      ${p.text ? `<details class="lp-preview-raw"><summary>${esc(t('preview.show'))}</summary><pre class="lp-preview-text">${esc(p.text)}</pre></details>` : ''}`;
}

/** 送出預覽：每條記事、每段回憶為什麼被選上（向量的話附上相似度）。 */
function recallDetails(sel) {
    if (!sel) return '';
    const lines = [];
    const vec = sel.vector === 'ok' ? t('preview.vector.ok')
        : sel.vector === 'error' ? t('preview.vector.error', { error: sel.error })
            : t('preview.vector.off');
    lines.push(`<div class="lp-note${sel.vector === 'error' ? ' lp-warn-text' : ''}" data-role="preview-vector">${esc(vec)}</div>`);
    const pct = (x) => `${Math.round(x * 100)}%`;
    if (sel.filtered) {
        const notes = getNotes().notes;
        const items = [...sel.notes].map(([id, info]) => {
            const note = notes.get(id);
            if (!note) return '';
            const why = t(`preview.why.${info.reason}`) + (info.score !== undefined ? ` ${pct(info.score)}` : '');
            return `<li data-recall-note="${esc(id)}">${esc(typeLabel(note.type))}：${esc(noteTitle(note))} <span class="lp-note">（${esc(why)}）</span></li>`;
        }).filter(Boolean);
        const skipped = sel.total - sel.notes.size;
        lines.push(`<div class="lp-label">${esc(t('preview.picked', { n: sel.notes.size, skipped }))}</div>`);
        if (items.length) lines.push(`<ul class="lp-recall-list">${items.join('')}</ul>`);
    }
    if (sel.memories.length) {
        const items = sel.memories.map((m) => {
            const why = m.reason === 'vector' ? `${t('preview.why.vector')} ${pct(m.score)}` : t('preview.why.keyword');
            return `<li data-recall-floor="${m.index}">${esc(t('preview.floor', { n: m.index }))} <span class="lp-note">（${esc(why)}）</span></li>`;
        });
        lines.push(`<div class="lp-label">${esc(t('preview.memories', { n: sel.memories.length }))}</div><ul class="lp-recall-list">${items.join('')}</ul>`);
    }
    return `<details class="lp-preview-raw" data-role="preview-recall"><summary>${esc(t('preview.why'))}</summary>${lines.join('')}</details>`;
}

function onToggle(e) {
    if (e.target?.dataset && 'recap' in e.target.dataset) {
        setSectionOpen('recap', e.target.open);
        return;
    }
    if (e.target?.dataset && 'preview' in e.target.dataset) {
        view.sum.previewOpen = e.target.open;
        return;
    }
    const sec = e.target?.dataset?.sec;
    if (!sec) return;
    if (e.target.open) view.openSections.add(sec);
    else view.openSections.delete(sec);
}
