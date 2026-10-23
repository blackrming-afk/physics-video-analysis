"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fitData, type FitModel, type FitSuccess } from "@/lib/curve-fitting";
import { formatSignificant } from "@/lib/number-format";

export type ComparisonPoint = {
  frame: number;
  time: number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  speed?: number;
  ax?: number;
  ay?: number;
};

export type ComparisonDataset = {
  id: string;
  label: string;
  createdAt: number;
  fps: number;
  points: ComparisonPoint[];
};

type ComparisonMetric = "xy" | "x" | "y" | "vx" | "vy" | "speed" | "ax" | "ay";

const METRICS: Array<{ id: ComparisonMetric; label: string; axisLabel: string; unit: string }> = [
  { id: "xy", label: "x-y", axisLabel: "y (m)", unit: "m" },
  { id: "x", label: "x-t", axisLabel: "x (m)", unit: "m" },
  { id: "y", label: "y-t", axisLabel: "y (m)", unit: "m" },
  { id: "vx", label: "Vx-t", axisLabel: "Vx (m/s)", unit: "m/s" },
  { id: "vy", label: "Vy-t", axisLabel: "Vy (m/s)", unit: "m/s" },
  { id: "speed", label: "speed-t", axisLabel: "Speed (m/s)", unit: "m/s" },
  { id: "ax", label: "ax-t", axisLabel: "Ax (m/s²)", unit: "m/s²" },
  { id: "ay", label: "ay-t", axisLabel: "Ay (m/s²)", unit: "m/s²" },
];

const MODEL_OPTIONS: Array<{ value: FitModel; label: string }> = [
  { value: "none", label: "不擬合" },
  { value: "linear", label: "線性" },
  { value: "quadratic", label: "二次" },
  { value: "exponential", label: "指數" },
  { value: "logarithmic", label: "對數" },
  { value: "power", label: "冪次" },
  { value: "inverse", label: "反比" },
  { value: "sine", label: "正弦" },
  { value: "cosine", label: "餘弦" },
];

const SERIES_COLORS = ["#22d3ee", "#c084fc", "#34d399", "#fbbf24", "#fb7185"];

