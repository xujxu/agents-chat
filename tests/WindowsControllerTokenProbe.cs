using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace DeploymentTests
{
    public static class WindowsControllerTokenProbe
    {
        const int TokenUser = 1, TokenPrivileges = 3, TokenOwner = 4, TokenSession = 12, TokenElevation = 20, TokenIntegrity = 25;
        const uint TokenAssignPrimary = 1, TokenDuplicate = 2, TokenQuery = 8, TokenAdjustDefault = 0x80;
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct Startup
        {
            public int cb;
            public string reserved, desktop, title;
            public int x, y, width, height, columns, rows, fill, flags;
            public short show, reservedBytes;
            public IntPtr reservedData, input, output, error;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInformation
        {
            public IntPtr process, thread;
            public uint pid, tid;
        }
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool DuplicateTokenEx(SafeAccessTokenHandle token, uint access, IntPtr security,
            int impersonation, int type, out SafeAccessTokenHandle copy);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(SafeAccessTokenHandle token, int type, IntPtr buffer, int size, out int needed);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool SetTokenInformation(SafeAccessTokenHandle token, int type, IntPtr buffer, int size);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessWithTokenW(SafeAccessTokenHandle token, uint logon, string application,
            StringBuilder command, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInformation process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint ResumeThread(SafeWaitHandle thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateProcess(SafeProcessHandle process, uint code);

        static void Native(bool success, string stage)
        {
            if (!success)
            {
                int error = Marshal.GetLastWin32Error();
                throw new Win32Exception(error, stage + " (Win32 " + error + ").");
            }
        }
        static string Information(SafeAccessTokenHandle token, int type, bool sid)
        {
            bool fixedSize = type == TokenElevation || type == TokenSession;
            int needed = 4;
            if (!fixedSize)
            {
                bool sized = GetTokenInformation(token, type, IntPtr.Zero, 0, out needed);
                int error = Marshal.GetLastWin32Error();
                if (sized || error != 122 || needed < (sid ? IntPtr.Size : 4) || needed > 65536)
                    throw new InvalidOperationException("Invalid token information size: class=" + type +
                        ", bytes=" + needed + ", error=" + error + ", returned=" + sized + ".");
            }
            int capacity = needed;
            IntPtr data = Marshal.AllocHGlobal(needed);
            try
            {
                Native(GetTokenInformation(token, type, data, capacity, out needed), "Read token information class " + type);
                if (needed < (sid ? IntPtr.Size : 4) || needed > capacity || fixedSize && needed != 4)
                    throw new InvalidOperationException("Invalid returned token information size for class " + type + ".");
                if (sid) return new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;
                byte[] bytes = new byte[needed];
                Marshal.Copy(data, bytes, 0, needed);
                return Convert.ToHexString(bytes);
            }
            finally { Marshal.FreeHGlobal(data); }
        }
        static string Permissions(SafeAccessTokenHandle token)
        {
            return Information(token, TokenUser, true) + ":" + Information(token, TokenPrivileges, false) + ":" +
                Information(token, TokenElevation, false) + ":" + Information(token, TokenIntegrity, true) + ":" +
                Information(token, TokenSession, false);
        }
        static string Quote(string value)
        {
            if (String.IsNullOrEmpty(value) || value.Contains('"') || value.Contains('\0') || value.EndsWith("\\"))
                throw new ArgumentException("Unsupported literal fixture argument.");
            return "\"" + value + "\"";
        }
        public static string Run(string pwsh, string childScript, string source, string node,
            string root, string job, int parentPid, string parentIdentity)
        {
            SafeAccessTokenHandle original;
            Native(OpenProcessToken(new IntPtr(-1), TokenQuery | TokenDuplicate, out original), "Open original controller token");
            using (original)
            {
                string owner = Information(original, TokenOwner, true);
                string user = Information(original, TokenUser, true);
                string permissions = Permissions(original);
                SafeAccessTokenHandle copy;
                Native(DuplicateTokenEx(original, TokenAssignPrimary | TokenDuplicate | TokenQuery | TokenAdjustDefault,
                    IntPtr.Zero, 2, 1, out copy), "Duplicate controller primary token");
                using (copy)
                {
                    var sid = new SecurityIdentifier(user);
                    byte[] bytes = new byte[sid.BinaryLength];
                    sid.GetBinaryForm(bytes, 0);
                    IntPtr sidData = Marshal.AllocHGlobal(bytes.Length);
                    IntPtr descriptor = Marshal.AllocHGlobal(IntPtr.Size);
                    try
                    {
                        Marshal.Copy(bytes, 0, sidData, bytes.Length);
                        Marshal.WriteIntPtr(descriptor, sidData);
                        Native(SetTokenInformation(copy, TokenOwner, descriptor, IntPtr.Size), "Set copied token default owner");
                    }
                    finally { Marshal.FreeHGlobal(descriptor); Marshal.FreeHGlobal(sidData); }
                    if (Information(copy, TokenOwner, true) != user || Permissions(copy) != permissions ||
                        Information(original, TokenOwner, true) != owner)
                        throw new InvalidOperationException("Copied token changed caller identity or privileges.");
                    var command = new StringBuilder(String.Join(" ", Array.ConvertAll(new[] {
                        pwsh, "-NoProfile", "-NonInteractive", "-File", childScript, "-Source", source,
                        "-Node", node, "-Root", root, "-JobName", job, "-OwnerPid", parentPid.ToString(),
                        "-OwnerIdentity", parentIdentity
                    }, Quote)));
                    IntPtr environment = Marshal.StringToHGlobalUni(
                        "SystemRoot=" + Environment.GetEnvironmentVariable("SystemRoot") + "\0TEMP=" + root + "\0TMP=" + root + "\0\0");
                    try
                    {
                        var startup = new Startup { cb = Marshal.SizeOf<Startup>() };
                        ProcessInformation info;
                        Native(CreateProcessWithTokenW(copy, 0, pwsh, command, 0x404, environment, root,
                            ref startup, out info), "Create suspended private-owner fixture");
                        using (var process = new SafeProcessHandle(info.process, true))
                        using (var thread = new SafeWaitHandle(info.thread, true))
                        {
                            try
                            {
                                SafeAccessTokenHandle actual;
                                Native(OpenProcessToken(info.process, TokenQuery, out actual), "Inspect created controller token");
                                using (actual)
                                    if (Information(actual, TokenOwner, true) != user || Permissions(actual) != permissions)
                                        throw new InvalidOperationException("Created controller token differs before admission.");
                                Native(ResumeThread(thread) != UInt32.MaxValue, "Resume private-owner fixture");
                                uint wait = WaitForSingleObject(process, 30000);
                                if (wait == UInt32.MaxValue) Native(false, "Wait for private-owner fixture");
                                if (wait != 0) throw new TimeoutException("Private-owner fixture did not exit.");
                                uint code;
                                Native(GetExitCodeProcess(process, out code), "Read private-owner fixture result");
                                if (code != 0) throw new InvalidOperationException("Private-owner fixture failed: " + code);
                            }
                            finally
                            {
                                uint wait = WaitForSingleObject(process, 0);
                                if (wait == UInt32.MaxValue) Native(false, "Inspect original fixture process");
                                if (wait == 258)
                                {
                                    Native(TerminateProcess(process, 1), "Stop original fixture process");
                                    if (WaitForSingleObject(process, 15000) != 0)
                                        throw new InvalidOperationException("Original fixture process did not settle.");
                                }
                            }
                        }
                    }
                    finally { Marshal.FreeHGlobal(environment); }
                }
                if (Information(original, TokenOwner, true) != owner || Permissions(original) != permissions)
                    throw new InvalidOperationException("Original caller token changed.");
                return owner;
            }
        }
    }
}
