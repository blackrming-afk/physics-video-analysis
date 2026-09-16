export type FitPoint = { t: number; value: number };

export type FitModel = "none" | "linear" | "quadratic" | "exponential" | "logarithmic" | "power" | "inverse" | "sine" | "cosine";
type ActiveFitModel = Exclude<FitModel, "none">;

export type FitSuccess = {
  ok: true;
  model: ActiveFitModel;
  coefficients: Record<string, number>;
  equation: string;
  rSquared?: number;
  correlation?: number;
  rmse: number;
  n: number;
  evaluate: (time: number) => number;
};

export type LinearFit = FitSuccess & { model: "linear"; m: number; b: number };
export type QuadraticFit = FitSuccess & { model: "quadratic"; a: number; b: number; c: number };
export type FitFailure = { ok: false; error: string };
export type FitResult = FitSuccess | FitFailure;

const RELATIVE_TOLERANCE = 1e-12;

function hasFiniteValues(points: FitPoint[]) {
  return points.every((point) => Number.isFinite(point.t) && Number.isFinite(point.value));
}

function formatCoefficient(value: number) {
  return Number(value.toPrecision(7)).toString();
}

function signedTerm(value: number, suffix: string) {
  return `${value >= 0 ? "+" : "−"} ${formatCoefficient(Math.abs(value))}${suffix}`;
}

function calculateStatistics(points: FitPoint[], evaluate: (time: number) => number) {
  const predictions = points.map((point) => evaluate(point.t));
  if (predictions.some((value) => !Number.isFinite(value))) return undefined;
  const n = points.length;
  const observedMean = points.reduce((sum, point) => sum + point.value, 0) / n;
  const predictedMean = predictions.reduce((sum, value) => sum + value, 0) / n;
  const residualSum = points.reduce((sum, point, index) => sum + (point.value - predictions[index]) ** 2, 0);
  const observedVariance = points.reduce((sum, point) => sum + (point.value - observedMean) ** 2, 0);
  const predictedVariance = predictions.reduce((sum, value) => sum + (value - predictedMean) ** 2, 0);
  const covariance = points.reduce((sum, point, index) => sum + (point.value - observedMean) * (predictions[index] - predictedMean), 0);
  const denominator = Math.sqrt(observedVariance * predictedVariance);
  return {
    rSquared: observedVariance <= Number.EPSILON ? undefined : 1 - residualSum / observedVariance,
    correlation: denominator <= Number.EPSILON ? undefined : covariance / denominator,
    rmse: Math.sqrt(residualSum / n),
  };
}

function createFit(model: ActiveFitModel, points: FitPoint[], coefficients: Record<string, number>, equation: string, evaluate: (time: number) => number): FitSuccess | FitFailure {
  if (Object.values(coefficients).some((value) => !Number.isFinite(value))) return { ok: false, error: "擬合無法可靠求解。" };
  const statistics = calculateStatistics(points, evaluate);
  if (!statistics || !Number.isFinite(statistics.rmse)) return { ok: false, error: "擬合產生無效數值。" };
  return {
    ok: true,
    model,
    coefficients,
    equation,
    rSquared: statistics.rSquared !== undefined && Number.isFinite(statistics.rSquared) ? statistics.rSquared : undefined,
    correlation: statistics.correlation !== undefined && Number.isFinite(statistics.correlation) ? statistics.correlation : undefined,
    rmse: statistics.rmse,
    n: points.length,
    evaluate,
  };
}

function solveThreeByThree(matrix: number[][], vector: number[]) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  const scale = Math.max(...matrix.flat().map(Math.abs), 1);
  const threshold = scale * RELATIVE_TOLERANCE;
  for (let column = 0; column < 3; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < 3; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) pivotRow = row;
    if (Math.abs(augmented[pivotRow][column]) <= threshold) return undefined;
    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];
    const pivot = augmented[column][column];
    for (let entry = column; entry < 4; entry += 1) augmented[column][entry] /= pivot;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry < 4; entry += 1) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  const solution = augmented.map((row) => row[3]);
  return solution.every(Number.isFinite) ? solution : undefined;
}

export function fitLinear(points: FitPoint[]): LinearFit | FitFailure {
  if (points.length < 2) return { ok: false, error: "線性擬合至少需要 2 個有效點。" };
  if (!hasFiniteValues(points)) return { ok: false, error: "擬合資料包含無效數值。" };
  const count = points.length;
  const sumT = points.reduce((sum, point) => sum + point.t, 0);
  const sumY = points.reduce((sum, point) => sum + point.value, 0);
  const sumTT = points.reduce((sum, point) => sum + point.t * point.t, 0);
  const sumTY = points.reduce((sum, point) => sum + point.t * point.value, 0);
  const denominator = count * sumTT - sumT * sumT;
  const scale = Math.max(Math.abs(count * sumTT), Math.abs(sumT * sumT), 1);
  if (Math.abs(denominator) <= scale * RELATIVE_TOLERANCE) return { ok: false, error: "x 資料接近重複，無法可靠進行線性擬合。" };
  const m = (count * sumTY - sumT * sumY) / denominator;
  const b = (sumY - m * sumT) / count;
  const evaluate = (time: number) => m * time + b;
  const result = createFit("linear", points, { m, b }, `y = ${formatCoefficient(m)}x ${signedTerm(b, "")}`, evaluate);
  return result.ok ? { ...result, model: "linear", m, b } : result;
}

