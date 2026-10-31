using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Deployment
{
    public sealed class WindowsControllerProcess : IDisposable
    {
        WindowsWorkerJob job;
        WindowsPrivateFile.DirectoryLease directory;
        WindowsControllerToken token;
        SafeProcessHandle process;
        bool disposed;
        public int Id { get; private set; }
        public StreamWriter StandardInput { get; private set; }
        public StreamReader StandardOutput { get; private set; }
        public StreamReader StandardError { get; private set; }

        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes
        {
            public int length;
            public IntPtr descriptor;
            public int inherit;
        }
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
        struct ExtendedStartup
        {
            public Startup startup;
            public IntPtr attributes;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInformation
        {
            public IntPtr process, thread;
            public uint pid, tid;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity,
            IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd,
            ref ExtendedStartup startup, out ProcessInformation information);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SecurityAttributes security, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
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
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder name, ref uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder name, uint size, uint flags);

        WindowsControllerProcess() { }
        static void Native(bool success, string stage)
        {
            if (!success)
            {
                int error = Marshal.GetLastWin32Error();
                throw new Win32Exception(error, stage + " (Win32 " + error + ").");
            }
        }
        static void CanonicalPath(string value)
        {
            if (String.IsNullOrEmpty(value) || value.Length < 4 || value.Length > 4096 ||
                !Char.IsAsciiLetter(value[0]) || value[1] != ':' || value[2] != '\\' ||
                value.Substring(3).Contains(':') || value.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0 ||
                !String.Equals(Path.GetFullPath(value), value, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("A canonical local controller path is required.");
        }
        static string Quote(string value)
        {
            if (value == null || value.Contains('\0')) throw new ArgumentException("Invalid controller argument.");
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char item in value)
            {
                if (item == '\\') { slashes++; continue; }
                result.Append('\\', item == '"' ? slashes * 2 + 1 : slashes);
                result.Append(item);
                slashes = 0;
            }
            result.Append('\\', slashes * 2);
            return result.Append('"').ToString();
        }
        static string EnvironmentBlock(Dictionary<string, string> values)
        {
            if (values == null || values.Count > 128) throw new ArgumentException("An explicit bounded controller environment is required.");
            var ordered = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in values)
            {
                if (String.IsNullOrEmpty(entry.Key) || entry.Key.Length > 256 || entry.Key.IndexOfAny(new[] { '=', '\0' }) >= 0 ||
                    entry.Value == null || entry.Value.Contains('\0'))
                    throw new ArgumentException("Invalid controller environment entry.");
                ordered.Add(entry.Key, entry.Value);
            }
            string systemRoot;
            if (!ordered.TryGetValue("SystemRoot", out systemRoot)) throw new ArgumentException("Controller environment requires SystemRoot.");
            CanonicalPath(systemRoot);
            var result = new StringBuilder();
            foreach (var entry in ordered)
            {
                if (entry.Value.Length > 32767 || result.Length + entry.Key.Length + entry.Value.Length + 3 > 32767)
                    throw new ArgumentException("Controller environment exceeds its size limit.");
                result.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
            }
            return result.Append('\0').ToString();
        }
        static void RequireExecutable(SafeFileHandle file, string expected)
        {
            var path = new StringBuilder(4096);
            uint length = GetFinalPathNameByHandleW(file, path, (uint)path.Capacity, 0);
            Native(length != 0, "Resolve retained controller executable");
            if (length >= path.Capacity || !String.Equals(path.ToString(), @"\\?\" + expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Controller executable is redirected.");
        }
        void RequireCreatedProcess(SafeFileHandle originalJob, string executable)
        {
            bool member;
            Native(IsProcessInJob(process, originalJob, out member), "Inspect original controller Job membership");
            var image = new StringBuilder(4096);
            uint size = (uint)image.Capacity;
            Native(QueryFullProcessImageNameW(process, 0, image, ref size), "Inspect original controller executable");
            if (!member || !job.KillOnClose || job.Inheritable ||
                !String.Equals(image.ToString(), executable, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Controller process differs from its original executable or Job.");
        }
        public static WindowsControllerProcess Start(string executable, string[] arguments, string cwd, Dictionary<string, string> environment)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) throw new PlatformNotSupportedException("Native controller requires Windows.");
            CanonicalPath(executable);
            CanonicalPath(cwd);
            if (arguments == null || arguments.Length > 256) throw new ArgumentException("Invalid controller arguments.");
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments)
            {
                if (argument == null || argument.Length > 32767) throw new ArgumentException("Invalid controller argument.");
                command.Append(' ').Append(Quote(argument));
                if (command.Length > 32766) throw new ArgumentException("Controller command exceeds its size limit.");
            }
            string environmentText = EnvironmentBlock(environment);
            var controller = new WindowsControllerProcess();
            try
            {
                controller.directory = WindowsPrivateFile.OpenDirectory(cwd);
                controller.token = WindowsControllerToken.Capture();
                using (SafeFileHandle image = File.OpenHandle(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    RequireExecutable(image, executable);
                    controller.job = WindowsWorkerJob.Create(Guid.NewGuid());
                    controller.Launch(executable, command, cwd, environmentText, image);
                }
                return controller;
            }
            catch (Exception failure)
            {
                try { controller.Dispose(); }
                catch (Exception cleanup) { throw new AggregateException(failure, cleanup); }
                throw;
            }
        }
        void Launch(string executable, StringBuilder command, string cwd, string environmentText, SafeFileHandle image)
        {
            var handles = new List<SafeFileHandle>();
            IntPtr attributes = IntPtr.Zero, jobValue = IntPtr.Zero, ioValues = IntPtr.Zero, environment = IntPtr.Zero;
            bool initialized = false;
            try
            {
                SafeFileHandle inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite;
                CreatePair(handles, out inputRead, out inputWrite);
                CreatePair(handles, out outputRead, out outputWrite);
                CreatePair(handles, out errorRead, out errorWrite);
                foreach (SafeFileHandle handle in new[] { inputWrite, outputRead, errorRead })
                    Native(SetHandleInformation(handle, 1, 0), "Protect parent controller pipe handle");
                SafeFileHandle originalJob = OpenJobObjectW(5, false, job.Name);
                handles.Add(originalJob);
                {
                    Native(!originalJob.IsInvalid, "Open original controller Job");
                    UIntPtr size = UIntPtr.Zero;
                    bool sized = InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                    int error = Marshal.GetLastWin32Error();
                    if (sized || error != 122 || size.ToUInt64() == 0 || size.ToUInt64() > 65536)
                        throw new InvalidOperationException("Invalid controller startup attribute size.");
                    attributes = Marshal.AllocHGlobal((int)size.ToUInt64());
                    Native(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "Initialize controller startup attributes");
                    initialized = true;
                    jobValue = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.WriteIntPtr(jobValue, originalJob.DangerousGetHandle());
                    ioValues = Marshal.AllocHGlobal(IntPtr.Size * 3);
                    var inherited = new[] { inputRead, outputWrite, errorWrite };
                    for (int index = 0; index < inherited.Length; index++)
                        Marshal.WriteIntPtr(ioValues, index * IntPtr.Size, inherited[index].DangerousGetHandle());
                    Native(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x2000d), jobValue,
                        new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Assign original controller Job at creation");
                    Native(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x20002), ioValues,
                        new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero), "Restrict inherited controller handles");
                    environment = Marshal.StringToHGlobalUni(environmentText);
                    var startup = new ExtendedStartup {
                        startup = new Startup { cb = Marshal.SizeOf<ExtendedStartup>(), flags = 0x100,
                            input = inputRead.DangerousGetHandle(), output = outputWrite.DangerousGetHandle(), error = errorWrite.DangerousGetHandle() },
                        attributes = attributes
                    };
                    directory.Check();
                    ProcessInformation info;
                    Native(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80404,
                        environment, cwd, ref startup, out info), "Create suspended private controller");
                    using (var thread = new SafeWaitHandle(info.thread, true))
                    {
                        process = new SafeProcessHandle(info.process, true);
                        Id = checked((int)info.pid);
                        RequireCreatedProcess(originalJob, executable);
                        RequireExecutable(image, executable);
                        token.PrepareChild(process);
                        directory.Check();
                        RequireCreatedProcess(originalJob, executable);
                        StandardInput = new StreamWriter(new FileStream(inputWrite, FileAccess.Write), new UTF8Encoding(false, true)) {
                            AutoFlush = true, NewLine = "\n"
                        };
                        handles.Remove(inputWrite);
                        StandardOutput = new StreamReader(new FileStream(outputRead, FileAccess.Read), new UTF8Encoding(false, true), false);
                        handles.Remove(outputRead);
                        StandardError = new StreamReader(new FileStream(errorRead, FileAccess.Read), new UTF8Encoding(false, true), false);
                        handles.Remove(errorRead);
                        uint previous = ResumeThread(thread);
                        Native(previous != UInt32.MaxValue, "Resume admitted private controller");
                        if (previous != 1) throw new InvalidOperationException("Controller primary thread suspension changed.");
                    }
                }
            }
            finally
            {
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
                if (ioValues != IntPtr.Zero) Marshal.FreeHGlobal(ioValues);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                foreach (SafeFileHandle handle in handles) handle.Dispose();
            }
        }
        static void CreatePair(List<SafeFileHandle> handles, out SafeFileHandle read, out SafeFileHandle write)
        {
            var security = new SecurityAttributes { length = Marshal.SizeOf<SecurityAttributes>(), descriptor = IntPtr.Zero, inherit = 1 };
            bool created = CreatePipe(out read, out write, ref security, 4096);
            int error = Marshal.GetLastWin32Error();
            if (read != null) handles.Add(read);
            if (write != null) handles.Add(write);
            if (!created) throw new Win32Exception(error, "Create private controller pipe (Win32 " + error + ").");
        }
        void RequireOpen()
        {
            if (disposed || process == null) throw new ObjectDisposedException("Private controller");
        }
        public bool HasExited
        {
            get
            {
                RequireOpen();
                uint result = WaitForSingleObject(process, 0);
                Native(result != UInt32.MaxValue, "Inspect original controller process");
                if (result != 0 && result != 258) throw new InvalidOperationException("Unknown controller wait result.");
                return result == 0;
            }
        }
        public int ExitCode
        {
            get
            {
                if (!HasExited) throw new InvalidOperationException("Controller has not exited.");
                uint code;
                Native(GetExitCodeProcess(process, out code), "Read original controller exit code");
                return unchecked((int)code);
            }
        }
        public bool WaitForExit(int milliseconds)
        {
            RequireOpen();
            if (milliseconds < 0 || milliseconds > 3600000) throw new ArgumentOutOfRangeException("milliseconds");
            uint result = WaitForSingleObject(process, (uint)milliseconds);
            Native(result != UInt32.MaxValue, "Wait for original controller");
            if (result != 0 && result != 258) throw new InvalidOperationException("Unknown controller wait result.");
            directory.Check();
            token.Check();
            return result == 0;
        }
        public void Kill()
        {
            RequireOpen();
            StopJob();
            directory.Check();
            token.Check();
        }
        void StopJob()
        {
            if (job == null) return;
            bool policy = job.KillOnClose && !job.Inheritable;
            job.Terminate();
            var deadline = System.Diagnostics.Stopwatch.StartNew();
            while (job.Members().Length != 0 || process != null && !HasExited)
            {
                if (deadline.ElapsedMilliseconds >= 15000) throw new TimeoutException("Original controller Job did not settle.");
                Thread.Sleep(50);
            }
            if (!policy) throw new InvalidOperationException("Original controller Job policy changed.");
        }
        public void Dispose()
        {
            if (disposed) return;
            var errors = new List<Exception>();
            try { StopJob(); } catch (Exception error) { errors.Add(error); }
            if (directory != null) { try { directory.Check(); } catch (Exception error) { errors.Add(error); } }
            if (token != null) { try { token.Check(); } catch (Exception error) { errors.Add(error); } }
            foreach (IDisposable resource in new IDisposable[] { StandardInput, StandardOutput, StandardError, process, job, directory, token })
            {
                if (resource == null) continue;
                try { resource.Dispose(); } catch (Exception error) { errors.Add(error); }
            }
            disposed = true;
            if (errors.Count != 0) throw new AggregateException("Private controller cleanup failed.", errors);
        }
    }
}
