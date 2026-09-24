#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <new>
#include <string>
#include <vector>

struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    ~Handle() {
        if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
    }
};

struct Attributes {
    std::vector<unsigned char> storage;
    LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
    ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
};

struct NativeError { DWORD code; };

void require(BOOL ok) {
    if (!ok) throw NativeError{ GetLastError() };
}

std::wstring quote(const std::wstring& input) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t value : input) {
        if (value == L'\\') { ++slashes; continue; }
        if (value == L'"') result.append(slashes * 2 + 1, L'\\');
        else result.append(slashes, L'\\');
        slashes = 0;
        result.push_back(value);
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'"');
    return result;
}

bool cancelled(HANDLE control) {
    DWORD bytes = 0;
    if (PeekNamedPipe(control, nullptr, 0, nullptr, &bytes, nullptr)) return bytes != 0;
    const DWORD error = GetLastError();
    if (error == ERROR_BROKEN_PIPE) return true;
    throw NativeError{ error };
}

void terminateAndWait(HANDLE job) {
    require(TerminateJobObject(job, 126));
    const ULONGLONG end = GetTickCount64() + 5000;
    for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        require(QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
            &accounting, sizeof(accounting), nullptr));
        if (accounting.ActiveProcesses == 0) return;
        if (GetTickCount64() >= end) throw NativeError{ WAIT_TIMEOUT };
        Sleep(10);
    }
}

int execute(int argc, wchar_t** argv) {
    if (argc < 3) throw NativeError{ ERROR_INVALID_PARAMETER };
    const std::wstring deadlineText = argv[1];
    if (deadlineText.empty() || deadlineText.find_first_not_of(L"0123456789") != std::wstring::npos) {
        throw NativeError{ ERROR_INVALID_PARAMETER };
    }
    const unsigned long timeout = std::wcstoul(argv[1], nullptr, 10);
    if (timeout == 0 || timeout > 120000) throw NativeError{ ERROR_INVALID_PARAMETER };
    const std::wstring executable = argv[2];
    const bool drive = !executable.empty() && ((executable[0] >= L'A' && executable[0] <= L'Z')
        || (executable[0] >= L'a' && executable[0] <= L'z'));
    if (!drive || executable.size() < 3 || executable[1] != L':' ||
        (executable[2] != L'\\' && executable[2] != L'/') ||
        executable.find(L':', 2) != std::wstring::npos) {
        throw NativeError{ ERROR_BAD_PATHNAME };
    }
    HANDLE control = GetStdHandle(STD_INPUT_HANDLE);
    if (cancelled(control)) return 126;
    const ULONGLONG deadline = GetTickCount64() + timeout;

    Handle job;
    job.value = CreateJobObjectW(nullptr, nullptr);
    require(job.value != nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
        &limits, sizeof(limits)));

    SECURITY_ATTRIBUTES inherit{ sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
    Handle input, output, errorOutput;
    input.value = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(input.value != INVALID_HANDLE_VALUE);
    errorOutput.value = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(errorOutput.value != INVALID_HANDLE_VALUE);
    require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE),
        GetCurrentProcess(), &output.value, 0, TRUE, DUPLICATE_SAME_ACCESS));
    HANDLE inherited[] = { input.value, output.value, errorOutput.value };

    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
    if (!bytes) throw NativeError{ GetLastError() };
    Attributes attributes;
    attributes.storage.resize(bytes);
    auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.storage.data());
    require(InitializeProcThreadAttributeList(list, 2, 0, &bytes));
    attributes.list = list;
    require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited, sizeof(inherited), nullptr, nullptr));
    // Atomic membership also covers launcher death before the engine resumes.
    require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        &job.value, sizeof(job.value), nullptr, nullptr));

    std::wstring command;
    for (int i = 2; i < argc; ++i) {
        if (i != 2) command.push_back(L' ');
        command += quote(argv[i]);
    }
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.value;
    startup.StartupInfo.hStdOutput = output.value;
    startup.StartupInfo.hStdError = errorOutput.value;
    startup.lpAttributeList = list;
    PROCESS_INFORMATION info{};
    require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
        nullptr, nullptr, &startup.StartupInfo, &info));
    Handle process, thread;
    process.value = info.hProcess;
    thread.value = info.hThread;
    BOOL owned = FALSE;
    require(IsProcessInJob(process.value, job.value, &owned));
    if (!owned) throw NativeError{ ERROR_ACCESS_DENIED };
    if (cancelled(control)) { terminateAndWait(job.value); return 126; }
    require(ResumeThread(thread.value) != static_cast<DWORD>(-1));

    DWORD result = 125;
    for (;;) {
        const DWORD wait = WaitForSingleObject(process.value, 20);
        if (wait == WAIT_OBJECT_0) {
            require(GetExitCodeProcess(process.value, &result));
            break;
        }
        if (wait != WAIT_TIMEOUT) throw NativeError{ GetLastError() };
        if (cancelled(control)) { result = 126; break; }
        if (GetTickCount64() >= deadline) { result = 124; break; }
    }
    terminateAndWait(job.value);
    return static_cast<int>(result);
}

int wmain(int argc, wchar_t** argv) {
    try { return execute(argc, argv); }
    catch (const NativeError& error) {
        std::fprintf(stderr, "voice_job_error:%lu\n", error.code);
        return 125;
    } catch (const std::bad_alloc&) {
        std::fprintf(stderr, "voice_job_error:%lu\n", static_cast<DWORD>(ERROR_NOT_ENOUGH_MEMORY));
        return 125;
    }
}
