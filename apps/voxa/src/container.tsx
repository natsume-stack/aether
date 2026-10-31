import {
  useContext,
  useEffect,
  useState,
  DragEventHandler,
  useMemo,
  useRef,
  useCallback,
} from 'react';
import { useIntl } from 'react-intl';
import { clamp } from 'ramda';
import { Modal } from '@box/box-design';
import { IconDropUp } from '@box/icons';
import { VoxelEditorContext } from './internals';
import styles from './container.module.scss';
import { Sidebar } from './views/sidebar';
import { RightPanel } from './views/right-panel';
import { BottomBar } from './views/bottom-bar';
import { useGlobalSelectRect } from './views/components/select-rect';
import { store, useAppSelector } from './redux/store';
import { NavBar } from './views/nav-bar';
import { initRegl } from './models/rendering/regl';
import { LayersTips } from './views/layers-tips';
import { GlobalContextMenu, useStageContextMenu } from './views/contextmenu';
import { useEventListener, useResizeObserver } from './views/hooks';
import { AppSwitchBtn } from './views/app-switch-btn';
import { RootContext } from './root-context';
import { AppMode } from './redux/app-slice';
import { VoxelEditor } from './models/editor';
import { AnimatorMode } from './redux/animator-slice';
import { MotionPanel } from './views/motions';
import { debounce } from './utils/debounce-throttle';
import { isMobile } from './utils/devices';
import { clientConfig } from './config/client';
import { ProfilePanel } from './views/profile-panel';
import { useFloatMenu } from './views/float-menu';
import { startVoxaAgentLive } from './models/agent-live';

// motion面板默认高度
const MOTION_DEFAULT_HEIGHT = 197;
// motion面板最小高度
const MOTION_MIN_HEIGHT = isMobile() ? 0 : 121;
// 页面除motion面板之外部分的最小高度
const STAGE_MIN_HEIGHT = isMobile() ? 0 : 341;
// 触发resize时，防抖的时间间隔
const RESIZE_DEBOUNCE_TIME = 50;

export type VoxelBuilderHandlers = {
  editor: VoxelEditor;
  setRendering: (render: boolean) => void;
  destroy: () => void;
};