function metricValue(point: ComparisonPoint, metric: Exclude<ComparisonMetric, "xy">) {
  const value = point[metric];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildFitInput(dataset: ComparisonDataset, metric: ComparisonMetric) {
  if (metric === "xy") {
    return dataset.points
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .map((point) => ({ t: point.x, value: point.y }));
  }
  return dataset.points
    .map((point) => ({ t: point.time, value: metricValue(point, metric) }))
    .filter((point): point is { t: number; value: number } => typeof point.value === "number");
}

function sampleFit(fit: FitSuccess, input: Array<{ t: number; value: number }>) {
  if (input.length < 2) return [];
  const start = Math.min(...input.map((point) => point.t));
  const end = Math.max(...input.map((point) => point.t));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const count = Math.max(32, Math.min(120, input.length * 8));
  return Array.from({ length: count }, (_, index) => {
    const t = count <= 1 ? start : start + ((end - start) * index) / (count - 1);
    return { t, fit: fit.evaluate(t) };
  });
}

export function ComparisonPanel({
  datasets,
  setDatasets,
}: {
  datasets: ComparisonDataset[];
  setDatasets: React.Dispatch<React.SetStateAction<ComparisonDataset[]>>;
}) {
  const [metric, setMetric] = useState<ComparisonMetric>("vy");
  const [fitModel, setFitModel] = useState<FitModel>("linear");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    setSelectedIds((current) => {
      const valid = current.filter((id) => datasets.some((dataset) => dataset.id === id));
      const missing = datasets.map((dataset) => dataset.id).filter((id) => !valid.includes(id));
      return [...valid, ...missing].slice(0, 5);
    });
  }, [datasets]);

  const selected = useMemo(
    () => datasets.filter((dataset) => selectedIds.includes(dataset.id)).slice(0, 5),
    [datasets, selectedIds],
  );

  const fitRows = useMemo(() => selected.map((dataset) => {
    const input = buildFitInput(dataset, metric);
    const result = fitModel === "none" ? null : fitData(fitModel, input);
    const curve = result && result.ok ? sampleFit(result, input) : [];
    return { dataset, input, result, curve };
  }), [selected, metric, fitModel]);

  const vySummary = useMemo(() => {
    if (metric !== "vy") return [];
    return selected.map((dataset) => {
      const input = buildFitInput(dataset, "vy");
      const result = fitData("linear", input);
      return {
        label: dataset.label,
        ay: result && result.ok ? result.coefficients.m : undefined,
      };
    }).filter((row) => typeof row.ay === "number");
  }, [metric, selected]);

  const averageAy = vySummary.length > 0
    ? vySummary.reduce((sum, row) => sum + (row.ay ?? 0), 0) / vySummary.length
    : undefined;
  const maxDifference = vySummary.length > 1
    ? Math.max(...vySummary.map((row) => row.ay as number)) - Math.min(...vySummary.map((row) => row.ay as number))
    : undefined;

  const metricInfo = METRICS.find((item) => item.id === metric) ?? METRICS[0];

  const renameDataset = (dataset: ComparisonDataset) => {
    const next = window.prompt("重新命名比較資料", dataset.label)?.trim();
    if (!next) return;
    setDatasets((items) => items.map((item) => item.id === dataset.id ? { ...item, label: next } : item));
  };

  const removeDataset = (dataset: ComparisonDataset) => {
    if (!window.confirm(`確定移除「${dataset.label}」這組比較資料嗎？`)) return;
    setDatasets((items) => items.filter((item) => item.id !== dataset.id));
  };

  if (datasets.length === 0) {
    return (
      <section className="mt-7 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-4 sm:p-5">
        <h3 className="text-base font-semibold text-cyan-100">多組資料比較</h3>
        <p className="mt-2 text-sm leading-6 text-slate-400">先完成一組影片分析並按「加入比較」，再載入下一支影片。可將不同質量、不同角度或不同條件的運動資料疊在同一張圖比較。</p>
      </section>
    );
  }

  return (
    <section className="mt-7 rounded-xl border border-cyan-300/25 bg-slate-950/25 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-cyan-100">多組資料比較</h3>
          <p className="mt-1 text-xs leading-5 text-slate-400">最多同時顯示 5 組；每組資料都以自己的第一個追蹤點作為 t = 0。</p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (datasets.length === 0) return;
            if (window.confirm("確定清除全部比較資料嗎？")) setDatasets([]);
          }}
          className="min-h-11 rounded-lg border border-rose-400/40 px-3 text-sm font-semibold text-rose-200 hover:bg-rose-400/10"
        >
          清除全部比較資料
        </button>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {datasets.map((dataset, index) => {
          const checked = selectedIds.includes(dataset.id);
          return (
            <div key={dataset.id} className={`rounded-lg border p-3 ${checked ? "border-cyan-300/50 bg-cyan-300/5" : "border-slate-700"}`}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    setSelectedIds((current) => {
                      if (!event.target.checked) return current.filter((id) => id !== dataset.id);
                      if (current.includes(dataset.id) || current.length >= 5) return current;
                      return [...current, dataset.id];
                    });
                  }}
                  className="h-5 w-5 accent-cyan-300"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-white">{dataset.label}</span>
                  <span className="text-xs text-slate-400">{dataset.points.length} 點 · {formatSignificant(dataset.fps)} fps · 系列 {index + 1}</span>
                </span>
              </label>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => renameDataset(dataset)} className="min-h-10 flex-1 rounded-md border border-slate-600 px-2 text-xs font-semibold text-slate-200 hover:bg-slate-800">重新命名</button>
                <button type="button" onClick={() => removeDataset(dataset)} className="min-h-10 flex-1 rounded-md border border-rose-400/30 px-2 text-xs font-semibold text-rose-200 hover:bg-rose-400/10">移除</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
          {METRICS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setMetric(item.id)}
              className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold ${metric === item.id ? "bg-slate-100 text-slate-950" : "bg-slate-800 text-slate-300"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="text-xs font-semibold text-slate-300">
          各組擬合
          <select
            value={fitModel}
            onChange={(event) => setFitModel(event.target.value as FitModel)}
            className="mt-1 block min-h-11 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-white outline-none focus:border-cyan-300 lg:w-44"
          >
            {MODEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>

      {selected.length === 0 ? (
        <p className="mt-5 rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-400">請至少勾選一組比較資料。</p>
      ) : (
        <>
          <div className="mt-5 h-[360px] min-w-0 rounded-lg border border-slate-700 bg-slate-950/20 p-2 sm:h-[430px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart margin={{ top: 18, right: 24, bottom: 28, left: 18 }}>
                <CartesianGrid stroke="#334155" strokeDasharray="4 4" />
                {metric === "xy" ? (
                  <>
                    <XAxis type="number" dataKey="x" name="x" unit=" m" stroke="#94a3b8" tick={{ fill: "#cbd5e1", fontSize: 12 }} label={{ value: "x (m)", position: "insideBottom", offset: -10, fill: "#cbd5e1", fontSize: 12 }} />
                    <YAxis type="number" dataKey="y" name="y" unit=" m" stroke="#94a3b8" tick={{ fill: "#cbd5e1", fontSize: 12 }} label={{ value: "y (m)", angle: -90, position: "insideLeft", fill: "#cbd5e1", fontSize: 12 }} />
                    <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #475569", borderRadius: 8, color: "#f8fafc" }} />
                    {selected.map((dataset, index) => (
                      <Scatter
                        key={dataset.id}
                        name={dataset.label}
                        data={dataset.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))}
                        fill={SERIES_COLORS[index % SERIES_COLORS.length]}
                        line={false}
                      />
                    ))}
                    {fitRows.map((row, index) => row.result && row.result.ok && row.curve.length > 0 ? (
                      <Line
                        key={`${row.dataset.id}-fit`}
                        name={`${row.dataset.label} 擬合`}
                        data={row.curve.map((point) => ({ x: point.t, y: point.fit }))}
                        dataKey="y"
                        type="monotone"
                        stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                        strokeWidth={2}
                        strokeDasharray="7 5"
                        dot={false}
                        isAnimationActive={false}
                      />
                    ) : null)}
                  </>
                ) : (
                  <>
                    <XAxis type="number" dataKey="time" name="t" unit=" s" stroke="#94a3b8" tick={{ fill: "#cbd5e1", fontSize: 12 }} label={{ value: "t (s)", position: "insideBottom", offset: -10, fill: "#cbd5e1", fontSize: 12 }} />
                    <YAxis type="number" dataKey="value" name={metricInfo.axisLabel} stroke="#94a3b8" tick={{ fill: "#cbd5e1", fontSize: 12 }} label={{ value: metricInfo.axisLabel, angle: -90, position: "insideLeft", fill: "#cbd5e1", fontSize: 12 }} />
                    <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #475569", borderRadius: 8, color: "#f8fafc" }} />
                    {selected.map((dataset, index) => {
                      const data = dataset.points
                        .map((point) => ({ time: point.time, value: metricValue(point, metric as Exclude<ComparisonMetric, "xy">) }))
                        .filter((point): point is { time: number; value: number } => typeof point.value === "number");
                      return (
                        <Line
                          key={dataset.id}
                          name={dataset.label}
                          data={data}
                          dataKey="value"
                          type="monotone"
                          stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          isAnimationActive={false}
                        />
                      );
                    })}
                    {fitRows.map((row, index) => row.result && row.result.ok && row.curve.length > 0 ? (
                      <Line
                        key={`${row.dataset.id}-fit`}
                        name={`${row.dataset.label} 擬合`}
                        data={row.curve.map((point) => ({ time: point.t, value: point.fit }))}
                        dataKey="value"
                        type="monotone"
                        stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                        strokeWidth={2}
                        strokeDasharray="7 5"
                        dot={false}
                        isAnimationActive={false}
                      />
                    ) : null)}
                  </>
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {selected.map((dataset, index) => (
              <span key={dataset.id} className="inline-flex items-center gap-2 rounded-full border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }} />
                {dataset.label}
              </span>
            ))}
          </div>

          {fitModel !== "none" && (
            <div className="mt-5 overflow-x-auto rounded-lg border border-slate-700">
              <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                <thead className="bg-slate-800 text-slate-300">
                  <tr>
                    <th className="px-3 py-2.5">資料</th>
                    <th className="px-3 py-2.5">方程式</th>
                    <th className="px-3 py-2.5">r</th>
                    <th className="px-3 py-2.5">R²</th>
                    <th className="px-3 py-2.5">RMSE</th>
                    <th className="px-3 py-2.5">n</th>
                  </tr>
                </thead>
                <tbody>
                  {fitRows.map(({ dataset, result }) => (
                    <tr key={dataset.id} className="border-t border-slate-700">
                      <td className="px-3 py-2.5 font-semibold text-white">{dataset.label}</td>
                      {result && result.ok ? (
                        <>
                          <td className="px-3 py-2.5 font-mono text-cyan-100">{result.equation.replaceAll("x", metric === "xy" ? "x" : "t")}</td>
                          <td className="px-3 py-2.5 font-mono text-slate-300">{formatSignificant(result.correlation)}</td>
                          <td className="px-3 py-2.5 font-mono text-slate-300">{formatSignificant(result.rSquared)}</td>
                          <td className="px-3 py-2.5 font-mono text-slate-300">{formatSignificant(result.rmse)}</td>
                          <td className="px-3 py-2.5 font-mono text-slate-300">{result.n}</td>
                        </>
                      ) : (
                        <td colSpan={5} className="px-3 py-2.5 text-amber-200">{result && !result.ok ? result.error : "未擬合"}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {metric === "vy" && vySummary.length > 0 && (
            <div className="mt-5 rounded-lg border border-amber-300/25 bg-amber-300/5 p-4">
              <h4 className="text-sm font-semibold text-amber-100">自由落體比較摘要（Vy-t 線性斜率）</h4>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {vySummary.map((row) => (
                  <div key={row.label} className="rounded-md border border-amber-300/15 px-3 py-2 text-sm">
                    <span className="text-slate-300">{row.label}</span>
                    <span className="float-right font-mono font-semibold text-amber-100">{formatSignificant(row.ay)} m/s²</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs leading-5 text-amber-100">
                平均 aᵧ = <span className="font-mono font-bold">{formatSignificant(averageAy)} m/s²</span>
                {maxDifference !== undefined && <> · 最大差異 = <span className="font-mono font-bold">{formatSignificant(maxDifference)} m/s²</span></>}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
