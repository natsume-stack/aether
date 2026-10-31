import { Button, Card, Col, Row, Space, Statistic } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

import { PageToolbar } from '../../components/page-toolbar';

import type { View } from '../../player-admin-types';

type Props = {
    loading:boolean;
    totals:Record<string, number>;
    canViewSecurity:boolean;
    isOwner:boolean;
    refresh:() => void;
    navigate:(view:View) => void;
};

export function OverviewPage({
    loading,
    totals,
    canViewSecurity,
    isOwner,
    refresh,
    navigate,
}:Props) {
    return (
        <>
            <PageToolbar title="管理概览">
                <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>
                    刷新
                </Button>
            </PageToolbar>
            <Row gutter={16}>
                <Col span={6}>
                    <Card className="player-admin-stat">
                        <Statistic title="账号总数" value={totals.users || 0} />
                    </Card>
                </Col>
                <Col span={6}>
                    <Card className="player-admin-stat">
                        <Statistic title="24 小时活跃" value={totals.activeLast24Hours || 0} />
                    </Card>
                </Col>
                <Col span={6}>
                    <Card className="player-admin-stat">
                        <Statistic title="有效会话" value={totals.activeSessions || 0} />
                    </Card>
                </Col>
                <Col span={6}>
                    <Card className="player-admin-stat">
                        <Statistic title="已封禁账号" value={totals.banned || 0} />
                    </Card>
                </Col>
            </Row>
            <Card className="player-admin-panel player-admin-overview-card" title="快捷操作">
                <Space>
                    <Button type="primary" onClick={() => navigate('players')}>
                        管理玩家账号
                    </Button>
                    {canViewSecurity ? (
                        <Button onClick={() => navigate('security')}>查看安全记录</Button>
                    ) : null}
                    {isOwner ? (
                        <Button onClick={() => navigate('admins')}>管理后台账号</Button>
                    ) : null}
                </Space>
            </Card>
        </>
    );
}
