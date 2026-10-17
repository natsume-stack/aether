import { ConfigProvider } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import type { ReactNode } from 'react';
import '@ant-design/v5-patch-for-react-19';
import 'antd/dist/reset.css';
import './global.less';

export function rootContainer(container:ReactNode) {
    return (
        <ConfigProvider
            locale={zhCN}
            componentSize="middle"
            theme={{ token: { borderRadius: 2, colorPrimary: '#1890ff' } }}
        >
            {container}
        </ConfigProvider>
    );
}
