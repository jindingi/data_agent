# ECharts 6.1.0 notes

The full browser build exposes `echarts`. Initialize only after a container exists and has a nonzero height. Use a size appropriate to your chosen layout, and ResizeObserver to call chart.resize(). When removing charts, call dispose(). A hidden chart may need resize after it becomes visible.

```js
const chart = echarts.init(container);
chart.setOption(options);
const observer = new ResizeObserver(() => chart.resize());
observer.observe(container);
// On teardown: observer.disconnect(); chart.dispose();
```

Use native controls with labels and keyboard support. Keep important chart information available as text or an appropriate data table when needed. Avoid encoding differences by color alone. Use the library's accessibility options where useful; this does not make all chart interactions keyboard accessible automatically.

ECharts events do not calculate business cross-filtering automatically. Maintain shared report state, filter the necessary embedded data, then update each affected chart and text with one consistent scope:

```js
chart.on('click', (event) => {
  state.category = event.name;
  renderSelection(); // your filtering and rendering, not a required framework API
});
```

`dataset` can share tabular data across series. `dataZoom` controls the visible range; do not silently treat visual zoom as a data filter for unrelated totals. `setOption` merges by default: when series disappear, deliberately replace the affected series or rebuild their data so stale categories do not remain.

Tooltip text from data must be escaped if returning HTML; `tooltip.renderMode: 'richText'` is useful when HTML is unnecessary. Avoid toolbox downloads, online maps, external image URLs and formatter code built with eval/Function. The application viewer blocks these operations. Use local embedded charts and explicit reset/empty-result behavior appropriate to the question.
