import { escapeHtml } from './html.js';

export function input(
    name,
    label,
    value = '',
    type = 'text',
    hint = '',
    required = false,
    limits = {},
) {
    const numberLimits =
        type === 'number'
            ? `min="${limits.min ?? 0}"${limits.max === undefined ? '' : ` max="${limits.max}"`} step="${limits.step ?? 1}"`
            : '';
    const hintMarkup = limits.hideHint
        ? ''
        : `<small class="${hint ? '' : 'empty'}">${hint ? escapeHtml(hint) : '&nbsp;'}</small>`;
    const placeholder = limits.placeholder ? `placeholder="${escapeHtml(limits.placeholder)}"` : '';
    const ariaLabel = limits.ariaLabel ? `aria-label="${escapeHtml(limits.ariaLabel)}"` : '';
    return `<label class="field ${limits.hideHint ? 'no-hint' : ''}"><span>${label}</span><input name="${name}" type="${type}" value="${escapeHtml(value)}" ${placeholder} ${ariaLabel} ${numberLimits} ${required ? 'required' : ''} ${limits.disabled ? 'disabled' : ''}/>${hintMarkup}</label>`;
}

export function settingToggle(name, label, description, checked) {
    return `<label class="setting-toggle"><span><strong>${label}</strong><small>${description}</small></span><span class="config-switch"><input name="${name}" type="checkbox" ${checked ? 'checked' : ''}/><i aria-hidden="true"></i></span></label>`;
}

export function setupExplanation(title, items) {
    return `<details class="setup-explainer"><summary>${title}</summary><div class="setup-explainer-grid">${items.map(([name, description]) => `<div><strong>${name}</strong><span>${description}</span></div>`).join('')}</div></details>`;
}

export function fileInput(label, filename, attributes, hint) {
    const data = Object.entries(attributes)
        .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
        .join(' ');
    return `<label class="field no-hint"><span>${label}</span><span class="file-picker"><span class="file-picker-action">选择文件</span><span class="file-picker-name">${escapeHtml(filename || '')}</span><input type="file" ${data} aria-label="${label}"/></span>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</label>`;
}
