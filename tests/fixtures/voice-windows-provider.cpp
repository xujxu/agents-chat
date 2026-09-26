#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <cstring>
#include <fcntl.h>
#include <io.h>

namespace fs = std::filesystem;

int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring(argv[1]) == L"--sleep") { Sleep(120000); return 0; }
    std::wstring model, audio, output;
    bool sense = false;
    for (int i = 1; i + 1 < argc; ++i) {
        const std::wstring key = argv[i];
        if (key == L"-m") model = argv[i + 1];
        if (key == L"-a" || key == L"-f") { audio = argv[i + 1]; sense = key == L"-a"; }
        if (key == L"-of") output = std::wstring(argv[i + 1]) + L".txt";
    }
    if (model.empty() || audio.empty()) return 3;
    const fs::path directory = fs::path(audio).parent_path();
    std::ofstream(directory / "child.pid") << GetCurrentProcessId();
    std::ifstream modeFile{ fs::path(model) };
    std::string mode;
    modeFile >> mode;
    if (mode == "environment") {
        if (GetEnvironmentVariableW(L"VOICE_TEST_SECRET", nullptr, 0) != 0) return 3;
    }
    std::ifstream wav(fs::path(audio), std::ios::binary);
    char header[76]{};
    wav.read(header, sizeof(header));
    short sample = 0;
    if (wav.gcount() >= 76) {
        std::memcpy(&sample, header + 44, 2);
        for (int i = 1; i < 16; ++i) {
            short value = 0;
            std::memcpy(&value, header + 44 + i * 2, 2);
            if (value != sample) { sample = 0; break; }
        }
    }
    if (sample == 13107 || mode == "wait") {
        wchar_t self[32768]{};
        if (!GetModuleFileNameW(nullptr, self, 32768)) return 3;
        std::wstring command = L"\"" + std::wstring(self) + L"\" --sleep";
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION child{};
        if (!CreateProcessW(self, command.data(), nullptr, nullptr, FALSE,
            CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) return 3;
        std::ofstream(directory / "descendant.pid") << child.dwProcessId;
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
        Sleep(120000);
    }
    if (mode == "fail") return 3;
    if (mode == "fail124") return 124;
    std::vector<unsigned char> allocation;
    if (sample == 16384 || mode == "memory") {
        allocation.resize(400 * 1024 * 1024, 42);
        Sleep(500);
    }
    if (mode == "stderr") std::cerr << std::string(100000, 'x');
    Sleep(400);
    std::string text = "\xe4\xbd\xa0\xe5\xa5\xbd\xef\xbc\x8cvoice PoC.\n";
    if (mode == "empty") text = " \n";
    if (mode == "oversized") text.assign(32769, 'x');
    if (mode == "invalid") text = "\xff";
    if (mode == "nul") text = std::string("a\0b", 3);
    if (sense) {
        _setmode(_fileno(stdout), _O_BINARY);
        std::cout.write(text.data(), static_cast<std::streamsize>(text.size()));
    } else if (mode == "directory") {
        if (!CreateDirectoryW(output.c_str(), nullptr)) return 3;
    } else if (mode == "reparse") {
        if (!CreateSymbolicLinkW(output.c_str(), model.c_str(),
            SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE)) return 3;
    } else if (mode == "hardlink") {
        if (!CreateHardLinkW(output.c_str(), model.c_str(), nullptr)) return 3;
    } else if (mode != "missing") {
        std::ofstream result(fs::path(output), std::ios::binary);
        result.write(text.data(), static_cast<std::streamsize>(text.size()));
        if (!result) return 3;
    }
    return 0;
}
