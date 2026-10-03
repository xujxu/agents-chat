using System;
using System.Collections.Generic;
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
    public sealed partial class WindowsPrivateFile
    {
        const uint SourceAttributes = 1 | 2 | 4 | 16 | 32 | 128 | 8192;
        [DllImport("advapi32.dll")]
        static extern uint SetSecurityInfo(SafeFileHandle handle, int objectType, uint information,
            [In] byte[] owner, [In] byte[] group, [In] byte[] dacl, IntPtr sacl);
        [StructLayout(LayoutKind.Sequential)]
        struct SourceBasicInformation
        {
            public long CreationTime, AccessTime, WriteTime, ChangeTime;
            public uint Attributes;
        }
        [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetSourceBasicInformation(SafeFileHandle handle, int informationClass,
            ref SourceBasicInformation information, uint bytes);
        [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetSourceDisposition(SafeFileHandle handle, int informationClass, ref uint flags, uint bytes);
        [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetSourceRename(SafeFileHandle handle, int informationClass, IntPtr information, uint bytes);

        public sealed class SourceSecurityRecord
        {
            public string Dev { get; }
            public string Ino { get; }
            public string SecurityDescriptor { get; }
            public uint Attributes { get; }
            public long Bytes { get; }
            internal SourceSecurityRecord(WindowsPrivateFile value)
            {
                FileInformation info = value.Information();
                EvidenceIdentity identity = value.OriginalIdentity();
                Dev = identity.Dev;
                Ino = identity.Ino;
                Attributes = info.Attributes;
                Bytes = (info.Attributes & 16) != 0 ? 0 : checked((long)(((ulong)info.SizeHigh << 32) | info.SizeLow));
                SecurityDescriptor = Descriptor(value.Security());
            }
        }

        sealed class SourceParents : IDisposable
        {
            readonly List<WindowsPrivateFile> parents = new List<WindowsPrivateFile>();
            public string Target { get; }
            public SourceParents(string project, string relative)
            {
                RequirePath(project);
                if (String.IsNullOrEmpty(relative) || relative.Length > 4096 ||
                    relative.IndexOfAny(new[] { '\\', ':', '\0', '\r', '\n', '<', '>', '|', '"', '*', '?' }) >= 0)
                    throw new InvalidDataException("Invalid source restoration path.");
                string[] parts = relative.Split('/');
                foreach (string part in parts)
                    if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") ||
                        System.Text.RegularExpressions.Regex.IsMatch(part,
                            @"^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3])(\.|$)",
                            System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                        throw new InvalidDataException("Invalid source restoration component.");
                Target = Path.Combine(project, relative.Replace('/', '\\'));
                RequirePath(Target);
                try
                {
                    parents.Add(PublicationDirectory(project, false));
                    string parent = project;
                    for (int index = 0; index < parts.Length - 1; index++)
                    {
                        parent = Path.Combine(parent, parts[index]);
                        parents.Add(PublicationDirectory(parent, false));
                    }
                    Check();
                }
                catch { Dispose(); throw; }
            }
            public void Check()
            {
                foreach (WindowsPrivateFile parent in parents) parent.CheckPublicationDirectory();
            }
            public void Dispose()
            {
                for (int index = parents.Count - 1; index >= 0; index--) parents[index].Dispose();
                parents.Clear();
            }
        }

        sealed class SourceAccess : IDisposable
        {
            readonly SourceParents parents;
            public WindowsPrivateFile Target { get; }
            readonly string kind;
            readonly EvidenceIdentity identity;
            public SourceAccess(string project, string relative, string kind, uint access, bool exclusive)
            {
                if (kind != "file" && kind != "directory") throw new InvalidDataException("Invalid restoration source kind.");
                this.kind = kind;
                parents = new SourceParents(project, relative);
                Target = new WindowsPrivateFile { file = parents.Target };
                try
                {
                    const uint readData = 1, readAttributes = 0x80, readControl = 0x20000;
                    Target.handle = CreateFileW(Target.file, readData | readAttributes | readControl | access,
                        exclusive ? 0u : 3u, IntPtr.Zero, 3, 0x2000000 | 0x200000, IntPtr.Zero);
                    if (Target.handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open original restoration source");
                    identity = Target.OriginalIdentity();
                    Check();
                }
                catch { Dispose(); throw; }
            }
            public void Check()
            {
                parents.Check();
                FileInformation info = Target.Information();
                EvidenceIdentity current = Target.OriginalIdentity();
                if ((info.Attributes & ~SourceAttributes) != 0 ||
                    ((info.Attributes & 16) != 0) != (kind == "directory") ||
                    current.Dev != identity.Dev || current.Ino != identity.Ino ||
                    !String.Equals(Target.FinalPath(), Target.file, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Original restoration source changed.");
            }
            public void Match(string dev, string ino)
            {
                Check();
                if (identity.Dev != dev || identity.Ino != ino) throw new InvalidDataException("Restoration source identity differs.");
            }
            public void Dispose()
            {
                Target.Dispose();
                parents.Dispose();
            }
        }

        public static void ValidateSourceSecurity(string sddl)
        {
            if (String.IsNullOrEmpty(sddl) || Encoding.UTF8.GetByteCount(sddl) > 8192 ||
                sddl.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0)
                throw new InvalidDataException("Unsupported restoration security descriptor.");
            var descriptor = new RawSecurityDescriptor(sddl);
            if (descriptor.SystemAcl != null || (descriptor.ControlFlags & ControlFlags.SystemAclPresent) != 0)
                throw new InvalidDataException("Source audit policy is not supported by project restoration.");
            using (WindowsIdentity account = WindowsIdentity.GetCurrent())
            {
                var groups = new HashSet<string>(StringComparer.Ordinal) { account.User.Value, account.Owner.Value };
                foreach (IdentityReference group in account.Groups) groups.Add(group.Value);
                if (descriptor.Owner == null || descriptor.Group == null ||
                    descriptor.Owner.Value != account.User.Value && descriptor.Owner.Value != account.Owner.Value ||
                    !groups.Contains(descriptor.Group.Value) || descriptor.DiscretionaryAcl == null ||
                    (descriptor.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0)
                    throw new InvalidDataException("Restoration requires supported same-account ownership.");
            }
            foreach (GenericAce entry in descriptor.DiscretionaryAcl)
            {
                CommonAce ace = entry as CommonAce;
                if (ace == null || ace.IsCallback || ace.SecurityIdentifier.Value == "S-1-3-4" ||
                    ace.AceQualifier != AceQualifier.AccessAllowed && ace.AceQualifier != AceQualifier.AccessDenied)
                    throw new InvalidDataException("Restoration requires ordinary source access rules.");
            }
        }

        static void SetSourceSecurity(WindowsPrivateFile target, RawSecurityDescriptor descriptor, bool ownership)
        {
            byte[] owner = null, group = null;
            if (ownership)
            {
                owner = new byte[descriptor.Owner.BinaryLength];
                descriptor.Owner.GetBinaryForm(owner, 0);
                group = new byte[descriptor.Group.BinaryLength];
                descriptor.Group.GetBinaryForm(group, 0);
            }
            byte[] dacl = new byte[descriptor.DiscretionaryAcl.BinaryLength];
            descriptor.DiscretionaryAcl.GetBinaryForm(dacl, 0);
            uint information = (ownership ? 7u : 4u) |
                ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 ? 0x80000000u : 0x20000000u);
            uint result = SetSecurityInfo(target.handle, 1, information, owner, group, dacl, IntPtr.Zero);
            if (result != 0) throw new Win32Exception((int)result, "Set original source file security");
        }

        public static SourceSecurityRecord CaptureSourceSecurity(string project, string relative, string kind)
        {
            using (var source = new SourceAccess(project, relative, kind, kind == "directory" ? 0x40000u : 0u, false))
            {
                var result = new SourceSecurityRecord(source.Target);
                ValidateSourceSecurity(result.SecurityDescriptor);
                source.Check();
                return result;
            }
        }

        public static void CheckSourceRootWriteAccess(string project)
        {
            RequirePath(project);
            using (var root = new WindowsPrivateFile { file = project })
            {
                const uint list = 1, addFile = 2, addDirectory = 4, deleteChild = 0x40;
                root.handle = CreateFileW(project, list | addFile | addDirectory | deleteChild | 0x80 | 0x20000,
                    3, IntPtr.Zero, 3, 0x2000000 | 0x200000, IntPtr.Zero);
                if (root.handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Admit source root restoration access");
                FileInformation info = root.Information();
                if ((info.Attributes & 16) == 0 || (info.Attributes & ~SourceAttributes) != 0 ||
                    !String.Equals(root.FinalPath(), project, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Source root restoration access is redirected.");
                ValidateSourceSecurity(Descriptor(root.Security()));
            }
        }

        public static void PrepareSourceDirectoryRemoval(string project, string relative, string dev, string ino)
        {
            using (var source = new SourceAccess(project, relative, "directory", 0x40000, true))
            {
                source.Match(dev, ino);
                ValidateSourceSecurity(Descriptor(source.Target.Security()));
                var temporary = new RawSecurityDescriptor(PrivateFileSecurity().GetSecurityDescriptorBinaryForm(), 0);
                SetSourceSecurity(source.Target, temporary, false);
                source.Check();
            }
        }

        public static void RemoveSourceEntry(string project, string relative, string kind, string dev, string ino)
        {
            RemoveSourceEntry(project, relative, kind, dev, ino, false);
        }

        public static void RemoveUnaliasedSourceFile(string project, string relative, string dev, string ino)
        {
            RemoveSourceEntry(project, relative, "file", dev, ino, true);
        }

        static void CheckPublicationFile(SourceAccess source, SourceSecurityRecord expected, string sha256)
        {
            if (expected == null || sha256 == null ||
                !System.Text.RegularExpressions.Regex.IsMatch(sha256, @"\A[a-f0-9]{64}\z"))
                throw new InvalidDataException("Source publication evidence differs.");
            source.Match(expected.Dev, expected.Ino);
            var actual = new SourceSecurityRecord(source.Target);
            ValidateSourceSecurity(actual.SecurityDescriptor);
            if (source.Target.Information().Links != 1)
                throw new InvalidDataException("Source publication requires unaliased files.");
            if (actual.Bytes != expected.Bytes || actual.Attributes != expected.Attributes ||
                actual.SecurityDescriptor != expected.SecurityDescriptor)
                throw new InvalidDataException("Source publication metadata changed.");
            using (var borrowed = new SafeFileHandle(source.Target.handle.DangerousGetHandle(), false))
            using (var stream = new FileStream(borrowed, FileAccess.Read))
            using (var algorithm = SHA256.Create())
            {
                stream.Position = 0;
                string hash = BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (hash != sha256) throw new InvalidDataException("Source publication bytes changed.");
            }
            source.Check();
        }

        public static void PublishSourceFile(string project, string relative, SourceSecurityRecord staged,
            SourceSecurityRecord before, string stagedSha256, string beforeSha256)
        {
            if (before == null && !String.IsNullOrEmpty(beforeSha256))
                throw new InvalidDataException("Absent source publication evidence differs.");
            using (var source = new SourceAccess(project, relative + ".lock", "file", 0x10000, true))
            using (var destination = new SourceParents(project, relative))
            {
                CheckPublicationFile(source, staged, stagedSha256);
                SourceAccess original = null;
                try
                {
                    try { original = new SourceAccess(project, relative, "file", 0x100, true); }
                    catch (Win32Exception error) when (before == null && error.NativeErrorCode == 2) { }
                    if (before == null && original != null)
                        throw new InvalidDataException("Expected source publication target is not absent.");
                    if (before != null) CheckPublicationFile(original, before, beforeSha256);
                    destination.Check();
                    source.Check();
                    byte[] name = Encoding.Unicode.GetBytes(destination.Target);
                    int rootOffset = IntPtr.Size == 8 ? 8 : 4;
                    int lengthOffset = rootOffset + IntPtr.Size;
                    int nameOffset = lengthOffset + 4;
                    int size = nameOffset + name.Length + 2;
                    IntPtr information = Marshal.AllocHGlobal(size);
                    try
                    {
                        Marshal.Copy(new byte[size], 0, information, size);
                        Marshal.WriteInt32(information, 0, before == null ? 0 : 1 | 2 | 0x40);
                        Marshal.WriteIntPtr(information, rootOffset, IntPtr.Zero);
                        Marshal.WriteInt32(information, lengthOffset, name.Length);
                        Marshal.Copy(name, 0, IntPtr.Add(information, nameOffset), name.Length);
                        Native(SetSourceRename(source.Target.handle, 22, information, checked((uint)size)),
                            "Atomically publish original source lockfile");
                    }
                    finally { Marshal.FreeHGlobal(information); }
                    source.Target.file = destination.Target;
                    destination.Check();
                    CheckPublicationFile(source, staged, stagedSha256);
                }
                finally { original?.Dispose(); }
            }
        }

        static void RemoveSourceEntry(string project, string relative, string kind, string dev, string ino, bool unaliased)
        {
            using (var source = new SourceAccess(project, relative, kind, 0x10000, true))
            {
                source.Match(dev, ino);
                ValidateSourceSecurity(Descriptor(source.Target.Security()));
                if (unaliased && source.Target.Information().Links != 1)
                    throw new InvalidDataException("Mutable source file removal requires an unaliased file.");
                // Do not clear attributes on an inode that may have another hard link.
                uint disposition = 1 | 2 | 4 | 16;
                Native(SetSourceDisposition(source.Target.handle, 21, ref disposition, 4), "Delete original restoration source");
            }
        }

        public static void RestoreSourceSecurity(string project, string relative, string kind, string dev, string ino,
            string sddl, uint attributes)
        {
            ValidateSourceSecurity(sddl);
            if (attributes == 0 || ((attributes & 128) != 0 && attributes != 128) ||
                (attributes & ~SourceAttributes) != 0 || ((attributes & 16) != 0) != (kind == "directory"))
                throw new InvalidDataException("Unsupported restored source attributes.");
            using (var source = new SourceAccess(project, relative, kind, 0x40000 | 0x80000 | 0x100, true))
            {
                source.Match(dev, ino);
                ValidateSourceSecurity(Descriptor(source.Target.Security()));
                if (kind == "file" && source.Target.Information().Links != 1)
                    throw new InvalidDataException("Restored file security requires an unaliased file.");
                // Exclusive target access prevents implicit propagation outside this explicit entry.
                SetSourceSecurity(source.Target, new RawSecurityDescriptor(sddl), true);
                uint writableAttributes = attributes & ~16u;
                var basic = new SourceBasicInformation { Attributes = writableAttributes == 0 ? 128u : writableAttributes };
                Native(SetSourceBasicInformation(source.Target.handle, 0, ref basic,
                    (uint)Marshal.SizeOf<SourceBasicInformation>()), "Restore original source attributes");
                source.Check();
            }
        }

        public static DirectoryLease CreateSourceDirectory(string project, string relative)
        {
            using (var parents = new SourceParents(project, relative))
            {
                parents.Check();
                DirectoryLease created = CreateDirectory(parents.Target);
                try { parents.Check(); created.Check(); return created; }
                catch { created.Dispose(); throw; }
            }
        }

        public sealed class CreatedSourceFile : IDisposable
        {
            readonly SourceParents parents;
            readonly WindowsPrivateFile target;
            readonly EvidenceIdentity identity;
            internal CreatedSourceFile(string project, string relative)
            {
                parents = new SourceParents(project, relative);
                target = new WindowsPrivateFile { file = parents.Target };
                try
                {
                    parents.Check();
                    target.stream = FileSystemAclExtensions.Create(new FileInfo(target.file), FileMode.CreateNew,
                        FileSystemRights.FullControl, FileShare.ReadWrite, 4096, FileOptions.WriteThrough, PrivateFileSecurity());
                    target.handle = target.stream.SafeFileHandle;
                    identity = target.OriginalIdentity();
                    Check();
                }
                catch { Dispose(); throw; }
            }
            void Check()
            {
                parents.Check();
                EvidenceIdentity current = target.OriginalIdentity();
                FileInformation info = target.Information();
                if (current.Dev != identity.Dev || current.Ino != identity.Ino || info.Links != 1 ||
                    (info.Attributes & (16 | ~SourceAttributes)) != 0 ||
                    !String.Equals(target.FinalPath(), target.file, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Original private restored file changed.");
                RequirePrivate(target.Security());
            }
            public SourceSecurityRecord CaptureIdentity()
            {
                Check();
                return new SourceSecurityRecord(target);
            }
            public SourceSecurityRecord Finish(long length)
            {
                Check();
                target.stream.Flush(true);
                var result = new SourceSecurityRecord(target);
                if (result.Bytes != length) throw new InvalidDataException("Restored private file size differs.");
                Check();
                return result;
            }
            public void Dispose()
            {
                target.Dispose();
                parents.Dispose();
            }
        }

        public static CreatedSourceFile CreateSourceFile(string project, string relative)
        {
            return new CreatedSourceFile(project, relative);
        }
    }
}
