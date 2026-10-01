using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Deployment
{
    public sealed class WindowsRuntimeHost : IDisposable
    {
        static readonly string[] Helpers = {
            "WindowsWorkerJob.cs", "WindowsRuntimeDomain.cs", "WindowsRuntimePipe.cs",
            "WindowsRuntimeControl.cs", "WindowsPrivateFile.cs", "WindowsRuntimeHost.cs",
            "windows-worker-launcher.ps1", "windows-runtime-host.ps1"
        };
        readonly List<WindowsPrivateFile> retained = new List<WindowsPrivateFile>();
        WindowsRuntimeDomain domain;
        WindowsRuntimeControl control;
        bool disposed;

        WindowsRuntimeHost() { }

        static JsonElement Fields(JsonElement value, params string[] fields)
        {
            if (value.ValueKind != JsonValueKind.Object)
                throw new InvalidDataException("Runtime configuration requires an object.");
            var remaining = new HashSet<string>(fields, StringComparer.Ordinal);
            foreach (JsonProperty field in value.EnumerateObject())
                if (!remaining.Remove(field.Name))
                    throw new InvalidDataException("Unexpected runtime configuration field.");
            if (remaining.Count != 0) throw new InvalidDataException("Incomplete runtime configuration.");
            return value;
        }
        WindowsPrivateFile Retain(string file, string sha256)
        {
            WindowsPrivateFile value = WindowsPrivateFile.Open(file, sha256);
            retained.Add(value);
            return value;
        }
        void Check()
        {
            if (disposed) throw new ObjectDisposedException("Managed runtime host");
            foreach (WindowsPrivateFile file in retained) file.Check();
        }
        void Publish(string directory, string configurationSha256, Guid generation)
        {
            int pid = Environment.ProcessId;
            string identity = WindowsWorkerJob.ProcessIdentity(pid);
            int session;
            using (Process process = Process.GetCurrentProcess()) session = process.SessionId;
            byte[] bytes = new UTF8Encoding(false, true).GetBytes(JsonSerializer.Serialize(new {
                version = 1, generation = generation.ToString("D"), pid, identity,
                configurationSha256, sessionId = session, job = domain.Name,
                launcherPid = domain.LauncherPid
            }));
            string file = Path.Combine(directory, "runtime-" + identity.Replace(':', '-') + ".json");
            string pending = file + ".pending-" + Guid.NewGuid().ToString("D");
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
            using (FileStream stream = FileSystemAclExtensions.Create(new FileInfo(pending), FileMode.CreateNew,
                FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.WriteThrough, security))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            File.Move(pending, file);
            Retain(file, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        }
        public static void Run(string configuration, string sha256, string helpers, string pwsh)
        {
            string stage = "configuration";
            try
            {
                using (var host = new WindowsRuntimeHost())
                {
                    WindowsPrivateFile config = host.Retain(configuration, sha256);
                    if (!String.Equals(Path.GetDirectoryName(configuration), helpers, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Configuration must belong to the installed helper bundle.");
                    using (JsonDocument document = JsonDocument.Parse(config.ReadText(),
                        new JsonDocumentOptions { MaxDepth = 16 }))
                    {
                        JsonElement root = Fields(document.RootElement, "version", "helpers", "command");
                        if (root.GetProperty("version").GetInt32() != 1)
                            throw new InvalidDataException("Unsupported runtime configuration version.");
                        stage = "helpers";
                        JsonElement files = Fields(root.GetProperty("helpers"), Helpers);
                        foreach (string name in Helpers)
                            host.Retain(Path.Combine(helpers, name), files.GetProperty(name).GetString());
                        stage = "command";
                        JsonElement command = Fields(root.GetProperty("command"), "file", "args", "cwd", "environment");
                        JsonElement arguments = command.GetProperty("args");
                        if (arguments.ValueKind != JsonValueKind.Array || arguments.GetArrayLength() > 4096)
                            throw new InvalidDataException("Invalid runtime command arguments.");
                        var args = new List<string>();
                        foreach (JsonElement arg in arguments.EnumerateArray()) args.Add(arg.GetString());
                        JsonElement variables = command.GetProperty("environment");
                        if (variables.ValueKind != JsonValueKind.Object)
                            throw new InvalidDataException("Invalid runtime command environment.");
                        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                        foreach (JsonProperty variable in variables.EnumerateObject())
                        {
                            if (environment.Count == 512)
                                throw new InvalidDataException("Runtime environment exceeds the limit.");
                            environment.Add(variable.Name, variable.Value.GetString());
                        }
                        host.Check();
                        Guid generation = Guid.NewGuid();
                        host.domain = WindowsRuntimeDomain.Start(generation, pwsh, helpers,
                            command.GetProperty("file").GetString(), args.ToArray(),
                            command.GetProperty("cwd").GetString(), environment);
                        stage = "publication";
                        host.control = new WindowsRuntimeControl(host.domain, generation, host.Check);
                        host.Check();
                        host.Publish(helpers, config.Sha256, generation);
                    }
                    stage = "control";
                    host.Check();
                    host.control.Run();
                }
            }
            catch
            {
                throw new InvalidOperationException("Managed runtime startup refused: " + stage + ".");
            }
        }
        public void Dispose()
        {
            if (disposed) return;
            try
            {
                try { if (control != null) control.Dispose(); }
                finally { if (domain != null) domain.Dispose(); }
            }
            finally
            {
                foreach (WindowsPrivateFile file in retained) file.Dispose();
                disposed = true;
            }
        }
    }
}
