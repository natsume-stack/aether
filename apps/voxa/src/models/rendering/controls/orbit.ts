import EventEmitter from 'events';
import { mat4, quat, vec2, vec3 } from 'gl-matrix';
import type { Camera } from '../camera/base';
import { Spherical } from '../math/spherical';
import { isFunction } from '../utils/function';

/**
 *
 */
const KEYS = {
  LEFT: 'ArrowLeft',
  UP: 'ArrowUp',
  RIGHT: 'ArrowRight',
  BOTTOM: 'ArrowDown',
};

export const enum MOUSE {
  ROTATE,
  DOLLY,
  PAN,
}

export const enum MOUSE_BUTTONS {
  LEFT,
  MIDDLE,
  RIGHT,
}

const enum TOUCH {
  ROTATE,
  DOLLY_PAN,
}

const enum TOUCHES {
  ONE = TOUCH.ROTATE,
  TWO = TOUCH.DOLLY_PAN,
}

export const CONTROLS_STATE = {
  NONE: -1,
  ROTATE: 0,
  DOLLY: 1,
  PAN: 2,
  TOUCH_ROTATE: 3,
  TOUCH_PAN: 4,
  TOUCH_DOLLY_PAN: 5,
  TOUCH_DOLLY_ROTATE: 6,
};

const _startEvent = { type: 'start' };
const _endEvent = { type: 'end' };
const OFFSET = vec3.create();

/**
 * This set of controls performs orbiting, dollying (zooming), and panning.
Unlike TrackballControls, it maintains the "up" direction object.up (+Y by default).

   Orbit - left mouse / touch: one-finger move
   Zoom - middle mouse, or mousewheel / touch: two-finger spread or squish
   Pan - right mouse, or left mouse + ctrl/meta/shiftKey, or arrow keys / touch: two-finger move
 */
export class OrbitControls extends EventEmitter {
  /**
   * Set to false to disable this control
   */
  public enabled = true;

  /**
   *  "target" sets the location of focus, where the object orbits around
   * */
  public target = vec3.create();

  /** For reset */
  public target0: vec3;
  public position0: vec3;

  /**
   * How far you can dolly in and out ( PerspectiveCamera only )
   */
  public minDistance = 0;
  public maxDistance = Infinity;

  public minZoom = 0;
  public maxZoom = Infinity; // How far you can orbit vertically, upper and lower limits.

  /**
   * How far you can orbit vertically, upper and lower limits.
   * Range is 0 to Math.PI radians.
   */
  public minPolarAngle = 0; // radians
  public maxPolarAngle = Math.PI; // radians

  /**
   * How far you can orbit horizontally, upper and lower limits.
   * If set, the interval [ min, max ] must be a sub-interval of [ - 2 PI, 2 PI ], with ( max - min < 2 PI )
   */
  public minAzimuthAngle = -Infinity; // radians
  public maxAzimuthAngle = Infinity; // radians

  // Set to true to enable damping (inertia)
  // If damping is enabled, you must call controls.update() in your animation loop
  public enableDamping = false;
  public dampingFactor = 0.05;

  // This option actually enables dollying in and out; left as "zoom" for backwards compatibility.
  // Set to false to disable zooming
  public enableZoom = true;
  public zoomSpeed = 1.0;

  // Set to false to disable rotating
  public enableRotate = true;
  public rotateSpeed = 1.0;

  // Set to false to disable panning
  public enablePan = true;
  public panSpeed = 1.0;
  public screenSpacePanning = true; // if false, pan orthogonal to world-space direction camera.up
  public keyPanSpeed = 7.0; // pixels moved per arrow key push

  /**
   * The target DOM element for key events
   */
  private _domElementKeyEvents?: Element;

  public state = CONTROLS_STATE.NONE;

  private EPS = 0.000001;

  // current position in spherical coordinates
  private spherical = new Spherical();
  private sphericalDelta = new Spherical();

  private scale = 1;

  private panOffset = vec3.create();
  private zoomChanged = false;

