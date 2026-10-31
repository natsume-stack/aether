import { useEffect, useRef } from 'react';
import { vec3 } from 'gl-matrix';

import { useEdit } from 'src/client/edit/edit-context';
import {
  getAgentPresence,
  useAgentPresence,
} from 'src/client/edit/agent-live/presence';
import style from './style.module.scss';

/**
 * DOM-projected presence layer. The 3D camera belongs to the engine, so the
 * cursor is projected onto the canvas every animation frame instead of adding a
 * second renderer; this keeps the overlay cheap and independent of the GPU path.
 */
export function AgentPresence() {
  const editor = useEdit();
  const presence = useAgentPresence();
  const rootRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const marker = markerRef.current;
      const root = rootRef.current;
      if (!marker || !root) return;

      const cursor = getAgentPresence().cursor;
      const state = editor.game?.state;
      const canvas = state?.dom?.canvas;
      if (!cursor || !cursor.visible || !canvas) {
        marker.style.opacity = '0';
        return;
      }

      const rootRect = root.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const world = vec3.fromValues(
        cursor.voxel[0] + 0.5,
        cursor.voxel[1] + 0.5,
        cursor.voxel[2] + 0.5,
      );
      const clip = vec3.transformMat4(vec3.create(), world, state.camera.viewProjection);
      const visible = clip[2] > -1 && clip[2] < 1;
      if (!visible) {
        marker.style.opacity = '0';
        return;
      }
      const localX = (clip[0] + 1) / 2 * canvasRect.width + (canvasRect.left - rootRect.left);
      const localY = (1 - clip[1]) / 2 * canvasRect.height + (canvasRect.top - rootRect.top);
      marker.style.opacity = '1';
      marker.style.transform = `translate3d(${localX}px, ${localY}px, 0) translate(-50%, -50%)`;

      if (labelRef.current) {
        const blockName = cursor.blockName || (cursor.block ? String(cursor.block) : '空气');
        labelRef.current.textContent = `AI · ${blockName} · ${cursor.voxel.join(', ')}`;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [editor]);

  const phaseLabel =
    presence.phase === 'attached'
      ? presence.action?.status === 'running'
        ? presence.action.label
        : '在线'
      : presence.phase === 'connecting'
        ? '接入中'
        : presence.phase === 'error'
          ? '通道断开'
          : '待接入';

  return (
    <div ref={rootRef} className={style.root} aria-hidden="true">
      {presence.lookTarget && <div className={style.cameraFrame} />}
      <div ref={markerRef} className={style.cursor}>
        <div className={style.cursorSquare} />
        <div ref={labelRef} className={style.cursorLabel} />
      </div>
      <div className={style.chipRow}>
        <div className={`${style.chip} ${style[presence.phase] || ''}`}>
          <span className={style.dot} />
          <span className={style.chipTitle}>{presence.agentName || 'AI'}</span>
          <span className={style.chipPhase}>{phaseLabel}</span>
        </div>
      </div>
      {presence.note && <div className={style.note}>{presence.note}</div>}
    </div>
  );
}
