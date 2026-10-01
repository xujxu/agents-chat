using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Deployment
{
    public sealed class WindowsPrivateFile : IDisposable
    {
        const int MaximumBytes = 1024 * 1024;
        SafeFileHandle handle;
        FileStream stream;
        byte[] content;
        string file, metadata, security;
        bool disposed;
        public string Sha256 { get; private set; }

        [StructLayout(LayoutKind.Sequential)]
        struct FileInformation
        {
            public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh;
            public uint WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
            public string Identity()
            {
                return String.Join(":", Attributes, CreationLow, CreationHigh, WriteLow, WriteHigh,
                    Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow);
            }
            public string DirectoryIdentity()
            {
                return String.Join(":", Attributes, CreationLow, CreationHigh, Volume, IndexHigh, IndexLow);
            }
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr attributes,
            uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool MoveFileExW(string existing, string destination, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint capacity, uint flags);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetKernelObjectSecurity(SafeFileHandle file, uint information,
            [Out] byte[] descriptor, uint size, out uint needed);

        WindowsPrivateFile() { }
        static void Native(bool success, string operation)
        {
            if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
        FileInformation Information()
        {
            FileInformation information;
            Native(GetFileInformationByHandle(handle, out information), "Read retained configuration metadata");
            return information;
        }
        string FinalPath()
        {
            var name = new StringBuilder(4096);
            uint count = GetFinalPathNameByHandleW(handle, name, (uint)name.Capacity, 0);
            Native(count != 0, "Resolve retained configuration path");
            if (count >= name.Capacity || !name.ToString().StartsWith(@"\\?\", StringComparison.Ordinal))
                throw new InvalidDataException("Private configuration path is redirected.");
            return name.ToString().Substring(4);
        }
        RawSecurityDescriptor Security()
        {
            byte[] buffer = new byte[65536];
            uint needed;
            Native(GetKernelObjectSecurity(handle, 7, buffer, (uint)buffer.Length, out needed),
                "Read retained configuration permissions");
            if (needed > buffer.Length) throw new InvalidDataException("Private configuration permissions exceed the size limit.");
            var descriptor = new RawSecurityDescriptor(buffer, 0);
            if (descriptor.BinaryLength < 20 || descriptor.BinaryLength > buffer.Length)
                throw new InvalidDataException("Private configuration permissions are invalid.");
            return descriptor;
        }
        static string Descriptor(RawSecurityDescriptor security)
        {
            return security.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access);
        }
        static void RequirePrivate(RawSecurityDescriptor descriptor)
        {
            string sid;
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) sid = identity.User.Value;
            if (descriptor.Owner == null || descriptor.Owner.Value != sid && descriptor.Owner.Value != "S-1-5-18" ||
                descriptor.DiscretionaryAcl == null ||
                (descriptor.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0)
                throw new InvalidDataException("Private configuration permissions are unsupported.");
            foreach (GenericAce entry in descriptor.DiscretionaryAcl)
            {
                CommonAce ace = entry as CommonAce;
                if (ace == null || ace.IsCallback ||
                    ace.AceQualifier != AceQualifier.AccessAllowed && ace.AceQualifier != AceQualifier.AccessDenied ||
                    ace.AceQualifier == AceQualifier.AccessAllowed &&
                    ace.SecurityIdentifier.Value != sid && ace.SecurityIdentifier.Value != "S-1-5-18")
                    throw new InvalidDataException("Private configuration permissions are unsupported.");
            }
        }
        static string Digest(byte[] bytes)
        {
            return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        }
        byte[] ReadContent(int size)
        {
            stream.Position = 0;
            byte[] bytes = new byte[size];
            try
            {
                int total = 0;
                while (total < bytes.Length)
                {
                    int count = stream.Read(bytes, total, bytes.Length - total);
                    if (count == 0) throw new InvalidDataException("Retained private configuration changed.");
                    total += count;
                }
                if (stream.ReadByte() != -1) throw new InvalidDataException("Retained private configuration changed.");
                return bytes;
            }
            catch
            {
                CryptographicOperations.ZeroMemory(bytes);
                throw;
            }
        }
        static void RequirePath(string file)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException("Private Windows configuration requires Windows.");
            if (file == null || file.Length < 4 || file.Length > 4096 ||
                !((file[0] >= 'A' && file[0] <= 'Z') || (file[0] >= 'a' && file[0] <= 'z')) ||
                file[1] != ':' || file[2] != '\\' || file.Substring(3).IndexOf(':') >= 0 ||
                file.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0 ||
                !String.Equals(Path.GetFullPath(file), file, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("A canonical local configuration file path is required.");
        }
        static WindowsPrivateFile PublicationDirectory(string directory)
        {
            var parent = new WindowsPrivateFile { file = directory };
            try
            {
                const uint readAttributes = 0x80, readControl = 0x20000, shareReadWrite = 3;
                const uint openExisting = 3, backupSemantics = 0x2000000, openReparsePoint = 0x200000;
                parent.handle = CreateFileW(directory, readAttributes | readControl, shareReadWrite,
                    IntPtr.Zero, openExisting, backupSemantics | openReparsePoint, IntPtr.Zero);
                if (parent.handle.IsInvalid)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Open original private publication directory");
                FileInformation information = parent.Information();
                const uint directoryAttribute = 0x10, reparsePoint = 0x400, encrypted = 0x4000;
                if ((information.Attributes & directoryAttribute) == 0 ||
                    (information.Attributes & (reparsePoint | encrypted)) != 0 ||
                    !String.Equals(parent.FinalPath(), directory, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Private publication directory is redirected.");
                RawSecurityDescriptor security = parent.Security();
                RequirePrivate(security);
                parent.metadata = information.DirectoryIdentity();
                parent.security = Descriptor(security);
                return parent;
            }
            catch
            {
                parent.Dispose();
                throw;
            }
        }
        void CheckPublicationDirectory()
        {
            if (Information().DirectoryIdentity() != metadata ||
                !String.Equals(FinalPath(), file, StringComparison.OrdinalIgnoreCase) || Descriptor(Security()) != security)
                throw new InvalidDataException("Private publication directory changed.");
        }
        public static WindowsPrivateFile Publish(string file, string text)
        {
            RequirePath(file);
            if (text == null) throw new ArgumentNullException("text");
            if (text.Length > MaximumBytes) throw new ArgumentException("Private publication exceeds the size limit.");
            byte[] bytes = new UTF8Encoding(false, true).GetBytes(text);
            WindowsPrivateFile published = null;
            try
            {
                if (bytes.Length > MaximumBytes) throw new ArgumentException("Private publication exceeds the size limit.");
                using (WindowsPrivateFile parent = PublicationDirectory(Path.GetDirectoryName(file)))
                {
                    parent.CheckPublicationDirectory();
                    var security = new FileSecurity();
                    using (WindowsIdentity account = WindowsIdentity.GetCurrent())
                    {
                        security.SetOwner(account.User);
                        security.SetAccessRuleProtection(true, false);
                        foreach (SecurityIdentifier sid in new[] {
                            account.User, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null)
                        })
                            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
                    }
                    string pending = file + ".pending-" + Guid.NewGuid().ToString("D");
                    using (FileStream stream = FileSystemAclExtensions.Create(new FileInfo(pending), FileMode.CreateNew,
                        FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.WriteThrough, security))
                    {
                        parent.CheckPublicationDirectory();
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush(true);
                    }
                    parent.CheckPublicationDirectory();
                    const uint writeThrough = 8;
                    Native(MoveFileExW(pending, file, writeThrough), "Publish original private evidence");
                    published = Open(file, Digest(bytes));
                    parent.CheckPublicationDirectory();
                    return published;
                }
            }
            catch
            {
                if (published != null) published.Dispose();
                throw;
            }
            finally { CryptographicOperations.ZeroMemory(bytes); }
        }
        public static WindowsPrivateFile Open(string file, string expectedSha256)
        {
            RequirePath(file);
            if (expectedSha256 == null || expectedSha256.Length != 64)
                throw new ArgumentException("An exact configuration SHA-256 is required.");
            foreach (char value in expectedSha256)
                if (!(value >= '0' && value <= '9' || value >= 'a' && value <= 'f'))
                    throw new ArgumentException("An exact configuration SHA-256 is required.");
            var retained = new WindowsPrivateFile { file = file };
            try
            {
                const uint read = 0x80000000, readControl = 0x20000, shareRead = 1, openExisting = 3, openReparsePoint = 0x200000;
                retained.handle = CreateFileW(file, read | readControl, shareRead, IntPtr.Zero,
                    openExisting, openReparsePoint, IntPtr.Zero);
                if (retained.handle.IsInvalid)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Open original private configuration");
                FileInformation information = retained.Information();
                const uint directory = 0x10, reparsePoint = 0x400, encrypted = 0x4000;
                if ((information.Attributes & (directory | reparsePoint | encrypted)) != 0 || information.Links != 1)
                    throw new InvalidDataException("Private configuration file type or links are unsupported.");
                if (information.SizeHigh != 0 || information.SizeLow > MaximumBytes)
                    throw new InvalidDataException("Private configuration file exceeds the size limit.");
                if (!String.Equals(retained.FinalPath(), file, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Private configuration path is redirected.");
                RawSecurityDescriptor security = retained.Security();
                RequirePrivate(security);
                retained.metadata = information.Identity();
                retained.security = Descriptor(security);
                retained.stream = new FileStream(retained.handle, FileAccess.Read, 1, false);
                retained.content = retained.ReadContent((int)information.SizeLow);
                retained.Sha256 = Digest(retained.content);
                if (retained.Sha256 != expectedSha256) throw new InvalidDataException("Private configuration digest differs.");
                retained.Check();
                return retained;
            }
            catch
            {
                retained.Dispose();
                throw;
            }
        }
        void CheckMetadata()
        {
            if (Information().Identity() != metadata ||
                !String.Equals(FinalPath(), file, StringComparison.OrdinalIgnoreCase) || Descriptor(Security()) != security)
                throw new InvalidDataException("Retained private configuration changed.");
        }
        public void Check()
        {
            if (disposed) throw new ObjectDisposedException("Private configuration");
            CheckMetadata();
            byte[] current = ReadContent(content.Length);
            try
            {
                if (Digest(current) != Sha256) throw new InvalidDataException("Retained private configuration changed.");
                CheckMetadata();
            }
            finally { CryptographicOperations.ZeroMemory(current); }
        }
        public string ReadText()
        {
            Check();
            string text = new UTF8Encoding(false, true).GetString(content);
            Check();
            return text;
        }
        public void Dispose()
        {
            if (disposed) return;
            if (stream != null) stream.Dispose();
            else if (handle != null) handle.Dispose();
            if (content != null) CryptographicOperations.ZeroMemory(content);
            disposed = true;
        }
    }
}
