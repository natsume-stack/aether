import type { GetServerSideProps } from 'next';
import Head from 'next/head';

import styles from './login-required.module.css';
import {
  PlayerLoginURLNotConfiguredError,
  requirePlayerLoginURL,
} from '../server/player-service-client';

type LoginRequiredProps = {
  source: 'creator' | 'play';
};

export const getServerSideProps: GetServerSideProps<LoginRequiredProps> = async ({
  query,
  res,
}) => {
  const source = (Array.isArray(query.source) ? query.source[0] : query.source) === 'creator'
    ? 'creator'
    : 'play';
  const returnUrl = Array.isArray(query.returnUrl)
    ? query.returnUrl[0]
    : query.returnUrl;

  try {
    return {
      redirect: {
        destination: requirePlayerLoginURL(source, returnUrl),
        permanent: false,
      },
    };
  } catch (error) {
    if (!(error instanceof PlayerLoginURLNotConfiguredError)) throw error;
    res.statusCode = 503;
    res.setHeader('Cache-Control', 'no-store');
    return { props: { source } };
  }
};

export default function LoginRequiredPage({ source }: LoginRequiredProps) {
  return (
    <>
      <Head>
        <title>未开启登录</title>
      </Head>
      <main className={styles.page}>
        <section className={styles.panel} aria-labelledby="login-unavailable-title">
          <div className={styles.icon} aria-hidden="true">
            <span />
          </div>
          <h1 id="login-unavailable-title">未开启登录</h1>
          <p>
            服主尚未配置{source === 'creator' ? '创作端' : '游玩端'}登录地址，请联系服主后再试。
          </p>
        </section>
      </main>
    </>
  );
}
