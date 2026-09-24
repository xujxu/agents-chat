#pragma once
#include "voice-native.h"
#include <intrin.h>
#include <cstdio>
#include <cstring>

inline void writeHostInformation() {
    int cpu[4]{};
    __cpuidex(cpu, 0, 0);
    const int maximum = cpu[0];
    __cpuidex(cpu, 1, 0);
    const bool avxState = (cpu[2] & (1 << 27)) && (cpu[2] & (1 << 28))
        && ((_xgetbv(0) & 6) == 6);
    const bool fma = avxState && (cpu[2] & (1 << 12));
    const bool f16c = avxState && (cpu[2] & (1 << 29));
    bool avx2 = false, bmi2 = false;
    if (maximum >= 7) {
        __cpuidex(cpu, 7, 0);
        avx2 = avxState && (cpu[1] & (1 << 5));
        bmi2 = (cpu[1] & (1 << 8)) != 0;
    }
    MEMORYSTATUSEX memory{};
    memory.dwLength = sizeof(memory);
    require(GlobalMemoryStatusEx(&memory));
    DWORD_PTR affinity = 0, systemAffinity = 0;
    require(GetProcessAffinityMask(GetCurrentProcess(), &affinity, &systemAffinity));
    unsigned count = 0;
    while (affinity) { count += static_cast<unsigned>(affinity & 1); affinity >>= 1; }
    BOOL inJob = FALSE;
    require(IsProcessInJob(GetCurrentProcess(), nullptr, &inJob));
    using VersionFunction = LONG(WINAPI*)(OSVERSIONINFOW*);
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    require(ntdll != nullptr);
    const FARPROC address = GetProcAddress(ntdll, "RtlGetVersion");
    require(address != nullptr);
    VersionFunction versionFunction = nullptr;
    static_assert(sizeof(versionFunction) == sizeof(address));
    std::memcpy(&versionFunction, &address, sizeof(address));
    OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof(version);
    if (versionFunction(&version) != 0) throw NativeError{ ERROR_NOT_SUPPORTED };
    std::printf("{\"version\":1,\"windowsBuild\":%lu,\"cpuFlags\":[", version.dwBuildNumber);
    bool first = true;
    const auto flag = [&first](bool enabled, const char* name) {
        if (enabled) { std::printf("%s\"%s\"", first ? "" : ",", name); first = false; }
    };
    flag(avx2, "avx2"); flag(fma, "fma"); flag(f16c, "f16c"); flag(bmi2, "bmi2");
    std::printf("],\"availablePhysicalBytes\":%llu,\"totalPhysicalBytes\":%llu,"
        "\"logicalCpus\":%lu,\"affinityLogicalCpus\":%u,\"inJob\":%s,\"jobLimitsKnown\":false}\n",
        memory.ullAvailPhys, memory.ullTotalPhys, GetActiveProcessorCount(ALL_PROCESSOR_GROUPS),
        count, inJob ? "true" : "false");
}
