import { Button, Card, Descriptions, Form, Input, Modal, Select } from 'antd';

import { dateTime } from '../../player-admin-format';
import { PlayerDetailDrawer, type DetailController } from './player-detail-drawer';

import type { FormInstance } from 'antd';
import type { Detail, Player } from '../../player-admin-types';

type ProfileDrawerProps = {
    selected?:Player;
    details?:Detail;
    form:FormInstance;
    controller:DetailController;
    close:() => void;
    save:() => void;
};

export function PlayerProfileDrawer({
    selected,
    details,
    form,
    controller,
    close,
    save,
}:ProfileDrawerProps) {
    return (
        <PlayerDetailDrawer
            controller={controller}
            width={620}
            title={selected ? `管理 · ${selected.displayName || selected.username}` : '玩家详情'}
            open={Boolean(selected)}
            onClose={close}
        >
            {details ? (
                <>
                    <Descriptions column={2} size="small" style={{ marginBottom: 24 }}>
                        <Descriptions.Item label="身份 ID" span={2}>
                            {details.player.subjectId}
                        </Descriptions.Item>
                        <Descriptions.Item label="创建时间">
                            {dateTime(details.player.createdAt)}
                        </Descriptions.Item>
                        <Descriptions.Item label="最近在线">
                            {dateTime(details.player.lastSeenAt)}
                        </Descriptions.Item>
                    </Descriptions>
                    <Card size="small" title="基础资料">
                        <Form form={form} layout="vertical">
                            <Form.Item
                                label="显示昵称"
                                name="displayName"
                                rules={[{ required: true }]}
                            >
                                <Input />
                            </Form.Item>
                            <Form.Item
                                label="用户 Key"
                                name="userKey"
                                rules={[{ max: 128, message: '用户 Key 不能超过 128 个字符' }]}
                            >
                                <Input placeholder="留空表示不设置" />
                            </Form.Item>
                            <Form.Item label="神岛 ID" name="boxId">
                                <Input />
                            </Form.Item>
                            <Form.Item label="标签" name="tags">
                                <Input />
                            </Form.Item>
                            <Form.Item label="服主备注" name="adminNote">
                                <Input.TextArea rows={3} />
                            </Form.Item>
                            <Button type="primary" onClick={save}>
                                保存资料
                            </Button>
                        </Form>
                    </Card>
                </>
            ) : null}
        </PlayerDetailDrawer>
    );
}

type CreatePlayerProps = {
    form:FormInstance;
    open:boolean;
    close:() => void;
    submit:() => void;
};

export function CreatePlayerDialog({ form, open, close, submit }:CreatePlayerProps) {
    return (
        <Modal title="新增玩家" open={open} onCancel={close} onOk={submit}>
            <Form form={form} layout="vertical">
                <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
                    <Input />
                </Form.Item>
                <Form.Item name="displayName" label="显示昵称" rules={[{ required: true }]}>
                    <Input />
                </Form.Item>
                <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 10 }]}>
                    <Input.Password />
                </Form.Item>
            </Form>
        </Modal>
    );
}

type CreatorPickerProps = {
    form:FormInstance;
    open:boolean;
    candidates:Player[];
    close:() => void;
    submit:() => void;
};

export function CreatorPickerDialog({ form, open, candidates, close, submit }:CreatorPickerProps) {
    return (
        <Modal
            title="新增创作权限"
            open={open}
            okText="下一步"
            cancelText="取消"
            onCancel={close}
            onOk={submit}
        >
            <Form form={form} layout="vertical">
                <Form.Item
                    name="subjectId"
                    label="玩家"
                    rules={[{ required: true, message: '请选择玩家' }]}
                >
                    <Select
                        showSearch
                        optionFilterProp="label"
                        placeholder="搜索并选择玩家"
                        options={candidates.map((player) => ({
                            value: player.subjectId,
                            label: `${player.displayName || player.username} (@${player.username})`,
                        }))}
                    />
                </Form.Item>
            </Form>
        </Modal>
    );
}
