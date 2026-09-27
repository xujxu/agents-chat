using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Deployment
{
    public sealed class WindowsWorkerJob : IDisposable
    {
        const uint KillOnCloseFlag = 0x2000;
        const uint QueryAndAssign = 0x0001 | 0x0004;
        const int MaximumMembers = 4096;
        IntPtr handle;
        public string Name { get; private set; }
        public string AccountSid { get; private set; }
        public int SessionId { get; private set; }
        public Guid Generation { get; private set; }
        public string OwnerIdentity { get; private set; }

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters
        {
            public ulong ReadOperations, WriteOperations, OtherOperations;
            public ulong ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes
        {
            public uint Length;
            public IntPtr Descriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObjectW(ref SecurityAttributes attributes, string name);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size, out uint returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetHandleInformation(IntPtr value, out uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr value);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")]
        static extern IntPtr LocalFree(IntPtr value);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string sddl, uint revision, out IntPtr descriptor, out uint size);

        static WindowsWorkerJob()
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || IntPtr.Size != 8
                || Marshal.SizeOf<BasicLimits>() != 64 || Marshal.SizeOf<ExtendedLimits>() != 144
                || Marshal.OffsetOf<ExtendedLimits>("Io").ToInt32() != 64)
                throw new PlatformNotSupportedException("Unsupported Windows Job ABI.");
        }

        static void Check(bool success, string operation)
        {
            if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
        static void CloseChecked(IntPtr value)
        {
            if (value != IntPtr.Zero) Check(CloseHandle(value), "CloseHandle(Job)");
        }
        IntPtr Retained()
        {
            if (handle == IntPtr.Zero) throw new ObjectDisposedException("WindowsWorkerJob");
            return handle;
        }
        static uint Limits(IntPtr job)
        {
            int size = Marshal.SizeOf<ExtendedLimits>();
            IntPtr memory = Marshal.AllocHGlobal(size);
            try
            {
                uint returned;
                Check(QueryInformationJobObject(job, 9, memory, (uint)size, out returned), "Query Job limits");
                if (returned != size) throw new InvalidDataException("Incomplete Job limit query.");
                return Marshal.PtrToStructure<ExtendedLimits>(memory).Basic.Flags;
            }
            finally { Marshal.FreeHGlobal(memory); }
        }
        public bool KillOnClose { get { return Limits(Retained()) == KillOnCloseFlag; } }
        public bool Inheritable
        {
            get
            {
                uint flags;
                Check(GetHandleInformation(Retained(), out flags), "Query Job handle inheritance");
                return (flags & 1) != 0;
            }
        }
        public static string ProcessIdentity(int pid)
        {
            using (Process process = Process.GetProcessById(pid))
                return pid + ":" + process.StartTime.ToUniversalTime().Ticks;
        }
        public static WindowsWorkerJob Create(Guid generation)
        {
            if (generation == Guid.Empty) throw new ArgumentException("Job generation must not be empty.");
            string sid;
            using (WindowsIdentity account = WindowsIdentity.GetCurrent()) sid = account.User.Value;
            IntPtr descriptor;
            uint size;
            Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                "D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1, out descriptor, out size), "Create private Job DACL");
            WindowsWorkerJob result = new WindowsWorkerJob();
            try
            {
                result.Name = @"Local\agents-deploy-" + generation.ToString("D");
                result.Generation = generation;
                result.AccountSid = sid;
                using (Process owner = Process.GetCurrentProcess())
                {
                    result.SessionId = owner.SessionId;
                    result.OwnerIdentity = ProcessIdentity(owner.Id);
                }
                SecurityAttributes attributes = new SecurityAttributes {
                    Length = (uint)Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = false
                };
                result.handle = CreateJobObjectW(ref attributes, result.Name);
                int error = Marshal.GetLastWin32Error();
                if (result.handle == IntPtr.Zero) throw new Win32Exception(error, "CreateJobObject");
                if (error == 183) throw new InvalidOperationException("Named Job already exists; no changes made.");
                ExtendedLimits limits = new ExtendedLimits();
                limits.Basic.Flags = KillOnCloseFlag;
                Check(SetInformationJobObject(result.handle, 9, ref limits,
                    (uint)Marshal.SizeOf<ExtendedLimits>()), "Set Job kill-on-close");
                if (!result.KillOnClose || result.Inheritable)
                    throw new InvalidOperationException("Unsafe Job limit or handle inheritance.");
            }
            catch (Exception original)
            {
                try { result.Dispose(); }
                catch (Exception cleanup) { throw new AggregateException(original, cleanup); }
                throw;
            }
            finally
            {
                if (LocalFree(descriptor) != IntPtr.Zero)
                    throw new InvalidOperationException("Freeing Job security descriptor failed.");
            }
            return result;
        }
        public static void JoinCurrent(string name)
        {
            const string prefix = @"Local\agents-deploy-";
            Guid generation;
            if (name == null || !name.StartsWith(prefix, StringComparison.Ordinal)
                || !Guid.TryParseExact(name.Substring(prefix.Length), "D", out generation)
                || generation == Guid.Empty) throw new ArgumentException("Invalid Job name.");
            IntPtr job = OpenJobObjectW(QueryAndAssign, false, name);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open original Job");
            Exception failure = null;
            try
            {
                if (Limits(job) != KillOnCloseFlag) throw new InvalidOperationException("Unsafe original Job limits.");
                Check(AssignProcessToJobObject(job, GetCurrentProcess()), "Assign gated launcher to Job");
                bool member;
                Check(IsProcessInJob(GetCurrentProcess(), job, out member), "Verify launcher Job membership");
                if (!member) throw new InvalidOperationException("Launcher was not assigned to Job.");
            }
            catch (Exception error) { failure = error; }
            try { CloseChecked(job); }
            catch (Exception error)
            {
                if (failure != null) throw new AggregateException(failure, error);
                throw;
            }
            if (failure != null) throw failure;
        }
        public long[] Members()
        {
            int size = 8 + MaximumMembers * IntPtr.Size;
            IntPtr memory = Marshal.AllocHGlobal(size);
            try
            {
                uint returned;
                Check(QueryInformationJobObject(Retained(), 3, memory, (uint)size, out returned), "Query original Job members");
                uint assigned = (uint)Marshal.ReadInt32(memory, 0);
                uint listed = (uint)Marshal.ReadInt32(memory, 4);
                if (assigned != listed || listed > MaximumMembers || returned < 8 + listed * IntPtr.Size
                    || returned > size) throw new InvalidDataException("Incomplete Job process enumeration.");
                long[] members = new long[listed];
                HashSet<long> seen = new HashSet<long>();
                for (int index = 0; index < members.Length; index++)
                {
                    long pid = Marshal.ReadIntPtr(memory, 8 + index * IntPtr.Size).ToInt64();
                    if (pid < 1 || pid > Int32.MaxValue || !seen.Add(pid))
                        throw new InvalidDataException("Invalid Job process identity.");
                    members[index] = pid;
                }
                return members;
            }
            finally { Marshal.FreeHGlobal(memory); }
        }
        public void Terminate() { Check(TerminateJobObject(Retained(), 1), "Terminate original Job"); }
        public void Dispose()
        {
            if (handle == IntPtr.Zero) return;
            CloseChecked(handle);
            handle = IntPtr.Zero;
        }
    }

    public static class WindowsWorkerLauncher
    {
        public static IDisposable WatchOwner(int pid, string identity)
        {
            if (WindowsWorkerJob.ProcessIdentity(pid) != identity) throw new InvalidOperationException("Owner identity changed.");
            return new Timer(state => {
                try { if (WindowsWorkerJob.ProcessIdentity(pid) != identity) Environment.Exit(1); }
                catch { Environment.Exit(1); }
            }, null, 250, 250);
        }
        public static string ReadFrame()
        {
            StringBuilder frame = new StringBuilder();
            while (true)
            {
                int next = Console.In.Read();
                if (next == -1) throw new EndOfStreamException("Owner command pipe closed.");
                if (next == '\n') return frame.ToString();
                frame.Append((char)next);
                if (frame.Length > 65536 || Encoding.UTF8.GetByteCount(frame.ToString()) > 65536)
                    throw new InvalidDataException("Native command exceeds limit.");
            }
        }
        sealed class Tail
        {
            readonly object gate = new object();
            byte[] tail = Array.Empty<byte>();
            public async Task Drain(Stream stream)
            {
                byte[] chunk = new byte[8192];
                int count;
                while ((count = await stream.ReadAsync(chunk, 0, chunk.Length).ConfigureAwait(false)) > 0)
                {
                    lock (gate)
                    {
                        int keep = Math.Min(tail.Length, 8192 - count);
                        byte[] next = new byte[keep + count];
                        Buffer.BlockCopy(tail, tail.Length - keep, next, 0, keep);
                        Buffer.BlockCopy(chunk, 0, next, keep, count);
                        tail = next;
                    }
                }
            }
            public string Base64() { lock (gate) return Convert.ToBase64String(tail); }
        }
        public sealed class Result
        {
            public string type = "result";
            public int exitCode;
            public string stdout, stderr;
        }
        public static Result Run(string file, string[] args, string cwd, Dictionary<string, string> env)
        {
            if (!Path.IsPathFullyQualified(file) || !Path.IsPathFullyQualified(cwd))
                throw new ArgumentException("Target file/cwd must be absolute.");
            ProcessStartInfo info = new ProcessStartInfo(file) {
                UseShellExecute = false, WorkingDirectory = cwd,
                RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
                CreateNoWindow = true
            };
            foreach (string arg in args) info.ArgumentList.Add(arg);
            info.Environment.Clear();
            foreach (KeyValuePair<string, string> pair in env) info.Environment.Add(pair.Key, pair.Value);
            using (Process target = Process.Start(info))
            {
                target.StandardInput.Close();
                Tail output = new Tail(), error = new Tail();
                Task stdout = output.Drain(target.StandardOutput.BaseStream);
                Task stderr = error.Drain(target.StandardError.BaseStream);
                target.WaitForExit();
                // Descendants may retain pipes after root exit. Never use EOF as settlement evidence.
                Task.WhenAll(stdout, stderr).Wait(500);
                if (stdout.IsFaulted) throw stdout.Exception;
                if (stderr.IsFaulted) throw stderr.Exception;
                return new Result { exitCode = target.ExitCode, stdout = output.Base64(), stderr = error.Base64() };
            }
        }
    }
}
