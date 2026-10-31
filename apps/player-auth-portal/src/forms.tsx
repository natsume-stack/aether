import React, { Component, createRef, type FormEvent, type ReactNode } from 'react';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';

import { PortalClient, PortalError, type Tone } from './client';

interface PasswordProps {
    label:string;
    name:string;
    autoComplete:string;
    minimum?:number;
    inputRef?:React.RefObject<HTMLInputElement | null>;
}
export class PasswordField extends Component<PasswordProps, { visible:boolean }> {
    public state = { visible: false };
    public render():ReactNode {
        const p = this.props;
        return (
            <label className="field">
                <span>{p.label}</span>
                <span className="input-shell">
                    <input
                        ref={p.inputRef}
                        name={p.name}
                        type={this.state.visible ? 'text' : 'password'}
                        autoComplete={p.autoComplete}
                        minLength={p.minimum ?? 1}
                        maxLength={128}
                        required
                    />
                    <button
                        className="input-action"
                        type="button"
                        aria-label={this.state.visible ? '隐藏密码' : '显示密码'}
                        aria-pressed={this.state.visible}
                        onClick={() => this.setState({ visible: !this.state.visible })}
                    >
                        {this.state.visible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                </span>
            </label>
        );
    }
}

export class Notice extends Component<{ children?:ReactNode; tone?:Tone }> {
    public render():ReactNode {
        return this.props.children ? (
            <div
                className={`message${this.props.tone === 'success' ? ' message-success' : ''}`}
                role={this.props.tone === 'success' ? 'status' : 'alert'}
            >
                {this.props.children}
            </div>
        ) : null;
    }
}

export class PendingLabel extends Component<{ pending:boolean; children:ReactNode }> {
    public render():ReactNode {
        return (
            <>
                {this.props.pending ? (
                    <LoaderCircle className="button-spinner" size={16} aria-hidden="true" />
                ) : null}
                <span>{this.props.children}</span>
            </>
        );
    }
}

interface ChangeProps {
    client:PortalClient;
    onCancel:() => void;
    onRelogin:(message:string, tone?:Tone) => void;
}
/** 密码仅短暂存在于输入和提交局部变量；不保存至全局状态或存储。 */
export class PasswordChange extends Component<ChangeProps, { busy:boolean; message:string }> {
    public state = { busy: false, message: '' };
    private pending = false;
    private input = createRef<HTMLInputElement>();
    public componentDidMount():void {
        this.input.current?.focus();
    }
    private submit = async (event:FormEvent<HTMLFormElement>):Promise<void> => {
        event.preventDefault();
        if (this.pending) {
            return;
        }
        const form = event.currentTarget;
        const values = new FormData(form);
        const current = String(values.get('currentPassword') || '');
        const next = String(values.get('newPassword') || '');
        if (next !== values.get('confirmPassword')) {
            this.setState({ message: '两次输入的新密码不一致' });
            (form.elements.namedItem('confirmPassword') as HTMLInputElement).focus();
            return;
        }
        if (current === next) {
            this.setState({ message: '新密码不能与原密码相同' });
            (form.elements.namedItem('newPassword') as HTMLInputElement).focus();
            return;
        }
        this.pending = true;
        this.setState({ busy: true, message: '' });
        try {
            await this.props.client.changePassword(current, next);
            form.reset();
            this.props.onRelogin('密码已修改，请使用新密码重新登录。', 'success');
        } catch (error) {
            if (
                error instanceof PortalError &&
                error.status === 401 &&
                error.code !== 'AUTH_API_KEY_INVALID'
            ) {
                form.reset();
                this.props.onRelogin('登录状态已过期，请重新登录。');
            } else {
                this.setState({ message: PortalClient.message(error) });
            }
        } finally {
            this.pending = false;
            this.setState({ busy: false });
        }
    };
    public render():ReactNode {
        return (
            <div className="auth-content">
                <Notice>{this.state.message}</Notice>
                <form className="auth-form" onSubmit={this.submit}>
                    <fieldset
                        className="password-fields"
                        disabled={this.state.busy}
                        aria-busy={this.state.busy}
                    >
                        <PasswordField
                            label="原密码"
                            name="currentPassword"
                            autoComplete="current-password"
                            inputRef={this.input}
                        />
                        <PasswordField
                            label="新密码"
                            name="newPassword"
                            autoComplete="new-password"
                            minimum={10}
                        />
                        <PasswordField
                            label="确认新密码"
                            name="confirmPassword"
                            autoComplete="new-password"
                            minimum={10}
                        />
                    </fieldset>
                    <small className="field-hint">密码至少 10 位，修改后需重新登录。</small>
                    <button className="primary-button" type="submit" disabled={this.state.busy}>
                        <PendingLabel pending={this.state.busy}>
                            {this.state.busy ? '正在修改' : '修改密码'}
                        </PendingLabel>
                    </button>
                    <button
                        className="secondary-button"
                        type="button"
                        disabled={this.state.busy}
                        onClick={this.props.onCancel}
                    >
                        返回账号
                    </button>
                </form>
            </div>
        );
    }
}
