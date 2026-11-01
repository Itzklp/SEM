"""Create a deterministic, synthetic-only fraud model and evaluation report.

The labels encode explicitly generated attack scenarios, not observed fraud.
Reported metrics describe this simulator only and must never be presented as
real-world detection performance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

if __package__ in (None, ""):
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.features import FEATURE_NAMES
else:
    from .features import FEATURE_NAMES

ROOT = Path(__file__).resolve().parents[3]
DATASET_DIR = ROOT / "ml" / "datasets"
MODEL_DIR = ROOT / "ml" / "models"
MODEL_INFERENCE_BUDGET_MS = 15.0
PIPELINE_ALLOW_MAX = 0.4
SCORE_WEIGHTS = {"rules": 0.5, "model": 0.35, "behavioural": 0.15}


def make_dataset(size: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    fraud = rng.random(size) < 0.025
    x = np.zeros((size, len(FEATURE_NAMES)), dtype=np.float64)
    # Benign population, in the same units and order as online feature reads.
    x[:, 0] = rng.lognormal(3.6, 0.8, size)  # amount major units
    x[:, 1] = rng.poisson(0.15, size)        # transactions / 5m
    x[:, 2] = rng.poisson(0.8, size)         # transactions / 1h
    x[:, 3] = rng.gamma(2.0, 45.0, size)     # amount sum / 1h
    x[:, 4] = rng.gamma(2.0, 40.0, size)     # average amount / 24h
    x[:, 5] = rng.poisson(1.2, size)         # distinct merchants / 1h
    x[:, 6] = rng.poisson(1.0, size)         # distinct locations / 24h
    x[:, 7] = rng.poisson(0.08, size)        # failed attempts / 10m
    x[:, 8] = rng.poisson(2.0, size)          # device transactions
    x[:, 9] = rng.integers(0, 4000, size)     # account age / days
    x[:, 10] = rng.beta(1.2, 10.0, size)      # merchant risk
    x[:, 11] = rng.beta(1.0, 12.0, size)      # IP risk

    # Select one or more synthetic attack signatures. This intentionally
    # overlaps the serving rule features so the experiment measures whether
    # a fitted combination generalises better than a single threshold.
    fraud_indexes = np.flatnonzero(fraud)
    for index in fraud_indexes:
        scenario = rng.integers(0, 6)
        if scenario == 0:  # velocity burst
            x[index, 1], x[index, 2] = rng.integers(4, 12), rng.integers(12, 35)
        elif scenario == 1:  # amount anomaly
            x[index, 0] = rng.uniform(700, 4000)
            x[index, 4] = rng.uniform(15, 90)
        elif scenario == 2:  # credential/device abuse
            x[index, 7], x[index, 8] = rng.integers(3, 10), rng.integers(20, 100)
        elif scenario == 3:  # geographic/merchant concentration
            x[index, 5], x[index, 6], x[index, 10] = rng.integers(6, 15), rng.integers(5, 12), rng.uniform(.6, 1)
        elif scenario == 4:  # risky network / young account
            x[index, 9], x[index, 11] = rng.integers(0, 10), rng.uniform(.6, 1)
        else:  # mixed low-level signals that no single threshold catches
            x[index, 1], x[index, 5], x[index, 10], x[index, 11] = 3, 4, .45, .4
    return x, fraud.astype(np.uint8)


def _contribution(ratio: np.ndarray) -> np.ndarray:
    return np.clip(ratio - 1.0, 0.0, 1.0)


def provider_components(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return the current rules, stub-model and behavioural score components."""
    velocity = _contribution(np.maximum(x[:, 1] / 10.0, x[:, 2] / 20.0))
    amount_ratio = np.divide(x[:, 0], x[:, 4] * 5.0, out=np.zeros(len(x)), where=x[:, 4] > 0)
    amount = _contribution(amount_ratio)
    device = _contribution(x[:, 8] / 50.0)
    geography = _contribution(x[:, 6] / 4.0)
    failed = _contribution(x[:, 7] / 3.0)
    merchant = np.where(x[:, 10] >= 0.7, x[:, 10], 0.0)
    rules = np.maximum.reduce([velocity, amount, device, geography, failed, merchant])
    stub_model = np.clip(x[:, 0] / 2000.0, 0.0, 1.0)
    behavioural = np.mean(
        np.column_stack((
            np.clip(x[:, 2] / 10.0, 0.0, 1.0),
            np.clip(x[:, 3] / 2000.0, 0.0, 1.0),
            np.clip(x[:, 5] / 5.0, 0.0, 1.0),
        )),
        axis=1,
    )
    return rules, stub_model, behavioural


