import { DownloadOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Input, Select, Space } from 'antd';

import { AdminPagination } from '../../components/admin-pagination';
import { PageToolbar } from '../../components/page-toolbar';
import { PlayerTable, type PlayerBatchAction } from './player-table';

import type { ColumnsType } from 'antd/es/table';
import type { Player } from '../../player-admin-types';

export type PlayerDirectoryMode = 'players' | 'online-sessions' | 'account-bans';

type Props = {
    mode:PlayerDirectoryMode;
    players:Player[];
    columns:ColumnsType<Player>;
    total:number;
    page:number;
    pageSize:number;
    search:string;
    identity:string;
    selectedIds:string[];
    loading:boolean;
    exporting:boolean;
    canExport:boolean;
    canCreate:boolean;
    refresh:() => void;
    exportPlayers:() => void;
    createPlayer:() => void;
    openDetails:(player:Player) => Promise<void>;
    batchPlayers:(action:PlayerBatchAction, subjectIds:string[], tag?:string) => Promise<void>;
    setPage:(page:number) => void;
    setPageSize:(size:number) => void;
    setSearch:(search:string) => void;
    setIdentity:(identity:string) => void;
    setSelectedIds:(ids:string[]) => void;
};

const copy = {
    'players': { title: '玩家账号', panel: '玩家目录' },
    'online-sessions': { title: '在线会话', panel: '当前在线玩家' },
    'account-bans': { title: '账号封禁', panel: '已封禁账号' },
} as const;

/** Shared player directory behavior for all player-list routes. */
export function PlayerDirectoryPage(props:Props) {
    const labels = copy[props.mode];
    const setSearch = (value:string) => {
        props.setSearch(value);
        props.setPage(1);
    };
    const panelTitle =
        props.mode === 'players' ? labels.panel : `${labels.panel}（${props.total}）`;

    return (
        <>
            <PageToolbar title={labels.title}>
                <Space>
                    <Button
                        icon={<ReloadOutlined />}
                        loading={props.loading}
                        onClick={props.refresh}
                    >
                        刷新
                    </Button>
                    {props.mode === 'players' && props.canExport ? (
                        <Button
                            icon={<DownloadOutlined />}
                            loading={props.exporting}
                            onClick={props.exportPlayers}
                        >
                            导出 CSV
                        </Button>
                    ) : null}
                    {props.mode === 'players' && props.canCreate ? (
                        <Button type="primary" icon={<PlusOutlined />} onClick={props.createPlayer}>
                            新增玩家
                        </Button>
                    ) : null}
                </Space>
            </PageToolbar>
            <Card
                className="player-admin-panel"
                title={panelTitle}
                extra={
                    <Space>
                        <Input
                            prefix={<SearchOutlined />}
                            allowClear
                            placeholder="搜索昵称、用户名或身份 ID"
                            value={props.search}
                            onChange={(event) => setSearch(event.target.value)}
                            style={{ width: 260 }}
                        />
                        {props.mode === 'players' ? (
                            <Select
                                value={props.identity}
                                onChange={(value) => {
                                    props.setIdentity(value);
                                    props.setPage(1);
                                }}
                                style={{ width: 110 }}
                                options={[
                                    { value: 'all', label: '全部账号' },
                                    { value: 'user', label: '普通账号' },
                                    { value: 'box', label: '神岛账号' },
                                    { value: 'banned', label: '已封禁' },
                                ]}
                            />
                        ) : null}
                    </Space>
                }
            >
                <PlayerTable
                    loading={props.loading}
                    className="player-admin-table"
                    selectedIds={props.selectedIds}
                    setSelectedIds={props.setSelectedIds}
                    openDetails={props.openDetails}
                    batchPlayers={props.batchPlayers}
                    columns={props.columns}
                    dataSource={props.players}
                    rowKey="subjectId"
                    pagination={false}
                    locale={
                        props.mode === 'online-sessions'
                            ? { emptyText: <Empty description="当前没有在线玩家" /> }
                            : undefined
                    }
                />
                <AdminPagination
                    page={props.page}
                    pageSize={props.pageSize}
                    total={props.total}
                    setPage={props.setPage}
                    setPageSize={props.setPageSize}
                />
            </Card>
        </>
    );
}
