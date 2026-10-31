/** 主题偏好可以本地保存，账号凭据不能。此入口在 HTML 首次绘制之前执行。 */
export class Theme {
    public static readonly key = 'box-player-admin-theme';
    public static readonly order = ['system', 'light', 'dark'] as const;
    public static current():string {
        return document.documentElement.dataset.theme || 'system';
    }
    public static apply(value:string):void {
        document.documentElement.dataset.theme = this.order.some((item) => item === value)
            ? value
            : 'system';
    }
    public static initialize():void {
        try {
            this.apply(localStorage.getItem(this.key) || 'system');
        } catch {
            this.apply('system');
        }
    }
    public static next():string {
        const next =
            this.order[
                (this.order.findIndex((value) => value === this.current()) + 1) % this.order.length
            ];
        this.apply(next);
        try {
            localStorage.setItem(this.key, next);
        } catch {
            /* 可选偏好，不阻断登录。 */
        }
        return next;
    }
}
