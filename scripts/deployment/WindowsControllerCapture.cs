using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Deployment
{
    public sealed class WindowsControllerCapture : IDisposable
    {
        const int MaximumFileBytes = 1024 * 1024;
        readonly List<IDisposable> resources = new List<IDisposable>();
        readonly List<WindowsPrivateFile.DirectoryLease> directories = new List<WindowsPrivateFile.DirectoryLease>();
        readonly List<WindowsPrivateFile> files = new List<WindowsPrivateFile>();
        string[] names;
        bool disposed;
        public string Directory { get; private set; }

        WindowsControllerCapture() { }

        static void Canonical(string value)
        {
            if (String.IsNullOrEmpty(value) || value.Length < 4 || value.Length > 4096 ||
                !Char.IsAsciiLetter(value[0]) || value[1] != ':' || value[2] != '\\' ||
                value.Substring(3).Contains(':') || value.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0 ||
                !String.Equals(Path.GetFullPath(value), value, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Canonical local controller paths are required.");
        }

        static bool Within(string child, string parent)
        {
            return String.Equals(child, parent, StringComparison.OrdinalIgnoreCase) ||
                child.StartsWith(parent.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
        }

        static string[] Inventory(string directory)
        {
            string[] entries = System.IO.Directory.GetFileSystemEntries(directory);
            if (entries.Length == 0 || entries.Length > 256)
                throw new InvalidDataException("Controller helper inventory exceeds its bound.");
            var names = new List<string>();
            foreach (string entry in entries)
            {
                string name = Path.GetFileName(entry);
                if (!Regex.IsMatch(name, @"^[A-Za-z0-9][A-Za-z0-9_.-]*\.(mjs|json|ps1|cs)$",
                    RegexOptions.CultureInvariant) ||
                    (File.GetAttributes(entry) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                    throw new InvalidDataException("Unsupported controller helper inventory or links.");
                names.Add(name);
            }
            return names.OrderBy(name => name, StringComparer.Ordinal).ToArray();
        }

        static void ExactEntries(string directory, params string[] expected)
        {
            string[] actual = System.IO.Directory.GetFileSystemEntries(directory)
                .Select(Path.GetFileName).OrderBy(name => name, StringComparer.Ordinal).ToArray();
            if (!actual.SequenceEqual(expected.OrderBy(name => name, StringComparer.Ordinal), StringComparer.Ordinal))
                throw new InvalidDataException("Captured controller inventory changed.");
        }

        void AddDirectory(string directory)
        {
            WindowsPrivateFile.DirectoryLease retained = WindowsPrivateFile.CreateDirectory(directory);
            resources.Add(retained);
            directories.Add(retained);
        }

        public static WindowsControllerCapture Create(string source, string project, string directory)
        {
            Canonical(source);
            Canonical(project);
            Canonical(directory);
            if (Within(directory, source) || Within(directory, project) ||
                Within(source, directory) || Within(project, directory))
                throw new ArgumentException("Controller capture must be outside source and installed project.");
            var capture = new WindowsControllerCapture { Directory = directory };
            var originals = new List<IDisposable>();
            var originalDirectories = new List<WindowsPrivateFile.DirectoryLease>();
            var originalFiles = new List<WindowsPrivateFile>();
            var failures = new List<Exception>();
            try
            {
                foreach (string original in new[] { source, Path.Combine(source, "scripts"),
                    Path.Combine(source, "scripts", "deployment"), Path.Combine(source, "lib"),
                    Path.Combine(source, "lib", "workflow"), project })
                {
                    WindowsPrivateFile.DirectoryLease retained = WindowsPrivateFile.OpenSourceDirectory(original);
                    originals.Add(retained);
                    originalDirectories.Add(retained);
                }
                string helpers = Path.Combine(source, "scripts", "deployment");
                capture.names = Inventory(helpers);
                var relativeFiles = capture.names.Select(name => Path.Combine("scripts", "deployment", name)).ToList();
                relativeFiles.Add(Path.Combine("lib", "workflow", "workflowSchema.mjs"));
                capture.AddDirectory(directory);
                foreach (string relative in new[] { "scripts", Path.Combine("scripts", "deployment"),
                    "lib", Path.Combine("lib", "workflow") })
                    capture.AddDirectory(Path.Combine(directory, relative));
                long total = 0;
                foreach (string relative in relativeFiles)
                {
                    string original = Path.Combine(source, relative);
                    string hash;
                    using (var stream = new FileStream(original, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        if (stream.Length > MaximumFileBytes || (total += stream.Length) > 16L * MaximumFileBytes)
                            throw new InvalidDataException("Controller capture exceeds its byte budget.");
                        hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
                        WindowsPrivateFile retained = WindowsPrivateFile.OpenSourceFile(original, hash);
                        originals.Add(retained);
                        originalFiles.Add(retained);
                    }
                    WindowsPrivateFile copy = WindowsPrivateFile.CopyTrustedSource(
                        original, hash, Path.Combine(directory, relative));
                    capture.resources.Add(copy);
                    capture.files.Add(copy);
                }
                foreach (WindowsPrivateFile.DirectoryLease original in originalDirectories) original.Check();
                foreach (WindowsPrivateFile original in originalFiles) original.Check();
                if (!Inventory(helpers).SequenceEqual(capture.names, StringComparer.Ordinal))
                    throw new InvalidDataException("Controller source inventory changed during capture.");
                capture.Check();
            }
            catch (Exception failure) { failures.Add(failure); }
            finally
            {
                originals.Reverse();
                foreach (IDisposable original in originals)
                {
                    try { original.Dispose(); }
                    catch (Exception cleanup) { failures.Add(cleanup); }
                }
            }
            if (failures.Count != 0)
            {
                try { capture.Dispose(); }
                catch (Exception cleanup) { failures.Add(cleanup); }
                throw new AggregateException(
                    "Controller capture failed; retain any incomplete destination " + directory + ".", failures);
            }
            return capture;
        }

        public void Check()
        {
            if (disposed) throw new ObjectDisposedException("Windows controller capture");
            foreach (WindowsPrivateFile.DirectoryLease directory in directories) directory.Check();
            ExactEntries(Directory, "scripts", "lib");
            ExactEntries(Path.Combine(Directory, "scripts"), "deployment");
            ExactEntries(Path.Combine(Directory, "lib"), "workflow");
            ExactEntries(Path.Combine(Directory, "lib", "workflow"), "workflowSchema.mjs");
            ExactEntries(Path.Combine(Directory, "scripts", "deployment"), names);
            foreach (WindowsPrivateFile file in files) file.Check();
            foreach (WindowsPrivateFile.DirectoryLease directory in directories) directory.Check();
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            var failures = new List<Exception>();
            for (int index = resources.Count - 1; index >= 0; index--)
            {
                try { resources[index].Dispose(); }
                catch (Exception failure) { failures.Add(failure); }
            }
            if (failures.Count != 0) throw new AggregateException("Controller capture handles did not close.", failures);
        }
    }
}
