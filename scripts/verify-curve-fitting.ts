import assert from "node:assert/strict";
import { fitCosine, fitDampedOscillation, fitData, fitExponential, fitInverse, fitLinear, fitLogarithmic, fitPower, fitQuadratic, fitSine, fitTerminalExponential } from "../lib/curve-fitting";
import { formatSignificant } from "../lib/number-format";

assert.equal(formatSignificant(-1.1483990764881795), "-1.148", "formatter should use four significant digits");
assert.equal(formatSignificant(13.3249), "13.32", "formatter should trim long decimals");
assert.equal(formatSignificant(undefined), "—", "formatter should provide a placeholder for missing values");

const closeTo = (actual: number | undefined, expected: number, label: string) => {
  if (actual === undefined) assert.fail(`${label} should be defined`);
  assert.ok(Math.abs(actual - expected) < 1e-10, `${label}: expected ${expected}, received ${actual}`);
};

const linear = fitLinear([0, 1, 2, 3].map((t) => ({ t, value: 2 * t + 1 })));
assert.ok(linear.ok, "linear fit should solve");
if (linear.ok) {
  closeTo(linear.m, 2, "linear slope");
  closeTo(linear.b, 1, "linear intercept");
  closeTo(linear.rSquared, 1, "linear R²");
  closeTo(linear.rmse, 0, "linear RMSE");
}

const formattedLinear = fitLinear([{ t: 0, value: 13.3249 }, { t: 1, value: -7.2051 }]);
assert.ok(formattedLinear.ok, "formatted linear fit should solve");
if (formattedLinear.ok) assert.equal(formattedLinear.equation, "y = -20.53x + 13.32", "fit equation should use four significant digits");

const quadratic = fitQuadratic([-1, 0, 1, 2, 3].map((t) => ({ t, value: -4.9 * t ** 2 + 3 * t + 2 })));
assert.ok(quadratic.ok, "quadratic fit should solve");
if (quadratic.ok) {
  closeTo(quadratic.a, -4.9, "quadratic A");
  closeTo(quadratic.b, 3, "quadratic B");
  closeTo(quadratic.c, 2, "quadratic C");
  closeTo(quadratic.rSquared, 1, "quadratic R²");
}

const exponential = fitExponential([0, 1, 2, 3, 4].map((t) => ({ t, value: 2 * Math.exp(0.5 * t) })));
assert.ok(exponential.ok, "exponential fit should solve");
if (exponential.ok) {
  closeTo(exponential.coefficients.A, 2, "exponential A");
  closeTo(exponential.coefficients.B, 0.5, "exponential B");
  closeTo(exponential.rSquared, 1, "exponential R²");
  closeTo(exponential.rmse, 0, "exponential RMSE");
}

const terminalExponential = fitTerminalExponential(Array.from({ length: 31 }, (_, index) => {
  const t = index * 0.1;
  return { t, value: -4 + (0 - (-4)) * Math.exp(-t / 0.5) };
}));
assert.ok(terminalExponential.ok, "terminal exponential fit should solve");
if (terminalExponential.ok) {
  assert.ok(Math.abs(terminalExponential.coefficients.VT - (-4)) < 1e-4, `terminal VT: expected -4, received ${terminalExponential.coefficients.VT}`);
  assert.ok(Math.abs(terminalExponential.coefficients.V0 - 0) < 1e-4, `terminal V0: expected 0, received ${terminalExponential.coefficients.V0}`);
  assert.ok(Math.abs(terminalExponential.coefficients.tau - 0.5) < 1e-4, `terminal tau: expected 0.5, received ${terminalExponential.coefficients.tau}`);
  assert.ok((terminalExponential.rSquared ?? 0) > 0.999999, "terminal exponential R² should be near 1");
}

