#pragma once
#include <windows.h>

struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    ~Handle() {
        if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
    }
};

struct NativeError { DWORD code; };

inline void require(BOOL ok) {
    if (!ok) throw NativeError{ GetLastError() };
}
