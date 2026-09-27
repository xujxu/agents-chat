"""Read-only fixed-offset PCM diagnostics; no transformed audio is emitted."""

import math

import numpy as np

RATE = 16000
METHOD = {
    "sample_rate": RATE, "global_lag_samples": [-RATE, RATE], "minimum_overlap_fraction": .8,
    "weak_below": .80, "ambiguous_gap_below": .05, "alternative_exclusion_samples": 160,
    "frame_samples": 160, "low_energy_dbfs": [-60, -50, -40],
    "window_samples": RATE, "window_centers": [.2, .5, .8], "local_search_radius": 1600,
    "residual": "Unscaled original-amplitude overlap", "time_warping": False,
}


def pcm_values(pcm):
    if (not isinstance(pcm, np.ndarray) or pcm.ndim != 1 or not 1 <= len(pcm) <= RATE * 30
            or pcm.dtype.kind != "i" or pcm.dtype.itemsize != 2):
        raise ValueError("Expected bounded nonempty mono PCM16")
    return pcm.astype(np.float64) / 32768


def rms(values):
    return float(np.sqrt(np.mean(values * values)))


def dbfs(value):
    return 20 * math.log10(value) if value > 0 else None


def signal_stats(pcm):
    values = pcm_values(pcm)
    peak = float(np.max(np.abs(values)))
    energy = rms(values)
    frame_count = len(values) // 160
    frames = values[:frame_count * 160].reshape(-1, 160)
    energies = np.sqrt(np.mean(frames * frames, axis=1))
    low = {}
    for level in METHOD["low_energy_dbfs"]:
        mask = energies <= 10 ** (level / 20)
        transitions = np.diff(np.concatenate(([False], mask, [False])).astype(np.int8))
        starts, ends = np.flatnonzero(transitions == 1), np.flatnonzero(transitions == -1)
        intervals = [[int(start * 160), int(end * 160)] for start, end in zip(starts, ends)]
        count = int(np.count_nonzero(mask))
        low[str(level)] = {
            "frames": count, "fraction": count / frame_count if frame_count else None,
            "intervals": intervals,
            "leading_samples": intervals[0][1] if intervals and intervals[0][0] == 0 else 0,
            "trailing_samples": frame_count * 160 - intervals[-1][0]
            if intervals and intervals[-1][1] == frame_count * 160 else 0,
        }
    negative = int(np.count_nonzero(pcm == -32768))
    positive = int(np.count_nonzero(pcm == 32767))
    near = int(np.count_nonzero(np.abs(values) >= .99))
    return {
        "samples": len(pcm), "duration_seconds": len(pcm) / RATE,
        "minimum_pcm": int(pcm.min()), "maximum_pcm": int(pcm.max()),
        "peak": peak, "peak_dbfs": dbfs(peak), "rms": energy, "rms_dbfs": dbfs(energy),
        "dc_offset": float(np.mean(values)), "zero_signal": not bool(np.any(pcm)),
        "negative_rail_samples": negative, "positive_rail_samples": positive, "near_rail_samples": near,
        "negative_rail_fraction": negative / len(pcm), "positive_rail_fraction": positive / len(pcm),
        "near_rail_fraction": near / len(pcm),
        "full_frames": frame_count, "partial_frame_samples": len(pcm) % 160, "low_energy": low,
    }


def unavailable(reason):
    return {"available": False, "reliable": False, "flags": [reason],
            "lag_samples": None, "lag_seconds": None, "correlation": None, "absolute_correlation": None,
            "alternative": None, "peak_gap": None, "overlap_samples": None,
            "source_coverage": None, "upload_coverage": None, "unmatched": None,
            "residual_rms": None, "relative_residual_rms": None, "centered_gain": None}


