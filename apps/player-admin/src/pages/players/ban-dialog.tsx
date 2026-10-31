import { Checkbox, Collapse, Form, Input, Modal, Select } from 'antd';

import type { FormInstance } from 'antd';
import type { Detail, Player } from '../../player-admin-types';

export type BanDialogController = {
    state?:{ player:Player; detail?:Detail };
    form:FormInstance;
    close:() => void;
    submit:() => Promise<void>;
};

export function BanDialog({ controller: c }:{ controller:BanDialogController }) {
    const state = c.state;
    const detail = state?.detail;
    const duration = Form.useWatch('duration', c.form);
    if (!state) {
        return null;
    }
    const ips = [
        detail?.player.lastLoginIp,
        detail?.player.lastSeenIp,
        ...(detail?.sessions || []).flatMap((session) => [session.createdIp, session.lastSeenIp]),
        ...(detail?.loginHistory || []).map((entry) => entry.ip),
    ].filter((value):value is string => Boolean(value));
    const devices = [
        ...new Set(
            [...(detail?.sessions || []), ...(detail?.loginHistory || [])]
                .map((entry) => entry.deviceHash)
                .filter((value):value is string => Boolean(value)),
        ),
    ];
    const uniqueIps = [...new Set(ips)];
    return (
        <Modal
            title={`封禁 · ${state.player.displayName || state.player.username}`}
            open
            onCancel={c.close}
            onOk={c.submit}
            okText="确认封禁"
            okButtonProps={{ danger: true, disabled: !detail }}
            destroyOnClose
        >
            <Form
                form={c.form}
                layout="vertical"
                initialValues={{ targets: ['account'], duration: 'permanent' }}
            >
                <Form.Item
                    name="targets"
                    label="封禁对象"
                    rules={[
                        {
                            required: true,
                            type: 'array',
                            min: 1,
                            message: '请至少选择一个封禁对象',
                        },
                    ]}
                >
                    <Checkbox.Group className="player-admin-ban-targets">
                        <Checkbox value="account">封禁账号</Checkbox>
                        {uniqueIps.length || devices.length ? (
                            <Collapse ghost>
                                {uniqueIps.length ? (
                                    <Collapse.Panel
                                        key="ip"
                                        header={`关联 IP（${uniqueIps.length}）`}
                                    >
                                        <div className="player-admin-ban-options">
                                            {uniqueIps.map((value) => (
                                                <Checkbox key={value} value={`ip:${value}`}>
                                                    封禁 IP：{value}
                                                </Checkbox>
                                            ))}
                                        </div>
                                    </Collapse.Panel>
                                ) : null}
                                {devices.length ? (
                                    <Collapse.Panel
                                        key="device"
                                        header={`关联设备（${devices.length}）`}
                                    >
                                        <div className="player-admin-ban-options">
                                            {devices.map((value) => (
                                                <Checkbox key={value} value={`device:${value}`}>
                                                    封禁设备：{value.slice(0, 16)}…
                                                </Checkbox>
                                            ))}
                                        </div>
                                    </Collapse.Panel>
                                ) : null}
                            </Collapse>
                        ) : null}
                    </Checkbox.Group>
                </Form.Item>
                <Form.Item
                    name="reason"
                    label="封禁理由"
                    rules={[
                        { required: true, max: 500, message: '请填写不超过 500 个字符的封禁理由' },
                    ]}
                >
                    <Input.TextArea
                        rows={3}
                        placeholder="例如：多次恶意破坏游戏规则"
                        maxLength={500}
                        showCount
                    />
                </Form.Item>
                <Form.Item name="duration" label="封禁期限">
                    <Select
                        options={[
                            { value: 'permanent', label: '永久封禁' },
                            { value: 'temporary', label: '指定到期时间' },
                        ]}
                    />
                </Form.Item>
                {duration === 'temporary' ? (
                    <Form.Item
                        name="bannedUntil"
                        label="到期时间"
                        rules={[{ required: true, message: '请选择封禁到期时间' }]}
                    >
                        <Input type="datetime-local" />
                    </Form.Item>
                ) : null}
            </Form>
        </Modal>
    );
}
