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
    public sealed partial class WindowsPrivateFile : IDisposable
    {
        const int MaximumBytes = 1024 * 1024;
        SafeFileHandle handle;
        FileStream stream;
        byte[] content;
        string file, metadata, security;
        bool disposed;
        public string Sha256 { get; private set; }
        public sealed class EvidenceIdentity
        {
            public string Dev { get; }
            public string Ino { get; }
            internal EvidenceIdentity(uint volume, uint high, uint low)
            {
                Dev = volume.ToString(System.Globalization.CultureInfo.InvariantCulture);
                Ino = (((ulong)high << 32) | low).ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
        }
        EvidenceIdentity OriginalIdentity()
        {
            FileInformation information = Information();
            return new EvidenceIdentity(information.Volume, information.IndexHigh, information.IndexLow);
        }
        public EvidenceIdentity CaptureIdentity()
        {
            Check();
            EvidenceIdentity result = OriginalIdentity();
            Check();
            return result;
        }
        public int ByteLength { get { Check(); return content.Length; } }
        public string SecurityDescriptor { get { Check(); return security; } }

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
        [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateNativeFileW(string name, uint access, uint share, IntPtr attributes,
            uint creation, uint flags, IntPtr template);
        static SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr attributes,
            uint creation, uint flags, IntPtr template)
        {
            return CreateNativeFileW(NativePath(name), access, share, attributes, creation, flags, template);
        }
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes
        {
            public int Length;
            public IntPtr Descriptor;
            public int Inherit;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool CreateDirectoryW(string name, ref SecurityAttributes attributes);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass,
            ref byte information, uint bytes);
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
        static string NativePath(string file)
        {
            RequirePath(file);
            return @"\\?\" + file;
        }
        static WindowsPrivateFile PublicationDirectory(string directory, bool requirePrivate = true, bool retirement = false)
        {
            var parent = new WindowsPrivateFile { file = directory };
            try
            {
                // Metadata-only handles do not prevent directory renames through share-delete exclusion.
                const uint listDirectory = 1, readAttributes = 0x80, readControl = 0x20000, shareReadWrite = 3;
                const uint delete = 0x10000;
                const uint openExisting = 3, backupSemantics = 0x2000000, openReparsePoint = 0x200000;
                parent.handle = CreateFileW(directory, listDirectory | readAttributes | readControl | (retirement ? delete : 0),
                    retirement ? 0 : shareReadWrite,
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
                if (requirePrivate) RequirePrivate(security);
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
        public sealed class DirectoryLease : IDisposable
        {
            readonly WindowsPrivateFile directory;
            internal DirectoryLease(WindowsPrivateFile directory) { this.directory = directory; }
            public void Check()
            {
                if (directory.disposed) throw new ObjectDisposedException("Private directory");
                directory.CheckPublicationDirectory();
            }
            public EvidenceIdentity CaptureIdentity()
            {
                Check();
                EvidenceIdentity result = directory.OriginalIdentity();
                Check();
                return result;
            }
            public string SecurityDescriptor { get { Check(); return directory.security; } }
            public void Dispose() { directory.Dispose(); }
        }
        public static DirectoryLease OpenDirectory(string directory)
        {
            RequirePath(directory);
            return new DirectoryLease(PublicationDirectory(directory));
        }
        public static DirectoryLease OpenSourceDirectory(string directory)
        {
            RequirePath(directory);
            return new DirectoryLease(PublicationDirectory(directory, false));
        }
        public static DirectoryLease CreateDirectory(string directory)
        {
            RequirePath(directory);
            using (WindowsPrivateFile parent = PublicationDirectory(Path.GetDirectoryName(directory), false))
            {
                var security = new DirectorySecurity();
                using (WindowsIdentity account = WindowsIdentity.GetCurrent())
                {
                    security.SetOwner(account.User);
                    security.SetAccessRuleProtection(true, false);
                    foreach (SecurityIdentifier sid in new[] {
                        account.User, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null)
                    })
                        security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                            PropagationFlags.None, AccessControlType.Allow));
                }
                GCHandle descriptor = GCHandle.Alloc(security.GetSecurityDescriptorBinaryForm(), GCHandleType.Pinned);
                try
                {
                    parent.CheckPublicationDirectory();
                    var attributes = new SecurityAttributes {
                        Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor.AddrOfPinnedObject(), Inherit = 0
                    };
                    Native(CreateDirectoryW(NativePath(directory), ref attributes), "Create original private directory");
                }
                finally { descriptor.Free(); }
                DirectoryLease created = OpenDirectory(directory);
                try
                {
                    parent.CheckPublicationDirectory();
                    created.Check();
                    return created;
                }
                catch
                {
                    created.Dispose();
                    throw;
                }
            }
        }
        static FileSecurity PrivateFileSecurity()
        {
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
            return security;
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
                    var security = PrivateFileSecurity();
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
                    // The generated pending name can exceed MAX_PATH even when the public destination does not.
                    Native(MoveFileExW(NativePath(pending), NativePath(file), writeThrough), "Publish original private evidence");
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
            return OpenFile(file, expectedSha256, true);
        }
        public static WindowsPrivateFile OpenExclusive(string file, string sha256, string dev, string ino, int bytes)
        {
            WindowsPrivateFile retained = OpenFile(file, sha256, true, exclusive: true);
            try
            {
                EvidenceIdentity identity = retained.CaptureIdentity();
                if (identity.Dev != dev || identity.Ino != ino || retained.ByteLength != bytes)
                    throw new InvalidDataException("Original exclusive evidence identity or length differs.");
                return retained;
            }
            catch
            {
                retained.Dispose();
                throw;
            }
        }
        public sealed class RetirementFile : IDisposable
        {
            readonly WindowsPrivateFile original;
            readonly DirectoryLease parent;
            internal RetirementFile(WindowsPrivateFile original, DirectoryLease parent)
            {
                this.original = original;
                this.parent = parent;
            }
            public void Check()
            {
                parent.Check();
                original.Check();
                parent.Check();
            }
            public void Delete()
            {
                Check();
                byte disposition = 1;
                Native(SetFileInformationByHandle(original.handle, 4, ref disposition, 1),
                    "Retire original private file");
                Dispose();
            }
            public void Dispose()
            {
                try { original.Dispose(); }
                finally { parent.Dispose(); }
            }
        }
        public static RetirementFile RetainForRetirement(string file, string sha256,
            string dev, string ino, int bytes)
        {
            RequirePath(file);
            DirectoryLease parent = OpenDirectory(Path.GetDirectoryName(file));
            WindowsPrivateFile original = null;
            try
            {
                original = OpenFile(file, sha256, true, true);
                EvidenceIdentity identity = original.CaptureIdentity();
                if (identity.Dev != dev || identity.Ino != ino || original.ByteLength != bytes)
                    throw new InvalidDataException("Original retirement file identity or length differs.");
                parent.Check();
                return new RetirementFile(original, parent);
            }
            catch
            {
                try { if (original != null) original.Dispose(); }
                finally { parent.Dispose(); }
                throw;
            }
        }
        public sealed class RetirementDirectory : IDisposable
        {
            readonly WindowsPrivateFile original;
            readonly DirectoryLease parent;
            internal RetirementDirectory(WindowsPrivateFile original, DirectoryLease parent)
            {
                this.original = original;
                this.parent = parent;
            }
            public void Check()
            {
                if (original.disposed) throw new ObjectDisposedException("Private directory");
                parent.Check();
                original.CheckPublicationDirectory();
                parent.Check();
            }
            public void Delete()
            {
                Check();
                byte disposition = 1;
                Native(SetFileInformationByHandle(original.handle, 4, ref disposition, 1),
                    "Retire original private directory");
                Dispose();
            }
            public void Dispose()
            {
                try { original.Dispose(); }
                finally { parent.Dispose(); }
            }
        }
        public static RetirementDirectory RetainDirectoryForRetirement(string directory, string dev, string ino)
        {
            RequirePath(directory);
            DirectoryLease parent = OpenDirectory(Path.GetDirectoryName(directory));
            WindowsPrivateFile original = null;
            try
            {
                original = PublicationDirectory(directory, retirement: true);
                EvidenceIdentity identity = original.OriginalIdentity();
                if (identity.Dev != dev || identity.Ino != ino)
                    throw new InvalidDataException("Original retirement directory identity differs.");
                original.CheckPublicationDirectory();
                parent.Check();
                return new RetirementDirectory(original, parent);
            }
            catch
            {
                try { if (original != null) original.Dispose(); }
                finally { parent.Dispose(); }
                throw;
            }
        }
        public static WindowsPrivateFile CopyTrustedSource(string source, string expectedSha256, string destination)
        {
            using (WindowsPrivateFile original = OpenFile(source, expectedSha256, false))
            {
                WindowsPrivateFile copy = null;
                try
                {
                    copy = Publish(destination, original.ReadText());
                    original.Check();
                    if (copy.Sha256 != expectedSha256)
                        throw new InvalidDataException("Copied source digest differs.");
                    return copy;
                }
                catch
                {
                    if (copy != null) copy.Dispose();
                    throw;
                }
            }
        }
        public static WindowsPrivateFile OpenSourceFile(string source, string expectedSha256)
        {
            return OpenFile(source, expectedSha256, false);
        }
        static WindowsPrivateFile OpenFile(string file, string expectedSha256, bool requirePrivate,
            bool retirement = false, bool exclusive = false)
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
                uint access = read | readControl | (retirement ? 0x10000u : 0u);
                uint share = retirement || exclusive ? 0u : shareRead;
                retained.handle = CreateFileW(file, access, share, IntPtr.Zero,
                    openExisting, openReparsePoint, IntPtr.Zero);
                if (retained.handle.IsInvalid)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Open original private configuration");
                retained.CaptureOpenedFile(FileAccess.Read, requirePrivate, expectedSha256);
                return retained;
            }
            catch
            {
                retained.Dispose();
                throw;
            }
        }
        void CaptureOpenedFile(FileAccess access, bool requirePrivate, string expectedSha256)
        {
            FileInformation information = Information();
            const uint directory = 0x10, reparsePoint = 0x400, encrypted = 0x4000;
            if ((information.Attributes & (directory | reparsePoint | encrypted)) != 0 || information.Links != 1)
                throw new InvalidDataException("Private configuration file type or links are unsupported.");
            if (information.SizeHigh != 0 || information.SizeLow > MaximumBytes)
                throw new InvalidDataException("Private configuration file exceeds the size limit.");
            if (!String.Equals(FinalPath(), file, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Private configuration path is redirected.");
            RawSecurityDescriptor descriptor = Security();
            if (requirePrivate) RequirePrivate(descriptor);
            metadata = information.Identity();
            security = Descriptor(descriptor);
            stream = new FileStream(handle, access, 1, false);
            content = ReadContent((int)information.SizeLow);
            Sha256 = Digest(content);
            if (Sha256 != expectedSha256) throw new InvalidDataException("Private configuration digest differs.");
            Check();
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
