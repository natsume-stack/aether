import React from 'react';
import { vec3 } from 'gl-matrix';
import style from './style.module.scss';

interface IComponentInputProps {
  label: string;
  lo: number;
  hi: number;
  value: number;
  step: number;
  onChange: (value: number) => void;
}

const ComponentInput = (props: IComponentInputProps) => {
  const { label, lo, hi, value, step, onChange } = props;
  return (
    <div className={style.inputBox} key={label}>
      <span className={style.label}>{label}</span>
      <input
        className={style.numberInput}
        type="number"
        min={lo}
        max={hi}
        step={step}
        value={Math.round(value * 1000) / 1000}
        onChange={(ev) => {
          const validatedValue = Math.max(lo, Math.min(hi, +ev.target.value));
          onChange(validatedValue);
        }}
      />
      <input
        type="range"
        min={lo}
        max={hi}
        step={step}
        value={value}
        onChange={(ev) => onChange(+ev.target.value)}
      />
    </div>
  );
};

interface VectorInputProps {
  label: string;
  value: vec3;
  lo: vec3;
  hi: vec3;
  step: number;
  onChange: (value: vec3) => void;
}

export function VectorInput(props: VectorInputProps) {
  const { label, value, lo, hi, step, onChange } = props;

  return (
    <div>
      <ComponentInput
        label={`${label}.x`}
        lo={lo[0]}
        hi={hi[0]}
        value={value[0]}
        step={step}
        onChange={(v: number) => {
          onChange(vec3.fromValues(v, value[1], value[2]));
        }}
      />
      <ComponentInput
        label={`${label}.y`}
        lo={lo[1]}
        hi={hi[1]}
        value={value[1]}
        step={step}
        onChange={(v: number) => {
          onChange(vec3.fromValues(value[0], v, value[2]));
        }}
      />
      <ComponentInput
        label={`${label}.z`}
        lo={lo[2]}
        hi={hi[2]}
        value={value[2]}
        step={step}
        onChange={(v: number) => {
          onChange(vec3.fromValues(value[0], value[1], v));
        }}
      />
    </div>
  );
}