export function fitQuadratic(points: FitPoint[]): QuadraticFit | FitFailure {
  if (points.length < 3) return { ok: false, error: "二次擬合至少需要 3 個有效點。" };
  if (!hasFiniteValues(points)) return { ok: false, error: "擬合資料包含無效數值。" };
  const sum = (selector: (point: FitPoint) => number) => points.reduce((total, point) => total + selector(point), 0);
  const s0 = points.length;
  const s1 = sum((point) => point.t);
  const s2 = sum((point) => point.t ** 2);
  const s3 = sum((point) => point.t ** 3);
  const s4 = sum((point) => point.t ** 4);
  const sy = sum((point) => point.value);
  const sty = sum((point) => point.t * point.value);
  const stty = sum((point) => point.t ** 2 * point.value);
  const solution = solveThreeByThree([[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]], [sy, sty, stty]);
  if (!solution) return { ok: false, error: "資料矩陣接近奇異，無法可靠進行二次擬合。" };
  const [c, b, a] = solution;
  const evaluate = (time: number) => a * time ** 2 + b * time + c;
  const result = createFit("quadratic", points, { A: a, B: b, C: c }, `y = ${formatCoefficient(a)}x² ${signedTerm(b, "x")} ${signedTerm(c, "")}`, evaluate);
  return result.ok ? { ...result, model: "quadratic", a, b, c } : result;
}

export function fitExponential(points: FitPoint[]): FitResult {
  if (points.length < 2) return { ok: false, error: "指數擬合至少需要 2 個有效點。" };
  if (!hasFiniteValues(points)) return { ok: false, error: "擬合資料包含無效數值。" };
  if (points.some((point) => point.value <= 0)) return { ok: false, error: "資料不適用此模型：指數擬合需要所有 y 值大於 0。" };
  const transformed = fitLinear(points.map((point) => ({ t: point.t, value: Math.log(point.value) })));
  if (!transformed.ok) return transformed;
  const A = Math.exp(transformed.b);
  const B = transformed.m;
  return createFit("exponential", points, { A, B }, `y = ${formatCoefficient(A)}e^(${formatCoefficient(B)}x)`, (time) => A * Math.exp(B * time));
}

export function fitLogarithmic(points: FitPoint[]): FitResult {
  if (points.length < 2) return { ok: false, error: "對數擬合至少需要 2 個有效點。" };
  if (!hasFiniteValues(points)) return { ok: false, error: "擬合資料包含無效數值。" };
  if (points.some((point) => point.t <= 0)) return { ok: false, error: "資料不適用此模型：對數擬合需要所有 x 值大於 0。" };
  const transformed = fitLinear(points.map((point) => ({ t: Math.log(point.t), value: point.value })));
  if (!transformed.ok) return transformed;
  const A = transformed.m;
  const B = transformed.b;
  return createFit("logarithmic", points, { A, B }, `y = ${formatCoefficient(A)}ln(x) ${signedTerm(B, "")}`, (time) => A * Math.log(time) + B);
}

export function fitPower(points: FitPoint[]): FitResult {
  if (points.length < 2) return { ok: false, error: "冪次擬合至少需要 2 個有效點。" };
  if (!hasFiniteValues(points)) return { ok: false, error: "擬合資料包含無效數值。" };
  if (points.some((point) => point.t <= 0 || point.value <= 0)) return { ok: false, error: "資料不適用此模型：冪次擬合需要所有 x、y 值大於 0。" };
  const transformed = fitLinear(points.map((point) => ({ t: Math.log(point.t), value: Math.log(point.value) })));
  if (!transformed.ok) return transformed;
  const A = Math.exp(transformed.b);
  const B = transformed.m;
  return createFit("power", points, { A, B }, `y = ${formatCoefficient(A)}x^${formatCoefficient(B)}`, (time) => A * time ** B);
}

export function fitInverse(points: FitPoint[]): FitResult {
  if (points.length < 2) return { ok: false, error: "反比擬合至少需要 2 個有效點。" };
  if (!hasFiniteValues(points)) return { ok: false, error: "擬合資料包含無效數值。" };
  if (points.some((point) => Math.abs(point.t) <= RELATIVE_TOLERANCE)) return { ok: false, error: "資料不適用此模型：反比擬合不能包含 x = 0。" };
  const transformed = fitLinear(points.map((point) => ({ t: 1 / point.t, value: point.value })));
  if (!transformed.ok) return transformed;
  const A = transformed.m;
  const B = transformed.b;
  return createFit("inverse", points, { A, B }, `y = ${formatCoefficient(A)} / x ${signedTerm(B, "")}`, (time) => A / time + B);
}

