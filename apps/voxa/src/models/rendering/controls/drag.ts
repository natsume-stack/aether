import EventEmitter from 'events';
import { mat4, vec2, vec3 } from 'gl-matrix';
import { Camera } from '../camera/base';
import { Plane } from '../math/plane';
import { Object3D } from '../objects/object3d';
import { Intersection, Raycaster } from '../raycast';
import { isFunction } from '../utils/function';
import { LONG_PRESS_DURATION } from '../../../defs';
import { CLICK_OFFSET_THRESHOLD } from '../../editing/const';

const POINTER = vec2.create();
// 用于计算pointerMover的移动距离
const POINTER_MOVE_START = vec2.create();
const POINTER_MOVE_END = vec2.create();

const OFFSET = vec3.create();
const INTERSECTION = vec3.create();
const WORLD_POSITION = vec3.create();
const INVERSE_MATRIX = mat4.create();

type Position = {
  clientX: number;
  clientY: number;
};

export class DragControls extends EventEmitter implements IDragControls {
  public enabled = true;
  /**
   * objects是否可拖拽
   * 默认为可拖拽
   */
  public draggable = true;
  /**
   * 是否递归查找objects的children
   * 默认是
   */
  public recursive = true;

  private raycaster = new Raycaster();
  private plane = new Plane();

  private selected: Object3D | undefined = undefined;
  private hovered: Object3D | undefined = undefined;
  private intersections: Intersection[] = [];
  private pointerdownTimestamp: number = 0;

  private pointers: PointerEvent[] = [];

  private addPointer(event: PointerEvent) {
    this.pointers.push(event);
  }

  private removePointer(event: { pointerId: string | number }) {
    for (let i = 0; i < this.pointers.length; i++) {
      if (this.pointers[i].pointerId == event.pointerId) {
        this.pointers.splice(i, 1);
        return;
      }
    }
  }

  private getCamera: () => Camera;

  constructor(
    private objects: Object3D[] | (() => Object3D[]),
    camera: Camera | (() => Camera),
    private domElement: HTMLElement,
  ) {
    super();

    this.getCamera = isFunction(camera) ? camera : () => camera;
    domElement.style.touchAction = 'none'; // disable touch scroll
    this.activate();
  }

  private activate() {
    this.domElement.addEventListener('pointermove', this.onPointerMove);
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointerup', this.onPointerUp);
    this.domElement.addEventListener('pointerleave', this.onPointerCancel);
    this.domElement.addEventListener('pointercancel', this.onPointerCancel);
  }

  private deactivate() {
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('pointerleave', this.onPointerCancel);
    this.domElement.removeEventListener('pointercancel', this.onPointerCancel);
  }

  public addListener<K extends keyof EventMap>(
    type: K,
    listener: (e: EventMap[K]) => void,
  ) {
    return super.addListener(type, listener);
  }

  public removeListener<K extends keyof EventMap>(
    type: K,
    listener: (e: EventMap[K]) => void,
  ) {
    return super.removeListener(type, listener);
  }

  public emit<K extends keyof EventMap>(type: K, data: EventMap[K]) {
    return super.emit(type, data);
  }

  public dispose() {
    this.deactivate();
  }

  public getObjects() {
    return Array.isArray(this.objects) ? this.objects : this.objects();
  }

  public getRaycaster() {
    return this.raycaster;
  }

  public hitTest(position: Position) {
    const pointer = this.getPointer(position);
    this.intersections.length = 0;

    const camera = this.getCamera();
    this.raycaster.setFromCamera([pointer.x, pointer.y], camera);
    this.raycaster.intersectObjects(
      this.getObjects(),
      this.recursive,
      this.intersections,
    );
    return this.intersections.length ? this.intersections[0].object : undefined;
  }

  private setFromMatrixPosition(out: vec3, matrix: mat4) {
    return vec3.set(out, matrix[12], matrix[13], matrix[14]);
  }

  private onPointerMove = (event: PointerEvent) => {
    if (!this.enabled) return;

    if (event.pointerType === 'touch') {
      vec2.set(
        POINTER_MOVE_START,
        this.pointers[0].clientX,
        this.pointers[0].clientY,
      );
      vec2.set(POINTER_MOVE_END, event.clientX, event.clientY);
      if (
        vec2.distance(POINTER_MOVE_START, POINTER_MOVE_END) >
        CLICK_OFFSET_THRESHOLD
      ) {
        this.pointerdownTimestamp = 0;
        return;
      }
    }

    this.updatePointer(event);
    this.raycaster.setFromCamera(POINTER, this.getCamera());

    if (this.draggable && this.selected) {
      if (this.raycaster.ray.intersectPlane(INTERSECTION, this.plane)) {
        vec3.sub(this.selected.position, INTERSECTION, OFFSET);
        vec3.transformMat4(
          this.selected.position,
          this.selected.position,
          INVERSE_MATRIX,
        );
      }

      this.emit('drag', { type: 'drag', event, object: this.selected });
      return;
    }

    // hover support
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') {
      return;
    }

