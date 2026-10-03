using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
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
                    uint tag = BitConverter.ToUInt32(data, 0);
                    if (tag != 0xa0000003 || (info.Attributes & 16) == 0)
                        throw new InvalidDataException("Only internal directory junction reparse points are supported.");
                    Kind = "junction";
                    string substitute = ReadName(data, 16, 8);
                    string display = ReadName(data, 16, 12);
                    string absolute = ResolveTarget(substitute, true);
                    if (display.Length != 0 && !String.Equals(absolute,
                        ResolveTarget(display, false), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Source reparse display and substitute targets differ.");
                    string location = Path.GetRelativePath(project, absolute).Replace('\\', '/');
                    if (location == "." || location == ".." || location.StartsWith("../", StringComparison.Ordinal) ||
                        Path.IsPathRooted(location))
                        throw new InvalidDataException("Source reparse target is outside the project.");
                    target = new SourceAccess(project, location, "directory", 0, false);
                    if (target.Target.Information().Volume != info.Volume)
                        throw new InvalidDataException("Source reparse target crosses the project filesystem.");
                    RelativeTarget = Path.GetRelativePath(Path.GetDirectoryName(source.file), absolute).Replace('\\', '/');
                    Check();
                }
                catch { Dispose(); throw; }
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
    }
}
