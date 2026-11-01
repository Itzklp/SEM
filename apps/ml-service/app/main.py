"""FastAPI inference API. The model is loaded once and never retrained in-process."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Annotated

import joblib
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from starlette.responses import Response

from .features import FEATURE_NAMES, to_model_row

MODEL_DIR = Path(os.getenv("MODEL_DIR", Path(__file__).resolve().parents[3] / "ml" / "models"))
MODEL_REGISTRY = MODEL_DIR / "registry.json"
INFERENCE_SECONDS = Histogram("ml_inference_duration_seconds", "Model inference duration")
INFERENCE_TOTAL = Counter("ml_inference_total", "Model inference calls", ["outcome"])

app = FastAPI(title="FraudGuard ML Service", version="1.0.0")
_model = None
_model_version: str | None = None


class ScoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amountMajorUnits: Annotated[float, Field(ge=0, le=1_000_000_000)]
    features: dict[str, Annotated[float, Field(ge=0, le=1_000_000_000)]]


class ScoreResponse(BaseModel):
    score: Annotated[float, Field(ge=0, le=1)]
    modelVersion: str


def load_active_model() -> tuple[object, str]:
    if not MODEL_REGISTRY.is_file():
        raise RuntimeError(f"Model registry not found: {MODEL_REGISTRY}")
    registry = json.loads(MODEL_REGISTRY.read_text(encoding="utf-8"))
    active = [entry for entry in registry.get("models", []) if entry.get("active")]
    if len(active) != 1:
        raise RuntimeError("Model registry must contain exactly one active model")
    entry = active[0]
    if entry.get("providerName") != "ml":
        raise RuntimeError("Active registry entry is not an ML model")
    artifact = (MODEL_DIR / entry["artifact"]).resolve()
    if MODEL_DIR.resolve() not in artifact.parents:
        raise RuntimeError("Model artifact path escapes MODEL_DIR")
    if not artifact.is_file():
        raise RuntimeError(f"Active model artifact not found: {artifact}")
    return joblib.load(artifact), entry["modelVersion"]


@app.on_event("startup")
def startup() -> None:
    global _model, _model_version
    try:
        _model, _model_version = load_active_model()
    except Exception as exc:
        # A live-but-unready process lets orchestration expose a useful health
        # response; inference remains unavailable and fraud-api falls back.
        _model = None
        _model_version = None
        app.state.model_load_error = str(exc)


@app.get("/health/live")
def liveness() -> dict[str, str]:
    return {"status": "live"}


@app.get("/health/ready")
def readiness() -> dict[str, str]:
    if _model is None or _model_version is None:
        raise HTTPException(status_code=503, detail=getattr(app.state, "model_load_error", "model unavailable"))
    return {"status": "ready", "modelVersion": _model_version}


@app.post("/api/v1/score", response_model=ScoreResponse)
def score(request: ScoreRequest) -> ScoreResponse:
    if _model is None or _model_version is None:
        INFERENCE_TOTAL.labels(outcome="unavailable").inc()
        raise HTTPException(status_code=503, detail="model unavailable")
    unknown = set(request.features) - set(FEATURE_NAMES[1:])
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown feature names: {sorted(unknown)}")
    try:
        row = to_model_row(request.amountMajorUnits, request.features)
        with INFERENCE_SECONDS.time():
            probability = float(_model.predict_proba([row])[0][1])
        if not 0 <= probability <= 1:
            raise ValueError("model returned probability outside [0,1]")
        INFERENCE_TOTAL.labels(outcome="success").inc()
        return ScoreResponse(score=probability, modelVersion=_model_version)
    except (ValueError, IndexError, TypeError) as exc:
        INFERENCE_TOTAL.labels(outcome="error").inc()
        raise HTTPException(status_code=500, detail="model inference failed") from exc


@app.get("/models")
def models() -> list[dict[str, object]]:
    if not MODEL_REGISTRY.is_file():
        return []
    registry = json.loads(MODEL_REGISTRY.read_text(encoding="utf-8"))
    return registry.get("models", [])


@app.get("/metrics")
def metrics() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