def rule_provider_score(x: np.ndarray) -> np.ndarray:
    """Replicate current RuleBasedScoringProvider defaults and score weights."""
    rules, stub_model, behavioural = provider_components(x)
    return np.clip(
        rules * SCORE_WEIGHTS["rules"]
        + stub_model * SCORE_WEIGHTS["model"]
        + behavioural * SCORE_WEIGHTS["behavioural"],
        0.0,
        1.0,
    )


def ml_provider_score(x: np.ndarray, model_scores: np.ndarray) -> np.ndarray:
    """Replace the rules provider's stub-model signal with the learned score."""
    rules, _, behavioural = provider_components(x)
    return np.clip(
        rules * SCORE_WEIGHTS["rules"]
        + model_scores * SCORE_WEIGHTS["model"]
        + behavioural * SCORE_WEIGHTS["behavioural"],
        0.0,
        1.0,
    )


def measure(
    y_true: np.ndarray,
    y_score: np.ndarray,
    latency_ms: float,
    threshold: float = 0.5,
) -> dict[str, float]:
    y_pred = (y_score >= threshold).astype(np.uint8)
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    return {
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
        "rocAuc": float(roc_auc_score(y_true, y_score)),
        "prAuc": float(average_precision_score(y_true, y_score)),
        "falsePositiveRate": float(fp / max(1, fp + tn)),
        "falseNegativeRate": float(fn / max(1, fn + tp)),
        "inferenceLatencyP99Ms": latency_ms,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=100_000)
    parser.add_argument("--seed", type=int, default=20261031)
    args = parser.parse_args()
    if args.rows < 1000:
        parser.error("--rows must be at least 1000")

    x, y = make_dataset(args.rows, args.seed)
    DATASET_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = DATASET_DIR / "synthetic_training.csv"
    np.savetxt(csv_path, np.column_stack((x, y)), delimiter=",", header=",".join((*FEATURE_NAMES, "is_fraud")), comments="", fmt="%.8g")

    x_train, x_test, y_train, y_test = train_test_split(
        x, y, test_size=.25, random_state=args.seed, stratify=y
    )
    candidates = {
        "logistic-regression": make_pipeline(
            StandardScaler(),
            LogisticRegression(max_iter=1000, class_weight="balanced", random_state=args.seed),
        ),
        "random-forest": RandomForestClassifier(n_estimators=160, min_samples_leaf=3, class_weight="balanced_subsample", n_jobs=1, random_state=args.seed),
        "hist-gradient-boosting": HistGradientBoostingClassifier(max_iter=120, l2_regularization=1.0, random_state=args.seed),
    }
    results: dict[str, dict[str, object]] = {}
    best_name, best_model, best_metrics = "", None, None
    best_model_scores: np.ndarray | None = None
    for name, model in candidates.items():
        model.fit(x_train, y_train)
        started = time.perf_counter()
        for row in x_test[: min(2000, len(x_test))]:
            model.predict_proba([row])
        elapsed = (time.perf_counter() - started) * 1000 / min(2000, len(x_test))
        # Warm each row individually for a latency measurement matching the
        # single-request HTTP serving path, with p99 explicitly reported.
        samples = []
        for row in x_test[: min(1000, len(x_test))]:
            t0 = time.perf_counter_ns()
            model.predict_proba([row])
            samples.append((time.perf_counter_ns() - t0) / 1_000_000)
        latency_p99 = float(np.percentile(samples, 99))
        scores = model.predict_proba(x_test)[:, 1]
        metrics = measure(y_test, scores, latency_p99)
        results[name] = {"metrics": metrics, "meanSingleRowLatencyMs": elapsed}
        eligible = latency_p99 <= MODEL_INFERENCE_BUDGET_MS
        best_is_eligible = best_metrics is not None and best_metrics["inferenceLatencyP99Ms"] <= MODEL_INFERENCE_BUDGET_MS
        if (eligible and not best_is_eligible) or (
            eligible == best_is_eligible
            and (best_metrics is None or (metrics["prAuc"], -latency_p99) > (best_metrics["prAuc"], -best_metrics["inferenceLatencyP99Ms"]))
        ):
            best_name, best_model, best_metrics = name, model, metrics
            best_model_scores = scores

    if best_model_scores is None or best_metrics is None:
        raise RuntimeError("No candidate model could be selected")
    baseline_scores = rule_provider_score(x_test)
    baseline_latency_samples = []
    for row in x_test[: min(1000, len(x_test))]:
        t0 = time.perf_counter_ns()
        rule_provider_score(row.reshape(1, -1))
        baseline_latency_samples.append((time.perf_counter_ns() - t0) / 1_000_000)
    baseline_latency_p99 = float(np.percentile(baseline_latency_samples, 99))
    ml_pipeline_scores = ml_provider_score(x_test, best_model_scores)
    comparison = {
        "decisionScoreThreshold": PIPELINE_ALLOW_MAX,
        "weights": SCORE_WEIGHTS,
        "rulesProvider": measure(y_test, baseline_scores, baseline_latency_p99, PIPELINE_ALLOW_MAX),
        "mlProvider": measure(y_test, ml_pipeline_scores, best_metrics["inferenceLatencyP99Ms"], PIPELINE_ALLOW_MAX),
        "note": "Both scores use the configured decision score threshold and identical rules/behavioural components; ML replaces only the rules provider's stub-model component.",
    }
    dataset_revision = hashlib.sha256(f"{args.seed}:{args.rows}".encode()).hexdigest()[:8]
    version = f"model-v1-synthetic-{best_name}-{dataset_revision}"
    artifact_name = f"{version}.joblib"
    joblib_path = MODEL_DIR / artifact_name
    import joblib
    joblib.dump(best_model, joblib_path, compress=3)
    registry_path = MODEL_DIR / "registry.json"
    previous_models: list[dict[str, object]] = []
    if registry_path.is_file():
        previous = json.loads(registry_path.read_text(encoding="utf-8"))
        previous_models = [
            {**entry, "active": False}
            for entry in previous.get("models", [])
            if entry.get("modelVersion") != version
        ]
    registry = {
        "schemaVersion": 1,
        "activeModelVersion": version,
        "models": [*previous_models, {
            "modelVersion": version,
            "providerName": "ml",
            "description": f"Synthetic-only {best_name}; trained with seed {args.seed} on generated attack scenarios.",
            "registeredAt": datetime.now(timezone.utc).isoformat(),
            "active": True,
            "artifact": artifact_name,
            "featureNames": list(FEATURE_NAMES),
            "metrics": best_metrics,
        }],
    }
    registry_path.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    registry_url = os.getenv("ML_REGISTRY_URL")
    registry_token = os.getenv("ML_REGISTRY_TOKEN")
    if registry_url or registry_token:
        if not registry_url or not registry_token:
            raise RuntimeError("Set both ML_REGISTRY_URL and ML_REGISTRY_TOKEN to publish a model registration")
        registration = {
            "modelVersion": version,
            "providerName": "ml",
            "description": registry["models"][-1]["description"],
            "registeredAt": registry["models"][-1]["registeredAt"],
            "active": True,
            "metrics": best_metrics,
        }
        request = urllib.request.Request(
            registry_url.rstrip("/") + "/api/v1/models",
            data=json.dumps(registration).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {registry_token}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status not in (200, 201):
                raise RuntimeError(f"Model registry returned HTTP {response.status}")
    report = {
        "dataset": {"source": "deterministic synthetic scenario generator", "rows": args.rows, "fraudRate": float(y.mean()), "seed": args.seed, "features": list(FEATURE_NAMES)},
        "candidateModels": results,
        "selectedModel": best_name,
        "modelInferenceBudgetP99Ms": MODEL_INFERENCE_BUDGET_MS,
        "selectionReason": "Highest PR-AUC candidate among models whose measured single-row p99 inference fits the model inference budget; if none meet it, highest PR-AUC candidate overall.",
        "controlledPipelineComparison": comparison,
        "warning": "All metrics describe synthetic labels and are not estimates of real-world fraud detection performance.",
    }
    (DATASET_DIR / "evaluation-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
