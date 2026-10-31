using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Deployment
{
    internal sealed class WindowsControllerToken : IDisposable
    {
        const int User = 1, Privileges = 3, Owner = 4, Statistics = 10, Session = 12, Elevation = 20, Integrity = 25;
        const uint Query = 8, AdjustDefault = 0x80;
        SafeAccessTokenHandle original;
        string owner, user, permissions, statistics;
        bool prepared, disposed;

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
        [DllImport("advapi32.dll", EntryPoint = "OpenProcessToken", SetLastError = true)]
        static extern bool OpenChildToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(SafeAccessTokenHandle token, int type, IntPtr buffer, int size, out int needed);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool SetTokenInformation(SafeAccessTokenHandle token, int type, IntPtr buffer, int size);

        static void Native(bool success, string stage)
        {
            if (!success)
            {
                int error = Marshal.GetLastWin32Error();
                throw new Win32Exception(error, stage + " (Win32 " + error + ").");
            }
        }
        static string Information(SafeAccessTokenHandle token, int type, bool sid)
        {
            bool fixedSize = type == Elevation || type == Session || type == Statistics;
            int needed = type == Statistics ? 56 : 4;
            if (!fixedSize)
            {
                bool sized = GetTokenInformation(token, type, IntPtr.Zero, 0, out needed);
                int error = Marshal.GetLastWin32Error();
                if (sized || error != 122 || needed < (sid ? IntPtr.Size : 4) || needed > 65536)
                    throw new InvalidOperationException("Invalid controller token information size for class " + type + ".");
            }
            int capacity = needed;
            IntPtr data = Marshal.AllocHGlobal(capacity);
            try
            {
                Native(GetTokenInformation(token, type, data, capacity, out needed), "Read controller token class " + type);
                if (needed < (sid ? IntPtr.Size : 4) || needed > capacity || fixedSize && needed != capacity)
                    throw new InvalidOperationException("Invalid returned controller token size.");
                if (sid) return new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;
                byte[] bytes = new byte[needed];
                Marshal.Copy(data, bytes, 0, needed);
                return Convert.ToHexString(bytes);
            }
            finally { Marshal.FreeHGlobal(data); }
        }
        static string Permissions(SafeAccessTokenHandle token)
        {
            return Information(token, User, true) + ":" + Information(token, Privileges, false) + ":" +
                Information(token, Elevation, false) + ":" + Information(token, Integrity, true) + ":" +
                Information(token, Session, false);
        }
        WindowsControllerToken() { }
        internal static WindowsControllerToken Capture()
        {
            var context = new WindowsControllerToken();
            try
            {
                Native(OpenProcessToken(new IntPtr(-1), Query, out context.original), "Open original controller caller token");
                context.owner = Information(context.original, Owner, true);
                context.user = Information(context.original, User, true);
                context.permissions = Permissions(context.original);
                context.statistics = Information(context.original, Statistics, false);
                return context;
            }
            catch { context.Dispose(); throw; }
        }
        internal void Check()
        {
            if (disposed) throw new ObjectDisposedException("Controller token");
            if (Information(original, Owner, true) != owner || Permissions(original) != permissions ||
                Information(original, Statistics, false) != statistics)
                throw new InvalidOperationException("Original controller caller token changed.");
        }
        internal void PrepareChild(SafeProcessHandle child)
        {
            Check();
            if (prepared) throw new InvalidOperationException("Controller child token preparation was already attempted.");
            prepared = true;
            SafeAccessTokenHandle actual;
            Native(OpenChildToken(child, Query | AdjustDefault, out actual), "Open distinct controller child token");
            using (actual)
            {
                string childStatistics = Information(actual, Statistics, false);
                // TOKEN_STATISTICS begins with token/authentication LUIDs; TokenType is at byte 24.
                if (childStatistics.Substring(0, 16) == statistics.Substring(0, 16) ||
                    childStatistics.Substring(16, 16) != statistics.Substring(16, 16) ||
                    childStatistics.Substring(48, 8) != "01000000" ||
                    Information(actual, Owner, true) != owner || Permissions(actual) != permissions)
                    throw new InvalidOperationException("Controller child token is shared or differs before admission.");
                var sid = new SecurityIdentifier(user);
                byte[] bytes = new byte[sid.BinaryLength];
                sid.GetBinaryForm(bytes, 0);
                IntPtr sidData = Marshal.AllocHGlobal(bytes.Length);
                IntPtr descriptor = IntPtr.Zero;
                try
                {
                    descriptor = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.Copy(bytes, 0, sidData, bytes.Length);
                    Marshal.WriteIntPtr(descriptor, sidData);
                    Native(SetTokenInformation(actual, Owner, descriptor, IntPtr.Size), "Set distinct controller child default owner");
                }
                finally
                {
                    if (descriptor != IntPtr.Zero) Marshal.FreeHGlobal(descriptor);
                    Marshal.FreeHGlobal(sidData);
                }
                if (Information(actual, Owner, true) != user || Permissions(actual) != permissions ||
                    Information(actual, Statistics, false).Substring(0, 16) != childStatistics.Substring(0, 16))
                    throw new InvalidOperationException("Controller child token changed identity or privileges.");
                Check();
            }
        }
        public void Dispose()
        {
            if (disposed) return;
            if (original != null) original.Dispose();
            disposed = true;
        }
    }
}
