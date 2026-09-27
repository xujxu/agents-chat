#define _WIN32_WINNT 0x0A00
#include "voice-native.h"
#include "voice-files.h"
#include <sddl.h>
#include <string>
#include <vector>

struct LocalMemory {
    HLOCAL value = nullptr;
    ~LocalMemory() { if (value) LocalFree(value); }
};

void createPrivateDirectory(const wchar_t* directory) {
    wchar_t volume[32768]{};
    require(GetVolumePathNameW(directory, volume, 32768));
    DWORD flags = 0;
    require(GetVolumeInformationW(volume, nullptr, 0, nullptr, nullptr, &flags, nullptr, 0));
    if (!(flags & FILE_PERSISTENT_ACLS)) throw NativeError{ ERROR_NOT_SUPPORTED };
    Handle token;
    require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value));
    DWORD bytes = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &bytes);
    if (!bytes) throw NativeError{ GetLastError() };
    std::vector<unsigned char> user(bytes);
    require(GetTokenInformation(token.value, TokenUser, user.data(), bytes, &bytes));
    LPWSTR sid = nullptr;
    require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, &sid));
    LocalMemory sidOwner;
    sidOwner.value = sid;
    const std::wstring sddl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;"
        + std::wstring(sid) + L")";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr));
    LocalMemory descriptorOwner;
    descriptorOwner.value = descriptor;
    SECURITY_ATTRIBUTES attributes{ sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE };
    require(CreateDirectoryW(directory, &attributes));
}

void writeTranscript(const wchar_t* file) {
    Handle handle;
    handle.value = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    require(handle.value != INVALID_HANDLE_VALUE);
    if (GetFileType(handle.value) != FILE_TYPE_DISK) throw NativeError{ ERROR_INVALID_DATA };
    BY_HANDLE_FILE_INFORMATION info{};
    require(GetFileInformationByHandle(handle.value, &info));
    if ((info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        || info.nNumberOfLinks != 1 || info.nFileSizeHigh || info.nFileSizeLow > 32768) {
        throw NativeError{ ERROR_INVALID_DATA };
    }
    std::vector<unsigned char> bytes(32769);
    DWORD total = 0;
    while (total < bytes.size()) {
        DWORD count = 0;
        require(ReadFile(handle.value, bytes.data() + total,
            static_cast<DWORD>(bytes.size()) - total, &count, nullptr));
        if (!count) break;
        total += count;
    }
    if (total > 32768) throw NativeError{ ERROR_INVALID_DATA };
    DWORD sent = 0;
    while (sent < total) {
        DWORD count = 0;
        require(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes.data() + sent,
            total - sent, &count, nullptr));
        if (!count) throw NativeError{ ERROR_WRITE_FAULT };
        sent += count;
    }
}
