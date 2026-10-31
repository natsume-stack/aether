import { memo, useContext, useMemo } from 'react';
import { useIntl } from 'react-intl';
import { Button, TooltipTrigger, TriggerOptions } from '@box/box-design';
import { VoxelEditorContext } from '../../internals';
import { useAppSelector } from '../../redux/store';
import { OFFSET_Y } from '.';
import style from './style.module.scss';

function UndoRedo(props: { triggerOptions: TriggerOptions }) {
  const intl = useIntl();
  const { triggerOptions } = props;
  const { undoEnabled, redoEnabled, playing } = useAppSelector((state) => {
    const { history, motionPanel } = state.app;
    return {
      undoEnabled: history.undoEnabled,
      redoEnabled: history.redoEnabled,
      playing: motionPanel.playing,
    };
  });
  const editor = useContext(VoxelEditorContext);

  const undoButton = useMemo(() => {
    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'Undo',
          defaultMessage: 'Undo',
        })}
        placement={'topLeft'}
        align={{ offset: [0, OFFSET_Y] }}
        {...triggerOptions}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon="#icon-edit-undo"
          disabled={!undoEnabled || playing}
          onClick={() => {
            editor?.history.undo();
          }}
        />
      </TooltipTrigger>
    );
  }, [editor, intl, triggerOptions, undoEnabled, playing]);

  const redoButton = useMemo(() => {
    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'Redo',
          defaultMessage: 'Redo',
        })}
        placement="top"
        align={{ offset: [-2, OFFSET_Y] }}
        {...triggerOptions}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon="#icon-edit-redo"
          disabled={!redoEnabled || playing}
          onClick={() => {
            editor?.history.redo();
          }}
        />
      </TooltipTrigger>
    );
  }, [editor, intl, redoEnabled, triggerOptions, playing]);

  return (
    <>
      {undoButton}
      {redoButton}
    </>
  );
}

export const UndoRedoButtons = memo(UndoRedo);
