using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Deployment
{
    public sealed partial class WindowsPrivateFile
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool DeviceIoControl(SafeFileHandle file, uint code, IntPtr input, uint inputBytes,
            [Out] byte[] output, uint outputBytes, out uint returned, IntPtr overlapped);
        [DllImport("kernel32.dll", EntryPoint = "DeviceIoControl", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetSourceReparsePoint(SafeFileHandle file, uint code, [In] byte[] input, uint inputBytes,
            IntPtr output, uint outputBytes, out uint returned, IntPtr overlapped);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetKernelObjectSecurity(SafeFileHandle file, uint information, [In] byte[] descriptor);

        public sealed class SourceReparseLease : IDisposable
        {
            readonly SourceParents parents;
            readonly WindowsPrivateFile source;
            SourceAccess target;
            byte[] data;
            string identity, security;
            bool disposed;
            public string Kind { get; private set; }
            public string RelativeTarget { get; private set; }
            public string ReparseData { get { Check(); return Convert.ToBase64String(data); } }
            public SourceSecurityRecord Metadata { get { Check(); return new SourceSecurityRecord(source); } }

            internal SourceReparseLease(string project, string relative)
            {
                parents = new SourceParents(project, relative);
                source = new WindowsPrivateFile { file = parents.Target };
                try
                {
                    source.handle = CreateFileW(source.file, 1 | 0x80 | 0x20000, 1, IntPtr.Zero,
                        3, 0x2000000 | 0x200000, IntPtr.Zero);
                    if (source.handle.IsInvalid)
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Open original source reparse point");
                    FileInformation info = source.Information();
                    if ((info.Attributes & 0x400) == 0 || (info.Attributes & ~(SourceAttributes | 0x400u)) != 0 ||
                        info.Links != 1 || !String.Equals(source.FinalPath(), source.file, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Unsupported or redirected source reparse point.");
                    identity = info.Identity();
                    security = Descriptor(source.Security());
                    ValidateSourceSecurity(security);
                    data = ReadData();
                    if ((info.Attributes & 16) == 0)
                        throw new InvalidDataException("Only internal directory junction reparse points are supported.");
                    Kind = "junction";
                    string absolute = DecodeTarget(project, data);
                    string location = Path.GetRelativePath(project, absolute).Replace('\\', '/');
                    target = new SourceAccess(project, location, "directory", 0, false);
                    if (target.Target.Information().Volume != info.Volume)
                        throw new InvalidDataException("Source reparse target crosses the project filesystem.");
                    RelativeTarget = Path.GetRelativePath(Path.GetDirectoryName(source.file), absolute).Replace('\\', '/');
                    Check();
                }
                catch { Dispose(); throw; }
            }

            internal static string DecodeTarget(string project, byte[] bytes)
            {
                if (bytes == null || bytes.Length < 16 || bytes.Length > 16384 ||
                    BitConverter.ToUInt16(bytes, 4) + 8 != bytes.Length || BitConverter.ToUInt16(bytes, 6) != 0 ||
                    BitConverter.ToUInt32(bytes, 0) != 0xa0000003)
                    throw new InvalidDataException("Unsupported or malformed directory junction reparse buffer.");
                string absolute = ResolveTarget(ReadName(bytes, 16, 8), true);
                string display = ReadName(bytes, 16, 12);
                if (display.Length != 0 && !String.Equals(absolute, ResolveTarget(display, false), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Source reparse display and substitute targets differ.");
                string location = Path.GetRelativePath(project, absolute).Replace('\\', '/');
                if (location == "." || location == ".." || location.StartsWith("../", StringComparison.Ordinal) ||
                    Path.IsPathRooted(location))
                    throw new InvalidDataException("Source reparse target is outside the project.");
                return absolute;
            }

            static string ReadName(byte[] bytes, int start, int field)
            {
                int offset = BitConverter.ToUInt16(bytes, field);
                int count = BitConverter.ToUInt16(bytes, field + 2);
                if ((offset & 1) != 0 || (count & 1) != 0 || start + offset + count > bytes.Length)
                    throw new InvalidDataException("Malformed source reparse name.");
                string value = new UnicodeEncoding(false, false, true).GetString(bytes, start + offset, count);
                if (value.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0)
                    throw new InvalidDataException("Unsupported source reparse name.");
                return value;
            }

            static string ResolveTarget(string value, bool substitute)
            {
                if (String.IsNullOrEmpty(value)) throw new InvalidDataException("Empty source reparse target.");
                if (substitute)
                {
                    if (!value.StartsWith(@"\??\", StringComparison.Ordinal))
                        throw new InvalidDataException("Unsupported source reparse namespace.");
                    value = value.Substring(4);
                }
                RequirePath(value);
                return value;
            }

            byte[] ReadData()
            {
                byte[] buffer = new byte[16384];
                uint returned;
                Native(DeviceIoControl(source.handle, 0x900a8, IntPtr.Zero, 0, buffer,
                    (uint)buffer.Length, out returned, IntPtr.Zero), "Read original source reparse data");
                if (returned < 16 || returned > buffer.Length || BitConverter.ToUInt16(buffer, 4) + 8 != returned ||
                    BitConverter.ToUInt16(buffer, 6) != 0)
                    throw new InvalidDataException("Malformed source reparse buffer.");
                Array.Resize(ref buffer, checked((int)returned));
                return buffer;
            }

            public void Check()
            {
                if (disposed) throw new ObjectDisposedException("Source reparse point");
                parents.Check();
                target.Check();
                byte[] current = ReadData();
                try
                {
                    if (source.Information().Identity() != identity || Descriptor(source.Security()) != security ||
                        !String.Equals(source.FinalPath(), source.file, StringComparison.OrdinalIgnoreCase) ||
                        !CryptographicOperations.FixedTimeEquals(current, data))
                        throw new InvalidDataException("Original source reparse point changed.");
                    target.Check();
                    parents.Check();
                }
                finally { CryptographicOperations.ZeroMemory(current); }
            }

            public void Dispose()
            {
                if (disposed) return;
                source.Dispose();
                target?.Dispose();
                parents.Dispose();
                if (data != null) CryptographicOperations.ZeroMemory(data);
                disposed = true;
            }
        }

        public static SourceReparseLease OpenSourceReparse(string project, string relative)
        {
            return new SourceReparseLease(project, relative);
        }

        public static SourceReparseLease CreateSourceJunction(string project, string relative, string reparseData,
            string sddl, uint attributes)
        {
            ValidateSourceSecurity(sddl);
            if ((attributes & 0x410) != 0x410 || (attributes & ~(SourceAttributes | 0x400u)) != 0 ||
                (attributes & 128) != 0 || reparseData == null || reparseData.Length > 21848)
                throw new InvalidDataException("Unsupported restored junction metadata.");
            byte[] bytes = Convert.FromBase64String(reparseData);
            if (Convert.ToBase64String(bytes) != reparseData)
                throw new InvalidDataException("Noncanonical junction reparse data.");
            using (var parents = new SourceParents(project, relative))
            {
                string absolute = SourceReparseLease.DecodeTarget(project, bytes);
                string targetRelative = Path.GetRelativePath(project, absolute).Replace('\\', '/');
                using (var target = new SourceAccess(project, targetRelative, "directory", 0, false))
                {
                    parents.Check();
                    target.Check();
                    EvidenceIdentity created;
                    using (var directory = CreateDirectory(parents.Target)) created = directory.CaptureIdentity();
                    using (var value = new WindowsPrivateFile { file = parents.Target })
                    {
                        value.handle = CreateFileW(value.file, 0x40000000 | 0x20000 | 0x40000 | 0x80000 | 0x80,
                            0, IntPtr.Zero, 3, 0x2000000 | 0x200000, IntPtr.Zero);
                        if (value.handle.IsInvalid)
                            throw new Win32Exception(Marshal.GetLastWin32Error(), "Open new private junction directory");
                        FileInformation info = value.Information();
                        EvidenceIdentity actual = value.OriginalIdentity();
                        if ((info.Attributes & 16) == 0 || (info.Attributes & ~SourceAttributes) != 0 ||
                            actual.Dev != created.Dev || actual.Ino != created.Ino ||
                            !String.Equals(value.FinalPath(), value.file, StringComparison.OrdinalIgnoreCase) ||
                            info.Volume != target.Target.Information().Volume)
                            throw new InvalidDataException("New private junction directory changed.");
                        RequirePrivate(value.Security());
                        parents.Check();
                        target.Check();
                        uint returned;
                        Native(SetSourceReparsePoint(value.handle, 0x900a4, bytes, (uint)bytes.Length,
                            IntPtr.Zero, 0, out returned, IntPtr.Zero), "Set original junction reparse data");
                        var descriptor = new RawSecurityDescriptor(sddl);
                        var binary = new byte[descriptor.BinaryLength];
                        descriptor.GetBinaryForm(binary, 0);
                        uint information = 7u | ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0
                            ? 0x80000000u : 0x20000000u);
                        // Kernel security updates the retained junction itself, without target-tree propagation.
                        Native(SetKernelObjectSecurity(value.handle, information, binary), "Restore original junction security");
                        uint ordinary = attributes & ~0x410u;
                        var basic = new SourceBasicInformation { Attributes = ordinary == 0 ? 128u : ordinary };
                        Native(SetSourceBasicInformation(value.handle, 0, ref basic,
                            (uint)Marshal.SizeOf<SourceBasicInformation>()), "Restore original junction attributes");
                        parents.Check();
                        target.Check();
                    }
                    var result = OpenSourceReparse(project, relative);
                    try
                    {
                        SourceSecurityRecord actual = result.Metadata;
                        if (actual.Dev != created.Dev || actual.Ino != created.Ino || result.ReparseData != reparseData ||
                            actual.Attributes != attributes || actual.SecurityDescriptor != sddl)
                            throw new InvalidDataException("Restored junction differs from its original metadata.");
                        parents.Check();
                        target.Check();
                        return result;
                    }
                    catch { result.Dispose(); throw; }
                }
            }
        }
    }
}
