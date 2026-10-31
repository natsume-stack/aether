import type { GetServerSideProps } from 'next';
import Head from 'next/head';

import { playerLoginURL, requestPlayerServiceIp, resolvePlayerServiceIdentity } from '../server/player-service-client';

type CreatorAccessRequiredProps = {
  account: { displayName: string; username: string; userId: string } | null;
  loginURL: string;
};

export const getServerSideProps: GetServerSideProps<CreatorAccessRequiredProps> = async ({ req, res }) => {
  try {
    const { identity } = await resolvePlayerServiceIdentity(req, res as unknown as import('next').NextApiResponse, requestPlayerServiceIp(req));
    if (identity.creatorAccess) {
      return { redirect: { destination: '/projects', permanent: false } };
    }
    return { props: { account: { displayName: identity.displayName, username: identity.username, userId: identity.userId }, loginURL: playerLoginURL('creator') } };
  } catch {
    return { props: { account: null, loginURL: playerLoginURL('creator') } };
  }
};

export default function CreatorAccessRequiredPage({ account, loginURL }: CreatorAccessRequiredProps) {
  const authenticated = Boolean(account);
  return <>
    <Head><title>{authenticated ? '暂无创作权限' : '请先登录'}</title></Head>
    <main>
      <section aria-labelledby="creator-access-title">
        {authenticated ? <>
          <span className="eyebrow">当前登录账号</span>
          <h1 id="creator-access-title">暂无创作权限</h1>
          <div className="account"><strong>{account?.displayName}</strong><span>@{account?.username} · 账号 ID {account?.userId}</span></div>
          <p>此账号尚未获授权进入创作端。请联系服主，在玩家管理中授予创作者权限后重试。</p>
        </> : <>
          <span className="eyebrow">创作端需要账号验证</span>
          <h1 id="creator-access-title">请先登录</h1>
          <p>登录后系统会检查你的创作者权限；只有获得服主授权的账号才能进入创作端。</p>
          <a href={loginURL}>登录 / 注册</a>
        </>}
      </section>
      <style jsx>{`
        main { min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #f5f5f5; background: #262626; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        section { width: min(440px, 100%); padding: 26px; border: 1px solid rgba(255,255,255,.12); border-radius: 10px; background: #333; box-shadow: 0 18px 48px rgba(0,0,0,.2); }
        .eyebrow { display: block; margin-bottom: 9px; color: rgba(255,255,255,.48); font-size: 11px; font-weight: 650; letter-spacing: .06em; }
        h1 { margin: 0; color: #fff; --font-color: #fff; font-size: 20px; line-height: 1.3; }
        .account { display: grid; gap: 3px; margin: 16px 0 14px; padding: 11px 12px; border: 1px solid rgba(255,255,255,.1); border-radius: 7px; background: rgba(255,255,255,.045); }
        .account strong { color: #fff; font-size: 14px; }
        .account span { color: rgba(255,255,255,.48); font-size: 11px; }
        p { margin: ${authenticated ? '0' : '12px 0 0'}; color: rgba(255,255,255,.62); line-height: 1.7; font-size: 14px; }
        a { display: inline-flex; min-height: 36px; align-items: center; justify-content: center; margin-top: 20px; padding: 0 15px; border-radius: 7px; color: #262626; background: #ffdb00; font-size: 13px; font-weight: 700; text-decoration: none; }
        a:hover { background: #ffe44d; }
      `}</style>
    </main>
  </>;
}
