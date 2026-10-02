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
        const int TokenUser = 1, TokenPrivileges = 3, TokenOwner = 4, TokenStatistics = 10,
            TokenSession = 12, TokenElevation = 20, TokenIntegrity = 25;
        const uint TokenQuery = 8, TokenAdjustDefault = 0x80;
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
        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedStartup
        {
            public Startup startup;
            public IntPtr attributes;
        }
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(SafeAccessTokenHandle token, int type, IntPtr buffer, int size, out int needed);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool SetTokenInformation(SafeAccessTokenHandle token, int type, IntPtr buffer, int size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
            ref ExtendedStartup startup, out ProcessInformation process);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle OpenJobObjectW(uint access, bool inherit, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool IsProcessInJob(SafeProcessHandle process, SafeFileHandle job, out bool member);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value,
            UIntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")]
        static extern void DeleteProcThreadAttributeList(IntPtr list);
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
            bool fixedSize = type == TokenElevation || type == TokenSession || type == TokenStatistics;
            int needed = type == TokenStatistics ? 56 : 4;
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
                if (needed < (sid ? IntPtr.Size : 4) || needed > capacity || fixedSize && needed != capacity)
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
        static void RequireMembership(SafeProcessHandle process, SafeFileHandle job)
        {
            bool member;
            Native(IsProcessInJob(process, job, out member), "Inspect original child Job membership");
            if (!member) throw new InvalidOperationException("Suspended child was not created in the original Job.");
        }
        static void RequireOriginal(SafeAccessTokenHandle original, string owner, string permissions, string statistics)
        {
            if (Information(original, TokenOwner, true) != owner || Permissions(original) != permissions ||
                Information(original, TokenStatistics, false) != statistics)
                throw new InvalidOperationException("Original caller token changed.");
        }
        static void SetOwner(SafeAccessTokenHandle token, string user)
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
                Native(SetTokenInformation(token, TokenOwner, descriptor, IntPtr.Size), "Set distinct child token default owner");
            }
            finally { Marshal.FreeHGlobal(descriptor); Marshal.FreeHGlobal(sidData); }
        }
        public static string Run(string pwsh, string childScript, string source, string node,
            string root, string job, int parentPid, string parentIdentity)
        {
            SafeAccessTokenHandle original;
            Native(OpenProcessToken(new IntPtr(-1), TokenQuery, out original), "Open original controller token");
            using (original)
            using (SafeFileHandle originalJob = OpenJobObjectW(5, false, job))
            {
                Native(!originalJob.IsInvalid, "Open original fixture Job");
                string owner = Information(original, TokenOwner, true);
                string user = Information(original, TokenUser, true);
                string permissions = Permissions(original);
                string statistics = Information(original, TokenStatistics, false);
                UIntPtr size = UIntPtr.Zero;
                bool sized = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                int sizeError = Marshal.GetLastWin32Error();
                if (sized || sizeError != 122 || size.ToUInt64() == 0 || size.ToUInt64() > 65536)
                    throw new InvalidOperationException("Invalid process attribute list size (Win32 " + sizeError + ").");
                IntPtr attributes = Marshal.AllocHGlobal((int)size.ToUInt64());
                IntPtr jobValue = Marshal.AllocHGlobal(IntPtr.Size);
                bool initialized = false;
                try
                {
                    Native(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "Initialize original Job startup attributes");
                    initialized = true;
                    Marshal.WriteIntPtr(jobValue, originalJob.DangerousGetHandle());
                    Native(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x2000d), jobValue,
                        new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Bind original Job at process creation");
                    var command = new StringBuilder(String.Join(" ", Array.ConvertAll(new[] {
                        pwsh, "-NoProfile", "-NonInteractive", "-File", childScript, "-Source", source,
                        "-Node", node, "-Root", root, "-OwnerPid", parentPid.ToString(),
                        "-OwnerIdentity", parentIdentity
                    }, Quote)));
                    IntPtr environment = Marshal.StringToHGlobalUni(
                        "SystemRoot=" + Environment.GetEnvironmentVariable("SystemRoot") + "\0TEMP=" + root + "\0TMP=" + root + "\0\0");
                    try
                    {
                        var startup = new ExtendedStartup {
                            startup = new Startup { cb = Marshal.SizeOf<ExtendedStartup>() }, attributes = attributes
                        };
                        ProcessInformation info;
                        Native(CreateProcessW(pwsh, command, IntPtr.Zero, IntPtr.Zero, false, 0x80404,
                            environment, root, ref startup, out info), "Create suspended original-Job fixture");
                        using (var process = new SafeProcessHandle(info.process, true))
                        using (var thread = new SafeWaitHandle(info.thread, true))
                        {
                            try
                            {
                                RequireMembership(process, originalJob);
                                SafeAccessTokenHandle actual;
                                Native(OpenProcessToken(info.process, TokenQuery | TokenAdjustDefault, out actual), "Inspect created controller token");
                                using (actual)
                                {
                                    string childStatistics = Information(actual, TokenStatistics, false);
                                    // TOKEN_STATISTICS starts with two LUIDs; its primary-token type is at byte 24.
                                    if (childStatistics.Substring(0, 16) == statistics.Substring(0, 16) ||
                                        childStatistics.Substring(16, 16) != statistics.Substring(16, 16) ||
                                        childStatistics.Substring(48, 8) != "01000000" ||
                                        Information(actual, TokenOwner, true) != owner || Permissions(actual) != permissions)
                                        throw new InvalidOperationException("Created child token is shared or differs before admission.");
                                    SetOwner(actual, user);
                                    if (Information(actual, TokenOwner, true) != user || Permissions(actual) != permissions ||
                                        Information(actual, TokenStatistics, false).Substring(0, 16) != childStatistics.Substring(0, 16))
                                        throw new InvalidOperationException("Distinct child token changed identity or privileges.");
                                    RequireOriginal(original, owner, permissions, statistics);
                                }
                                RequireMembership(process, originalJob);
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
                finally
                {
                    if (initialized) DeleteProcThreadAttributeList(attributes);
                    Marshal.FreeHGlobal(jobValue);
                    Marshal.FreeHGlobal(attributes);
                }
                RequireOriginal(original, owner, permissions, statistics);
                return owner;
            }
        }
    }
}
