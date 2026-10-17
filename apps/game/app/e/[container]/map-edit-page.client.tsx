'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import EditIconSvg from '../../../assets/edit-icons.svg';
import { EngineApp } from '../../../components/engine-app';
import { Error } from '../../../components/error';
import { getArenaServerRenderProps } from '../../../server/server-render';
import { ArenaBg } from '/components/loading/arena';
import { LangType } from '/src/apis/createra';

// TODO  use client 后不再需要这种方式了，换回来
const DynamicEditUi = dynamic(() => import('../../../src/views/edit/index'), {
  ssr: false,
});

export function MapEditPageClient(
  props: Awaited<ReturnType<typeof getArenaServerRenderProps>>['props'],
) {
  const [isLoading, setIsLoading] = useState(true);
  const [locale, setLocale] = useState<LangType>(props.locale);
  // 如果有异常，去异常页面
  if (props.error) {
    return <Error code={props.error.code} info={props.error.info} />;
  }

  return (
    <div id="__next__root">
      <EngineApp {...props} locale={locale} message={props.message}>
        <EditIconSvg />
        {isLoading && <ArenaBg />}
        <DynamicEditUi
          userInfo={props.userInfo}
          removeLoading={() => setIsLoading(false)}
          setLocale={setLocale}
        />
      </EngineApp>
    </div>
  );
}
