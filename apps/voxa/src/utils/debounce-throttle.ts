/**
 * 防抖
 */
export function debounce(fn: Function, wait: number) {
  let timer = -1;

  return function (immediate: boolean = false) {
    clearTimeout(timer);

    if (immediate) {
      fn();
    } else {
      timer = window.setTimeout(fn, wait);
    }
  };
}

/**
 * 节流
 */
export function throttle(fn: Function, interval: number) {
  let timer = -1;

  return function (immediate: boolean = false) {
    if (immediate) {
      clearTimeout(timer);
      timer = -1;
    } else if (timer > 0) {
      return;
    }

    fn();

    timer = window.setTimeout(() => {
      timer = -1;
    }, interval);
  };
}
