using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Deployment
{
    public sealed class WindowsRuntimeDomain : IDisposable
    {
        WindowsWorkerJob job;
        Process launcher;
        Task<string> result;
        Task<string> diagnostic;
        int? rootExitCode;
        bool admitted, inputClosed, stopping, stopped, disposed;

        public string Name { get; private set; }
        public int LauncherPid { get; private set; }

        WindowsRuntimeDomain() { }

        static void Text(string value, string label, bool absolute = false)
        {
            if (value == null || value.Length > 32768 || value.IndexOf('\0') >= 0 ||
                (absolute && !Path.IsPathFullyQualified(value)))
                throw new ArgumentException("Invalid runtime " + label + ".");
        }
        static JsonElement Frame(string text, params string[] keys)
        {
            using (JsonDocument document = JsonDocument.Parse(text))
            {
                JsonElement root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Invalid runtime launcher frame.");
                var remaining = new HashSet<string>(keys, StringComparer.Ordinal);
                foreach (JsonProperty field in root.EnumerateObject())
                    if (!remaining.Remove(field.Name)) throw new InvalidDataException("Unexpected runtime launcher fields.");
                if (remaining.Count != 0) throw new InvalidDataException("Incomplete runtime launcher frame.");
                return root.Clone();
            }
        }
        public static WindowsRuntimeDomain Start(Guid generation, string pwsh, string helpers,
            string file, string[] args, string cwd, Dictionary<string, string> environment)
        {
            Text(pwsh, "PowerShell", true);
            Text(helpers, "helper directory", true);
            Text(file, "executable", true);
            Text(cwd, "working directory", true);
            if (args == null || args.Length > 4096 || environment == null || environment.Count > 512)
                throw new ArgumentException("Invalid runtime command fields.");
            var copiedArgs = (string[])args.Clone();
            foreach (string arg in copiedArgs) Text(arg, "argument");
            var copiedEnvironment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in environment)
            {
                Text(pair.Value, "environment value");
                if (String.IsNullOrEmpty(pair.Key) || pair.Key.Length > 256)
                    throw new ArgumentException("Invalid runtime environment name.");
                for (int index = 0; index < pair.Key.Length; index++)
                {
                    char value = pair.Key[index];
                    if (!(value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' || value == '_' ||
                        index > 0 && value >= '0' && value <= '9'))
                        throw new ArgumentException("Invalid runtime environment name.");
                }
                copiedEnvironment.Add(pair.Key, pair.Value);
            }
            string grant = JsonSerializer.Serialize(new {
                type = "run", command = new { file, args = copiedArgs, cwd, env = copiedEnvironment }
            });
            if (Encoding.UTF8.GetByteCount(grant) > 65536)
                throw new ArgumentException("Runtime command exceeds the launcher frame limit.");
            var domain = new WindowsRuntimeDomain();
            try
            {
                domain.job = WindowsWorkerJob.Create(generation);
                domain.Name = domain.job.Name;
                var start = new ProcessStartInfo(pwsh) {
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    WorkingDirectory = helpers
                };
                foreach (string arg in new[] { "-NoProfile", "-NonInteractive", "-File",
                    Path.Combine(helpers, "windows-worker-launcher.ps1"), "-JobName", domain.Name,
                    "-OwnerPid", Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    "-OwnerIdentity", domain.job.OwnerIdentity, "-PersistentRuntime" })
                    start.ArgumentList.Add(arg);
                foreach (string key in new List<string>(start.Environment.Keys))
                    if (key.Equals("NODE_OPTIONS", StringComparison.OrdinalIgnoreCase) ||
                        key.Equals("NODE_PATH", StringComparison.OrdinalIgnoreCase)) start.Environment.Remove(key);
                domain.launcher = Process.Start(start);
                if (domain.launcher.Handle == IntPtr.Zero) throw new InvalidOperationException("Runtime launcher handle is unavailable.");
                domain.LauncherPid = domain.launcher.Id;
                domain.diagnostic = WindowsWorkerLauncher.ReadFrameAsync(domain.launcher.StandardError, 4096);
                var ready = WindowsWorkerLauncher.ReadFrameAsync(domain.launcher.StandardOutput, 131072);
                if (!ready.Wait(30000)) throw new TimeoutException("Runtime launcher admission timed out.");
                JsonElement frame = Frame(ready.GetAwaiter().GetResult(), "type", "name", "pid", "processIdentity");
                if (frame.GetProperty("type").GetString() != "ready" ||
                    frame.GetProperty("name").GetString() != domain.Name ||
                    frame.GetProperty("pid").GetInt32() != domain.LauncherPid ||
                    frame.GetProperty("processIdentity").GetString() != WindowsWorkerJob.ProcessIdentity(domain.LauncherPid) ||
                    Array.IndexOf(domain.job.Members(), (long)domain.LauncherPid) < 0 || domain.launcher.HasExited)
                    throw new InvalidOperationException("Runtime launcher did not join the original Job.");
                domain.admitted = true;
                domain.launcher.StandardInput.WriteLine(grant);
                domain.launcher.StandardInput.Flush();
                domain.result = WindowsWorkerLauncher.ReadFrameAsync(domain.launcher.StandardOutput, 131072);
                return domain;
            }
            catch (Exception error)
            {
                try { domain.Dispose(); }
                catch (Exception cleanup) { throw new AggregateException(error, cleanup); }
                throw;
            }
        }

        public sealed class Observation
        {
            public string phase { get; internal set; }
            public int? rootExitCode { get; internal set; }
            public long[] members { get; internal set; }
            public bool applicationHealthy { get { return false; } }
            public bool quiescent { get; internal set; }
        }

        void RequireRetained()
        {
            if (disposed || job == null || launcher == null)
                throw new ObjectDisposedException("Original runtime domain");
        }
        public Observation Observe()
        {
            RequireRetained();
            if (stopping && !stopped) throw new InvalidOperationException("Original runtime Job settlement is incomplete.");
            if (!stopped)
            {
                if (launcher.HasExited) throw new InvalidOperationException("Original runtime launcher exited unexpectedly.");
                if (diagnostic.IsCompletedSuccessfully)
                    throw new InvalidOperationException("Original runtime launcher reported a failure.");
                if (!rootExitCode.HasValue && result.IsCompleted)
                {
                    JsonElement frame = Frame(result.GetAwaiter().GetResult(), "type", "exitCode", "stdout", "stderr");
                    if (frame.GetProperty("type").GetString() != "result")
                        throw new InvalidDataException("Invalid runtime command result.");
                    foreach (string name in new[] { "stdout", "stderr" })
                    {
                        string tail = frame.GetProperty(name).GetString();
                        if (tail == null || tail.Length > 10924 || Convert.FromBase64String(tail).Length > 8192)
                            throw new InvalidDataException("Invalid runtime command output.");
                    }
                    rootExitCode = frame.GetProperty("exitCode").GetInt32();
                }
            }
            long[] members = job.Members();
            if (stopped && members.Length != 0) throw new InvalidOperationException("Original stopped Job is no longer empty.");
            return new Observation {
                phase = stopped ? "stopped" : rootExitCode.HasValue ? "root-exited" : "admitted",
                rootExitCode = rootExitCode, members = members, quiescent = stopped
            };
        }
        public void Stop()
        {
            RequireRetained();
            if (stopped) { Observe(); return; }
            stopping = true;
            if (!inputClosed) { launcher.StandardInput.Close(); inputClosed = true; }
            job.Terminate();
            if (!launcher.WaitForExit(15000)) throw new TimeoutException("Original runtime launcher did not exit.");
            var deadline = Stopwatch.StartNew();
            while (job.Members().Length != 0)
            {
                if (deadline.ElapsedMilliseconds >= 10000)
                    throw new TimeoutException("Original runtime Job did not settle.");
                Thread.Sleep(20);
            }
            stopped = true;
        }
        public void Retire()
        {
            RequireRetained();
            if (!stopped) throw new InvalidOperationException("Original runtime Job must settle before retirement.");
            Observe();
            Dispose();
        }
        public void Dispose()
        {
            if (disposed) return;
            var errors = new List<Exception>();
            if (job != null)
            {
                try { job.Dispose(); job = null; }
                catch (Exception error) { errors.Add(error); }
            }
            if (launcher != null)
            {
                try
                {
                    // A failed admission may leave the gated launcher outside the Job.
                    if (!admitted && !launcher.HasExited)
                    {
                        try { launcher.Kill(); }
                        catch (InvalidOperationException) when (launcher.HasExited) { }
                    }
                    if (!launcher.WaitForExit(15000)) throw new TimeoutException("Original runtime launcher cleanup timed out.");
                    launcher.Dispose();
                    launcher = null;
                }
                catch (Exception error) { errors.Add(error); }
            }
            if (errors.Count != 0) throw new AggregateException("Runtime domain cleanup is incomplete.", errors);
            disposed = true;
        }
    }
}
