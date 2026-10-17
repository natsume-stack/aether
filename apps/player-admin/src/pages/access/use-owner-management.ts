import { Form, message } from 'antd';
import { useCallback, useState } from 'react';

import { useAdminRequest } from '../../hooks/use-admin-request';
import { reportAdminError } from '../../player-admin-errors';
import { capabilityLeaves } from './permission-tree';
import { playerAdminApi as api } from '../../player-admin-api';

import type { Admin, Group } from '../../player-admin-types';

type AdminFormValues = {
    username?:string;
    displayName:string;
    password?:string;
    permissionGroupId?:string;
};

/** Owns management-account and permission-group persistence and editor state. */
export function useOwnerManagement() {
    const [admins, setAdmins] = useState<Admin[]>([]);
    const [groups, setGroups] = useState<Group[]>([]);
    const { loading, run } = useAdminRequest();
    const [adminOpen, setAdminOpen] = useState(false);
    const [groupOpen, setGroupOpen] = useState(false);
    const [editingAdmin, setEditingAdmin] = useState<Admin>();
    const [editingGroup, setEditingGroup] = useState<Group>();
    const [adminForm] = Form.useForm();
    const [groupForm] = Form.useForm();

    const load = useCallback(
        () =>
            run(async () => {
                const [adminResult, groupResult] = await Promise.all([
                    api.getApiPlayAdminAdmins(),
                    api.getApiPlayAdminPermissionGroups(),
                ]);
                setAdmins(adminResult.admins || []);
                setGroups(groupResult.groups || []);
            }),
        [run],
    );

    const openAdminEditor = (admin?:Admin) => {
        setEditingAdmin(admin);
        adminForm.setFieldsValue(
            admin
                ? {
                      ...admin,
                      password: '',
                      permissions: [],
                      permissionGroupId: admin.permissionGroupId || undefined,
                  }
                : { permissions: [], permissionGroupId: undefined },
        );
        setAdminOpen(true);
    };

    const closeAdminEditor = () => {
        setAdminOpen(false);
        setEditingAdmin(undefined);
        adminForm.resetFields();
    };

    const saveAdmin = async () => {
        let values:AdminFormValues;
        try {
            values = await adminForm.validateFields();
        } catch {
            return;
        }
        try {
            const payload = editingAdmin
                ? {
                      displayName: values.displayName,
                      permissionGroupId: values.permissionGroupId,
                      ...(values.password ? { password: values.password } : {}),
                  }
                : values;
            if (editingAdmin) {
                await api.patchApiPlayAdminAdminsId({
                    params: { path: { id: editingAdmin.id } },
                    body: payload,
                });
            } else {
                const { username, displayName, password, permissionGroupId } = values;
                if (!username || !displayName || !password || !permissionGroupId) {
                    throw new Error('请完整填写管理账号信息');
                }
                await api.postApiPlayAdminAdmins({
                    body: { username, displayName, password, permissionGroupId },
                });
            }
            message.success(editingAdmin ? '管理账号已更新' : '管理账号已创建');
            closeAdminEditor();
            await load();
        } catch (error) {
            reportAdminError(error);
        }
    };

    const removeAdmin = async (admin:Admin) => {
        return run(async () => {
            await api.deleteApiPlayAdminAdminsId({ params: { path: { id: admin.id } } });
            message.success('管理账号已删除');
            await load();
        });
    };

    const toggleAdminStatus = (admin:Admin) =>
        run(async () => {
            await api.patchApiPlayAdminAdminsId({
                params: { path: { id: admin.id } },
                body: {
                    displayName: admin.displayName,
                    status: admin.status === 'active' ? 'disabled' : 'active',
                },
            });
            await load();
        });

    const openGroupEditor = (group?:Group) => {
        setEditingGroup(group);
        groupForm.setFieldsValue(
            group
                ? { name: group.name, permissions: group.permissions }
                : { name: '', permissions: [] },
        );
        setGroupOpen(true);
    };

    const closeGroupEditor = () => {
        setGroupOpen(false);
        setEditingGroup(undefined);
        groupForm.resetFields();
    };

    const saveGroup = async () => {
        return run(async () => {
            const values = await groupForm.validateFields();
            const payload = { ...values, permissions: capabilityLeaves(values.permissions) };
            if (editingGroup) {
                await api.patchApiPlayAdminPermissionGroupsId({
                    params: { path: { id: editingGroup.id } },
                    body: payload,
                });
            } else {
                await api.postApiPlayAdminPermissionGroups({ body: payload });
            }
            message.success(editingGroup ? '权限组已更新' : '权限组已创建');
            closeGroupEditor();
            await load();
        });
    };

    const removeGroup = async (group:Group) => {
        return run(async () => {
            await api.deleteApiPlayAdminPermissionGroupsId({ params: { path: { id: group.id } } });
            message.success('权限组已删除');
            await load();
        });
    };

    return {
        admins,
        groups,
        loading,
        load,
        adminDialog: {
            form: adminForm,
            open: adminOpen,
            editing: editingAdmin,
            openEditor: openAdminEditor,
            close: closeAdminEditor,
            save: saveAdmin,
        },
        groupDialog: {
            form: groupForm,
            open: groupOpen,
            editing: editingGroup,
            openEditor: openGroupEditor,
            close: closeGroupEditor,
            save: saveGroup,
        },
        toggleAdminStatus,
        removeAdmin,
        removeGroup,
    };
}
