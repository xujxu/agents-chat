using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Deployment
{
    public static class WindowsRuntimePipe
    {
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes
        {
            public uint Length;
            public IntPtr Descriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafePipeHandle CreateNamedPipeW(string name, uint mode, uint pipeMode,
            uint instances, uint outputBytes, uint inputBytes, uint timeout, ref SecurityAttributes attributes);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetHandleInformation(SafePipeHandle handle, out uint flags);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string text, uint revision, out IntPtr descriptor, out uint size);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetKernelObjectSecurity(SafePipeHandle handle, uint information,
            [Out] byte[] descriptor, uint size, out uint needed);
        [DllImport("kernel32.dll")]
        static extern IntPtr LocalFree(IntPtr memory);

        static void Check(bool result, string operation)
        {
            if (!result) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
        static string Name(Guid generation)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException("Windows runtime pipes require Windows.");
            if (generation == Guid.Empty) throw new ArgumentException("Runtime generation must not be empty.");
            return "agents-chat-runtime-" + generation.ToString("D");
        }

        public static NamedPipeServerStream Create(Guid generation)
        {
            string name = Name(generation);
            string sid;
            using (WindowsIdentity account = WindowsIdentity.GetCurrent()) sid = account.User.Value;
            IntPtr descriptor;
            uint size;
            Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                "D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1, out descriptor, out size),
                "Create private runtime pipe DACL");
            SafePipeHandle handle = null;
            NamedPipeServerStream pipe = null;
            List<Exception> errors = new List<Exception>();
            try
            {
                SecurityAttributes attributes = new SecurityAttributes {
                    Length = (uint)Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = false
                };
                const uint duplex = 3, firstInstance = 0x80000, overlapped = 0x40000000, rejectRemote = 8;
                handle = CreateNamedPipeW(@"\\.\pipe\" + name, duplex | firstInstance | overlapped,
                    rejectRemote, 1, 65536, 65536, 0, ref attributes);
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Create original runtime pipe");
                uint flags;
                Check(GetHandleInformation(handle, out flags), "Inspect runtime pipe handle");
                if ((flags & 1) != 0) throw new InvalidOperationException("Runtime pipe handle is inheritable.");
                pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
                handle = null;
            }
            catch (Exception error) { errors.Add(error); }
            if (LocalFree(descriptor) != IntPtr.Zero)
                errors.Add(new InvalidOperationException("Freeing runtime pipe descriptor failed."));
            if (handle != null) handle.Dispose();
            if (errors.Count != 0)
            {
                if (pipe != null) pipe.Dispose();
                throw errors.Count == 1 ? errors[0] : new AggregateException(errors);
            }
            return pipe;
        }

        public static byte[] SecurityDescriptor(PipeStream pipe)
        {
            if (pipe == null) throw new ArgumentNullException("pipe");
            uint needed;
            bool success = GetKernelObjectSecurity(pipe.SafePipeHandle, 4, null, 0, out needed);
            int error = Marshal.GetLastWin32Error();
            if (success || error != 122 || needed < 20 || needed > 4096)
                throw new InvalidDataException("Invalid runtime pipe DACL size.");
            byte[] descriptor = new byte[needed];
            uint returned;
            Check(GetKernelObjectSecurity(pipe.SafePipeHandle, 4, descriptor, needed, out returned),
                "Read runtime pipe DACL");
            if (returned != needed) throw new InvalidDataException("Runtime pipe DACL changed during query.");
            return descriptor;
        }

        public static NamedPipeClientStream Connect(Guid generation, int serverPid, string identity, int timeoutMilliseconds)
        {
            string name = Name(generation);
            if (serverPid < 1) throw new ArgumentOutOfRangeException("serverPid");
            if (identity == null || identity.Length == 0 || identity.Length > 64)
                throw new ArgumentException("An original runtime pipe owner identity is required.");
            if (timeoutMilliseconds < 1 || timeoutMilliseconds > 30000)
                throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            using (Process expected = Process.GetProcessById(serverPid))
            {
                if (expected.Handle == IntPtr.Zero || expected.HasExited ||
                    identity != serverPid.ToString(CultureInfo.InvariantCulture) + ":" +
                        expected.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture))
                    throw new InvalidOperationException("Runtime pipe owner identity changed.");
                NamedPipeClientStream client = new NamedPipeClientStream(".", name, PipeDirection.InOut,
                    PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
                try
                {
                    client.Connect(timeoutMilliseconds);
                    uint actual;
                    Check(GetNamedPipeServerProcessId(client.SafePipeHandle, out actual), "Read runtime pipe server PID");
                    if (actual != serverPid || expected.HasExited)
                        throw new InvalidOperationException("Runtime pipe server identity differs.");
                    return client;
                }
                catch
                {
                    client.Dispose();
                    throw;
                }
            }
        }
    }
}