    this.intersections.length = 0;

    const camera = this.getCamera();
    this.raycaster.setFromCamera(POINTER, camera);
    this.raycaster.intersectObjects(
      this.getObjects(),
      this.recursive,
      this.intersections,
    );

    if (this.intersections.length > 0) {
      const object = this.intersections[0].object;
      this.plane.setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(this.plane.normal),
        this.setFromMatrixPosition(WORLD_POSITION, object.matrixWorld),
      );

      if (this.hovered !== object && this.hovered !== undefined) {
        this.emit('hoveroff', {
          type: 'hoveroff',
          event,
          object: this.hovered,
        });
        this.hovered = undefined;
      }

      if (this.hovered !== object) {
        this.emit('hoveron', { type: 'hoveron', event, object });
        this.hovered = object;
      }
      return;
    }

    if (this.hovered !== undefined) {
      this.emit('hoveroff', { type: 'hoveroff', event, object: this.hovered });
      this.hovered = undefined;
    }
  };

  private onPointerDown = (event: PointerEvent) => {
    if (!this.enabled) return;

    this.updatePointer(event);

    this.addPointer(event);

    this.selected = this.hitTest(event);

    if (event.pointerType === 'touch') {
      this.pointerdownTimestamp = new Date().getTime();
    } else {
      this.emit('select', {
        type: 'select',
        event,
        object: this.selected,
      });
    }

    if (!this.draggable || !this.selected) {
      return;
    }
    this.plane.setFromNormalAndCoplanarPoint(
      this.getCamera().getWorldDirection(this.plane.normal),
      this.setFromMatrixPosition(WORLD_POSITION, this.selected.matrixWorld),
    );

    if (
      this.raycaster.ray.intersectPlane(INTERSECTION, this.plane) &&
      this.selected.parent
    ) {
      mat4.invert(INVERSE_MATRIX, this.selected.parent.matrixWorld);
      vec3.sub(
        OFFSET,
        INTERSECTION,
        this.setFromMatrixPosition(WORLD_POSITION, this.selected.matrixWorld),
      );
    }
    this.emit('dragstart', { type: 'dragstart', event, object: this.selected });
  };

  private onPointerUp = (event: PointerEvent) => {
    if (!this.enabled) return;

    if (
      event.pointerType === 'touch' &&
      this.pointerdownTimestamp &&
      this.pointers.length === 1
    ) {
      if (
        new Date().getTime() - this.pointerdownTimestamp <
        LONG_PRESS_DURATION
      ) {
        this.emit('select', {
          type: 'select',
          event,
          object: this.selected,
        });
      }
    }
    this.removePointer(event);

    if (this.selected) {
      this.draggable &&
        this.emit('dragend', { type: 'dragend', event, object: this.selected });
      this.selected = undefined;
    }
  };

  private onPointerCancel = (event: PointerEvent) => {
    if (!this.enabled) return;

    this.removePointer(event);

    if (this.selected) {
      this.draggable &&
        this.emit('dragend', { type: 'dragend', event, object: this.selected });
      this.selected = undefined;
    }
  };

  private getPointer(event: Position) {
    const rect = this.domElement.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = (-(event.clientY - rect.top) / rect.height) * 2 + 1;
    return { x, y };
  }

  private updatePointer(event: PointerEvent) {
    const { x, y } = this.getPointer(event);
    POINTER[0] = x;
    POINTER[1] = y;
  }
}

interface BaseEvent {
  type: 'select' | 'dragstart' | 'drag' | 'dragend' | 'hoveron' | 'hoveroff';
  event: PointerEvent;
}

interface DragControlEvent extends BaseEvent {
  object: Object3D;
}

interface SelectEvent extends BaseEvent {
  object?: Object3D;
}

interface EventMap {
  dragstart: DragControlEvent;
  drag: DragControlEvent;
  dragend: DragControlEvent;
  hoveron: DragControlEvent;
  hoveroff: DragControlEvent;
  select: SelectEvent;
}
interface IDragControls {
  emit<K extends keyof EventMap>(type: K, data: EventMap[K]): boolean;
  addListener<K extends keyof EventMap>(
    type: K,
    listener: (e: EventMap[K]) => void,
  ): this;
  removeListener<K extends keyof EventMap>(
    type: K,
    listener: (e: EventMap[K]) => void,
  ): this;
}
