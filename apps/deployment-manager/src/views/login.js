export function webLogin() {
    return `<section class="manager-login-page"><article class="manager-login-card">
    <div class="manager-login-heading"><span class="manager-login-kicker">BOX3 ENGINE</span><h1>Box Engine 管理界面</h1></div>
    <form id="web-login-form" class="manager-login-form"><label class="field"><span>管理密钥</span><input name="token" type="password" minlength="32" autocomplete="current-password" placeholder="请输入管理密钥" required/><small>密钥仅保存在当前标签页；关闭标签页或退出管理后需要重新输入。</small></label><p id="web-login-error"></p><button class="button primary" type="submit">进入管理平台</button></form>
  </article></section>`;
}
