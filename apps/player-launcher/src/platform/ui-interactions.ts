/** Keep keyboard navigation inside open dialogs. No extra UI dependency needed. */
export function bindDialogFocus():void {
    document.querySelectorAll<HTMLElement>('[role="dialog"]').forEach((dialog) => {
        dialog.addEventListener('keydown', (event) => {
            if (event.key !== 'Tab') {
                return;
            }
            const controls = [
                ...dialog.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
                ),
            ];
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (!first) {
                return;
            }
            if (
                event.shiftKey &&
                (document.activeElement === first || !dialog.contains(document.activeElement))
            ) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });
    });
}
