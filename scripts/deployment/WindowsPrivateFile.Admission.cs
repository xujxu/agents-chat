using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Deployment
{
    public sealed partial class WindowsPrivateFile
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
            ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);

        public sealed class AdmissionLease : IDisposable
        {
            readonly WindowsPrivateFile parent, gate;
            bool closed;
            internal AdmissionLease(WindowsPrivateFile parent, WindowsPrivateFile gate)
            { this.parent = parent; this.gate = gate; }
            public void Check()
            {
                if (closed) throw new ObjectDisposedException("Windows admission");
                parent.CheckPublicationDirectory();
                gate.Check();
                parent.CheckPublicationDirectory();
            }
            public void Dispose()
            {
                if (closed) return;
                closed = true;
                var failures = new List<Exception>();
                try { gate.Dispose(); } catch (Exception error) { failures.Add(error); }
                try { parent.Dispose(); } catch (Exception error) { failures.Add(error); }
                if (failures.Count != 0)
                    throw new AggregateException("Windows admission close failed.", failures);
            }
        }

        public static AdmissionLease AcquireAdmission(string control)
        {
            RequirePath(control);
            WindowsPrivateFile parent = null, gate = null;
            try
            {
                parent = PublicationDirectory(control);
                gate = new WindowsPrivateFile { file = Path.Combine(control, "windows-admission.lock") };
                GCHandle descriptor = GCHandle.Alloc(
                    PrivateFileSecurity().GetSecurityDescriptorBinaryForm(), GCHandleType.Pinned);
                try
                {
                    parent.CheckPublicationDirectory();
                    var attributes = new SecurityAttributes {
                        Length = Marshal.SizeOf<SecurityAttributes>(),
                        Descriptor = descriptor.AddrOfPinnedObject(), Inherit = 0
                    };
                    const uint readWriteControl = 0xC0020000, openAlways = 4, openReparsePoint = 0x200000;
                    gate.handle = CreateFileW(NativePath(gate.file), readWriteControl, 0,
                        ref attributes, openAlways, openReparsePoint, IntPtr.Zero);
                    if (gate.handle.IsInvalid)
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Acquire exclusive Windows admission");
                }
                finally { descriptor.Free(); }
                gate.CaptureOpenedFile(FileAccess.ReadWrite, true, Digest(Array.Empty<byte>()));
                var lease = new AdmissionLease(parent, gate);
                lease.Check();
                return lease;
            }
            catch (Exception failure)
            {
                var failures = new List<Exception> { failure };
                try { if (gate != null) gate.Dispose(); } catch (Exception error) { failures.Add(error); }
                try { if (parent != null) parent.Dispose(); } catch (Exception error) { failures.Add(error); }
                if (failures.Count != 1)
                    throw new AggregateException("Windows admission acquisition and cleanup failed.", failures);
                throw;
            }
        }
    }
}
