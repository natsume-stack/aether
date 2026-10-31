import { THEME_KEY, themes } from '../core/constants.js';
import { icon } from './icons.js';
import { state } from '../core/state.js';

export function applyTheme(theme) {
    state.theme = themes.some(([id]) => id === theme) ? theme : 'system';
    if (state.theme === 'system') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.dataset.theme = state.theme;
    }
    localStorage.setItem(THEME_KEY, state.theme);
}

export function themeControl() {
    const currentLabel = themes.find(([id]) => id === state.theme)?.[1] || '跟随系统';
    const themeIcon = (id) => icon(id === 'system' ? 'device' : id === 'light' ? 'sun' : 'moon');
    return `<div class="theme-picker">
    ${
        state.themeMenuOpen
            ? `<div class="theme-menu" role="menu" aria-label="界面主题">${themes
                  .map(
                      ([id, label]) =>
                          `<button class="${state.theme === id ? 'active' : ''}" data-theme-choice="${id}" role="menuitemradio" aria-checked="${state.theme === id}">${themeIcon(id)}<span>${label}</span><i></i></button>`,
                  )
                  .join('')}</div>`
            : ''
    }
    <button class="theme-trigger ${state.themeMenuOpen ? 'open' : ''}" id="theme-trigger" aria-expanded="${state.themeMenuOpen}">${themeIcon(state.theme)}<span>外观</span><small>${currentLabel}</small>${icon('chevron')}</button>
  </div>`;
}
