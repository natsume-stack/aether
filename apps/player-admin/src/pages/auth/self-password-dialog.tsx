import { Form, Input, Modal } from 'antd';

import type { FormInstance } from 'antd';

type Props = {
    form:FormInstance;
    open:boolean;
    saving:boolean;
    close:() => void;
    submit:() => void;
};

export function SelfPasswordDialog({ form, open, saving, close, submit }:Props) {
    return (
        <Modal
            title="修改密码"
            open={open}
            confirmLoading={saving}
            okText="确认修改"
            cancelText="取消"
            onCancel={close}
            onOk={submit}
        >
            <Form form={form} layout="vertical">
                <Form.Item
                    name="currentPassword"
                    label="当前密码"
                    rules={[{ required: true, message: '请输入当前密码' }]}
                >
                    <Input.Password autoComplete="current-password" />
                </Form.Item>
                <Form.Item
                    name="newPassword"
                    label="新密码"
                    rules={[
                        { required: true, message: '请输入新密码' },
                        { min: 12, message: '密码至少 12 位' },
                    ]}
                >
                    <Input.Password autoComplete="new-password" />
                </Form.Item>
                <Form.Item
                    name="confirmPassword"
                    label="确认新密码"
                    dependencies={['newPassword']}
                    rules={[
                        { required: true, message: '请再次输入新密码' },
                        ({ getFieldValue }) => ({
                            validator(_, value) {
                                return !value || getFieldValue('newPassword') === value
                                    ? Promise.resolve()
                                    : Promise.reject(new Error('两次输入的密码不一致'));
                            },
                        }),
                    ]}
                >
                    <Input.Password autoComplete="new-password" />
                </Form.Item>
            </Form>
        </Modal>
    );
}
