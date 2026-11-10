import * as echarts from "echarts/core";
import { BarChart, CandlestickChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import {
  BrushComponent,
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapContinuousComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

/** Modular ECharts build: only the declared chart kinds and the components the theme uses, canvas renderer only. */
echarts.use([
  LineChart,
  BarChart,
  ScatterChart,
  HeatmapChart,
  CandlestickChart,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  DataZoomInsideComponent,
  BrushComponent,
  VisualMapContinuousComponent,
  CanvasRenderer,
]);

export { echarts };
export type ChartInstance = ReturnType<typeof echarts.init>;
