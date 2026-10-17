import { memo, useCallback, useContext } from 'react';
import { useIntl } from 'react-intl';
import { Button } from '@box/box-design';
import { VoxelEditorContext } from '../../internals';
import { SaveState } from '../../redux/app-slice';
import { useAppSelector } from '../../redux/store';
import styles from './style.module.scss';

function SaveButtonView() {
  const editor = useContext(VoxelEditorContext);
  const intl = useIntl();
  const { parentType, saveState, isPublishing } = useAppSelector(({ app }) => ({
    parentType: app.parentType,
    saveState: app.saveState,
    isPublishing: app.isPublishing,
  }));

  const save = useCallback(() => {
    if (!editor) {
      return;
    }

    if (parentType === 'engine') {
      editor.iframeTool.emitSaveEvent();
      return;
    }

    editor.manualSave();
  }, [editor, parentType]);

  let onClick: (() => void) | undefined;
  let text: string | undefined;
  let loading = false;

  switch (saveState) {
    case SaveState.Saving:
      loading = true;
      break;
    case SaveState.Failed:
    default:
      text = intl.formatMessage({
        description: 'Save button',
        defaultMessage: 'Save',
      });
      onClick = save;
      break;
  }

  return (
    <Button
      className={[styles.button, styles.save].join(' ')}
      type="secondary"
      onClick={onClick}
      disabled={isPublishing}
      loading={loading}
    >
      {text}
    </Button>
  );
}

export const SaveButton = memo(SaveButtonView);
