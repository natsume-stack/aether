import { CodeOutlined, FileImageOutlined, SoundOutlined } from '@ant-design/icons';
import { Button, Empty, Form, Input, Modal, Space, Tabs } from 'antd';

import { formatBytes } from '../../player-admin-format';

import type { FormInstance } from 'antd';
import type { PlayMap, PlayBundleReview } from '../../player-admin-types';

type Resource = PlayBundleReview['resources'][number];
type Props = {
    editing?:PlayMap;
    setEditing:(world:PlayMap | undefined) => void;
    form:FormInstance;
    saveWorld:() => Promise<void>;
    review?:PlayBundleReview;
    reviewFile?:File;
    reviewWorldId:string;
    setReviewWorldId:(id:string) => void;
    reviewCategory:string;
    setReviewCategory:(category:string) => void;
    preview?:{ resource:Resource; content:string };
    setPreview:(preview:{ resource:Resource; content:string } | undefined) => void;
    previewResource:(resource:Resource) => Promise<void>;
    cancelReview:() => Promise<void>;
    confirmImport:() => Promise<void>;
    loading:boolean;
};

/** 只负责展示弹窗；权限、请求和导入生命周期仍由 PlayMapsPage 管理。 */
export function PlayMapDialogs({
    editing,
    setEditing,
    form,
    saveWorld,
    review,
    reviewFile,
    reviewWorldId,
    setReviewWorldId,
    reviewCategory,
    setReviewCategory,
    preview,
    setPreview,
    previewResource,
    cancelReview,
    confirmImport,
    loading,
}:Props) {
    return (
        <>
            <Modal
                title="地图设置"
                open={Boolean(editing)}
                onCancel={() => setEditing(undefined)}
                onOk={() => void saveWorld()}
                okText="保存"
            >
                <Form form={form} layout="vertical">
                    <Form.Item
                        name="publicId"
                        label="访问 ID"
                        rules={[
                            {
                                required: true,
                                pattern: /^[a-z0-9][a-z0-9-]{0,62}$/,
                                message: '使用小写字母、数字或连字符，最长 63 位',
                            },
                        ]}
                    >
                        <Input
                            addonBefore="/p/"
                            maxLength={63}
                            onChange={(event) =>
                                form.setFieldValue(
                                    'publicId',
                                    event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                                )
                            }
                        />
                    </Form.Item>
                </Form>
            </Modal>
            <Modal
                title="检查游玩包"
                open={Boolean(review)}
                width={1040}
                wrapClassName="play-bundle-review-modal"
                onCancel={() => void cancelReview()}
                footer={
                    <Space>
                        <Button onClick={() => void cancelReview()}>取消</Button>
                        <Button
                            type="primary"
                            loading={loading}
                            onClick={() => void confirmImport()}
                        >
                            确认导入
                        </Button>
                    </Space>
                }
            >
                {review ? (
                    <>
                        <div className="play-bundle-review-summary">
                            <div className="play-bundle-review-file">
                                <span>导入文件</span>
                                <strong title={reviewFile?.name}>
                                    {reviewFile?.name || '游玩包'}
                                </strong>
                            </div>
                            <div>
                                <span>地图数量</span>
                                <strong>{review.mapCount} 张</strong>
                            </div>
                            <div>
                                <span>资源内容</span>
                                <strong>
                                    {formatBytes(review.totalBytes)} · {review.blobCount} 个
                                </strong>
                            </div>
                        </div>
                        {review.warnings.length ? (
                            <div className="play-bundle-review-warnings">
                                <strong>检查提示</strong>
                                {review.warnings.map((warning, index) => (
                                    <div key={index}>{warning}</div>
                                ))}
                            </div>
                        ) : null}
                        <div className="play-bundle-review-workspace">
                            <section className="play-bundle-review-map-list">
                                <div className="play-bundle-review-section-title">地图</div>
                                <div className="play-bundle-review-scroll">
                                    {review.worlds.map((world) => (
                                        <button
                                            key={world.id}
                                            type="button"
                                            className={`play-bundle-review-item ${
                                                reviewWorldId === world.id ? 'is-selected' : ''
                                            }`}
                                            onClick={() => {
                                                setReviewWorldId(world.id);
                                                setPreview(undefined);
                                            }}
                                        >
                                            <strong>{world.name}</strong>
                                            <span>
                                                {world.mapRole === 'main' ? '主地图' : '副地图'}
                                                {world.version ? ` · ${world.version}` : ''}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </section>
                            <section className="play-bundle-review-resource-list">
                                <Tabs
                                    activeKey={reviewCategory}
                                    onChange={(key) => {
                                        setReviewCategory(key);
                                        setPreview(undefined);
                                    }}
                                    items={[
                                        {
                                            key: 'script',
                                            label: (
                                                <Space size={4}>
                                                    <CodeOutlined />
                                                    脚本
                                                </Space>
                                            ),
                                        },
                                        {
                                            key: 'image',
                                            label: (
                                                <Space size={4}>
                                                    <FileImageOutlined />
                                                    图片
                                                </Space>
                                            ),
                                        },
                                        {
                                            key: 'audio',
                                            label: (
                                                <Space size={4}>
                                                    <SoundOutlined />
                                                    音频
                                                </Space>
                                            ),
                                        },
                                    ]}
                                />
                                <div className="play-bundle-review-scroll">
                                    {review.resources
                                        .filter(
                                            (resource) =>
                                                resource.worldId === reviewWorldId &&
                                                resource.kind === reviewCategory,
                                        )
                                        .map((resource) => (
                                            <button
                                                key={resource.id}
                                                type="button"
                                                disabled={!resource.previewable}
                                                className={`play-bundle-review-item ${
                                                    preview?.resource.id === resource.id
                                                        ? 'is-selected'
                                                        : ''
                                                }`}
                                                onClick={() => void previewResource(resource)}
                                            >
                                                <strong title={resource.name}>
                                                    {resource.name}
                                                </strong>
                                                <span>
                                                    {formatBytes(resource.bytes)}
                                                    {resource.scriptTarget
                                                        ? ` · ${resource.scriptTarget}`
                                                        : ''}
                                                    {resource.previewable ? '' : ' · 无法预览'}
                                                </span>
                                            </button>
                                        ))}
                                    {!review.resources.some(
                                        (resource) =>
                                            resource.worldId === reviewWorldId &&
                                            resource.kind === reviewCategory,
                                    ) ? (
                                        <Empty
                                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                                            description="没有此类资源"
                                        />
                                    ) : null}
                                </div>
                            </section>
                            <section className="play-bundle-review-preview">
                                {preview ? (
                                    <>
                                        <div className="play-bundle-review-preview-head">
                                            <strong title={preview.resource.name}>
                                                {preview.resource.name}
                                            </strong>
                                            <span>
                                                {preview.resource.mimeType} ·{' '}
                                                {formatBytes(preview.resource.bytes)}
                                            </span>
                                        </div>
                                        {preview.resource.kind === 'script' ? (
                                            preview.content ? (
                                                <pre className="play-bundle-review-code">
                                                    {preview.content}
                                                </pre>
                                            ) : (
                                                <Empty description="该脚本为空" />
                                            )
                                        ) : preview.resource.kind === 'image' ? (
                                            <div className="play-bundle-review-image">
                                                <img
                                                    src={preview.content}
                                                    alt={preview.resource.name}
                                                />
                                            </div>
                                        ) : preview.resource.kind === 'audio' ? (
                                            <div className="play-bundle-review-audio">
                                                <audio controls src={preview.content} />
                                            </div>
                                        ) : (
                                            <a
                                                href={preview.content}
                                                target="_blank"
                                                rel="noreferrer"
                                            >
                                                打开资源预览
                                            </a>
                                        )}
                                    </>
                                ) : (
                                    <Empty description="选择资源以预览">
                                        <span className="player-admin-muted">
                                            预览不会执行脚本或启动地图
                                        </span>
                                    </Empty>
                                )}
                            </section>
                        </div>
                    </>
                ) : null}
            </Modal>
        </>
    );
}