type HarmonicSolution = { omega: number; sine: number; cosine: number; offset: number; residual: number };

function solveHarmonicAtOmega(points: FitPoint[], omega: number): HarmonicSolution | undefined {
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const vector = [0, 0, 0];
  for (const point of points) {
    const basis = [Math.sin(omega * point.t), Math.cos(omega * point.t), 1];
    for (let row = 0; row < 3; row += 1) {
      vector[row] += basis[row] * point.value;
      for (let column = 0; column < 3; column += 1) matrix[row][column] += basis[row] * basis[column];
    }
  }
  const solution = solveThreeByThree(matrix, vector);
  if (!solution) return undefined;
  const [sine, cosine, offset] = solution;
  const residual = points.reduce((sum, point) => sum + (point.value - (sine * Math.sin(omega * point.t) + cosine * Math.cos(omega * point.t) + offset)) ** 2, 0);
  return Number.isFinite(residual) ? { omega, sine, cosine, offset, residual } : undefined;
}

function findHarmonicSolution(points: FitPoint[]) {
  const sorted = [...points].sort((left, right) => left.t - right.t);
  const span = sorted[sorted.length - 1].t - sorted[0].t;
  const deltas = sorted.slice(1).map((point, index) => point.t - sorted[index].t).filter((delta) => delta > RELATIVE_TOLERANCE);
  const minimumDelta = deltas.length > 0 ? Math.min(...deltas) : 0;
  if (span <= RELATIVE_TOLERANCE || minimumDelta <= RELATIVE_TOLERANCE) return undefined;
  const minOmega = Math.max((Math.PI * 2) / (span * 8), 1e-5);
  const maxOmega = Math.max(minOmega * 1.1, Math.min((Math.PI / minimumDelta) * 0.95, ((Math.PI * 2) / span) * 12));
  const sampleCount = 240;
  let best: HarmonicSolution | undefined;
  let bestIndex = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const candidate = solveHarmonicAtOmega(points, minOmega + ((maxOmega - minOmega) * index) / (sampleCount - 1));
    if (candidate && (!best || candidate.residual < best.residual)) { best = candidate; bestIndex = index; }
  }
  if (!best) return undefined;
  const step = (maxOmega - minOmega) / (sampleCount - 1);
  let low = Math.max(minOmega, best.omega - (bestIndex === 0 ? 0 : step));
  let high = Math.min(maxOmega, best.omega + (bestIndex === sampleCount - 1 ? 0 : step));
  for (let iteration = 0; iteration < 42; iteration += 1) {
    const leftOmega = low + (high - low) / 3;
    const rightOmega = high - (high - low) / 3;
    const left = solveHarmonicAtOmega(points, leftOmega);
    const right = solveHarmonicAtOmega(points, rightOmega);
    if (!left || !right) break;
    if (left.residual <= right.residual) { high = rightOmega; if (left.residual < best.residual) best = left; }
    else { low = leftOmega; if (right.residual < best.residual) best = right; }
  }
  return best;
}

function fitHarmonic(points: FitPoint[], model: "sine" | "cosine"): FitResult {
  if (points.length < 5) return { ok: false, error: `${model === "sine" ? "正弦" : "餘弦"}擬合至少需要 5 個有效點。` };
  if (!hasFiniteValues(points)) return { ok: false, error: "擬合資料包含無效數值。" };
  const solution = findHarmonicSolution(points);
  if (!solution) return { ok: false, error: "資料時間範圍不足，無法可靠進行週期擬合。" };
  const A = Math.hypot(solution.sine, solution.cosine);
  const omega = solution.omega;
  const phi = model === "sine" ? Math.atan2(solution.cosine, solution.sine) : Math.atan2(-solution.sine, solution.cosine);
  const C = solution.offset;
  const evaluate = model === "sine" ? (time: number) => A * Math.sin(omega * time + phi) + C : (time: number) => A * Math.cos(omega * time + phi) + C;
  const name = model === "sine" ? "sin" : "cos";
  return createFit(model, points, { A, omega, phi, C }, `y = ${formatCoefficient(A)}${name}(${formatCoefficient(omega)}x ${signedTerm(phi, "")}) ${signedTerm(C, "")}`, evaluate);
}

export const fitSine = (points: FitPoint[]) => fitHarmonic(points, "sine");
export const fitCosine = (points: FitPoint[]) => fitHarmonic(points, "cosine");

export function fitData(model: FitModel, points: FitPoint[]): FitResult | null {
  if (model === "none") return null;
  if (model === "linear") return fitLinear(points);
  if (model === "quadratic") return fitQuadratic(points);
  if (model === "exponential") return fitExponential(points);
  if (model === "logarithmic") return fitLogarithmic(points);
  if (model === "power") return fitPower(points);
  if (model === "inverse") return fitInverse(points);
  if (model === "sine") return fitSine(points);
  return fitCosine(points);
}

export function evaluateFit(fit: FitSuccess, time: number) {
  return fit.evaluate(time);
}
