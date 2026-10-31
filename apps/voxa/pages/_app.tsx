import React from 'react';
import Head from 'next/head';
import { AppProps } from 'next/app';
import './common.css';

export default function MyApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>Voxel Editor</title>
        <link rel="icon" type="image/x-icon" href="/images/favicon.ico" />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/images/favicon-32x32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/images/favicon-16x16.png"
        />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
