using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Deployment
{
    public sealed class WindowsRuntimeListenerNotReadyException : InvalidOperationException
    {
        public WindowsRuntimeListenerNotReadyException() : base("Runtime listener is not ready.") { }
    }

    public sealed class WindowsRuntimeListener : IDisposable
    {
        const uint InsufficientBuffer = 122, OwnerModuleListener = 6, MaximumTable = 16 * 1024 * 1024;
        [DllImport("iphlpapi.dll")]
        static extern uint GetExtendedTcpTable(IntPtr table, ref uint size,
            [MarshalAs(UnmanagedType.Bool)] bool order, uint family, uint tableClass, uint reserved);

        [StructLayout(LayoutKind.Sequential)]
        struct Row4
        {
            public uint State, LocalAddress, LocalPort, RemoteAddress, RemotePort, Pid;
            public long CreatedAt;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public ulong[] Module;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct Row6
        {
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] LocalAddress;
            public uint LocalScope, LocalPort;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] RemoteAddress;
            public uint RemoteScope, RemotePort, State, Pid;
            public long CreatedAt;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public ulong[] Module;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct Table4 { public uint Count; public Row4 First; }
        [StructLayout(LayoutKind.Sequential)]
        struct Table6 { public uint Count; public Row6 First; }

        sealed class Binding
        {
            public string Address;
            public int Pid, Port;
            public long CreatedAt;
        }
        readonly object gate = new object();
        readonly Guid generation;
        readonly int ownerPid, launcherPid, port;
        readonly string ownerIdentity;
        Process owner, listener;
        Binding binding;
        string listenerIdentity;
        bool disposed;

        public int ListenerPid { get { return binding.Pid; } }
        public string ListenerIdentity { get { return listenerIdentity; } }
        public string Address { get { return binding.Address; } }
        public int Port { get { return binding.Port; } }
        public string CreatedAt { get { return binding.CreatedAt.ToString(CultureInfo.InvariantCulture); } }

        WindowsRuntimeListener(Guid generation, int ownerPid, string ownerIdentity, int launcherPid, int port)
        {
            this.generation = generation;
            this.ownerPid = ownerPid;
            this.ownerIdentity = ownerIdentity;
            this.launcherPid = launcherPid;
            this.port = port;
        }
        static int DecodePort(uint value)
        {
            return unchecked((ushort)IPAddress.NetworkToHostOrder((short)value));
        }
        static void Add(List<Binding> matches, uint state, uint encodedPort, uint pid,
            long createdAt, IPAddress address, uint scope, int port)
        {
            if (DecodePort(encodedPort) != port) return;
            if (state != 2 || pid == 0 || pid > Int32.MaxValue || createdAt <= 0 || scope != 0)
                throw new InvalidDataException("Invalid native runtime listener binding.");
            matches.Add(new Binding { Address = address.ToString(), Pid = (int)pid, Port = port, CreatedAt = createdAt });
        }
        static void ReadTable(uint family, int port, List<Binding> matches)
        {
            uint size = 0;
            uint error = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, OwnerModuleListener, 0);
            if (error != InsufficientBuffer) throw new Win32Exception((int)error, "Cannot size native listener table.");
            int offset = Marshal.OffsetOf(family == 2 ? typeof(Table4) : typeof(Table6), "First").ToInt32();
            int stride = Marshal.SizeOf(family == 2 ? typeof(Row4) : typeof(Row6));
            for (int attempt = 0; attempt < 4; attempt++)
            {
                if (size < 4 || size > MaximumTable) throw new InvalidDataException("Native listener table exceeds its bound.");
                uint capacity = size;
                IntPtr table = Marshal.AllocHGlobal((int)capacity);
                try
                {
                    error = GetExtendedTcpTable(table, ref size, false, family, OwnerModuleListener, 0);
                    if (error == InsufficientBuffer) continue;
                    if (error != 0) throw new Win32Exception((int)error, "Cannot read native listener table.");
                    uint count = unchecked((uint)Marshal.ReadInt32(table));
                    if (size < 4 || size > capacity || count > 65536 ||
                        count > 0 && offset + (long)stride * count > capacity)
                        throw new InvalidDataException("Invalid native listener table layout.");
                    for (int index = 0; index < count; index++)
                    {
                        IntPtr row = IntPtr.Add(table, checked(offset + index * stride));
                        if (family == 2)
                        {
                            Row4 value = Marshal.PtrToStructure<Row4>(row);
                            Add(matches, value.State, value.LocalPort, value.Pid, value.CreatedAt,
                                new IPAddress(BitConverter.GetBytes(value.LocalAddress)), 0, port);
                        }
                        else
                        {
                            Row6 value = Marshal.PtrToStructure<Row6>(row);
                            Add(matches, value.State, value.LocalPort, value.Pid, value.CreatedAt,
                                new IPAddress(value.LocalAddress), value.LocalScope, port);
                        }
                    }
                    return;
                }
                finally { Marshal.FreeHGlobal(table); }
            }
            throw new InvalidOperationException("Native listener table did not stabilize.");
        }
        static Binding ReadBinding(int port)
        {
            var matches = new List<Binding>();
            ReadTable(2, port, matches);
            ReadTable(23, port, matches);
            if (matches.Count == 0) throw new WindowsRuntimeListenerNotReadyException();
            if (matches.Count != 1) throw new InvalidOperationException("Runtime listener is ambiguous.");
            Binding result = matches[0];
            IPAddress address = IPAddress.Parse(result.Address);
            if (!address.Equals(IPAddress.Loopback) && !address.Equals(IPAddress.Any) &&
                !address.Equals(IPAddress.IPv6Any) &&
                !(address.IsIPv4MappedToIPv6 && address.MapToIPv4().Equals(IPAddress.Loopback)))
                throw new InvalidOperationException("Runtime listener is not IPv4 loopback accessible.");
            return result;
        }
        void CheckOwner()
        {
            if (disposed) throw new ObjectDisposedException("Original runtime listener");
            if (owner == null || owner.HasExited || WindowsWorkerJob.ProcessIdentity(ownerPid) != ownerIdentity)
                throw new InvalidOperationException("Original runtime listener owner differs.");
        }
        HashSet<long> Members()
        {
            CheckOwner();
            string text = WindowsRuntimeControl.Exchange(generation, ownerPid, ownerIdentity, "observe", 15000);
            using (JsonDocument document = JsonDocument.Parse(text))
            {
                JsonElement root = document.RootElement;
                var fields = new HashSet<string>(new[] { "phase", "rootExitCode", "members", "applicationHealthy", "quiescent" },
                    StringComparer.Ordinal);
                foreach (JsonProperty field in root.EnumerateObject())
                    if (!fields.Remove(field.Name)) throw new InvalidDataException("Invalid runtime listener domain reply.");
                if (fields.Count != 0) throw new InvalidDataException("Incomplete runtime listener domain reply.");
                string phase = root.GetProperty("phase").GetString();
                if (root.GetProperty("quiescent").GetBoolean() || root.GetProperty("applicationHealthy").GetBoolean() ||
                    phase != "admitted" && phase != "root-exited")
                    throw new InvalidOperationException("Original runtime listener domain is not running.");
                JsonElement values = root.GetProperty("members");
                if (values.GetArrayLength() > 4096) throw new InvalidDataException("Runtime listener process inventory exceeds its bound.");
                var members = new HashSet<long>();
                foreach (JsonElement entry in values.EnumerateArray())
                {
                    long pid = entry.GetInt64();
                    if (pid <= 0 || pid > Int32.MaxValue || !members.Add(pid))
                        throw new InvalidDataException("Invalid runtime listener process inventory.");
                }
                if (!members.Contains(launcherPid))
                    throw new InvalidOperationException("Original runtime listener domain is not running.");
                CheckOwner();
                return members;
            }
        }
        public static WindowsRuntimeListener Retain(Guid generation, int ownerPid, string ownerIdentity, int launcherPid, int port)
        {
            if (generation == Guid.Empty || ownerPid <= 0 || launcherPid <= 0 || ownerPid == launcherPid ||
                String.IsNullOrEmpty(ownerIdentity) || ownerIdentity.Length > 64 || port < 1 || port > 65535)
                throw new ArgumentException("Explicit original runtime listener authority is required.");
            var retained = new WindowsRuntimeListener(generation, ownerPid, ownerIdentity, launcherPid, port);
            try
            {
                retained.owner = Process.GetProcessById(ownerPid);
                IntPtr ownerHandle = retained.owner.Handle;
                if (ownerHandle == IntPtr.Zero) throw new InvalidOperationException("Original runtime owner handle is unavailable.");
                HashSet<long> members = retained.Members();
                retained.binding = ReadBinding(port);
                if (!members.Contains(retained.binding.Pid))
                    throw new InvalidOperationException("Runtime listener is outside the original Job.");
                retained.listener = Process.GetProcessById(retained.binding.Pid);
                IntPtr listenerHandle = retained.listener.Handle;
                if (listenerHandle == IntPtr.Zero) throw new InvalidOperationException("Original listener handle is unavailable.");
                retained.listenerIdentity = WindowsWorkerJob.ProcessIdentity(retained.listener.Id);
                if (String.IsNullOrEmpty(retained.listenerIdentity) || retained.listener.SessionId != retained.owner.SessionId)
                    throw new InvalidOperationException("Original runtime listener process differs.");
                retained.Check();
                return retained;
            }
            catch (Exception error)
            {
                try { retained.Dispose(); }
                catch (Exception cleanup) { throw new AggregateException(error, cleanup); }
                throw;
            }
        }
        public void Check()
        {
            lock (gate)
            {
                HashSet<long> members = Members();
                if (listener.HasExited || WindowsWorkerJob.ProcessIdentity(listener.Id) != listenerIdentity ||
                    !members.Contains(listener.Id))
                    throw new InvalidOperationException("Original runtime listener process differs.");
                Binding current = ReadBinding(port);
                if (current.Pid != binding.Pid || current.CreatedAt != binding.CreatedAt || current.Address != binding.Address)
                    throw new InvalidOperationException("Original runtime listener binding changed.");
                if (!Members().Contains(listener.Id) || listener.HasExited ||
                    WindowsWorkerJob.ProcessIdentity(listener.Id) != listenerIdentity)
                    throw new InvalidOperationException("Original runtime listener process differs.");
            }
        }
        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
                try { if (listener != null) listener.Dispose(); }
                finally { if (owner != null) owner.Dispose(); }
            }
        }
    }
}