  private rotateStart = vec2.create();
  private rotateEnd = vec2.create();
  private rotateDelta = vec2.create();

  private panStart = vec2.create();
  private panEnd = vec2.create();
  private panDelta = vec2.create();

  private dollyStart = vec2.create();
  private dollyEnd = vec2.create();
  private dollyDelta = vec2.create();

  private pointers: PointerEvent[] = [];
  private pointerPositions: Record<string, vec2> = {};

  private lastPosition = vec3.create();
  private lastQuaternion = quat.create();

  private quat = quat.create();
  private quatInverse = quat.create();

  private getCamera: () => Camera;

  constructor(camera: Camera | (() => Camera), public domElement: HTMLElement) {
    super();

    this.getCamera = isFunction(camera) ? camera : () => camera;
    this.domElement.style.touchAction = 'none'; // disable touch scroll

    // for reset
    this.target0 = vec3.clone(this.getCamera().target);
    this.position0 = vec3.clone(this.getCamera().position);

    this.domElement.addEventListener('contextmenu', this.onContextMenu);

    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointercancel', this.onPointerCancel);
    this.domElement.addEventListener('wheel', this.onMouseWheel, {
      passive: false,
    });

    quat.rotationTo(this.quat, this.getCamera().up, vec3.fromValues(0, 1, 0));
    quat.invert(this.quatInverse, this.quat);

    // force an update at start
    this.update();
  }

  public getPolarAngle() {
    return this.spherical.phi;
  }

  public getAzimuthalAngle() {
    return this.spherical.theta;
  }

  public getDistance() {
    return vec3.dist(this.getCamera().position, this.target);
  }

  public listenToKeyEvents(domElement: Element) {
    domElement.addEventListener('keydown', this.onKeyDown);
    this._domElementKeyEvents = domElement;
  }

  public saveState() {
    vec3.copy(this.target0, this.target);
    vec3.copy(this.position0, this.getCamera().position);
  }

  public reset() {
    const camera = this.getCamera();
    vec3.copy(this.target0, camera.target);
    vec3.copy(this.position0, camera.position);
    vec3.copy(this.target, this.target0);
    vec3.copy(this.lastPosition, this.position0);

    camera.zoom = 1;
    camera.updateProjectionMatrix();

    this.state = CONTROLS_STATE.NONE;
  }

