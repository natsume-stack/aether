import { LockOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { Button, Card, Form, Input, message } from 'antd';
import { useState } from 'react';

import { useAdminRequest } from '../../hooks/use-admin-request';
import { playerAdminApi as api } from '../../player-admin-api';

import type { Actor } from '../../player-admin-types';

type Props = { onSuccess:(actor:Actor) => void };

/** The login page deliberately owns only credentials and never admin shell state. */
export function LoginPage({ onSuccess }:Props) {
    const { loading, run } = useAdminRequest();
    const [mode, setMode] = useState<'admin' | 'owner'>('admin');
    const [form] = Form.useForm();

    const submit = () =>
        run(async () => {
            const values = await form.validateFields();
            const result =
                mode === 'admin'
                    ? await api.postApiPlayAdminLogin({ body: values })
                    : await api.postApiPlayAdminOwnerSession({
                          headers: { Authorization: `Bearer ${values.password}` },
                          body: {},
                      });
            onSuccess(result.actor);
            message.success('登录成功');
        });

    const selectMode = (next:'admin' | 'owner') => {
        setMode(next);
        form.resetFields();
    };

    return (
        <main className="player-admin-login">
            <Card className="player-admin-login-card" bordered={false}>
                <div className="player-admin-brand player-admin-login-brand">
                    <span className="player-admin-brand-mark">B</span>BOX3 Engine
                </div>
                <h1 className="player-admin-login-title">后台管理</h1>
                <div className="player-admin-login-tabs">
                    <button
                        className={mode === 'admin' ? 'active' : ''}
                        onClick={() => selectMode('admin')}
                    >
                        管理员登录
                    </button>
                    <button
                        className={mode === 'owner' ? 'active' : ''}
                        onClick={() => selectMode('owner')}
                    >
                        服主登录
                    </button>
                </div>
                <Form form={form} layout="vertical" onFinish={submit}>
                    {mode === 'admin' ? (
                        <>
                            <Form.Item
                                name="username"
                                label="用户名"
                                rules={[{ required: true, message: '请输入用户名' }]}
                            >
                                <Input prefix={<UserOutlined />} />
                            </Form.Item>
                            <Form.Item
                                name="password"
                                label="密码"
                                rules={[{ required: true, message: '请输入密码' }]}
                            >
                                <Input.Password prefix={<LockOutlined />} />
                            </Form.Item>
                        </>
                    ) : (
                        <Form.Item
                            name="password"
                            label="服主管理令牌"
                            rules={[{ required: true, message: '请输入服主管理令牌' }]}
                        >
                            <Input.Password
                                prefix={<SafetyCertificateOutlined />}
                                autoComplete="off"
                            />
                        </Form.Item>
                    )}
                    <Button type="primary" htmlType="submit" block loading={loading}>
                        登录后台
                    </Button>
                </Form>
            </Card>
        </main>
    );
}
