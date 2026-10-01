using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Deployment
{
    public sealed class WindowsRuntimeControl : IDisposable
    {
        const int RequestLimit = 8192, ReplyLimit = 131072, PeerTimeout = 5000;
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        readonly WindowsRuntimeDomain domain;
        readonly NamedPipeServerStream pipe;
        readonly string generation, ownerIdentity;
        readonly int ownerPid;
        bool running, disposed;

        public WindowsRuntimeControl(WindowsRuntimeDomain domain, Guid generation)
        {
            if (domain == null || generation == Guid.Empty ||
                domain.Name != @"Local\agents-deploy-" + generation.ToString("D"))
                throw new ArgumentException("Control requires the original runtime domain generation.");
            this.domain = domain;
            this.generation = generation.ToString("D");
            ownerPid = Environment.ProcessId;
            ownerIdentity = WindowsWorkerJob.ProcessIdentity(ownerPid);
            pipe = WindowsRuntimePipe.Create(generation);
        }

        static JsonElement Fields(string text, params string[] names)
        {
            using (JsonDocument document = JsonDocument.Parse(text))
            {
                JsonElement root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Invalid runtime control object.");
                var remaining = new HashSet<string>(names, StringComparer.Ordinal);
                foreach (JsonProperty field in root.EnumerateObject())
                    if (!remaining.Remove(field.Name)) throw new InvalidDataException("Unexpected runtime control fields.");
                if (remaining.Count != 0) throw new InvalidDataException("Incomplete runtime control object.");
                return root.Clone();
            }
        }
        static bool Equal(JsonElement root, string name, string value)
        {
            JsonElement field = root.GetProperty(name);
            return field.ValueKind == JsonValueKind.String && field.GetString() == value;
        }
        static bool Equal(JsonElement root, string name, int value)
        {
            JsonElement field = root.GetProperty(name);
            int number;
            return field.ValueKind == JsonValueKind.Number && field.TryGetInt32(out number) && number == value;
        }
        static bool Method(string method)
        {
            return method == "observe" || method == "stop" || method == "retire";
        }
        static async Task<string> ReadFrame(PipeStream stream, int maximum, CancellationToken token)
        {
            byte[] bytes = new byte[maximum], next = new byte[1];
            int count = 0;
            while (true)
            {
                if (await stream.ReadAsync(next.AsMemory(), token).ConfigureAwait(false) == 0)
                    throw new EndOfStreamException("Runtime control peer closed.");
                if (next[0] == 10) return Utf8.GetString(bytes, 0, count);
                if (count == maximum) throw new InvalidDataException("Runtime control frame exceeds limit.");
                bytes[count++] = next[0];
            }
        }
        static async Task WriteFrame(PipeStream stream, string frame, int maximum, CancellationToken token)
        {
            byte[] bytes = Utf8.GetBytes(frame + "\n");
            if (bytes.Length - 1 > maximum) throw new InvalidDataException("Runtime control reply exceeds limit.");
            await stream.WriteAsync(bytes.AsMemory(), token).ConfigureAwait(false);
        }
        static void Log(string reason)
        {
            Console.Error.WriteLine("Runtime control peer refused: " + reason + ".");
        }
        async Task Send(string frame)
        {
            using (var timeout = new CancellationTokenSource(PeerTimeout))
            {
                try
                {
                    await WriteFrame(pipe, frame, ReplyLimit, timeout.Token).ConfigureAwait(false);
                    // DisconnectNamedPipe discards unread replies; let the receiving client close first.
                    byte[] trailing = new byte[1024];
                    int total = 0, count;
                    while ((count = await pipe.ReadAsync(trailing.AsMemory(), timeout.Token).ConfigureAwait(false)) != 0)
                    {
                        if (total == 0) Log("trailing-data");
                        total += count;
                        if (total > RequestLimit) { Log("trailing-size"); return; }
                    }
                }
                catch (OperationCanceledException) { Log("reply-deadline"); }
                catch (IOException error) when (!(error is InvalidDataException)) { Log("reply-disconnected"); }
            }
        }
        async Task Refuse(string reason)
        {
            Log(reason);
            await Send("refused").ConfigureAwait(false);
        }
        async Task<bool> Serve()
        {
            string text;
            using (var timeout = new CancellationTokenSource(PeerTimeout))
            {
                try { text = await ReadFrame(pipe, RequestLimit, timeout.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) { Log("request-deadline"); return false; }
                catch (EndOfStreamException) { Log("request-disconnected"); return false; }
                catch (InvalidDataException) { await Refuse("request-size").ConfigureAwait(false); return false; }
                catch (DecoderFallbackException) { await Refuse("request-encoding").ConfigureAwait(false); return false; }
                catch (IOException) { Log("request-transport"); return false; }
            }
            JsonElement request;
            string method, requestId;
            try
            {
                request = Fields(text, "version", "generation", "ownerPid", "ownerIdentity", "requestId", "method");
                if (!Equal(request, "version", 1) || !Equal(request, "generation", generation) ||
                    !Equal(request, "ownerPid", ownerPid) || !Equal(request, "ownerIdentity", ownerIdentity) ||
                    request.GetProperty("requestId").ValueKind != JsonValueKind.String ||
                    request.GetProperty("method").ValueKind != JsonValueKind.String)
                    throw new InvalidDataException("Runtime control scope differs.");
                method = request.GetProperty("method").GetString();
                requestId = request.GetProperty("requestId").GetString();
                Guid id;
                if (!Method(method) || !Guid.TryParseExact(requestId, "D", out id) ||
                    id == Guid.Empty || id.ToString("D") != requestId)
                    throw new InvalidDataException("Invalid runtime control request.");
            }
            catch (JsonException) { await Refuse("request-json").ConfigureAwait(false); return false; }
            catch (InvalidDataException) { await Refuse("request-scope").ConfigureAwait(false); return false; }

            object result;
            if (method == "retire")
            {
                if (domain.Observe().phase != "stopped")
                {
                    await Refuse("retirement-before-settlement").ConfigureAwait(false);
                    return false;
                }
                domain.Retire();
                result = "retired";
            }
            else
            {
                if (method == "stop") domain.Stop();
                result = domain.Observe();
            }
            await Send(JsonSerializer.Serialize(new {
                version = 1, generation, ownerPid, ownerIdentity, requestId, result
            })).ConfigureAwait(false);
            return method == "retire";
        }
        async Task Listen()
        {
            while (true)
            {
                await pipe.WaitForConnectionAsync().ConfigureAwait(false);
                bool retired;
                try { retired = await Serve().ConfigureAwait(false); }
                finally { pipe.Disconnect(); }
                if (retired) return;
            }
        }
        public void Run()
        {
            if (disposed || running) throw new InvalidOperationException("Runtime control listener is unavailable.");
            running = true;
            Listen().GetAwaiter().GetResult();
        }

        static string CaptureResult(JsonElement result, string method)
        {
            if (method == "retire")
            {
                if (result.ValueKind != JsonValueKind.String || result.GetString() != "retired")
                    throw new InvalidDataException("Invalid runtime retirement reply.");
                return "retired";
            }
            JsonElement value = Fields(result.GetRawText(), "phase", "rootExitCode", "members", "applicationHealthy", "quiescent");
            bool admitted = Equal(value, "phase", "admitted"), exited = Equal(value, "phase", "root-exited");
            bool stopped = Equal(value, "phase", "stopped");
            JsonElement exit = value.GetProperty("rootExitCode"), members = value.GetProperty("members");
            int code;
            bool hasExit = exit.ValueKind == JsonValueKind.Number && exit.TryGetInt32(out code);
            if ((!admitted && !exited && !stopped) || method == "stop" && !stopped ||
                admitted && exit.ValueKind != JsonValueKind.Null || exited && !hasExit ||
                exit.ValueKind != JsonValueKind.Null && !hasExit ||
                value.GetProperty("applicationHealthy").ValueKind != JsonValueKind.False ||
                value.GetProperty("quiescent").ValueKind != (stopped ? JsonValueKind.True : JsonValueKind.False) ||
                members.ValueKind != JsonValueKind.Array || members.GetArrayLength() > 4096 ||
                stopped && members.GetArrayLength() != 0)
                throw new InvalidDataException("Invalid runtime domain observation.");
            var seen = new HashSet<int>();
            foreach (JsonElement member in members.EnumerateArray())
            {
                int pid;
                if (member.ValueKind != JsonValueKind.Number || !member.TryGetInt32(out pid) || pid < 1 || !seen.Add(pid))
                    throw new InvalidDataException("Invalid runtime Job member.");
            }
            return value.GetRawText();
        }
        static async Task<string> ExchangeFrames(PipeStream client, string generation, int ownerPid,
            string ownerIdentity, string method, CancellationToken token)
        {
            string requestId = Guid.NewGuid().ToString("D");
            await WriteFrame(client, JsonSerializer.Serialize(new {
                version = 1, generation, ownerPid, ownerIdentity, requestId, method
            }), RequestLimit, token).ConfigureAwait(false);
            string text = await ReadFrame(client, ReplyLimit, token).ConfigureAwait(false);
            if (text == "refused") throw new InvalidOperationException("Runtime control request was refused.");
            JsonElement response = Fields(text, "version", "generation", "ownerPid", "ownerIdentity", "requestId", "result");
            if (!Equal(response, "version", 1) || !Equal(response, "generation", generation) ||
                !Equal(response, "ownerPid", ownerPid) || !Equal(response, "ownerIdentity", ownerIdentity) ||
                !Equal(response, "requestId", requestId))
                throw new InvalidDataException("Runtime control response identity differs.");
            return CaptureResult(response.GetProperty("result"), method);
        }
        public static string Exchange(Guid generation, int ownerPid, string ownerIdentity, string method, int timeoutMilliseconds)
        {
            if (!Method(method)) throw new ArgumentException("Unsupported runtime control method.");
            var elapsed = Stopwatch.StartNew();
            using (var client = WindowsRuntimePipe.Connect(generation, ownerPid, ownerIdentity, timeoutMilliseconds))
            {
                int remaining = timeoutMilliseconds - (int)elapsed.ElapsedMilliseconds;
                if (remaining <= 0) throw new TimeoutException("Runtime control exchange timed out.");
                using (var timeout = new CancellationTokenSource(remaining))
                {
                    try
                    {
                        return ExchangeFrames(client, generation.ToString("D"), ownerPid, ownerIdentity,
                            method, timeout.Token).GetAwaiter().GetResult();
                    }
                    catch (OperationCanceledException error)
                    {
                        throw new TimeoutException("Runtime control exchange timed out.", error);
                    }
                }
            }
        }
        public void Dispose()
        {
            if (disposed) return;
            pipe.Dispose();
            disposed = true;
        }
    }
}
