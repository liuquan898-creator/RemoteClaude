// RemoteClaude 解锁服务：电脑锁屏时，替控制端把 Windows 密码或 PIN 输进登录界面。
// 设计和安全措施见 docs/06-unlock-service.md。
// 用 .NET Framework 自带的 csc.exe 编译（只支持 C# 5 语法），安装见 install.ps1。
//
// 运行方式：
//   RemoteClaudeUnlock.exe            作为 Windows 服务运行（由服务管理器启动，SYSTEM 身份）
//   RemoteClaudeUnlock.exe --console  以普通身份在控制台运行，只用于测试管道协议，不能真正解锁
//   RemoteClaudeUnlock.exe --inject   由服务在用户会话的安全桌面上启动，从标准输入读密码并输入
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace RemoteClaude
{
    static class Program
    {
        public const string PipeName = "RemoteClaudeUnlock";
        public static bool ConsoleMode;

        static int Main(string[] args)
        {
            string mode = args.Length > 0 ? args[0] : "";
            if (mode == "--inject") return Injector.Run();
            if (mode == "--console")
            {
                ConsoleMode = true;
                Log.Write("以控制台方式运行（只用于测试），按 Ctrl+C 结束");
                new PipeServer(false).Run();
                return 0;
            }
            ServiceBase.Run(new UnlockService());
            return 0;
        }
    }

    class UnlockService : ServiceBase
    {
        PipeServer server;

        public UnlockService()
        {
            ServiceName = Program.PipeName;
            CanStop = true;
            CanHandleSessionChangeEvent = true;
        }

        protected override void OnStart(string[] args)
        {
            Session.UseEvents();
            server = new PipeServer(true);
            var thread = new Thread(server.Run);
            thread.IsBackground = true;
            thread.Start();
            Log.Write("服务已启动");
        }

        protected override void OnStop()
        {
            if (server != null) server.Stop();
            Log.Write("服务已停止");
        }

        /// <summary>系统通知的锁屏、解锁事件，是判断锁屏最可靠的依据</summary>
        protected override void OnSessionChange(SessionChangeDescription change)
        {
            uint id = (uint)change.SessionId;
            switch (change.Reason)
            {
                case SessionChangeReason.SessionLock:
                    Session.MarkLocked(id, true);
                    break;
                case SessionChangeReason.SessionUnlock:
                case SessionChangeReason.SessionLogon:
                case SessionChangeReason.SessionLogoff:
                    Session.MarkLocked(id, false);
                    break;
            }
        }
    }

    /// <summary>命名管道服务：一次处理一个连接，每个连接一条命令</summary>
    class PipeServer
    {
        const int MaxFailures = 3;
        static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(15);

        readonly bool asService;
        readonly List<DateTime> failures = new List<DateTime>();
        volatile bool stopping;

        public PipeServer(bool asService)
        {
            this.asService = asService;
        }

        public void Stop()
        {
            stopping = true;
            // 连一下自己，让正在等连接的循环醒过来
            try
            {
                using (var c = new NamedPipeClientStream(".", Program.PipeName)) c.Connect(500);
            }
            catch (Exception) { }
        }

        /// <summary>只允许本机交互登录的用户和 SYSTEM，拒绝经网络访问</summary>
        static PipeSecurity Security()
        {
            var ps = new PipeSecurity();
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
                PipeAccessRights.FullControl, AccessControlType.Deny));
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null),
                PipeAccessRights.ReadWrite, AccessControlType.Allow));
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                PipeAccessRights.FullControl, AccessControlType.Allow));
            return ps;
        }

        public void Run()
        {
            while (!stopping)
            {
                NamedPipeServerStream pipe = null;
                try
                {
                    pipe = new NamedPipeServerStream(Program.PipeName, PipeDirection.InOut, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, Security());
                    pipe.WaitForConnection();
                    if (stopping) break;
                    Handle(pipe);
                }
                catch (Exception e)
                {
                    Log.Write("管道出错: " + e.Message);
                    Thread.Sleep(500);
                }
                finally
                {
                    if (pipe != null) pipe.Dispose();
                }
            }
        }

        void Handle(NamedPipeServerStream pipe)
        {
            string line = ReadLine(pipe, 2048);
            string reply;
            if (line == null) reply = "ERR failed";
            else if (line == "STATUS") reply = "OK locked=" + (Session.IsLocked(Session.Console()) ? "1" : "0");
            else if (line.StartsWith("UNLOCK ")) reply = Unlock(line.Substring(7));
            else reply = "ERR failed";
            byte[] bytes = Encoding.UTF8.GetBytes(reply + "\n");
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
            try { pipe.WaitForPipeDrain(); } catch (Exception) { }
        }

        /// <summary>读一行，最多等 5 秒，免得一个不说话的连接把服务卡住</summary>
        static string ReadLine(Stream s, int max)
        {
            var buf = new byte[max];
            int len = 0;
            try
            {
                while (len < max)
                {
                    IAsyncResult ar = s.BeginRead(buf, len, max - len, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(5000)) return null;
                    int n = s.EndRead(ar);
                    if (n <= 0) return null;
                    len += n;
                    int nl = Array.IndexOf(buf, (byte)'\n', 0, len);
                    if (nl >= 0) return Encoding.UTF8.GetString(buf, 0, nl).TrimEnd('\r');
                }
                return null;
            }
            finally
            {
                Array.Clear(buf, 0, buf.Length); // 里面可能有密码
            }
        }

        string Unlock(string b64)
        {
            Log.Write("收到解锁请求");
            string password;
            try
            {
                password = Encoding.UTF8.GetString(Convert.FromBase64String(b64.Trim()));
            }
            catch (FormatException)
            {
                return "ERR failed";
            }
            if (password.Length == 0 || password.Length > 256) return "ERR failed";

            lock (failures)
            {
                failures.RemoveAll(t => DateTime.UtcNow - t > FailureWindow);
                if (failures.Count >= MaxFailures) return "ERR rate-limited";
            }
            uint session = Session.Console();
            if (!Session.IsLocked(session)) return "ERR not-locked";
            // 控制台测试模式没有 SYSTEM 身份，进不了安全桌面
            if (!asService) return "ERR no-service";

            int code;
            try
            {
                code = Launcher.RunInjector(session, password);
            }
            catch (Exception e)
            {
                Log.Write("启动注入进程失败: " + e.Message);
                return "ERR failed";
            }
            if (code == Injector.NoLogonScreen) { Log.Write("没找到登录界面，没有输入"); return "ERR no-logon-screen"; }
            if (code == Injector.NotLocked) return "ERR not-locked";
            if (code != 0) { Log.Write("注入进程退出码 " + code); return "ERR failed"; }

            for (int i = 0; i < 20; i++)
            {
                Thread.Sleep(500);
                if (!Session.IsLocked(session))
                {
                    lock (failures) failures.Clear();
                    Log.Write("解锁成功");
                    return "OK";
                }
            }
            lock (failures) failures.Add(DateTime.UtcNow);
            Log.Write("已输入，但电脑仍然锁着");
            return "ERR still-locked";
        }
    }

    /// <summary>
    /// 判断会话是否锁屏。不用 WTSQuerySessionInformation 的 SessionFlags：
    /// 微软文档写明它在部分 Windows 版本上锁定、未锁定是反的，靠它判断不保险。
    /// 改用两个信号同时满足：服务收到过这个会话的锁屏事件且还没收到解锁事件；
    /// 这个会话里正在运行 LogonUI.exe（只在锁屏、登录、Ctrl+Alt+Del 界面显示时运行）。
    /// 控制台测试模式和注入进程收不到事件，只看 LogonUI。
    /// </summary>
    static class Session
    {
        static readonly HashSet<uint> locked = new HashSet<uint>();
        static bool useEvents;

        public static uint Console()
        {
            return Native.WTSGetActiveConsoleSessionId();
        }

        /// <summary>服务启动时调用：之后以锁屏事件为准。启动时已经锁着的，按 LogonUI 补记一次</summary>
        public static void UseEvents()
        {
            useEvents = true;
            uint c = Console();
            if (LogonUiRunning(c)) MarkLocked(c, true);
        }

        public static void MarkLocked(uint session, bool isLocked)
        {
            lock (locked)
            {
                if (isLocked) locked.Add(session);
                else locked.Remove(session);
            }
        }

        public static bool LogonUiRunning(uint session)
        {
            bool found = false;
            foreach (Process p in Process.GetProcessesByName("LogonUI"))
            {
                try
                {
                    if ((uint)p.SessionId == session) found = true;
                }
                catch (Exception) { }
                finally
                {
                    p.Dispose();
                }
            }
            return found;
        }

        public static bool IsLocked(uint session)
        {
            if (session == 0xFFFFFFFF) return false;
            if (!LogonUiRunning(session)) return false;
            if (!useEvents) return true;
            lock (locked) return locked.Contains(session);
        }
    }

    /// <summary>以 SYSTEM 身份在用户会话的安全桌面上启动注入进程</summary>
    static class Launcher
    {
        public static int RunInjector(uint session, string password)
        {
            IntPtr token = IntPtr.Zero, dup = IntPtr.Zero;
            var pi = new Native.PROCESS_INFORMATION();
            try
            {
                if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out token)) throw new Win32Exception();
                if (!Native.DuplicateTokenEx(token, Native.MAXIMUM_ALLOWED, IntPtr.Zero, 2 /* SecurityImpersonation */, 1 /* TokenPrimary */, out dup)) throw new Win32Exception();
                uint sid = session;
                if (!Native.SetTokenInformation(dup, 12 /* TokenSessionId */, ref sid, 4)) throw new Win32Exception();

                using (var stdin = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable))
                {
                    var si = new Native.STARTUPINFO();
                    si.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
                    si.lpDesktop = @"winsta0\winlogon";
                    si.dwFlags = Native.STARTF_USESTDHANDLES;
                    si.hStdInput = stdin.ClientSafePipeHandle.DangerousGetHandle();
                    string exe = Process.GetCurrentProcess().MainModule.FileName;
                    string cmd = "\"" + exe + "\" --inject";
                    if (!Native.CreateProcessAsUserW(dup, exe, cmd, IntPtr.Zero, IntPtr.Zero, true, Native.CREATE_NO_WINDOW,
                        IntPtr.Zero, Path.GetDirectoryName(exe), ref si, out pi)) throw new Win32Exception();
                    stdin.DisposeLocalCopyOfClientHandle();
                    // 密码走匿名管道，不出现在命令行里
                    byte[] data = Encoding.ASCII.GetBytes(Convert.ToBase64String(Encoding.UTF8.GetBytes(password)) + "\n");
                    try
                    {
                        stdin.Write(data, 0, data.Length);
                        stdin.Flush();
                    }
                    finally
                    {
                        Array.Clear(data, 0, data.Length);
                    }
                }

                if (Native.WaitForSingleObject(pi.hProcess, 20000) != 0)
                {
                    Native.TerminateProcess(pi.hProcess, 99);
                    return 98;
                }
                uint exit;
                Native.GetExitCodeProcess(pi.hProcess, out exit);
                return (int)exit;
            }
            finally
            {
                if (pi.hProcess != IntPtr.Zero) Native.CloseHandle(pi.hProcess);
                if (pi.hThread != IntPtr.Zero) Native.CloseHandle(pi.hThread);
                if (dup != IntPtr.Zero) Native.CloseHandle(dup);
                if (token != IntPtr.Zero) Native.CloseHandle(token);
            }
        }
    }

    /// <summary>注入进程：在安全桌面上收起锁屏画面、输入密码、按回车</summary>
    static class Injector
    {
        public const int NoLogonScreen = 3;
        public const int NotLocked = 4;
        public const int BadInput = 5;

        public static int Run()
        {
            string line = System.Console.In.ReadLine();
            if (string.IsNullOrEmpty(line)) return BadInput;
            string password;
            try
            {
                password = Encoding.UTF8.GetString(Convert.FromBase64String(line.Trim()));
            }
            catch (FormatException)
            {
                return BadInput;
            }

            uint session = Session.Console();
            if (!Session.IsLocked(session)) return NotLocked;

            // 1. 唤醒屏幕，按空格收起锁屏画面
            if (SwitchToInputDesktop() == null) return NoLogonScreen;
            Keys.NudgeMouse();
            Thread.Sleep(200);
            Keys.Tap(Native.VK_SPACE);
            Thread.Sleep(1500);

            // 2. 输入密码前再确认：必须在安全桌面上，且仍然锁着。否则密码可能打进别的窗口
            string desk = SwitchToInputDesktop();
            if (!string.Equals(desk, "Winlogon", StringComparison.OrdinalIgnoreCase)) return NoLogonScreen;
            if (!Session.IsLocked(session)) return NotLocked;

            // 3. 清掉输入框里已有的内容（比如上一步的空格），逐字输入，回车
            Keys.Combo(Native.VK_CONTROL, (ushort)'A');
            Keys.Tap(Native.VK_BACK);
            foreach (char c in password)
            {
                Keys.Type(c);
                Thread.Sleep(15);
            }
            Thread.Sleep(100);
            Keys.Tap(Native.VK_RETURN);
            return 0;
        }

        /// <summary>把当前线程切到输入桌面，返回桌面名（Default 或 Winlogon），失败返回 null</summary>
        static string SwitchToInputDesktop()
        {
            IntPtr desk = Native.OpenInputDesktop(0, false, Native.GENERIC_ALL);
            if (desk == IntPtr.Zero) return null;
            if (!Native.SetThreadDesktop(desk))
            {
                Native.CloseDesktop(desk);
                return null;
            }
            var buf = new byte[512];
            uint needed;
            if (!Native.GetUserObjectInformationW(desk, Native.UOI_NAME, buf, (uint)buf.Length, out needed)) return "";
            return Encoding.Unicode.GetString(buf, 0, (int)Math.Min(needed, (uint)buf.Length)).TrimEnd('\0');
        }
    }

    static class Keys
    {
        public static void NudgeMouse()
        {
            Send(Mouse(1, 0), Mouse(-1, 0));
        }

        public static void Tap(ushort vk)
        {
            Send(Key(vk, false), Key(vk, true));
        }

        public static void Combo(ushort mod, ushort vk)
        {
            Send(Key(mod, false), Key(vk, false), Key(vk, true), Key(mod, true));
        }

        /// <summary>
        /// 键盘上能直接打出的字符用虚拟键（登录界面对它最可靠），按大写锁定的状态决定要不要按住 Shift；
        /// 需要 Ctrl、Alt 才能打出的字符和非 ASCII 字符用 Unicode 方式。
        /// </summary>
        public static void Type(char c)
        {
            short scan = c < 0x80 ? Native.VkKeyScanW(c) : (short)-1;
            int mods = scan == -1 ? 0 : (scan >> 8) & 0xff;
            if (scan == -1 || (mods & 6) != 0)
            {
                Send(Unicode(c, false), Unicode(c, true));
                return;
            }
            ushort vk = (ushort)(scan & 0xff);
            bool shift = (mods & 1) != 0;
            if (char.IsLetter(c) && (Native.GetKeyState(Native.VK_CAPITAL) & 1) != 0) shift = !shift;
            if (shift) Send(Key(Native.VK_SHIFT, false), Key(vk, false), Key(vk, true), Key(Native.VK_SHIFT, true));
            else Send(Key(vk, false), Key(vk, true));
        }

        static Native.INPUT Key(ushort vk, bool up)
        {
            var i = new Native.INPUT();
            i.type = Native.INPUT_KEYBOARD;
            i.u.ki.wVk = vk;
            i.u.ki.wScan = (ushort)Native.MapVirtualKeyW(vk, 0);
            i.u.ki.dwFlags = up ? Native.KEYEVENTF_KEYUP : 0u;
            return i;
        }

        static Native.INPUT Unicode(char c, bool up)
        {
            var i = new Native.INPUT();
            i.type = Native.INPUT_KEYBOARD;
            i.u.ki.wScan = c;
            i.u.ki.dwFlags = Native.KEYEVENTF_UNICODE | (up ? Native.KEYEVENTF_KEYUP : 0u);
            return i;
        }

        static Native.INPUT Mouse(int dx, int dy)
        {
            var i = new Native.INPUT();
            i.type = Native.INPUT_MOUSE;
            i.u.mi.dx = dx;
            i.u.mi.dy = dy;
            i.u.mi.dwFlags = Native.MOUSEEVENTF_MOVE;
            return i;
        }

        static void Send(params Native.INPUT[] inputs)
        {
            Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
        }
    }

    static class Log
    {
        static readonly object gate = new object();

        /// <summary>只记事件，绝不记密码</summary>
        public static void Write(string msg)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + msg;
            if (Program.ConsoleMode)
            {
                System.Console.WriteLine(line);
                return;
            }
            try
            {
                lock (gate)
                {
                    string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "RemoteClaude");
                    Directory.CreateDirectory(dir);
                    string file = Path.Combine(dir, "unlock.log");
                    var info = new FileInfo(file);
                    if (info.Exists && info.Length > 512 * 1024) info.Delete();
                    File.AppendAllText(file, line + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch (Exception) { }
        }
    }

    static class Native
    {
        public const uint TOKEN_ALL_ACCESS = 0xF01FF;
        public const uint MAXIMUM_ALLOWED = 0x02000000;
        public const uint GENERIC_ALL = 0x10000000;
        public const int STARTF_USESTDHANDLES = 0x100;
        public const uint CREATE_NO_WINDOW = 0x08000000;
        public const int UOI_NAME = 2;
        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_KEYUP = 0x2;
        public const uint KEYEVENTF_UNICODE = 0x4;
        public const uint MOUSEEVENTF_MOVE = 0x1;
        public const ushort VK_BACK = 0x08;
        public const ushort VK_RETURN = 0x0D;
        public const ushort VK_SHIFT = 0x10;
        public const ushort VK_CONTROL = 0x11;
        public const ushort VK_CAPITAL = 0x14;
        public const ushort VK_SPACE = 0x20;

        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr newToken);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, uint length);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessAsUserW(IntPtr token, string app, string cmd, IntPtr processAttrs, IntPtr threadAttrs,
            bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
        [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr h, uint code);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr desk);
        [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desk);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetUserObjectInformationW(IntPtr obj, int index, byte[] info, uint length, out uint needed);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern short VkKeyScanW(char c);
        [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint type);
        [DllImport("user32.dll")] public static extern short GetKeyState(int vk);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess, hThread;
            public int dwProcessId, dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx, dy;
            public uint mouseData, dwFlags, time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk, wScan;
            public uint dwFlags, time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public InputUnion u;
        }
    }
}
