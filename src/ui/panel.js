// 大視窗：標題列 + 分頁（摘要／記事／已完成／設定）。
// 第一版只有設定頁是完整的，其他分頁先放「製作中」的說明。

import { ctx, escapeHtml as esc, hasCharacterChat, isGroupChat, isTauriTavern, LOG_PREFIX } from '../util.js';
import { getPath, getSettings, saveSettings, setPath } from '../settings.js';
import { currentLocale, detectHostLocale, LOCALE_NAMES, LOCALES, t } from '../i18n.js';
import { getTemplate, isTemplateModified, resetTemplate, setTemplate, TEMPLATE_KEYS, TEMPLATE_VARS } from '../prompts.js';

const TABS = ['summary', 'notes', 'done', 'settings'];
const SCOPE_KINDS = ['summary', 'characters', 'items', 'promises', 'todos'];
const SCOPE_VALUES = ['none', 'copy', 'share'];

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
    tpl: 'l1',
    confirmReset: false,
    resetDone: false,
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
    try { lastFocus?.focus?.(); } catch (e) { /* 元素可能已經不在 */ }
}

/** 聊天切換、語言切換等狀況下重畫（只有開著時才畫）。 */
export function refreshPanel() {
    if (isPanelOpen()) render();
}

function onKeydown(e) {
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
    panel.setAttribute('aria-label', t('app.name'));
    panel.setAttribute('lang', currentLocale());
    panel.innerHTML = renderHeader() + renderTabs() + `<div class="lp-body">${renderBanner()}${renderTab()}</div>`;
    const newBody = panel.querySelector('.lp-body');
    if (newBody) newBody.scrollTop = scrollTop;
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
        <div class="lp-stats">${esc(t('panel.statsNone'))}</div>
      </div>
      <button type="button" class="lp-icon-btn" data-action="close" aria-label="${esc(t('panel.close'))}" title="${esc(t('panel.close'))}">
        <span class="fa-solid fa-xmark" aria-hidden="true"></span>
      </button>
    </div>`;
}

function renderTabs() {
    const items = TABS.map((tab) => {
        const on = view.tab === tab;
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
    switch (view.tab) {
        case 'summary': return renderWip('wip.summary');
        case 'notes': return renderWip('wip.notes');
        case 'done': return renderWip('wip.done');
        case 'settings': return renderSettings();
        default: return '';
    }
}

function renderWip(key) {
    return `<div class="lp-wip">${esc(t(key))}</div>`;
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

function textInput(path, id, label, type = 'text', placeholder = '') {
    const val = getPath(getSettings(), path) ?? '';
    return `<label class="lp-field" for="${id}"><span class="lp-label">${esc(label)}</span>
      <input id="${id}" type="${type}" class="text_pole" data-path="${path}" data-kind="text" value="${esc(val)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"></label>`;
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

function renderSettings() {
    const s = getSettings();
    const hostName = LOCALE_NAMES[detectHostLocale()];

    const general = `
      ${checkbox('enabled', t('set.enabled'), true)}
      <div class="lp-row">
        <label class="lp-label" for="lp-lang">${esc(t('set.language'))}</label>
        ${select('language', 'lp-lang', [['auto', t('set.language.auto', { name: hostName })], ...LOCALES.map((l) => [l, LOCALE_NAMES[l]])], true)}
      </div>
      <div class="lp-note">${esc(t('set.language.note'))}</div>`;

    const custom = s.source === 'custom' ? `
      <div class="lp-grid2 lp-card">
        ${textInput('custom.url', 'lp-custom-url', t('set.custom.url'), 'url', 'https://api.example.com/v1')}
        ${textInput('custom.model', 'lp-custom-model', t('set.custom.model'))}
        ${textInput('custom.key', 'lp-custom-key', t('set.custom.key'), 'password')}
        <div class="lp-note lp-warn lp-span2">${esc(t('set.custom.warn'))}</div>
      </div>` : '';
    const model = `
      ${radio('lp-source', 'source', 'main', t('set.source.main'))}
      ${radio('lp-source', 'source', 'custom', t('set.source.custom'))}
      ${custom}`;

    const summary = `
      <div class="lp-row">
        <label class="lp-label" for="lp-mode">${esc(t('set.summary.mode'))}</label>
        ${select('summary.mode', 'lp-mode', [['auto', t('set.summary.mode.auto')], ['manual', t('set.summary.mode.manual')]])}
      </div>
      ${checkbox('summary.includeUser', t('set.summary.includeUser'), true)}
      ${s.summary.includeUser ? '' : `<div class="lp-callout lp-warn">${esc(t('set.summary.includeUser.warn'))}</div>`}
      <div class="lp-row">${inline('set.summary.ratio', { min: numberInput('summary.ratioMin', 'min %'), max: numberInput('summary.ratioMax', 'max %') })}</div>
      <div class="lp-row">${inline('set.summary.tokens', { min: numberInput('summary.minTokens', 'min tokens'), max: numberInput('summary.maxTokens', 'max tokens') })}</div>
      <div class="lp-note">${esc(t('set.summary.note'))}</div>`;

    const compress = `
      <div class="lp-row">${inline('set.compress.l2', { n: numberInput('compress.l1PerL2', 'L1 → L2') })}</div>
      <div class="lp-row">${inline('set.compress.l3', { n: numberInput('compress.l2PerL3', 'L2 → L3') })}</div>
      <div class="lp-row">${inline('set.compress.ratio', { min: numberInput('compress.ratioMin', 'min %'), max: numberInput('compress.ratioMax', 'max %') })}</div>
      <div class="lp-note">${esc(t('set.compress.note'))}</div>`;

    const hide = `
      <div>${esc(t('set.hide.desc'))}</div>
      ${checkbox('hide.markHidden', t('set.hide.mark'))}
      <div class="lp-note">${esc(t('set.hide.note'))}</div>`;

    const scopeHead = `<span></span>${SCOPE_VALUES.map((v) => `<span class="lp-label">${esc(t(`scope.${v}`))}</span>`).join('')}`;
    const scopeRows = SCOPE_KINDS.map((kind) => {
        const cells = SCOPE_VALUES.map((v) => {
            const on = s.scope[kind] === v;
            const aria = `${t(`kind.${kind}`)}: ${t(`scope.${v}`)}`;
            return `<label class="lp-radio-cell"><input type="radio" name="lp-scope-${kind}" data-path="scope.${kind}" value="${v}"${on ? ' checked' : ''} aria-label="${esc(aria)}"></label>`;
        }).join('');
        return `<span class="lp-scope-kind">${esc(t(`kind.${kind}`))}</span>${cells}`;
    }).join('');
    const scope = `
      <div class="lp-note">${esc(t('set.scope.desc'))}</div>
      <div class="lp-scroll-x"><div class="lp-scope-grid">${scopeHead}${scopeRows}</div></div>`;

    const inject = `
      <div class="lp-row">
        <label class="lp-label" for="lp-pos">${esc(t('set.inject.position'))}</label>
        ${select('inject.position', 'lp-pos', ['in_chat', 'in_prompt', 'before_prompt'].map((p) => [p, t(`set.inject.pos.${p}`)]), true)}
        ${s.inject.position === 'in_chat' ? `<span class="lp-label">${esc(t('set.inject.depth'))}</span>${numberInput('inject.depth', t('set.inject.depth'))}` : ''}
      </div>
      <div class="lp-note">${esc(t('set.inject.note'))}</div>`;

    const advanced = renderTemplates();

    return `<div class="lp-settings">
      ${section('general', t('sec.general'), t('sec.general.hint'), general)}
      ${section('model', t('sec.model'), t(`set.source.current.${s.source}`), model)}
      ${section('summary', t('sec.summary'), t('sec.summary.hint'), summary)}
      ${section('compress', t('sec.compress'), t('sec.compress.hint'), compress)}
      ${section('hide', t('sec.hide'), t('sec.hide.hint'), hide)}
      ${section('scope', t('sec.scope'), t('sec.scope.hint'), scope)}
      ${section('inject', t('sec.inject'), t('sec.inject.hint'), inject)}
      ${section('advanced', t('sec.advanced'), t('sec.advanced.hint'), advanced)}
    </div>`;
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

function onChange(e) {
    const el = e.target;
    const path = el.dataset?.path;
    if (!path || el.dataset.kind === 'text') return;
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

function onInput(e) {
    const el = e.target;
    if (el.dataset?.kind === 'text') {
        setPath(getSettings(), el.dataset.path, el.value.trim());
        saveSettings();
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

function onToggle(e) {
    const sec = e.target?.dataset?.sec;
    if (!sec) return;
    if (e.target.open) view.openSections.add(sec);
    else view.openSections.delete(sec);
}
