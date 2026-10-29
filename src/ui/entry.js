// 兩個入口：魔術棒選單裡的「戀人手帳」，以及擴充設定面板裡的按鈕。

import { escapeHtml as esc } from '../util.js';
import { t } from '../i18n.js';
import { openPanel } from './panel.js';
import { VERSION } from '../version.js';
import { hasNews, onSeenChange } from '../changelog.js';

const WAND_ID = 'lp_wand_entry';
const DRAWER_ID = 'lp_settings_drawer';

export function mountWandEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(WAND_ID)) return;
    const item = document.createElement('div');
    item.id = WAND_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.innerHTML = `<div class="fa-solid fa-book-open extensionsMenuExtensionButton" aria-hidden="true"></div><span class="lp-wand-label"></span>`;
    const open = () => {
        // 先關掉魔術棒選單，再開大視窗。
        globalThis.jQuery?.(menu).fadeOut?.(150);
        openPanel();
    };
    item.addEventListener('click', open);
    item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
        }
    });
    menu.appendChild(item);
    relabelEntries();
}

export function mountSettingsDrawer() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById(DRAWER_ID)) return;
    const wrap = document.createElement('div');
    wrap.id = DRAWER_ID;
    wrap.className = 'lp-drawer';
    wrap.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b class="lp-drawer-title"></b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="lp-drawer-hint"></div>
          <button type="button" class="menu_button lp-drawer-open"></button>
        </div>
      </div>`;
    wrap.querySelector('.lp-drawer-open').addEventListener('click', () => openPanel());
    host.appendChild(wrap);
    relabelEntries();
}

/** 語言切換後更新入口的文字。 */
export function relabelEntries() {
    const label = document.querySelector(`#${WAND_ID} .lp-wand-label`);
    if (label) label.textContent = t('app.name');
    const drawer = document.getElementById(DRAWER_ID);
    if (drawer) {
        // 附上正在執行的程式版本：手機瀏覽器有時會一直用快取的舊檔，看這裡就知道更新有沒有載入。
        drawer.querySelector('.lp-drawer-title').innerHTML = `${esc(t('app.name'))} <small class="lp-version">v${esc(VERSION)}</small>`;
        drawer.querySelector('.lp-drawer-hint').textContent = t('drawer.hint');
        drawer.querySelector('.lp-drawer-open').textContent = t('drawer.open');
    }
    refreshNewBadges();
}

/** 有沒看過的更新時，入口旁邊標 NEW（v0.13.30）。 */
export function refreshNewBadges() {
    const on = hasNews();
    for (const host of [document.querySelector(`#${WAND_ID} .lp-wand-label`), document.querySelector(`#${DRAWER_ID} .lp-drawer-title`)]) {
        if (!host) continue;
        let dot = host.parentElement.querySelector('.lp-new-dot');
        if (on && !dot) {
            dot = document.createElement('span');
            dot.className = 'lp-new-dot';
            host.after(dot);
        }
        if (dot) {
            if (on) dot.textContent = t('whatsnew.badge');
            else dot.remove();
        }
    }
}
onSeenChange(refreshNewBadges);