export default function VoxelBuilderContainer() {
  const [editor, setEditor] = useState<VoxelEditor>();

  const appMode = useAppSelector((state) => state.app.mode);
  const { editParts } = useAppSelector((state) => state.permission);

  const intl = useIntl();

  const { setRetry } = useContext(RootContext);

  const canvas = useRef<HTMLCanvasElement>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);

  useSvgSymbols();

  useEffect(() => {
    if (!canvas.current) {
      return;
    }

    const { toolType, mode } = store.getState().editing;
    let disposeEditor: Function;
    let disposeAgentLive: (() => void) | undefined;
    initRendering(canvas.current).then((res) => {
      const { editor, setRendering, destroy } = res;

      if (process.env.NODE_ENV === 'development') {
        window['editor'] = editor;
      }

      editor.voxelApp.setTool({
        toolType,
        mode,
      });

      setEditor(editor);

      setRendering(true);

      disposeEditor = () => {
        void editor.closeEditSession();
        destroy();
      };

      setRetry(() => {
        return editor.launch;
      });

      /**
       * 活体通道：让远端 AI 接上这台编辑器。
       * AI 的每个动作都走真人同一条路径（相机 / 体素光标 / destination 体素），
       * 所以人能看到建模过程，而不是刷新后模型突然变了。
       */
      if (!isMobile()) {
        disposeAgentLive = startVoxaAgentLive(editor);
      }

      /**
       * 初始化结束后，读取地址栏中的参数进行加载。
       */
      editor.launch();
    });

    return () => {
      disposeAgentLive?.();
      disposeAgentLive = undefined;

      if (disposeEditor) {
        disposeEditor();
      }

      Modal.destroyAll();
    };
  }, [setRetry, canvas]);

  useEffect(() => {
    if (editor) {
      editor.setIntl(intl);
    }
  }, [editor, intl]);

  const selectRect = useGlobalSelectRect(editor);

  const layersTips = useEditingLayerTips();

  /**
   * 拖拽.vox文件至面板时，插入.vox首个部件到当前体素编辑器中。
   */
  const onDrop = useCallback<DragEventHandler<HTMLDivElement>>(
    (evt) => {
      if (!editor) {
        return;
      }

      const { files } = evt.dataTransfer;

      const [file] = files;

      if (!file) {
        return;
      }

      editor?.voxTool.loadFirstPart(file);
    },
    [editor],
  );

  const appSwitchBtn = useMemo(() => {
    if (appMode === AppMode.Animator || !editParts) {
      return;
    }

    return <AppSwitchBtn />;
  }, [appMode, editParts]);

  /**
   * 禁止所有Tab事件，避免通过Tab选中非输入框元素
   */
  useEventListener('keydown', (evt) => {
    if (evt.key === 'Tab') {
      evt.preventDefault();
    }
  });

  const contextmenuVisible = useAppSelector(
    ({ app }) => app.contextmenu.visible,
  );

  useStageContextMenu(editor);

  const animatorMode = useAppSelector(({ animator }) => animator.mode);

  const [motionHeight, setMotionHeight] = useState<number>(
    MOTION_DEFAULT_HEIGHT,
  );

  const dragStartState = useRef<
    { startY: number; startHeight: number; maxHeight: number } | undefined
  >();

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current) {
        return;
      }
      const maxHeight = containerRef.current.offsetHeight - STAGE_MIN_HEIGHT;
      dragStartState.current = {
        startY: e.clientY,
        startHeight: motionHeight,
        maxHeight: maxHeight,
      };

      const onDrag = (e: MouseEvent) => {
        if (dragStartState.current === undefined) {
          return;
        }
        const diff = dragStartState.current.startY - e.clientY;
        let newHeight = dragStartState.current.startHeight + diff;
        newHeight = clamp(
          MOTION_MIN_HEIGHT,
          dragStartState.current.maxHeight,
          newHeight,
        );
        setMotionHeight(newHeight);
      };

      const onDragEnd = () => {
        dragStartState.current = undefined;

        window.removeEventListener('mousemove', onDrag);
        window.removeEventListener('mouseup', onDragEnd);
      };

      window.addEventListener('mousemove', onDrag);
      window.addEventListener('mouseup', onDragEnd);
    },
    [containerRef, motionHeight],
  );

  const prevContainerHeight = useRef<number>(0);

  const resize = useMemo(() => {
    return debounce(() => {
      if (!containerRef.current) {
        return;
      }
      const containerHeight = containerRef.current.offsetHeight;

      // container高度增加，优先拉伸舞台区，motion高度不变
      if (containerHeight >= prevContainerHeight.current) {
        prevContainerHeight.current = containerHeight;
        return;
      }

      prevContainerHeight.current = containerHeight;
      // container高度减少，优先压缩舞台区，当舞台区高度不足时，压缩motion面板
      const diff = containerHeight - motionHeight - STAGE_MIN_HEIGHT;
      if (diff < 0) {
        const newHeight = clamp(
          MOTION_MIN_HEIGHT,
          motionHeight + diff,
          motionHeight + diff,
        );
        setMotionHeight(newHeight);
      }
    }, RESIZE_DEBOUNCE_TIME);
  }, [containerRef, motionHeight]);

  const cachedResize = useResizeObserver(containerRef.current, resize);

  useEffect(() => {
    if (animatorMode === AnimatorMode.Motion) {
      cachedResize.current(true);
    }
  }, [animatorMode, cachedResize]);

  const [showRightPanel, setShowRightPanel] = useState(true);

  const voxelEditorStyle = useMemo(() => {
    const showPanel = `
    'navBar navBar navBar' 
    'sideBar canvas rightPanel' 
    'sideBar bottomBar rightPanel' 
    'motionPanel motionPanel motionPanel'`;
    const hidePanel = `
    'navBar navBar navBar' 
    'sideBar canvas canvas' 
    'sideBar bottomBar bottomBar' 
    'motionPanel motionPanel motionPanel'`;
    return {
      minHeight: isMobile() ? undefined : '613px',
      gridTemplateAreas: showRightPanel ? showPanel : hidePanel,
    };
  }, [showRightPanel]);

  const className = useMemo(() => {
    const toggleIconClassName = [styles.toggle];
    if (!showRightPanel) {
      toggleIconClassName.push(styles.toggleHide);
    }
    return toggleIconClassName.join(' ');
  }, [showRightPanel]);

  const onToggle = useCallback(() => {
    setShowRightPanel(!showRightPanel);
  }, [showRightPanel]);

  const profilerEnabled = useAppSelector(({ app }) => app.profilerEnabled);

  const profilePanel = useMemo(() => {
    if (!profilerEnabled) {
      return;
    }

    return <ProfilePanel />;
  }, [profilerEnabled]);

  const floatMenu = useFloatMenu();

  return (
    <VoxelEditorContext.Provider value={editor}>
      <div
        id="voxel-editor"
        className={styles.voxelEditor}
        style={voxelEditorStyle}
        onDrop={onDrop}
        ref={containerRef}
      >
        <div className={styles.canvasContainer}>
          <canvas ref={canvas} />
          {profilePanel}
          {floatMenu}
        </div>
        <NavBar type={appMode} />
        <Sidebar type={appMode} />
        {appSwitchBtn}
        <RightPanel isShow={showRightPanel} />
        <div className={className} onClick={onToggle}>
          <IconDropUp />
        </div>
        <BottomBar type={appMode} />
        {animatorMode === AnimatorMode.Motion && (
          <div className={styles.motionPanelContainer}>
            <div className={styles.resizeHandle} onMouseDown={onDragStart} />
            <MotionPanel height={motionHeight} />
          </div>
        )}
        {selectRect}
        {contextmenuVisible && <GlobalContextMenu />}
        <div
          style={{
            height: '100%',
            width: '100%',
            pointerEvents: 'none',
            position: 'relative',
          }}
        >
          {layersTips}
        </div>
      </div>
    </VoxelEditorContext.Provider>
  );
}