  public update() {
    const twoPI = 2 * Math.PI;
    const camera = this.getCamera();
    const { quaternion, position } = camera;
    vec3.sub(OFFSET, position, this.target);

    // rotate offset to "y-axis-is-up" space
    vec3.transformQuat(OFFSET, OFFSET, this.quat);

    // angle from z-axis around y-axis
    this.spherical.setFromVector3(OFFSET);

    if (this.enableDamping) {
      this.spherical.theta += this.sphericalDelta.theta * this.dampingFactor;
      this.spherical.phi += this.sphericalDelta.phi * this.dampingFactor;
    } else {
      this.spherical.theta += this.sphericalDelta.theta;
      this.spherical.phi += this.sphericalDelta.phi;
    }

    // restrict theta to be between desired limits

    let min = this.minAzimuthAngle;
    let max = this.maxAzimuthAngle;

    if (isFinite(min) && isFinite(max)) {
      if (min < -Math.PI) min += twoPI;
      else if (min > Math.PI) min -= twoPI;

      if (max < -Math.PI) max += twoPI;
      else if (max > Math.PI) max -= twoPI;

      if (min <= max) {
        this.spherical.theta = Math.max(
          min,
          Math.min(max, this.spherical.theta),
        );
      } else {
        this.spherical.theta =
          this.spherical.theta > (min + max) / 2
            ? Math.max(min, this.spherical.theta)
            : Math.min(max, this.spherical.theta);
      }
    }

    // restrict phi to be between desired limits
    this.spherical.phi = Math.max(
      this.minPolarAngle,
      Math.min(this.maxPolarAngle, this.spherical.phi),
    );

    this.spherical.makeSafe();

    this.spherical.radius *= this.scale;

    // restrict radius to be between desired limits
    this.spherical.radius = Math.max(
      this.minDistance,
      Math.min(this.maxDistance, this.spherical.radius),
    );

    // move target to panned location

    if (this.enableDamping === true) {
      vec3.scaleAndAdd(
        this.target,
        this.target,
        this.panOffset,
        this.dampingFactor,
      );
    } else {
      vec3.add(this.target, this.target, this.panOffset);
    }

    this.spherical.applyToVec3(OFFSET);

    // rotate offset back to "camera-up-vector-is-up" space
    vec3.transformQuat(OFFSET, OFFSET, this.quatInverse);

    vec3.add(position, this.target, OFFSET);
    camera.lookAt(this.target);
    if (this.enableDamping === true) {
      this.sphericalDelta.theta *= 1 - this.dampingFactor;
      this.sphericalDelta.phi *= 1 - this.dampingFactor;
      vec3.scale(this.panOffset, this.panOffset, 1 - this.dampingFactor);
    } else {
      this.sphericalDelta.set(0, 0, 0);

      vec3.set(this.panOffset, 0, 0, 0);
    }

    this.scale = 1;

    // update condition is:
    // min(camera displacement, camera rotation in radians)^2 > EPS
    // using small-angle approximation cos(x/2) = 1 - x^2 / 8

    if (
      this.zoomChanged ||
      vec3.sqrDist(this.lastPosition, position) > this.EPS ||
      8 * (1 - quat.dot(this.lastQuaternion, quaternion)) > this.EPS
    ) {
      vec3.copy(this.lastPosition, position);
      quat.copy(this.lastQuaternion, quaternion);
      this.zoomChanged = false;

      return true;
    }

    return false;
  }

  private dispose() {
    this.domElement.removeEventListener('contextmenu', this.onContextMenu);

    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointercancel', this.onPointerCancel);
    this.domElement.removeEventListener('wheel', this.onMouseWheel);

    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);

    if (this._domElementKeyEvents !== undefined) {
      this._domElementKeyEvents.removeEventListener('keydown', this.onKeyDown);
    }

