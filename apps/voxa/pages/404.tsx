import React from 'react';

export default function Custom404() {
  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1
        style={{
          display: 'inline-block',
          margin: '0 20px 0 0',
          paddingRight: '23px',
          fontSize: '24px',
          fontWeight: 500,
          verticalAlign: 'top',
          borderRight: '1px solid rgba(0, 0, 0,.3)',
        }}
      >
        404
      </h1>
      <div
        style={{
          display: 'inline-block',
          textAlign: 'left',
          lineHeight: '49px',
          height: '49px',
          verticalAlign: 'middle',
        }}
      >
        <h2
          style={{
            fontSize: '14px',
            fontWeight: 'normal',
            lineHeight: 'inherit',
            margin: 0,
            padding: 0,
          }}
        >
          This page could not be found.
        </h2>
      </div>
    </div>
  );
}
