#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>

int main() {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
    if (!QueryInformationJobObject(nullptr, JobObjectExtendedLimitInformation,
        &limits, sizeof(limits), nullptr)) return 1;
    if (!QueryInformationJobObject(nullptr, JobObjectCpuRateControlInformation,
        &cpu, sizeof(cpu), nullptr)) return 2;
    std::printf("{\"limitFlags\":%lu,\"cpuControlFlags\":%lu}",
        limits.BasicLimitInformation.LimitFlags, cpu.ControlFlags);
    return 0;
}
