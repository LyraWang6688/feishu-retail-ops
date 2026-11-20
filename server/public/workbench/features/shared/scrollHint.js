/**
 * 横向滚动提示：内容超出时给右侧渐变遮罩；滚到最右自动隐藏。
 * 只用于局部滚动容器，不改变页面整体滚动。
 */
export function bindScrollHints(root, {
  wrapSelector = '[data-scroll-wrap]',
  areaSelector = '[data-scroll-area]',
} = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const controllers = [];
  for (const wrap of root.querySelectorAll(wrapSelector)) {
    const area = wrap.querySelector(areaSelector);
    if (!area) continue;
    const update = () => {
      const max = Math.max(0, area.scrollWidth - area.clientWidth);
      const atEnd = max <= 1 || area.scrollLeft >= max - 1;
      wrap.classList.toggle('has-overflow', max > 1);
      wrap.classList.toggle('at-end', atEnd);
    };
    area.addEventListener('scroll', update, { passive: true });
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(update);
      observer.observe(area);
      controllers.push({ wrap, area, update, observer });
    } else {
      controllers.push({ wrap, area, update });
    }
    update();
  }
  return controllers;
}
