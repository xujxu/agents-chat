"""Strict interpretation of synthetic heaptrack evidence, not an OOM diagnosis."""
import math
import statistics

MIB = 1024 ** 2


def parse_stacks(text):
    result = []
    for line in text.splitlines():
        if not line.strip():
            continue
        stack, separator, value = line.rpartition(" ")
        if not separator or not stack.strip() or not value.isdecimal():
            raise ValueError("Malformed or negative folded-stack cost")
        result.append((stack, int(value)))
    if not result:
        raise ValueError("No folded-stack evidence")
    return result


def stack_bytes(rows, name):
    return sum(value for stack, value in rows if name in stack)


def overhead(baseline, tracked):
    if len(baseline) != 3 or len(tracked) != 3:
        raise ValueError("Three baseline/tracked pairs are required")
    cpu, rss, wall = [], [], []
    for before, after in zip(baseline, tracked):
        for row in (before, after):
            if any(not math.isfinite(row[key]) or row[key] < 0 for key in (
                    "cpu_seconds", "wall_seconds", "max_rss_bytes")) or row["wall_seconds"] == 0:
                raise ValueError("Invalid resource measurement")
        cpu.append(100 * (after["cpu_seconds"] - before["cpu_seconds"]) / before["wall_seconds"])
        rss.append(after["max_rss_bytes"] - before["max_rss_bytes"])
        wall.append(after["wall_seconds"] / before["wall_seconds"])
    return {"extra_one_core_cpu_percent": statistics.median(cpu),
            "extra_peak_rss_bytes": statistics.median(rss),
            "wall_ratio": statistics.median(wall)}


def assess(native_exact, cli_named_bytes, abrupt_readable, measured_overhead):
    gates = {
        "native_allocation_release_realloc_thread_accounting": native_exact is True,
        "cli_buffer_native_path_at_least_32_mib": cli_named_bytes >= 32 * MIB,
        "known_allocations_readable_after_sigkill": abrupt_readable is True,
        "extra_total_cpu_below_5_percent_one_core":
            measured_overhead["extra_one_core_cpu_percent"] < 5,
        "extra_subject_peak_rss_below_32_mib":
            measured_overhead["extra_peak_rss_bytes"] < 32 * MIB,
        "wall_ratio_below_1_25": measured_overhead["wall_ratio"] < 1.25,
    }
    return {
        "synthetic_gates_passed": all(gates.values()),
        "gates": gates,
        "failed_gates": [name for name, passed in gates.items() if not passed],
        "production_ready": False,
        "root_cause_proven": False,
        "limitations": [
            "Full malloc tracing, not a bounded-memory always-on sampler.",
            "Direct mmap, custom allocators and V8 managed heaps are not comprehensively tracked.",
            "Synthetic Buffer attribution does not prove V8 internal malloc attribution.",
            "SIGKILL test proves selected earlier records survive, not lossless final capture.",
            "Outstanding allocations at termination are not proof of a memory leak.",
            "Allocator fragmentation/retention and production symbol coverage remain unverified.",
            "Collector RSS is limited with the whole experiment, not included in subject RSS overhead.",
            "No real OOM reproduction or allocation-stack loss counter is available in this experiment.",
        ],
    }
