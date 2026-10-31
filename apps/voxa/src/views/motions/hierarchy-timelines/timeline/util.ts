import { MouseEventHandler, useCallback, useContext, useRef } from 'react';
import { isMetaKeyPressed } from '@box/box-design';
import { TimelineContext } from '../context';

export function useItemHandlers(
  nodeId: string,
  ids: string[],
  selected: boolean,
) {
  const { onItemSelect, onDragItemStart } = useContext(TimelineContext);

  const shouldUseClick = useCallback(
    (evt: React.MouseEvent) =>
      selected && !isMetaKeyPressed(evt) && evt.button === 0,
    [selected],
  );

  // 是否触发过mousemove，如果触发过，则不执行onClick，避免影响拖拽
  const moved = useRef(false);

  const onMouseDown = useCallback<MouseEventHandler>(
    (evt) => {
      evt.stopPropagation();

      moved.current = false;

      if (!shouldUseClick(evt)) {
        onItemSelect(evt, ids, nodeId, selected);
      }

      onDragItemStart(evt);
    },
    [onItemSelect, nodeId, ids, selected, shouldUseClick, onDragItemStart],
  );

  const onMouseMove = useCallback<MouseEventHandler>((evt) => {
    moved.current = true;
  }, []);

  const onClick = useCallback<MouseEventHandler>(
    (evt) => {
      if (moved.current) {
        return;
      }

      if (shouldUseClick(evt)) {
        evt.stopPropagation();
        onItemSelect(evt, ids, nodeId, selected);
      }
    },
    [onItemSelect, nodeId, ids, selected, shouldUseClick],
  );

  return { onMouseDown, onMouseMove, onClick };
}
