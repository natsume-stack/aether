import React, {
  ReactNode,
  memo,
  useMemo,
  useContext,
  useCallback,
  useRef,
} from 'react';
import { useIntl } from 'react-intl';
import { useDispatch } from 'react-redux';
import { Button, Input, TooltipTrigger, useClassName } from '@box/box-design';
import { RootState, store, useAppSelector } from '../../redux/store';
import { hexToRGB, RGBToHex, RGBToHsv } from '../../utils/color';
import { HueSlider, SaturationValueSketch } from './slider-sketch';
import { VoxelEditorContext } from '../../internals';
import { PaletteRGB, setPaletteItem } from '../../redux/palette-slice';
import { isPaletteItemValid } from '../../models/palette/util';
import type { onAppSliderAbort } from '../hooks';
import { AppSlider } from '../components/slider';
import styles from './settings.module.scss';

export const Settings = memo(function SettingsView() {
  return (
    <div className={styles.settings}>
      <div className={styles.divider} />
      <SaturationValueSketch />
      <PaletteSlider />
      <PaletteInputs />
      <PaletteEmissive />
    </div>
  );
});

function PaletteSlider() {
  const intl = useIntl();

  return (
    <div className={styles.slider}>
      <TooltipTrigger
        placement="bottom"
        align={{ offset: [0, 4] }}
        text={intl.formatMessage({
          description: 'buttonPaletteColorPicker',
          defaultMessage: 'Eyedropper',
        })}
      >
        <Button
          className={styles.icon}
          type="icon"
          icon="#icon-secondary-eyedropper"
          disabled
        />
      </TooltipTrigger>
      <HueSlider />
    </div>
  );
}

function PaletteInputs() {
  const { rgb, selectedIdx } = useAppSelector((state) => {
    const { items, selectedId: selectedIdx } = state.palette;

    const item = items[selectedIdx];

    if (!isPaletteItemValid(item)) {
      return {
        rgb: [0, 0, 0],
        selectedIdx,
      };
    }

    return {
      rgb: item.rgb,
      selectedIdx,
    };
  });

  const getColor = useCallback((rgb: number[]) => {
    const [r, g, b] = rgb;
    const hex = RGBToHex(r, g, b).toUpperCase();
    return {
      r,
      g,
      b,
      hex,
    };
  }, []);

  const getNewestValue = useCallback(() => {
    const { items, selectedId: selectedIdx } = store.getState().palette;
    const item = items[selectedIdx];

    if (!isPaletteItemValid(item)) {
      return {
        r: 0,
        g: 0,
        b: 0,
        hex: '000000',
      };
    }

    return getColor(item.rgb);
  }, [getColor]);

  const { r, g, b, hex } = useMemo(() => {
    return getColor(rgb);
  }, [getColor, rgb]);

  const editor = useContext(VoxelEditorContext);

  const setRGB = useCallback(
    (id: number, rgb: PaletteRGB) => {
      if (!editor) {
        return;
      }
      const [r, g, b] = rgb;
      const hsv = RGBToHsv(r, g, b);

      editor.history.saveAction({ action: setPaletteItem({ id, rgb, hsv }) });

      editor.palette.updateMeshTexture(id);
    },
    [editor],
  );

  const onConfirm = useCallback(
    (hexStr: string) => {
      const rgb = hexToRGB(hexStr);

      if (!rgb) {
        return;
      }

      setRGB(selectedIdx, rgb);
    },

    [selectedIdx, setRGB],
  );

  return (
    <div className={styles.inputs}>
      <PaletteInput
        className={styles.hex}
        value={hex}
        onConfirm={(value) => {
          onConfirm(value.toString());
        }}
        getNewestValue={() => getNewestValue().hex}
      >
        HEX
      </PaletteInput>
      <PaletteInput
        value={r}
        onConfirm={(value) => {
          const v = RGBToHex(Number(value), g, b);
          onConfirm(v);
        }}
        getNewestValue={() => getNewestValue().r}
      >
        R
      </PaletteInput>
      <PaletteInput
        value={g}
        onConfirm={(value) => {
          const v = RGBToHex(r, Number(value), b);
          onConfirm(v);
        }}
        getNewestValue={() => getNewestValue().g}
      >
        G
      </PaletteInput>
      <PaletteInput
        value={b}
        onConfirm={(value) => {
          const v = RGBToHex(r, g, Number(value));
          onConfirm(v);
        }}
        getNewestValue={() => getNewestValue().b}
      >
        B
      </PaletteInput>
    </div>
  );
}