    //this.dispatchEvent( { type: 'dispose' } ); // should this be added here?
  }

  private getZoomScale() {
    return Math.pow(0.95, this.zoomSpeed);
  }

  /**
   * 在球形轨道上围绕target左转
   */
  public rotateLeft(angle: number) {
    this.sphericalDelta.theta -= angle;
  }

  private rotateUp(angle: number) {
    this.sphericalDelta.phi -= angle;
  }

  private panLeft(distance: number, objectMatrix: mat4) {
    vec3.scaleAndAdd(
      this.panOffset,
      this.panOffset,
      [objectMatrix[0], objectMatrix[1], objectMatrix[2]],
      -distance,
    );
  }

  private panUp = (() => {
    const v = vec3.create();

    return (distance: number, objectMatrix: mat4) => {
      if (this.screenSpacePanning === true) {
        vec3.set(v, objectMatrix[4], objectMatrix[5], objectMatrix[6]);
      } else {
        vec3.cross(v, this.getCamera().up, [
          objectMatrix[0],
          objectMatrix[1],
          objectMatrix[2],
        ]);
      }

      vec3.scaleAndAdd(this.panOffset, this.panOffset, v, distance);
    };
  })();

  // deltaX and deltaY are in pixels; right and down are positive
  private pan = (() => {
    const offset = vec3.create();

    return (deltaX: number, deltaY: number) => {
      const element = this.domElement;

      const camera = this.getCamera();
      if (camera.isPerspectiveCamera()) {
        const position = camera.position;
        vec3.sub(offset, position, this.target);
        let targetDistance = vec3.len(offset);

        // half of the fov is center to top of screen
        targetDistance *= Math.tan(camera.fov / 2);

        // we use only clientHeight here so aspect ratio does not distort speed
        this.panLeft(
          (2 * deltaX * targetDistance) / element.clientHeight,
          camera.matrix,
        );
        this.panUp(
          (2 * deltaY * targetDistance) / element.clientHeight,
          camera.matrix,
        );
      } else if (camera.isOrthographicCamera()) {
        this.panLeft(
          (deltaX * camera.frustumHeight * camera.aspect) /
            camera.zoom /
            element.clientWidth,
          camera.matrix,
        );
        this.panUp(
          (deltaY * camera.frustumHeight) / camera.zoom / element.clientHeight,
          camera.matrix,
        );
      } else {
        // camera neither orthographic nor perspective
        console.warn(
          'WARNING: Unknown camera type encountered - pan disabled.',
        );
        this.enablePan = false;
      }
    };
  })();

  /**
   * 缩小界面（拉远摄像机）
   * @param dollyScale
   */
  private dollyOut(dollyScale: number) {
    const camera = this.getCamera();
    this.scale /= dollyScale;
    camera.zoom = Math.max(
      this.minZoom,
      Math.min(this.maxZoom, camera.zoom * dollyScale),
    );
    camera.updateProjectionMatrix();
    if (camera.isOrthographicCamera()) {
      this.zoomChanged = true;
    }
  }

  /**
   * 放大界面（推进摄像机）
   * @param dollyScale
   */
  private dollyIn(dollyScale: number) {
    const camera = this.getCamera();
    this.scale *= dollyScale;
    camera.zoom = Math.max(
      this.minZoom,
      Math.min(this.maxZoom, camera.zoom / dollyScale),
    );
    camera.updateProjectionMatrix();
    if (camera.isOrthographicCamera()) {
      this.zoomChanged = true;
    }
  }

  //
  // event callbacks - update the object state
  //

  private handleMouseDownRotate(event: { clientX: any; clientY: any }) {
    vec2.set(this.rotateStart, event.clientX, event.clientY);
  }

  private handleMouseDownDolly(event: { clientX: any; clientY: any }) {
    vec2.set(this.dollyStart, event.clientX, event.clientY);
  }

  private handleMouseDownPan(event: { clientX: any; clientY: any }) {
    vec2.set(this.panStart, event.clientX, event.clientY);
  }

  private handleMouseMoveRotate(event: { clientX: any; clientY: any }) {
    vec2.set(this.rotateEnd, event.clientX, event.clientY);

    vec2.sub(this.rotateDelta, this.rotateEnd, this.rotateStart);
    vec2.scale(this.rotateDelta, this.rotateDelta, this.rotateSpeed);

    const element = this.domElement;

    this.rotateLeft((2 * Math.PI * this.rotateDelta[0]) / element.clientHeight); // yes, height

    this.rotateUp((2 * Math.PI * this.rotateDelta[1]) / element.clientHeight);

    vec2.copy(this.rotateStart, this.rotateEnd);

    this.update();
  }

  private handleMouseMoveDolly(event: { clientX: any; clientY: any }) {
    vec2.set(this.dollyEnd, event.clientX, event.clientY);

    vec2.sub(this.dollyDelta, this.dollyEnd, this.dollyStart);

    if (this.dollyDelta[1] > 0) {
      this.dollyOut(this.getZoomScale());
    } else if (this.dollyDelta[1] < 0) {
      this.dollyIn(this.getZoomScale());
    }

    vec2.copy(this.dollyStart, this.dollyEnd);

    this.update();
  }

  private handleMouseMovePan(event: { clientX: any; clientY: any }) {
    vec2.set(this.panEnd, event.clientX, event.clientY);

    vec2.sub(this.panDelta, this.panEnd, this.panStart);
    vec2.scale(this.panDelta, this.panDelta, this.panSpeed);

    this.pan(this.panDelta[0], this.panDelta[1]);

    vec2.copy(this.panStart, this.panEnd);

    this.update();
  }

  private handleMouseWheel(event: WheelEvent) {
    if (event.deltaY < 0) {
      this.dollyIn(this.getZoomScale());
    } else if (event.deltaY > 0) {
      this.dollyOut(this.getZoomScale());
    }

    this.update();
  }

  private handleKeyDown(event: { code: any; preventDefault: () => void }) {
    let needsUpdate = false;

    switch (event.code) {
      case KEYS.UP:
        this.pan(0, this.keyPanSpeed);
        needsUpdate = true;
        break;

      case KEYS.BOTTOM:
        this.pan(0, -this.keyPanSpeed);
        needsUpdate = true;
        break;

      case KEYS.LEFT:
        this.pan(this.keyPanSpeed, 0);
        needsUpdate = true;
        break;

      case KEYS.RIGHT:
        this.pan(-this.keyPanSpeed, 0);
        needsUpdate = true;
        break;
    }

    if (needsUpdate) {
      // prevent the browser from scrolling on cursor keys
      event.preventDefault();

      this.update();
    }
  }

  private handleTouchStartRotate() {
    if (this.pointers.length === 1) {
      vec2.set(
        this.rotateStart,
        this.pointers[0].pageX,
        this.pointers[0].pageY,
      );
      vec2.set(
        this.rotateStart,
        this.pointers[0].pageX,
        this.pointers[0].pageY,
      );
    } else {
      const x = 0.5 * (this.pointers[0].pageX + this.pointers[1].pageX);
      const y = 0.5 * (this.pointers[0].pageY + this.pointers[1].pageY);

      vec2.set(this.rotateStart, x, y);
    }
  }

  private handleTouchStartPan() {
    if (this.pointers.length === 1) {
      vec2.set(this.panStart, this.pointers[0].pageX, this.pointers[0].pageY);
    } else {
      const x = 0.5 * (this.pointers[0].pageX + this.pointers[1].pageX);
      const y = 0.5 * (this.pointers[0].pageY + this.pointers[1].pageY);

      vec2.set(this.panStart, x, y);
    }
  }

  private handleTouchStartDolly() {
    const dx = this.pointers[0].pageX - this.pointers[1].pageX;
    const dy = this.pointers[0].pageY - this.pointers[1].pageY;

    const distance = Math.sqrt(dx * dx + dy * dy);

    vec2.set(this.dollyStart, 0, distance);
  }

  private handleTouchStartDollyPan() {
    if (this.enableZoom) this.handleTouchStartDolly();

    if (this.enablePan) this.handleTouchStartPan();
  }

  private handleTouchStartDollyRotate() {
    if (this.enableZoom) this.handleTouchStartDolly();

    if (this.enableRotate) this.handleTouchStartRotate();
  }

  private handleTouchMoveRotate(event: PointerEvent) {
    if (this.pointers.length == 1) {
      vec2.set(this.rotateEnd, event.pageX, event.pageY);
    } else {
      const position = this.getSecondPointerPosition(event);

      const x = 0.5 * (event.pageX + position[0]);
      const y = 0.5 * (event.pageY + position[1]);

      vec2.set(this.rotateEnd, x, y);
    }

    vec2.sub(this.rotateDelta, this.rotateEnd, this.rotateStart);
    vec2.scale(this.rotateDelta, this.rotateDelta, this.rotateSpeed);

    const element = this.domElement;

    this.rotateLeft((2 * Math.PI * this.rotateDelta[0]) / element.clientHeight); // yes, height

    this.rotateUp((2 * Math.PI * this.rotateDelta[1]) / element.clientHeight);

    vec2.copy(this.rotateStart, this.rotateEnd);
  }

  private handleTouchMovePan(event: PointerEvent) {
    if (this.pointers.length === 1) {
      vec2.set(this.panEnd, event.pageX, event.pageY);
    } else {
      const position = this.getSecondPointerPosition(event);

      const x = 0.5 * (event.pageX + position[0]);
      const y = 0.5 * (event.pageY + position[1]);

      vec2.set(this.panEnd, x, y);
    }

    vec2.sub(this.panDelta, this.panEnd, this.panStart);
    vec2.scale(this.panDelta, this.panDelta, this.panSpeed);

    this.pan(this.panDelta[0], this.panDelta[1]);

    vec2.copy(this.panStart, this.panEnd);
  }

  private handleTouchMoveDolly(event: PointerEvent) {
    const position = this.getSecondPointerPosition(event);

    const dx = event.pageX - position[0];
    const dy = event.pageY - position[1];

    const distance = Math.sqrt(dx * dx + dy * dy);

    vec2.set(this.dollyEnd, 0, distance);

    vec2.set(
      this.dollyDelta,
      0,
      Math.pow(this.dollyEnd[1] / this.dollyStart[1], this.zoomSpeed),
    );

    this.dollyOut(this.dollyDelta[1]);

    vec2.copy(this.dollyStart, this.dollyEnd);
  }

  private handleTouchMoveDollyPan(event: any) {
    if (this.enableZoom) this.handleTouchMoveDolly(event);

    if (this.enablePan) this.handleTouchMovePan(event);
  }

  private handleTouchMoveDollyRotate(event: any) {
    if (this.enableZoom) this.handleTouchMoveDolly(event);

    if (this.enableRotate) this.handleTouchMoveRotate(event);
  }

  //
  // event handlers - FSM: listen for events and reset state
  //

  private onPointerDown = (event: PointerEvent) => {
    if (this.enabled === false) return;

    if (this.pointers.length === 0) {
      this.domElement.setPointerCapture(event.pointerId);

      this.domElement.addEventListener('pointermove', this.onPointerMove);
      this.domElement.addEventListener('pointerup', this.onPointerUp);
    }

    //

    this.addPointer(event);

    if (event.pointerType === 'touch') {
      this.onTouchStart(event);
    } else {
      this.onMouseDown(event);
    }
  };

  private onPointerMove = (event: { pointerType: string }) => {
    if (this.enabled === false) return;

    if (event.pointerType === 'touch') {
      this.onTouchMove(event);
    } else {
      this.onMouseMove(event);
    }
  };

  private onPointerUp = (event: { pointerId: number }) => {
    this.removePointer(event);

    if (this.pointers.length === 0) {
      this.domElement.releasePointerCapture(event.pointerId);

      this.domElement.removeEventListener('pointermove', this.onPointerMove);
      this.domElement.removeEventListener('pointerup', this.onPointerUp);
    }

    this.state = CONTROLS_STATE.NONE;
  };

  private onPointerCancel = (event: { pointerId: string | number }) => {
    this.removePointer(event);
  };

  private mouseButtonToAction: Partial<Record<MOUSE_BUTTONS, MOUSE>> = {
    [MOUSE_BUTTONS.MIDDLE]: MOUSE.PAN,
    [MOUSE_BUTTONS.RIGHT]: MOUSE.ROTATE,
  };

  /**
   * 绑定鼠标按键对应的操作
   * @param button 鼠标按键
   * @param action 鼠标操作
   */
  public bindMouseButtonAction(button: MOUSE_BUTTONS, action: MOUSE) {
    this.mouseButtonToAction[button] = action;
  }

  /**
   * 解绑鼠标按键对应的操作
   * @param button 鼠标按键
   */
  public unbindMouseButtonAction(button: MOUSE_BUTTONS) {
    this.mouseButtonToAction[button] = undefined;
  }

  private onMouseDown = (event: PointerEvent) => {
    const mouseAction = this.mouseButtonToAction[event.button];

    switch (mouseAction) {
      case MOUSE.DOLLY:
        if (this.enableZoom === false) return;

        this.handleMouseDownDolly(event);

        this.state = CONTROLS_STATE.DOLLY;

        break;

      case MOUSE.ROTATE:
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          if (this.enablePan === false) return;

          this.handleMouseDownPan(event);

          this.state = CONTROLS_STATE.PAN;
        } else {
          if (this.enableRotate === false) return;

          this.handleMouseDownRotate(event);

          this.state = CONTROLS_STATE.ROTATE;
        }

        break;

      case MOUSE.PAN:
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          if (this.enableRotate === false) return;

          this.handleMouseDownRotate(event);

          this.state = CONTROLS_STATE.ROTATE;
        } else {
          if (this.enablePan === false) return;

          this.handleMouseDownPan(event);

          this.state = CONTROLS_STATE.PAN;
        }

        break;

      default:
        this.state = CONTROLS_STATE.NONE;
    }
  };

  private onMouseMove = (event: any) => {
    if (this.enabled === false) return;
    switch (this.state) {
      case CONTROLS_STATE.ROTATE:
        if (this.enableRotate === false) return;

        this.handleMouseMoveRotate(event);

        break;

      case CONTROLS_STATE.DOLLY:
        if (this.enableZoom === false) return;

        this.handleMouseMoveDolly(event);

        break;

      case CONTROLS_STATE.PAN:
        if (this.enablePan === false) return;

        this.handleMouseMovePan(event);

        break;
    }
  };

  private onMouseWheel = (event: WheelEvent) => {
    if (
      this.enabled === false ||
      this.enableZoom === false ||
      this.state !== CONTROLS_STATE.NONE
    )
      return;

    event.preventDefault();

    this.handleMouseWheel(event);
  };

  private onKeyDown = (event: any) => {
    if (this.enabled === false || this.enablePan === false) return;

    this.handleKeyDown(event);
  };

  private onTouchStart = (event: any) => {
    this.trackPointer(event);

    switch (this.pointers.length) {
      case 1:
        if (this.enableRotate === false) return;

        this.handleTouchStartRotate();

        this.state = CONTROLS_STATE.TOUCH_ROTATE;

        break;

      case 2:
        if (this.enableZoom === false && this.enablePan === false) return;

        this.handleTouchStartDollyPan();

        this.state = CONTROLS_STATE.TOUCH_DOLLY_PAN;

        break;

      default:
        this.state = CONTROLS_STATE.NONE;
    }
  };

  private onTouchMove = (event: any) => {
    this.trackPointer(event);

    switch (this.state) {
      case CONTROLS_STATE.TOUCH_ROTATE:
        if (this.enableRotate === false) return;

        this.handleTouchMoveRotate(event);

        this.update();

        break;

      case CONTROLS_STATE.TOUCH_PAN:
        if (this.enablePan === false) return;

        this.handleTouchMovePan(event);

        this.update();

        break;

      case CONTROLS_STATE.TOUCH_DOLLY_PAN:
        if (this.enableZoom === false && this.enablePan === false) return;

        this.handleTouchMoveDollyPan(event);

        this.update();

        break;

      case CONTROLS_STATE.TOUCH_DOLLY_ROTATE:
        if (this.enableZoom === false && this.enableRotate === false) return;

        this.handleTouchMoveDollyRotate(event);

        this.update();

        break;

      default:
        this.state = CONTROLS_STATE.NONE;
    }
  };

  private onContextMenu = (event: { preventDefault: () => void }) => {
    if (this.enabled === false) return;

    event.preventDefault();
  };

  private addPointer(event: PointerEvent) {
    this.pointers.push(event);
  }

  private removePointer(event: { pointerId: string | number }) {
    delete this.pointerPositions[event.pointerId];

    for (let i = 0; i < this.pointers.length; i++) {
      if (this.pointers[i].pointerId == event.pointerId) {
        this.pointers.splice(i, 1);
        return;
      }
    }
  }

  private trackPointer(event: PointerEvent) {
    let position = this.pointerPositions[event.pointerId];

    if (position === undefined) {
      position = vec2.create();
      this.pointerPositions[event.pointerId] = position;
    }

    vec2.set(position, event.pageX, event.pageY);
  }

  private getSecondPointerPosition(event: { pointerId: any }) {
    const pointer =
      event.pointerId === this.pointers[0].pointerId
        ? this.pointers[1]
        : this.pointers[0];

    return this.pointerPositions[pointer.pointerId];
  }
}
