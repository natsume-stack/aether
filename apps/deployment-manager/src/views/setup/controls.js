import { escapeHtml } from '../../ui/html.js';

export function serviceModeChoice(attribute, options, selected) {
    return `<div class="database-mode-choice" role="group" aria-label="服务来源">${options.map(([value, label]) => `<button type="button" class="${selected === value ? 'active' : ''}" ${attribute}="${value}" aria-pressed="${selected === value}"><strong>${escapeHtml(label)}</strong></button>`).join('')}</div>`;
}
