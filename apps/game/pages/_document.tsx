import React from 'react';
import Document, {
  DocumentContext,
  Html,
  Head,
  Main,
  NextScript,
} from 'next/document';

class MyDocument extends Document<{ lang: string }> {
  // Document not support Data Fetching methods yet
  public static async getInitialProps(ctx: DocumentContext) {
    const initialProps = await Document.getInitialProps(ctx);

    return {
      lang: 'zh-CN', // TODO Fetch from user info
      ...initialProps,
    };
  }
  public render() {
    const isCreatera = process.env.NEXT_PUBLIC_APP_EDITION === 'createra';
    return (
      <Html lang={this.props.lang}>
        <Head>
          <meta charSet="utf-8" />
          <link
            rel="shortcut icon"
            href={isCreatera ? '/createra-favicon.ico' : '/favicon.ico'}
            type="image/x-icon"
          />
          <link
            rel="apple-touch-icon"
            href={isCreatera ? '/createra-favicon.ico' : '/favicon.ico'}
            type="image/x-icon"
          />
          <meta content="telephone=no,email=no" name="format-detection" />
          <meta name="mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-title" content="Game" />
          <meta
            name="apple-mobile-web-app-status-bar-style"
            content="black-translucent"
          />
          <meta content="yes" name="apple-touch-fullscreen" />
          <meta
            name="App-Config"
            content="fullscreen=yes,useHistoryState=yes,transition=yes"
          />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

export default MyDocument;