const PaletteInput = memo(PaletteInputView);

function PaletteInputView(options: {
  className?: string;
  children?: ReactNode;
  value: string | number;
  onConfirm: (value: string | number) => void;
  getNewestValue: () => string | number;
}) {
  const {
    className: optionClassName,
    children,
    value,
    onConfirm,
    getNewestValue,
  } = options;
  const className = useClassName(
    [styles.input, optionClassName],
    [optionClassName],
  );

  const isNumber = typeof value === 'number';
  const rbgValidator = useCallback((value: string) => {
    return /^\d{0,3}$/.test(value);
  }, []);
  const hexValidator = useCallback((value: string) => {
    return /^[a-fA-F\d]{0,6}$/.test(value);
  }, []);

  return (
    <div className={className}>
      <Input
        className={styles.value}
        type="primary"
        size="small"
        center
        min={isNumber ? 0 : undefined}
        max={isNumber ? 255 : undefined}
        valueType={isNumber ? 'number' : 'string'}
        value={value}
        onBlur={(value) => {
          onConfirm && onConfirm(value);
        }}
        validator={isNumber ? rbgValidator : hexValidator}
        getNewestValue={getNewestValue}
      />
      <div className={styles.label}>{children}</div>
    </div>
  );
}

function PaletteEmissive() {
  const intl = useIntl();

  const editor = useContext(VoxelEditorContext);

  const { emissive, itemId } = useAppSelector((state) => {
    const { items, selectedId } = state.palette;

    const item = items[selectedId];

    if (!isPaletteItemValid(item)) {
      return {
        emissive: 0,
        itemId: selectedId,
      };
    }

    // 换算到发光度的显示值范围 0 - 100
    return {
      emissive: (item.material.emissive / 255) * 100,
      itemId: selectedId,
    };
  });

  const dispatch = useDispatch();

  const onAbort = useCallback<onAppSliderAbort>(
    (oldState) => {
      if (!editor || !oldState) {
        return;
      }

      const oldItem = oldState.palette.items[itemId];

      if (isPaletteItemValid(oldItem)) {
        dispatch(
          setPaletteItem({
            id: itemId,
            material: {
              emissive: oldItem.material.emissive,
            },
          }),
        );

        editor.palette.updateMeshTexture(itemId);
      }
    },
    [dispatch, itemId, editor],
  );

  const onAfterChange = useCallback(
    (emissive: number, oldState?: RootState) => {
      if (!editor) {
        return;
      }

      editor.history.saveAction({
        action: setPaletteItem({
          id: itemId,
          material: {
            emissive: Math.round((emissive / 100) * 255),
          },
        }),
        saveRecord: true,
        oldState,
      });
    },
    [editor, itemId],
  );

  const onChange = useCallback(
    (value: number) => {
      if (!editor) {
        return;
      }

      editor.history.saveAction({
        action: setPaletteItem({
          id: itemId,
          material: {
            emissive: Math.round((value / 100) * 255),
          },
        }),
        saveRecord: false,
      });

      editor.palette.updateMeshTexture(itemId);
    },
    [editor, itemId],
  );

  const inputOldState = useRef<RootState | undefined>();

  const input = useMemo(() => {
    return (
      <Input
        type="primary"
        size="small"
        center
        className={styles.input}
        valueType="number"
        value={emissive}
        min={0}
        max={100}
        precision={0}
        validator={(value) => {
          return /^\d{0,3}$/.test(value);
        }}
        formatter={(value) => {
          return `${value}%`;
        }}
        onFocus={() => {
          inputOldState.current = store.getState();
        }}
        onBlur={(value: string) => {
          onAfterChange(Number(value), inputOldState.current);
        }}
      />
    );
  }, [emissive, onAfterChange, inputOldState]);

  return (
    <div className={styles.emissive}>
      <div className={styles.iconTitle}>
        {intl.formatMessage({
          description: 'Palette Emissive',
          defaultMessage: 'Emissive',
        })}
      </div>
      <AppSlider
        type="normal"
        value={emissive}
        min={0}
        max={100}
        step={1}
        className={styles.sliderWrapper}
        sliderClassName={styles.emissiveSlider}
        onChange={onChange}
        onAfterChange={onAfterChange}
        onAbort={onAbort}
        input={input}
      />
    </div>
  );
}
