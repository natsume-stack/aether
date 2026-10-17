import { Col, Row } from 'antd';

import type { ReactNode } from 'react';

export function PageToolbar({ title, children }:{ title:ReactNode; children?:ReactNode }) {
    return (
        <Row justify="space-between" align="middle" className="player-admin-page-toolbar">
            <Col>
                <h1 className="player-admin-page-title">{title}</h1>
            </Col>
            {children ? <Col>{children}</Col> : null}
        </Row>
    );
}
