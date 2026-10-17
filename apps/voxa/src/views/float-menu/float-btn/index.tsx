import React, { ReactNode } from 'react';
import { useClassName } from '@box/box-design';
import style from './style.module.scss';

export function FloatBtn(props: {
  className?: string;
  icon: ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  text: string;
}) {
  const className = useClassName(
    [style.floatBtn, props.className],
    [props.className],
  );

  return (
    <button className={className} onClick={props.onClick}>
      {props.icon}
      <span>{props.text}</span>
    </button>
  );
}
