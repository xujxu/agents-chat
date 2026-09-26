"""Fixed descriptive measurements for the synthetic audio-graph probe."""

import numpy as np

from voice_signal_metrics import dbfs, rms

FREQUENCIES = {
    "mono-tones": [250, 1000, 3000], "stereo-tones": [500, 1500],
}
METHOD = {"version": 1, "tone_window_seconds": [3, 5], "envelope_ms": 1,
          "marker_starts_ms": [1000, 4000, 7000], "marker_length_ms": 200,
          "search_radius_ms": 1000, "alternative_exclusion_ms": 10,
          "weak_below": .8, "ambiguous_gap_below": .05}


def finite(values):
    array = np.asarray(values, dtype=np.float64)
    if (array.ndim != 1 or not 1 <= len(array) <= 192000 * 30
            or not np.all(np.isfinite(array))):
        raise ValueError("Expected bounded finite one-dimensional PCM")
    return array


def valid_rate(rate):
    if not isinstance(rate, int) or not 1000 <= rate <= 192000:
        raise ValueError("Invalid sample rate")


def quantize(values):
    bounded = np.clip(finite(values), -1, 1)
    return np.floor(bounded * np.where(bounded < 0, 32768, 32767) + .5).astype("<i2")


def stats(values, rate, pcm=False):
    values = finite(values)
    valid_rate(rate)
    peak, energy = float(np.max(np.abs(values))), rms(values)
    return {"rate": rate, "samples": len(values), "duration_seconds": len(values) / rate,
            "minimum": float(values.min()), "maximum": float(values.max()),
            "peak": peak, "peak_dbfs": dbfs(peak), "rms": energy, "rms_dbfs": dbfs(energy),
            "dc": float(values.mean()), "zero_signal": not bool(np.any(values)),
            "negative_rail": int(np.count_nonzero(values == -1)),
            "positive_rail": int(np.count_nonzero(values == (32767 / 32768 if pcm else 1))),
            "near_rail": int(np.count_nonzero(np.abs(values) >= .99))}


def envelope(values, rate):
    values = finite(values)
    valid_rate(rate)
    bins = len(values) * 1000 // rate
    edges = np.arange(bins + 1, dtype=np.float64) * rate / 1000
    integral = np.concatenate(([0.], np.cumsum(values * values)))
    left = np.floor(edges).astype(int)
    fraction = edges - left
    partial = values[np.minimum(left, len(values) - 1)] ** 2 * fraction
    totals = integral[left] + partial
    return np.sqrt(np.maximum(0, np.diff(totals) / (rate / 1000)))


def tones(values, rate, frequencies):
    values = finite(values)
    valid_rate(rate)
    if len(values) < 5 * rate:
        raise ValueError("Missing complete tone interval")
    time = np.arange(3 * rate, 5 * rate) / rate
    columns = [part for frequency in frequencies
               for part in (np.sin(2 * np.pi * frequency * time),
                            np.cos(2 * np.pi * frequency * time))]
    matrix = np.column_stack([*columns, np.ones(len(time))])
    selected = values[3 * rate:5 * rate]
    coefficients, _, rank, _ = np.linalg.lstsq(matrix, selected, rcond=None)
    if rank != matrix.shape[1]:
        raise ValueError("Rank-deficient tone fit")
    return {"amplitudes": {str(f): float(np.hypot(*coefficients[2*i:2*i+2]))
                           for i, f in enumerate(frequencies)},
            "dc": float(coefficients[-1]), "residual_rms": rms(selected - matrix @ coefficients)}


def marker(template, signal, nominal):
    template, signal = finite(template), finite(signal)
    start, end = max(0, nominal - 1000), min(len(signal) - len(template), nominal + 1000)
    missing = {"position_ms": None, "offset_ms": None, "correlation": None,
               "alternative_correlation": None, "peak_gap": None, "reliable": False}
    if end < start:
        return {**missing, "flags": ["missing_window"]}
    centered = template - template.mean()
    variance = float(centered @ centered)
    if variance <= 1e-20:
        return {**missing, "flags": ["zero_variance"]}
    positions = np.arange(start, end + 1)
    windows = np.lib.stride_tricks.sliding_window_view(signal, len(template))[start:end+1]
    means = windows.mean(axis=1)
    energy = np.sum(windows * windows, axis=1) - len(template) * means**2
    valid = energy > 1e-20
    if not np.any(valid):
        return {**missing, "flags": ["zero_variance"]}
    correlations = np.full(len(positions), -np.inf)
    correlations[valid] = np.clip((windows[valid] @ centered) / np.sqrt(energy[valid] * variance), -1, 1)
    best = np.lexsort((positions, np.abs(positions - nominal), -correlations))[0]
    position, correlation = int(positions[best]), float(correlations[best])
    alternatives = correlations[(np.abs(positions - position) > 10) & valid]
    alternative = float(alternatives.max()) if len(alternatives) else None
    gap = correlation - alternative if alternative is not None else None
    flags = []
    if correlation < .8:
        flags.append("weak")
    if gap is not None and gap < .05:
        flags.append("ambiguous")
    if position in (start, end):
        flags.append("search_boundary")
    return {"position_ms": position, "offset_ms": position - nominal,
            "correlation": correlation, "alternative_correlation": alternative,
            "peak_gap": gap, "reliable": not flags, "flags": flags}


def describe(values, rate, stimulus, templates, pcm=False):
    result = {"stats": stats(values, rate, pcm)}
    if stimulus in FREQUENCIES:
        result["tones"] = tones(values, rate, FREQUENCIES[stimulus])
    else:
        frames = envelope(values, rate)
        markers = [marker(template, frames, nominal)
                   for template, nominal in zip(templates, METHOD["marker_starts_ms"])]
        result.update({"markers": markers,
                       "partial_envelope_samples": len(values) - len(frames) * rate / 1000,
                       "intervals": [
                           {"delta_ms": b["position_ms"] - a["position_ms"] - 3000,
                            "reason": None} if a["reliable"] and b["reliable"] else
                           {"delta_ms": None, "reason": "unreliable_marker"}
                           for a, b in zip(markers, markers[1:])]})
    return result
