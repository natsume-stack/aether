import { Form, Input, Modal, notification, Select, TreeSelect } from 'antd';

import {
    capabilityLeaves,
    expandPermissionSelection,
    isViewRequiredBySelection,
    permissionTree,
} from './permission-tree';

import type { FormInstance } from 'antd';
import type { Admin, Group } from '../../player-admin-types';

type AdminDialogProps = {
    form:FormInstance;
    open:boolean;
    editing?:Admin;
    groups:Group[];
    close:() => void;
    submit:() => void;
};

export function AdminAccountDialog({
    form,
    open,
    editing,
    groups,
    close,
    submit,
}:AdminDialogProps) {
    return (
        <Modal
            title={editing ? '编辑管理账号' : '新增管理账号'}
            open={open}
            onCancel={close}
            onOk={submit}
        >
            <Form form={form} layout="vertical" initialValues={{ permissions: [] }}>
                <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
                    <Input disabled={Boolean(editing)} />
                </Form.Item>
                <Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}>
                    <Input />
                </Form.Item>
                <Form.Item
                    name="password"
                    label={editing ? '新密码（留空不修改）' : '初始密码'}
                    rules={[{ required: !editing, min: 12, message: '密码至少 12 位' }]}
                >
                    <Input.Password />
                </Form.Item>
                <Form.Item
                    name="permissionGroupId"
                    label="权限组"
                    rules={[{ required: true, message: '请选择权限组' }]}
                >
                    <Select
                        placeholder="选择权限组"
                        options={groups.map((group) => ({
                            value: group.id,
                            label: `${group.name} · ${group.permissions.length} 项权限`,
                        }))}
                    />
                </Form.Item>
            </Form>
        </Modal>
    );
}

type PermissionGroupDialogProps = {
    form:FormInstance;
    open:boolean;
    editing?:Group;
    close:() => void;
    submit:() => void;
};

export function PermissionGroupDialog({
    form,
    open,
    editing,
    close,
    submit,
}:PermissionGroupDialogProps) {
    return (
        <Modal
            title={editing ? '编辑权限组' : '新增权限组'}
            open={open}
            onCancel={close}
            onOk={submit}
        >
            <Form form={form} layout="vertical">
                {editing ? (
                    <div className="player-admin-muted" style={{ marginBottom: 16 }}>
                        保存后将影响 {editing.adminCount} 个管理账号的实际权限。
                    </div>
                ) : null}
                <Form.Item name="name" label="权限组名称" rules={[{ required: true }]}>
                    <Input maxLength={32} />
                </Form.Item>
                <Form.Item name="permissions" label="权限" rules={[{ required: true }]}>
                    <TreeSelect
                        treeData={permissionTree}
                        treeCheckable
                        treeDefaultExpandedKeys={[
                            'category:players',
                            'category:players:player-accounts',
                        ]}
                        showCheckedStrategy={TreeSelect.SHOW_CHILD}
                        onChange={(values, _labels, extra) => {
                            const requested = capabilityLeaves(Array.isArray(values) ? values : []);
                            const expanded = expandPermissionSelection(requested);
                            const previous = capabilityLeaves(
                                form.getFieldValue('permissions') || [],
                            );
                            const retained = previous.filter(
                                (capability) =>
                                    !requested.includes(capability) &&
                                    expanded.includes(capability),
                            );
                            const attemptedView =
                                typeof extra?.triggerValue === 'string' &&
                                extra.checked === false &&
                                isViewRequiredBySelection(extra.triggerValue, previous);
                            if (retained.length || attemptedView) {
                                notification.warning({
                                    message: '无法取消查看权限',
                                    description:
                                        '编辑权限需要对应的查看权限。请先取消相关编辑权限。',
                                    placement: 'topRight',
                                });
                            }
                            form.setFieldValue('permissions', expanded);
                        }}
                        placeholder="选择此权限组包含的能力"
                        className="player-admin-permission-select"
                    />
                </Form.Item>
            </Form>
        </Modal>
    );
}