def alignment(x, y, minimum_lag=-RATE, maximum_lag=RATE, full_window=False):
    for values in (x, y):
        if (not isinstance(values, np.ndarray) or values.ndim != 1 or not 1 <= len(values) <= RATE * 30
                or not np.all(np.isfinite(values))):
            raise ValueError("Expected bounded finite alignment signal")
    if (not isinstance(minimum_lag, int) or not isinstance(maximum_lag, int)
            or maximum_lag < minimum_lag or maximum_lag - minimum_lag > 2 * RATE):
        raise ValueError("Invalid bounded lag search")
    x, y = x.astype(np.float64, copy=False), y.astype(np.float64, copy=False)
    lags = np.arange(minimum_lag, maximum_lag + 1)
    starts = np.maximum(0, -lags)
    ends = np.minimum(len(x), len(y) - lags)
    count = ends - starts
    valid = count == len(x) if full_window else count >= math.ceil(.8 * min(len(x), len(y)))
    valid &= count > 1
    if not np.any(valid):
        return unavailable("insufficient_overlap")
    lags, starts, ends, count = (v[valid] for v in (lags, starts, ends, count))

    def sums(values, left, right):
        prefix = np.concatenate(([0.0], np.cumsum(values)))
        squares = np.concatenate(([0.0], np.cumsum(values * values)))
        return prefix[right] - prefix[left], squares[right] - squares[left]

    sx, qx = sums(x, starts, ends)
    sy, qy = sums(y, starts + lags, ends + lags)
    vx, vy = qx - sx * sx / count, qy - sy * sy / count
    variance_floor = 64 * np.finfo(np.float64).eps
    valid = (vx > variance_floor * np.maximum(qx, 1)) & (vy > variance_floor * np.maximum(qy, 1))
    if not np.any(valid):
        return unavailable("insufficient_energy")
    lags, starts, ends, count, sx, sy, vx, vy = (
        v[valid] for v in (lags, starts, ends, count, sx, sy, vx, vy))
    nfft = 1 << (len(x) + len(y) - 2).bit_length()
    cross = np.fft.irfft(np.fft.rfft(y, nfft) * np.conj(np.fft.rfft(x, nfft)), nfft)
    correlations = (cross[lags % nfft] - sx * sy / count) / np.sqrt(vx * vy)
    if not np.all(np.isfinite(correlations)) or np.max(np.abs(correlations)) > 1 + 1e-7:
        raise ValueError("Invalid normalized correlation")
    correlations = np.clip(correlations, -1, 1)

    def best(indices):
        return int(indices[np.lexsort((lags[indices], np.abs(lags[indices]), -np.abs(correlations[indices])))[0]])

    chosen = best(np.arange(len(lags)))
    lag, correlation = int(lags[chosen]), float(correlations[chosen])
    alternatives = np.flatnonzero(np.abs(lags - lag) > 160)
    alternate = best(alternatives) if len(alternatives) else None
    gap = abs(correlation) - abs(float(correlations[alternate])) if alternate is not None else None
    flags = []
    if abs(correlation) < .8:
        flags.append("weak")
    if gap is not None and gap < .05:
        flags.append("ambiguous")
    if lag in (minimum_lag, maximum_lag):
        flags.append("search_boundary")
    start, end = int(starts[chosen]), int(ends[chosen])
    original, uploaded = x[start:end], y[start+lag:end+lag]
    residual = rms(uploaded - original)
    return {
        "available": True, "reliable": not flags, "flags": flags, "lag_samples": lag, "lag_seconds": lag / RATE,
        "correlation": correlation, "absolute_correlation": abs(correlation),
        "alternative": {"lag_samples": int(lags[alternate]), "correlation": float(correlations[alternate])}
        if alternate is not None else None,
        "peak_gap": gap, "overlap_samples": end - start,
        "source_coverage": (end - start) / len(x), "upload_coverage": (end - start) / len(y),
        "unmatched": {"source_prefix": start, "source_suffix": len(x) - end,
                      "upload_prefix": start + lag, "upload_suffix": len(y) - end - lag},
        "residual_rms": residual, "relative_residual_rms": residual / rms(original),
        "centered_gain": float(np.dot(original - np.mean(original), uploaded - np.mean(uploaded))
                               / np.sum((original - np.mean(original)) ** 2)),
    }


def compare_signals(source_pcm, upload_pcm):
    x, y = pcm_values(source_pcm), pcm_values(upload_pcm)
    global_result = alignment(x, y)
    windows = []
    for fraction in METHOD["window_centers"]:
        start = math.floor(fraction * len(x)) - RATE // 2
        end = start + RATE
        if start < 0 or end > len(x):
            local = unavailable("incomplete_source_window")
        elif not global_result["available"]:
            local = unavailable("global_alignment_unavailable")
        else:
            lag = global_result["lag_samples"]
            low, high = max(-RATE, lag - 1600), min(RATE, lag + 1600)
            local = alignment(x[start:end], y, minimum_lag=start + low,
                              maximum_lag=start + high, full_window=True)
            if local["available"]:
                local["lag_samples"] -= start
                local["lag_seconds"] = local["lag_samples"] / RATE
                if local["alternative"] is not None:
                    local["alternative"]["lag_samples"] -= start
                selected = start + local["lag_samples"]
                if min(rms(x[start:end]), rms(y[selected:selected+RATE])) <= .001:
                    local["flags"].append("low_energy")
                    local["reliable"] = False
            if rms(x[start:end]) <= .001 and "low_energy" not in local["flags"]:
                local["flags"].append("low_energy")
                local["reliable"] = False
        local.update(center_fraction=fraction, source_start=start, source_end=end,
                     conditional=not global_result["reliable"],
                     delta_from_global_samples=local["lag_samples"] - global_result["lag_samples"]
                     if local["available"] and global_result["available"] else None)
        windows.append(local)
    reliable = global_result["reliable"] and all(w["reliable"] for w in windows)
    return {
        "original": signal_stats(source_pcm), "uploaded": signal_stats(upload_pcm),
        "duration_delta_seconds": (len(y) - len(x)) / RATE,
        "global": global_result, "windows": windows,
        "last_minus_first_samples": windows[-1]["lag_samples"] - windows[0]["lag_samples"] if reliable else None,
        "offset_consistency_reason": None if reliable else "Global/local matching is uncertain, unavailable or low energy",
    }