const logarithmic = fitLogarithmic([0.5, 1, 2, 3, 5, 8].map((t) => ({ t, value: 3 * Math.log(t) + 1 })));
assert.ok(logarithmic.ok, "logarithmic fit should solve");
if (logarithmic.ok) {
  closeTo(logarithmic.coefficients.A, 3, "logarithmic A");
  closeTo(logarithmic.coefficients.B, 1, "logarithmic B");
  closeTo(logarithmic.rSquared, 1, "logarithmic R²");
}

const power = fitPower([0.5, 1, 2, 3, 4].map((t) => ({ t, value: 2 * t ** 1.5 })));
assert.ok(power.ok, "power fit should solve");
if (power.ok) {
  closeTo(power.coefficients.A, 2, "power A");
  closeTo(power.coefficients.B, 1.5, "power B");
  closeTo(power.rSquared, 1, "power R²");
  closeTo(power.rmse, 0, "power RMSE");
}

const inverse = fitInverse([1, 2, 3, 4, 5].map((t) => ({ t, value: 6 / t + 1.5 })));
assert.ok(inverse.ok, "inverse fit should solve");
if (inverse.ok) {
  closeTo(inverse.coefficients.A, 6, "inverse A");
  closeTo(inverse.coefficients.B, 1.5, "inverse B");
  closeTo(inverse.rSquared, 1, "inverse R²");
  closeTo(inverse.rmse, 0, "inverse RMSE");
}

const harmonicPoints = Array.from({ length: 61 }, (_, index) => {
  const t = index * 0.1;
  return { t, value: 2 * Math.sin(3 * t + 0.5) + 1 };
});
const sine = fitSine(harmonicPoints);
assert.ok(sine.ok, "sine fit should solve");
if (sine.ok) {
  closeTo(sine.coefficients.A, 2, "sine A");
  assert.ok(Math.abs(sine.coefficients.omega - 3) < 1e-6, `sine omega: expected 3, received ${sine.coefficients.omega}`);
  closeTo(sine.coefficients.C, 1, "sine C");
  closeTo(sine.rSquared, 1, "sine R²");
  assert.ok(sine.rmse < 1e-5, `sine RMSE should be near zero, received ${sine.rmse}`);
}

const cosine = fitCosine(Array.from({ length: 61 }, (_, index) => {
  const t = index * 0.1;
  return { t, value: 2 * Math.cos(3 * t + 0.5) + 1 };
}));
assert.ok(cosine.ok, "cosine fit should solve");
if (cosine.ok) {
  closeTo(cosine.coefficients.A, 2, "cosine A");
  assert.ok(Math.abs(cosine.coefficients.omega - 3) < 1e-6, `cosine omega: expected 3, received ${cosine.coefficients.omega}`);
  closeTo(cosine.coefficients.C, 1, "cosine C");
}

const damped = fitDampedOscillation(Array.from({ length: 121 }, (_, index) => {
  const t = index * 0.05;
  return { t, value: 2.5 * Math.exp(-0.4 * t) * Math.sin(4.2 * t + 0.35) + 0.6 };
}));
assert.ok(damped.ok, "damped oscillation fit should solve");
if (damped.ok) {
  assert.ok(Math.abs(damped.coefficients.A - 2.5) < 0.03, `damped A: expected 2.5, received ${damped.coefficients.A}`);
  assert.ok(Math.abs(damped.coefficients.gamma - 0.4) < 0.02, `damped gamma: expected 0.4, received ${damped.coefficients.gamma}`);
  assert.ok(Math.abs(damped.coefficients.omega - 4.2) < 0.02, `damped omega: expected 4.2, received ${damped.coefficients.omega}`);
  assert.ok(Math.abs(damped.coefficients.C - 0.6) < 0.03, `damped C: expected 0.6, received ${damped.coefficients.C}`);
  assert.ok((damped.rSquared ?? 0) > 0.999, "damped oscillation R² should be near 1");
}

const generic = fitData("linear", [{ t: 0, value: 1 }, { t: 1, value: 3 }]);
assert.ok(generic?.ok, "generic model dispatcher should solve linear data");

process.stdout.write("Curve-fitting verification passed.\n");
