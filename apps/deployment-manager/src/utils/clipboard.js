export async function copyText(value) {
    const text = String(value || '');
    if (!text) {
        throw new Error('没有可复制的内容。');
    }
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {
            // HTTP 管理端通常没有 Clipboard API 权限，继续使用兼容回退。
        }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) {
        throw new Error('浏览器未允许复制到剪贴板。');
    }
}