/**
 * 加载Icon的Svg Symbol文件
 */
function useSvgSymbols() {
  useEffect(() => {
    /**
     * fill-icons跟stroke-icons的划分依据的是设计组件库规范
     */
    const list = [
      /**
       * dynamic import
       * path must be explicitly written
       * https://nextjs.org/docs/advanced-features/dynamic-import#basic-usage
       */
      import('../assets/icons/fill-icons.svg'),
      import('../assets/icons/stroke-icons.svg'),
    ];

    const elements: HTMLDivElement[] = [];

    Promise.allSettled(list).then((loadResult) => {
      loadResult.forEach((result) => {
        if (result.status === 'fulfilled') {
          const div = document.createElement('div');

          div.style.width = '0px';
          div.style.height = '0px';

          div.innerHTML = result.value.default;

          document.body.appendChild(div);

          elements.push(div);
        }
      });
    });

    return () => {
      elements.forEach((element) => {
        element.remove();
      });
    };
  }, []);
}

export const IntlVoxelBuilderContainer = VoxelBuilderContainer;

/**
 * 初始化渲染相关的模块
 */
async function initRendering(
  canvas: HTMLCanvasElement,
): Promise<VoxelBuilderHandlers> {
  let rendering = false;

  const regl = await initRegl(canvas);

  const editor = new VoxelEditor({
    regl,
  });

  regl.frame(() => {
    if (!rendering) {
      return;
    }

    editor.render();
  });

  function destroy() {
    regl.destroy();
  }

  return {
    editor: editor,
    setRendering: (_r: boolean) => {
      rendering = _r;
    },
    destroy,
  };
}

/**
 * 体建造/删减、面拉伸时的tips组件。
 */
function useEditingLayerTips() {
  const showBoxBuilder = useAppSelector(
    ({ editing }) => editing.layersTips.visible,
  );

  return showBoxBuilder ? <LayersTips /> : undefined;
}
