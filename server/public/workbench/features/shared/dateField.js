import { escapeHtml } from '../../core/formatters.js';

/**
 * 日期控件：可见部分是统一外框 + 固定格式日期；
 * 点击/聚焦时由透明的原生 input[type=date] 打开系统日期选择器。
 * 这样 iOS / Android 的外框、字号、文字格式一致，不再受原生日期控件最小宽度影响。
 */
export const dateFieldHtml = ({
  label, labelClass = '', inputAttr = '', value = '', min = '', max = '', ariaLabel = '',
} = {}) => {
  const text = String(value || '');
  const minAttr = min ? ` min="${escapeHtml(String(min))}"` : '';
  const maxAttr = max ? ` max="${escapeHtml(String(max))}"` : '';
  return `<label class="${escapeHtml(labelClass)}">
    <span>${escapeHtml(label)}</span>
    <span class="date-control">
      <span class="date-control__value" data-date-display>${escapeHtml(text)}</span>
      <input class="date-control__native" type="date" ${inputAttr} value="${escapeHtml(text)}"${minAttr}${maxAttr} aria-label="${escapeHtml(ariaLabel || label)}">
    </span>
  </label>`;
};

/** 把原生 input 的值同步到可见文字；返回 input 和 sync，供快捷范围等程序化赋值后调用。 */
export const bindDateControl = (root, inputSelector) => {
  const input = root?.querySelector(inputSelector) || null;
  const display = input?.closest('.date-control')?.querySelector('[data-date-display]') || null;
  const sync = () => {
    if (display) display.textContent = String(input?.value || '');
  };
  if (input) {
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    sync();
  }
  return { input, sync };
};
