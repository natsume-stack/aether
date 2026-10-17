import { Checkbox, Col, Form, InputNumber, Row, Select } from 'antd';

export type AuthorizationSettings = {
    banLimit:'limited' | 'permanent';
    minutes:number;
    days:number;
    permissions:Array<'players.view' | 'players.ban' | 'identity-bans.manage' | 'moderation.view'>;
};
export const permissionOptions = [
    { label: '查询处罚记录与详情', value: 'moderation.view', apis: 'listBans / getBan' },
    { label: '查询玩家状态', value: 'players.view', apis: 'getPlayerStatus' },
    { label: '封禁玩家账号', value: 'players.ban', apis: 'banPlayer / revokeBan' },
    {
        label: '封禁当前 IP / 设备',
        value: 'identity-bans.manage',
        apis: 'banCurrentIP / banCurrentDevice / revokeBan',
    },
];

/** Used by both creation and editing; validation and permission labels live once. */
export function AuthorizationFields() {
    const form = Form.useFormInstance<AuthorizationSettings>();
    const permanent = Form.useWatch('banLimit', form) === 'permanent';
    return (
        <>
            <Form.Item
                name="permissions"
                label="允许的操作"
                rules={[{ required: true, type: 'array', min: 1, message: '至少选择一项权限' }]}
            >
                <Checkbox.Group className="player-admin-authorization-permissions">
                    {permissionOptions.map((permission) => (
                        <Checkbox key={permission.value} value={permission.value}>
                            <span>{permission.label}</span>
                            <small className="player-admin-muted">{permission.apis}</small>
                        </Checkbox>
                    ))}
                </Checkbox.Group>
            </Form.Item>

            <Form.Item name="banLimit" label="单次封禁上限" rules={[{ required: true }]}>
                <Select
                    options={[
                        { value: 'limited', label: '限制时长' },
                        { value: 'permanent', label: '永久' },
                    ]}
                />
            </Form.Item>
            <Row gutter={16}>
                <Col span={permanent ? 0 : 12}>
                    <Form.Item
                        name="minutes"
                        hidden={permanent}
                        label="最长封禁时长（分钟）"
                        rules={[
                            {
                                required: true,
                                type: 'number',
                                min: 1,
                                max: 10080,
                                message: '请输入 1–10080 分钟的上限',
                            },
                        ]}
                    >
                        <InputNumber style={{ width: '100%' }} min={1} max={10080} precision={0} />
                    </Form.Item>
                </Col>
                <Col span={permanent ? 24 : 12}>
                    <Form.Item
                        name="days"
                        label="授权有效期（天）"
                        rules={[
                            {
                                required: true,
                                type: 'number',
                                min: 1,
                                max: 360,
                                message: '请输入 1–360 天的有效期',
                            },
                        ]}
                    >
                        <InputNumber style={{ width: '100%' }} min={1} max={360} precision={0} />
                    </Form.Item>
                </Col>
            </Row>
        </>
    );
}
