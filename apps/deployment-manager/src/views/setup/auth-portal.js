import { state } from '../../core/state.js';
import { input } from '../../ui/forms.js';
import { defaultAuthPortalImage } from '../../configuration/auth-portal-image.js';

export function authPortalImageSetting() {
    return `<section class="network-service-card login-image-card" aria-labelledby="login-image-heading">
    <div class="network-card-heading">
      <h2 id="login-image-heading">登录页面镜像</h2>
      <button type="button" class="text-button" id="restore-default-login-image" ${state.busy ? 'disabled' : ''}>恢复默认</button>
    </div>
    ${input('authPortalImage', '镜像名称与版本', state.config?.authPortalImage || defaultAuthPortalImage(), 'text', '仅使用本机 Docker 已有镜像', false, { placeholder: 'my-login:1.0', disabled: state.busy })}
  </section>`;
}
