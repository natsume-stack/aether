import React, { Component, type FormEvent, type ReactNode } from 'react';
import { Tabs } from 'radix-ui';
import { ArrowRight, Check, LoaderCircle, LogOut, Monitor, Moon, Sun } from 'lucide-react';

import { PortalClient, type Player, type Session, type Tone } from './client';
import { PasswordField, Notice, PendingLabel, PasswordChange } from './forms';
import { Theme } from './theme';

interface State {
    kind:'loading' | 'auth' | 'account' | 'password';
    mode:'login' | 'register';
    player:Player | null;
    returnUrl:string;
    registrationEnabled:boolean;
    busy:boolean;
    message:string;
    tone:Tone;
    theme:string;
}

/** 一个页面类管理有限状态。其他开发者改 render，不需要重写认证客户端。 */
export class PortalApp extends Component<Record<string, never>, State> {
    public state:State = {
        kind: 'loading',
        mode: 'login',
        player: null,
        returnUrl: '',
        registrationEnabled: true,
        busy: false,
        message: '',
        tone: 'error',
        theme: Theme.current(),
    };
    private readonly client = new PortalClient();
    private active = false;
    private pending = false;
    public componentDidMount():void {
        this.active = true;
        void this.client
            .session()
            .then((data) => {
                if (this.active) {
                    if (data.player && data.returnUrl && this.client.navigation.transferState) {
                        location.assign(data.returnUrl);
                        return;
                    }
                    this.setState({
                        kind: data.player ? 'account' : 'auth',
                        player: data.player,
                        returnUrl: data.returnUrl || '',
                        registrationEnabled: data.registrationEnabled !== false,
                    });
                }
            })
            .catch((error) => {
                if (this.active) {
                    this.setState({
                        kind: 'auth',
                        message: PortalClient.message(error),
                        registrationEnabled: !(error && error.registrationEnabled === false),
                    });
                }
            });
    }
    public componentWillUnmount():void {
        this.active = false;
    }
    private authenticated(data:Session):void {
        if (!data.player) {
            throw new Error('玩家服务未返回有效账号，请重试');
        }
        this.setState({
            kind: 'account',
            player: data.player,
            returnUrl: data.returnUrl || '',
            message: '',
        });
        if (data.returnUrl) {
            location.assign(data.returnUrl);
        } // 后端已经按配置 Origin 校验。
    }
    private relogin = (message = '', tone:Tone = 'error'):void => {
        this.setState({ kind: 'auth', mode: 'login', player: null, message, tone, busy: false });
    };
    private submitAuth = async (event:FormEvent<HTMLFormElement>):Promise<void> => {
        event.preventDefault();
        if (this.pending) {
            return;
        }
        const values = new FormData(event.currentTarget);
        const password = String(values.get('password') || '');
        if (this.state.mode === 'register' && password !== values.get('confirmPassword')) {
            this.setState({ message: '两次输入的密码不一致', tone: 'error' });
            return;
        }
        this.pending = true;
        this.setState({ busy: true, message: '', tone: 'error' });
        try {
            const username = String(values.get('username') || '');
            this.authenticated(
                this.state.mode === 'register'
                    ? await this.client.register(
                          username,
                          String(values.get('displayName') || ''),
                          password,
                      )
                    : await this.client.login(username, password),
            );
        } catch (error) {
            this.setState({ message: PortalClient.message(error) });
        } finally {
            this.pending = false;
            this.setState({ busy: false });
        }
    };
    private logout = async ():Promise<void> => {
        if (this.pending) {
            return;
        }
        this.pending = true;
        this.setState({ busy: true, message: '' });
        try {
            await this.client.logout();
            this.relogin();
        } catch (error) {
            this.setState({ message: PortalClient.message(error) });
        } finally {
            this.pending = false;
            this.setState({ busy: false });
        }
    };
    private renderForm():ReactNode {
        const register = this.state.mode === 'register' && this.state.registrationEnabled;
        return (
            <form
                className="auth-form"
                onSubmit={this.submitAuth}
                key={register ? 'register' : 'login'}
            >
                <label className="field">
                    <span>用户名</span>
                    <input
                        name="username"
                        autoComplete="username"
                        maxLength={32}
                        autoFocus
                        required
                    />
                </label>
                {register ? (
                    <label className="field">
                        <span>昵称</span>
                        <input name="displayName" autoComplete="nickname" maxLength={32} required />
                    </label>
                ) : null}
                <PasswordField
                    label="密码"
                    name="password"
                    autoComplete={register ? 'new-password' : 'current-password'}
                    minimum={register ? 10 : 1}
                />
                {register ? (
                    <>
                        <PasswordField
                            label="确认密码"
                            name="confirmPassword"
                            autoComplete="new-password"
                            minimum={10}
                        />
                        <small className="field-hint">密码至少 10 位，请勿与其他网站共用。</small>
                    </>
                ) : null}
                <button className="primary-button" type="submit" disabled={this.state.busy}>
                    <PendingLabel pending={this.state.busy}>
                        {this.state.busy
                            ? register
                                ? '正在创建'
                                : '正在登录'
                            : register
                              ? '创建账号'
                              : '登录'}
                    </PendingLabel>
                    <ArrowRight size={16} />
                </button>
            </form>
        );
    }
    private renderAuth():ReactNode {
        if (!this.state.registrationEnabled) {
            return (
                <div className="auth-content">
                    <Notice tone={this.state.tone}>{this.state.message}</Notice>
                    {this.renderForm()}
                </div>
            );
        }
        return (
            <Tabs.Root
                className="auth-tabs"
                value={this.state.mode}
                onValueChange={(mode) =>
                    this.setState({
                        mode: mode === 'register' ? 'register' : 'login',
                        message: '',
                        tone: 'error',
                    })
                }
            >
                <Tabs.List className="tab-list" aria-label="账号操作">
                    <Tabs.Trigger className="tab-trigger" value="login">
                        登录
                    </Tabs.Trigger>
                    <Tabs.Trigger className="tab-trigger" value="register">
                        注册
                    </Tabs.Trigger>
                </Tabs.List>
                <Notice tone={this.state.tone}>{this.state.message}</Notice>
                <Tabs.Content className="tab-content" value={this.state.mode}>
                    {this.renderForm()}
                </Tabs.Content>
            </Tabs.Root>
        );
    }
    private renderAccount():ReactNode {
        const player = this.state.player!;
        return (
            <div className="account-view">
                <span className="success-mark">
                    <Check size={19} />
                </span>
                <div className="account-copy">
                    <strong>{player.displayName || player.username || '玩家'}</strong>
                    <span>@{player.username}</span>
                </div>
                <Notice>{this.state.message}</Notice>
                <div className="account-actions">
                    {this.state.returnUrl ? (
                        <a className="primary-button" href={this.state.returnUrl}>
                            继续访问
                            <ArrowRight size={16} />
                        </a>
                    ) : null}
                    <button
                        className="secondary-button"
                        type="button"
                        disabled={this.state.busy}
                        onClick={() => this.setState({ kind: 'password', message: '' })}
                    >
                        修改密码
                    </button>
                    <button
                        className="secondary-button"
                        type="button"
                        disabled={this.state.busy}
                        onClick={this.logout}
                    >
                        <PendingLabel pending={this.state.busy}>
                            {this.state.busy ? '正在退出' : '退出登录'}
                        </PendingLabel>
                        <LogOut size={16} />
                    </button>
                </div>
            </div>
        );
    }
    public render():ReactNode {
        const { kind, theme } = this.state;
        const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
        const title =
            kind === 'password' ? '修改密码' : kind === 'account' ? '账号已登录' : '登录玩家账号';
        const subtitle =
            kind === 'password'
                ? '验证原密码后，设置新的登录密码。'
                : kind === 'account'
                  ? '管理当前账号，或继续访问。'
                  : !this.state.registrationEnabled
                    ? '使用服主创建的账号继续访问。'
                    : '登录后继续访问游戏或创作端。';
        return (
            <div className="portal-layout">
                <header className="portal-header">
                    <div className="portal-brand">
                        <span className="brand-mark">BOX</span>
                        <span>
                            <strong>玩家登录</strong>
                            <small>PLAYER SERVICE</small>
                        </span>
                    </div>
                    <button
                        className="icon-button"
                        type="button"
                        aria-label="切换主题"
                        onClick={() => this.setState({ theme: Theme.next() })}
                    >
                        <Icon size={17} />
                    </button>
                </header>
                <main className="page-shell">
                    <section className="auth-card" aria-labelledby="page-title">
                        <header className="auth-header">
                            <span className="eyebrow">PLAYER ACCOUNT</span>
                            <h1 id="page-title">{title}</h1>
                            <p>{subtitle}</p>
                        </header>
                        {kind === 'loading' ? (
                            <div className="state-view" role="status">
                                <LoaderCircle className="spinner" size={18} />
                                <span>正在检查登录状态</span>
                            </div>
                        ) : kind === 'password' ? (
                            <PasswordChange
                                client={this.client}
                                onCancel={() => this.setState({ kind: 'account' })}
                                onRelogin={this.relogin}
                            />
                        ) : kind === 'account' ? (
                            this.renderAccount()
                        ) : (
                            this.renderAuth()
                        )}
                    </section>
                </main>
            </div>
        );
    }
}
