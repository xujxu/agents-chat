using System;
using System.Diagnostics;
using System.Globalization;
using System.Threading;

namespace Deployment
{
    public sealed class WindowsRuntimeLease : IDisposable
    {
        readonly object gate = new object();
        readonly Process owner;
        readonly Stopwatch lifetime;
        readonly int timeoutMilliseconds;
        readonly Timer timer;
        bool released, disposed;

        WindowsRuntimeLease(int pid, string identity, int timeoutMilliseconds)
        {
            if (timeoutMilliseconds < 1 || timeoutMilliseconds > 1800000)
                throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            if (pid < 1 || pid == Environment.ProcessId || String.IsNullOrEmpty(identity) || identity.Length > 64)
                throw new ArgumentException("An original activation controller is required.");
            owner = Process.GetProcessById(pid);
            try
            {
                if (owner.Handle == IntPtr.Zero || owner.HasExited ||
                    identity != pid.ToString(CultureInfo.InvariantCulture) + ":" +
                        owner.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture))
                    throw new InvalidOperationException("Original activation controller identity differs.");
                this.timeoutMilliseconds = timeoutMilliseconds;
                lifetime = Stopwatch.StartNew();
                timer = new Timer(Tick, null, 250, 250);
            }
            catch
            {
                owner.Dispose();
                throw;
            }
        }

        public static WindowsRuntimeLease Start(int pid, string identity, int timeoutMilliseconds = 1800000)
        {
            return new WindowsRuntimeLease(pid, identity, timeoutMilliseconds);
        }

        void RequireOwner()
        {
            if (owner.HasExited || lifetime.ElapsedMilliseconds >= timeoutMilliseconds)
                throw new InvalidOperationException("Original activation controller or lifetime is unavailable.");
        }

        void Tick(object state)
        {
            lock (gate)
            {
                if (disposed || released) return;
                try { RequireOwner(); }
                catch
                {
                    Console.Error.WriteLine("Runtime activation lease expired or its original controller exited.");
                    Environment.Exit(1);
                }
            }
        }

        public void Check()
        {
            lock (gate)
            {
                if (disposed) throw new ObjectDisposedException("Runtime activation lease");
                if (!released) RequireOwner();
            }
        }

        public bool TryRelease(int actualPeerPid)
        {
            lock (gate)
            {
                if (disposed) throw new ObjectDisposedException("Runtime activation lease");
                if (actualPeerPid != owner.Id || owner.HasExited) return false;
                if (released) return true;
                RequireOwner();
                released = true;
                timer.Dispose();
                return true;
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
                timer.Dispose();
                owner.Dispose();
            }
        }
    }
}
