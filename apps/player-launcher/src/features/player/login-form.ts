import type { PlayerLauncherState, PlayerServer } from '../../types';

export function renderLoginCard(
    state:PlayerLauncherState,
    server:PlayerServer,
    {
        escapeHtml,
        icon,
    }:{
        escapeHtml:(value:unknown) => string;
        icon:(name:string) => string;
    },
):string {
    const draft = state.loginDraft?.serverId === server.id ? state.loginDraft : undefined;
    return `<div class="login-layout">
    <section class="surface login-card" aria-labelledby="player-login-title">
      <div class="login-card-heading"><h3 id="player-login-title">登录后查看地图</h3><p>账号仅在此服务器下有效。</p></div>
      ${state.authError ? `<p class="inline-error" role="alert">${escapeHtml(state.authError)}</p>` : ''}
      <form id="player-login-form" aria-busy="${state.busy}">
        <div class="login-field"><label for="player-username">玩家账号</label>
          <input id="player-username" name="username" value="${escapeHtml(draft?.username || '')}" autocomplete="username" placeholder="输入此服务器的玩家账号" autocapitalize="none" spellcheck="false" required ${state.busy ? 'readonly' : ''}>
        </div>
        <div class="login-field"><label for="player-password">密码</label>
          <div class="password-input-row">
            <input id="player-password" name="password" value="${escapeHtml(draft?.password || '')}" type="${draft?.passwordVisible ? 'text' : 'password'}" autocomplete="current-password" placeholder="输入密码" required ${state.busy ? 'readonly' : ''}>
            <button class="password-visibility" type="button" data-toggle-password aria-label="${draft?.passwordVisible ? '隐藏密码' : '显示密码'}" aria-pressed="${Boolean(draft?.passwordVisible)}" ${state.busy ? 'disabled' : ''}>${draft?.passwordVisible ? '隐藏' : '显示'}</button>
          </div>
        </div>
        <button class="button primary" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在登录…' : '登录并查看地图'}${icon('arrow')}</button>
      </form>
    </section>
  </div>`;
}
