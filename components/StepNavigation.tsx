"use client";

export type WorkflowStep = "video" | "reticle" | "tracking" | "calibration" | "analysis";

type StepNavigationProps = {
  activeStep: WorkflowStep;
  completed: Partial<Record<WorkflowStep, boolean>>;
  onSelect: (step: WorkflowStep) => void;
};

const STEPS: Array<{ id: WorkflowStep; label: string }> = [
  { id: "video", label: "輸入影片" },
  { id: "reticle", label: "調整準星" },
  { id: "tracking", label: "追蹤軌跡" },
  { id: "calibration", label: "原點與比例尺" },
  { id: "analysis", label: "圖形與擬合" },
];

export function StepNavigation({ activeStep, completed, onSelect }: StepNavigationProps) {
  return (
    <nav aria-label="物理影片分析工作流程" className="sticky top-0 z-40 -mx-5 border-y border-slate-700/80 bg-[#07111e]/95 px-5 py-3 backdrop-blur sm:-mx-8 sm:px-8 lg:-mx-12 lg:px-12">
      <ol className="mx-auto grid max-w-[1560px] grid-cols-5 gap-2">
        {STEPS.map((step, index) => {
          const isActive = activeStep === step.id;
          const isComplete = completed[step.id];
          return (
            <li key={step.id}>
              <button
                type="button"
                aria-current={isActive ? "step" : undefined}
                onClick={() => onSelect(step.id)}
                className={`flex min-h-14 w-full flex-col items-center justify-center rounded-xl border px-2 text-center text-xs font-bold transition sm:min-h-16 sm:flex-row sm:gap-2 sm:text-sm ${isActive ? "border-cyan-200 bg-cyan-300 text-slate-950 shadow-lg shadow-cyan-950/30" : isComplete ? "border-emerald-300/35 bg-emerald-300/10 text-emerald-100 hover:bg-emerald-300/20" : "border-slate-700 bg-[#0c1b2c] text-slate-300 hover:border-slate-500 hover:bg-slate-800"}`}
              >
                <span className="font-mono text-[11px] sm:text-xs">{isActive ? `● ${index + 1}` : isComplete ? `✓ ${index + 1}` : index + 1}</span>
                <span className="leading-4">{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
