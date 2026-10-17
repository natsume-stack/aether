let renderApplication;

export function setRenderer(renderer) {
    renderApplication = renderer;
}

export function render() {
    if (!renderApplication) {
        throw new Error('Application renderer is not initialized');
    }
    renderApplication();
}
