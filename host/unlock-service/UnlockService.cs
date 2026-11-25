// RemoteClaude 解锁服务：电脑锁屏时，替控制端把 Windows 密码或 PIN 输进登录界面；
// 被控端控制这台电脑、电脑又没有显示器时，开关虚拟屏（docs/11-virtual-display.md）。
// 设计和安全措施见 docs/06-unlock-service.md。
// 用 .NET Framework 自带的 csc.exe 编译（只支持 C# 5 语法），安装见 install.ps1。
// UNLOCK_SERVICE_VERSION 3：改了这个文件就把数字加 1，被控端据此提示"解锁服务有新版本"（host/unlockinstall.js）
//
// 运行方式：
//   RemoteClaudeUnlock.exe            作为 Windows 服务运行（由服务管理器启动，SYSTEM 身份）
//   RemoteClaudeUnlock.exe --console  以普通身份在控制台运行，只用于测试管道协议，不能真正解锁
//   RemoteClaudeUnlock.exe --inject   由服务在用户会话的安全桌面上启动，从标准输入读密码并输入
//   RemoteClaudeUnlock.exe --shade locked|unlocked <就绪事件名>  由服务在用户会话的普通桌面上启动：隐私屏的黑幕（docs/11 第 4.4 节）
//   RemoteClaudeUnlock.exe --install-display <inf>  由安装脚本以管理员身份调用：建好虚拟屏设备、装驱动，装完停用
//   RemoteClaudeUnlock.exe --uninstall-display      由安装脚本以管理员身份调用：先停用再删掉虚拟屏设备
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
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

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
            if (mode == "--shade") return args.Length > 2 ? Shade.Run(args[1], args[2]) : 2;
            if (mode == "--install-display") return VirtualDisplay.InstallCommand(args.Length > 1 ? args[1] : null);
            if (mode == "--uninstall-display") return VirtualDisplay.UninstallCommand();
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
            if (server != null) server.ShutdownShade();
            if (server != null) server.ShutdownDisplay();
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

    /// <summary>
    /// 命名管道服务。防冒充（docs/06 的"管道防冒充"）：
    ///   - 启动时先建"锚"实例：带 FILE_FLAG_FIRST_PIPE_INSTANCE，名字已被别的进程占了就失败，这时不服务，
    ///     只记日志、每 5 秒重试；建成后服务自己连上它，一直握到停止。锚不接受别人的连接，
    ///     只负责让名字一刻也不空出来：干活的实例怎么建、怎么关、出什么错，普通进程都没机会抢注；
    ///   - 管道的所有者明确设为 SYSTEM，被控端连上后据此（以及进程路径）确认对面是真的服务。
    /// 几个槽位各用一个线程，一个不说话的连接只占住一个槽位几秒，卡不住整个服务；
    /// 不在控制台会话里的客户端（别的用户、远程桌面会话）连上就断开，
    /// 唯一的例外是远程桌面断开后可以接回控制台的会话（见 RemoteSession），它只能问 STATUS、发 ATTACH。
    /// </summary>
    class PipeServer
    {
        // 每个账户 15 分钟内最多失败几次（按发请求的会话的用户分开记，见 failures）
        const int MaxFailures = 3;
        // 接回控制台（不论成败）15 分钟内最多几次。接回后会话就不再是断开的，正常用不了这么多。所有账户合计
        const int MaxAttaches = 5;
        static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(15);
        // 接回前核对密码最多等多久。LogonUserW 碰上连不上的域控、慢的 Microsoft 账户登录可能卡很久，不能一直占着解锁的锁
        const int PasswordCheckTimeoutMs = 15000;
        // 接回后最多等多久看登录界面（LogonUI）出不出来：断开前锁着的会话，接回后登录界面可能过一会儿才出来
        const int AttachSettleMs = 5000;
        const int AttachSettlePollMs = 250;
        // 查不到会话用户的 SID 时（比如控制台测试模式没有 SYSTEM 身份）记在这个共用的桶里
        const string UnknownAccount = "?";
        const int Slots = 4;
        // 每个槽位同时最多两个实例（正在处理的连接、替它等下一个连接的），再加一个锚
        const int MaxInstances = Slots * 2 + 1;
        // 读一条请求总共最多等这么久（整行的总时限，不是每次读各等这么久）。被控端连上、核实完就一次写完整行，
        // 最长的 UNLOCK 行约 1 KB（256 个字符的密码按 UTF-8 最多 768 字节，Base64 后 1024 个字符），
        // 管道缓冲区 4 KB 一次装得下，实际几毫秒就到齐，2 秒很宽裕
        const int ReadTimeoutMs = 2000;
        const int CloseWaitMs = 1000;
        static readonly TimeSpan NameTakenLogInterval = TimeSpan.FromMinutes(10);
        // 虚拟屏（docs/11）：被控端要求开着、又这么久没发 PING（被控端每隔 2 秒发一次），就自己停用，
        // 免得被控端崩了、被结束了，虚拟屏一直开着
        const int DisplayLeaseMs = 15000;

        readonly bool asService;
        readonly byte[] securityDescriptor;
        // 失败记录按账户分开：键是发请求的会话的用户 SID。别的用户的会话（比如另一个断开的远程桌面会话）输错，
        // 不占这个用户的次数；同一个账户的解锁、接回仍共用一个桶，每个账户的限制和原来一样严
        readonly Dictionary<string, List<DateTime>> failures = new Dictionary<string, List<DateTime>>(StringComparer.OrdinalIgnoreCase);
        readonly List<DateTime> attaches = new List<DateTime>();
        readonly object unlockGate = new object();
        readonly object instanceGate = new object();
        readonly HashSet<NamedPipeServerStream> instances = new HashSet<NamedPipeServerStream>();
        readonly ManualResetEvent stopped = new ManualResetEvent(false);
        volatile bool stopping;
        NamedPipeServerStream anchor;
        NamedPipeClientStream anchorClient;
        DateTime nameTakenLoggedAt = DateTime.MinValue;
        // 虚拟屏开关和看门狗共用这把锁：displayRequested 是被控端要求开着，pendingOff 是看门狗要关、还没关成。
        // last*PingTicks 是被控端最近一次为虚拟屏、隐私屏报平安（Stopwatch 时间戳，不受改系统时间影响），不在锁里，用 Interlocked 读写。
        // 两个分开记：被控端关一边没关成时，只停那一边的 PING，另一边照常续，看门狗收拾没关成的那边
        const int MaxDisplaySwitches = 10;
        readonly object displayGate = new object();
        readonly List<long> displaySwitches = new List<long>();
        bool displayRequested;
        bool pendingOff;
        long lastDisplayPingTicks;
        long lastShadePingTicks;
        // 隐私屏（docs/11 第 4.4 节）：黑幕程序由 ShadeHost 管，开、关和看门狗都在这把锁里。
        // 控制台会话里任何程序都能连管道：一分钟最多开 MaxShadeStarts 次，免得被反复开关、反复锁屏
        const int MaxShadeStarts = 10;
        readonly object shadeGate = new object();
        readonly List<long> shadeStarts = new List<long>();

        public PipeServer(bool asService)
        {
            this.asService = asService;
            securityDescriptor = Security(asService).GetSecurityDescriptorBinaryForm();
        }

        /// <summary>只允许本机交互登录的用户和 SYSTEM，拒绝经网络访问。作为服务时所有者是 SYSTEM</summary>
        static PipeSecurity Security(bool asService)
        {
            var ps = new PipeSecurity();
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
                PipeAccessRights.FullControl, AccessControlType.Deny));
            // ReadWrite 不含 CreateNewInstance：普通用户不能往这个名字下再添实例
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null),
                PipeAccessRights.ReadWrite, AccessControlType.Allow));
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                PipeAccessRights.FullControl, AccessControlType.Allow));
            // 再建同名实例要有 CreateNewInstance 权限。服务里这一条就是上面的 SYSTEM；控制台测试模式下是当前用户
            ps.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,
                PipeAccessRights.FullControl, AccessControlType.Allow));
            // 普通用户建不出所有者是 SYSTEM 的管道，被控端靠这一条认出真服务。控制台测试模式没这个权限
            if (asService) ps.SetOwner(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null));
            return ps;
        }

        public void Run()
        {
            ProcessAccess.AllowQueryByInteractiveUsers();
            if (!EstablishAnchor()) return; // 还没拿到名字就被要求停止
            if (asService)
            {
                // 服务刚启动时没有被控端要求开虚拟屏：上次开着没关（服务被结束、电脑开着虚拟屏重启了）就先关掉
                string err;
                if (VirtualDisplay.State() >= VirtualDisplay.Enabled)
                    Log.Write(VirtualDisplay.SetEnabled(false, out err) ? "服务启动时虚拟屏开着，已停用" : "服务启动时虚拟屏开着，停用失败：" + err);
                var watchdog = new Thread(DisplayWatchdog);
                watchdog.IsBackground = true;
                watchdog.Name = "display-watchdog";
                watchdog.Start();
            }
            for (int i = 0; i < Slots; i++)
            {
                var t = new Thread(SlotLoop);
                t.IsBackground = true;
                t.Name = "pipe-slot-" + i;
                t.Start();
            }
            stopped.WaitOne();
        }

        public void Stop()
        {
            stopping = true;
            lock (instanceGate)
            {
                foreach (var s in instances)
                {
                    try { s.Dispose(); } catch (Exception) { }
                }
                instances.Clear();
            }
            try { if (anchorClient != null) anchorClient.Dispose(); } catch (Exception) { }
            try { if (anchor != null) anchor.Dispose(); } catch (Exception) { }
            stopped.Set();
        }

        /// <summary>
        /// 带 FIRST_PIPE_INSTANCE 建锚实例并自己连上它。名字被别人占着就记警告、每 5 秒重试，
        /// 期间不建任何干活的实例、不服务。返回 false 表示还没建成就要停止了
        /// </summary>
        bool EstablishAnchor()
        {
            bool reported = false;
            while (!stopping)
            {
                int error;
                SafePipeHandle h = PipeNative.Create(@"\\.\pipe\" + Program.PipeName, true, MaxInstances, securityDescriptor, out error);
                if (!h.IsInvalid)
                {
                    var server = new NamedPipeServerStream(PipeDirection.InOut, true, false, h);
                    var client = new NamedPipeClientStream(".", Program.PipeName, PipeDirection.In);
                    try
                    {
                        // 此刻名字下只有锚这一个实例（别人没有新建实例的权限），连上的必定是它
                        client.Connect(2000);
                        server.WaitForConnection();
                    }
                    catch (Exception e)
                    {
                        client.Dispose();
                        server.Dispose();
                        Log.Write("连接锚实例失败: " + e.Message);
                        Thread.Sleep(1000);
                        continue;
                    }
                    anchor = server;
                    anchorClient = client;
                    if (reported) Log.Write("管道名已拿回，开始服务");
                    return true;
                }
                h.Dispose();
                ReportNameTaken(error, !reported);
                reported = true;
                Thread.Sleep(5000);
            }
            return false;
        }

        /// <summary>建一个干活的管道实例（锚已经握着名字，不需要也不能再带 FIRST_PIPE_INSTANCE）。失败返回 null</summary>
        NamedPipeServerStream CreateInstance()
        {
            lock (instanceGate)
            {
                if (stopping) return null;
                int error;
                SafePipeHandle h = PipeNative.Create(@"\\.\pipe\" + Program.PipeName, false, MaxInstances, securityDescriptor, out error);
                if (h.IsInvalid)
                {
                    h.Dispose();
                    Log.Throttled("create-instance", "创建管道实例失败，错误 " + error);
                    return null;
                }
                NamedPipeServerStream s;
                try
                {
                    s = new NamedPipeServerStream(PipeDirection.InOut, true, false, h);
                }
                catch (Exception)
                {
                    h.Dispose();
                    throw;
                }
                instances.Add(s);
                return s;
            }
        }

        void ReportNameTaken(int error, bool firstTime)
        {
            if (!firstTime && DateTime.UtcNow - nameTakenLoggedAt < NameTakenLogInterval) return;
            nameTakenLoggedAt = DateTime.UtcNow;
            string msg = "警告：管道名 \\\\.\\pipe\\" + Program.PipeName + " 已被别的进程占用（错误 " + error +
                "），可能有程序在冒充解锁服务。不提供服务，每 5 秒重试一次";
            Log.Write(msg);
            if (asService)
            {
                try { EventLog.WriteEntry(Program.PipeName, msg, EventLogEntryType.Error); } catch (Exception) { }
            }
        }

        void Release(NamedPipeServerStream s)
        {
            if (s == null) return;
            lock (instanceGate) instances.Remove(s);
            try { s.Dispose(); } catch (Exception) { }
        }

        void SlotLoop()
        {
            NamedPipeServerStream listening = null;
            while (!stopping)
            {
                if (listening == null)
                {
                    try { listening = CreateInstance(); }
                    catch (Exception e) { Log.Throttled("create-instance", "创建管道实例出错: " + e.Message); }
                    if (listening == null)
                    {
                        Thread.Sleep(1000);
                        continue;
                    }
                }
                try
                {
                    listening.WaitForConnection();
                }
                catch (IOException)
                {
                    // 对面连上又马上走了（ERROR_NO_DATA 等），换个实例接着等
                    Release(listening);
                    listening = null;
                    continue;
                }
                catch (Exception e)
                {
                    if (!stopping) Log.Throttled("wait", "等待连接出错: " + e.Message);
                    Release(listening);
                    listening = null;
                    if (!stopping) Thread.Sleep(500);
                    continue;
                }
                NamedPipeServerStream conn = listening;
                listening = null;
                if (stopping)
                {
                    Release(conn);
                    break;
                }
                // 先把下一个实例建好再处理这个连接：名字始终有人占着，也始终有实例在等连接
                try { listening = CreateInstance(); }
                catch (Exception e) { Log.Throttled("create-instance", "创建管道实例出错: " + e.Message); }
                try
                {
                    Handle(conn);
                }
                catch (Exception e)
                {
                    Log.Throttled("connection", "处理连接出错: " + e.Message);
                }
                finally
                {
                    Release(conn);
                }
            }
            Release(listening);
        }

        void Handle(NamedPipeServerStream pipe)
        {
            // 只服务两种程序，别的（别的用户、正连着的远程桌面会话里的程序）连上就断开，
            // 免得它们拿错误密码烧掉失败次数，或者占着槽位：
            //   - 控制台会话里的程序：STATUS、UNLOCK、ATTACH（ATTACH 这时等同 UNLOCK），以及虚拟屏、隐私屏的 PING、DISPLAY、SHADE；
            //   - 远程桌面断开后、可以接回控制台的会话里的程序（docs/06"远程桌面断开后从手机接回"）：只认 STATUS、ATTACH。
            // 会话号只认 GetNamedPipeClientSessionId，不看请求里写了什么
            uint clientSession;
            if (!Native.GetNamedPipeClientSessionId(pipe.SafePipeHandle, out clientSession))
            {
                Log.Throttled("other-session", "拒绝了查不到会话号的连接");
                return;
            }
            uint console = Session.Console();
            bool atConsole = clientSession == console;
            string why;
            if (!atConsole && !RemoteSession.CanAttach(clientSession, console, out why))
            {
                Log.Throttled("other-session", "拒绝了不在控制台会话里的连接（会话 " + clientSession + "：" + why + "）");
                return;
            }
            string line = ReadLine(pipe, 2048, ReadTimeoutMs);
            string reply;
            if (line == null) reply = "ERR failed";
            else if (line == "STATUS")
            {
                // 旧版被控端只看开头是不是 OK，后面多出的字段不影响它。display：虚拟屏设备 -1 没装、0 停用、1 启用
                reply = atConsole
                    ? "OK locked=" + (Session.IsLocked(console) ? "1" : "0") + " attach=0 display=" + VirtualDisplay.State() + " shade=" + ShadeState(console)
                    : "OK locked=1 attach=1";
            }
            // 虚拟屏、隐私屏只为控制台会话里的被控端开关（docs/11）
            else if (line == "PING" || line.StartsWith("PING ", StringComparison.Ordinal)) reply = atConsole ? Ping(line.Substring(4), console) : "ERR failed";
            else if (line == "DISPLAY ON" || line == "DISPLAY OFF") reply = atConsole ? Display(line == "DISPLAY ON") : "ERR failed";
            else if (line == "SHADE ON" || line == "SHADE OFF" || line == "SHADE END") reply = atConsole ? ShadeCommand(line.Substring(6), console) : "ERR failed";
            else if (line.StartsWith("UNLOCK ", StringComparison.Ordinal))
            {
                if (atConsole) reply = Unlock(clientSession, line.Substring(7));
                else
                {
                    // 往安全桌面输入密码只为控制台会话做；断开的会话要先 ATTACH
                    Log.Throttled("remote-unlock", "拒绝了不在控制台会话里的解锁输入请求（会话 " + clientSession + "）");
                    reply = "ERR failed";
                }
            }
            else if (line.StartsWith("ATTACH ", StringComparison.Ordinal)) reply = Attach(clientSession, line.Substring(7));
            else reply = "ERR failed";
            byte[] bytes = Encoding.UTF8.GetBytes(reply + "\n");
            try
            {
                pipe.Write(bytes, 0, bytes.Length);
                pipe.Flush();
            }
            catch (IOException)
            {
                return; // 对面已经走了（比如被控端核实不过就断开），不算错误
            }
            // 不用 WaitForPipeDrain：对面一直不读，它就一直不返回。等对面关掉，最多等 CloseWaitMs（1 秒）；
            // 回应已经在管道缓冲区里，这边关掉以后对面照样读得到
            WaitForClose(pipe, CloseWaitMs);
        }

        /// <summary>
        /// 读一行。从开始读算起，整行总共最多等 timeoutMs，到点返回 null；每次读只等剩下的时间。
        /// 不能每次读各等 timeoutMs：那样对面隔一会儿喂一个字节，就能一直占着槽位
        /// </summary>
        static string ReadLine(Stream s, int max, int timeoutMs)
        {
            var buf = new byte[max];
            int len = 0;
            Stopwatch clock = Stopwatch.StartNew();
            try
            {
                while (len < max)
                {
                    long left = timeoutMs - clock.ElapsedMilliseconds;
                    if (left <= 0) return null;
                    IAsyncResult ar = s.BeginRead(buf, len, max - len, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne((int)left)) return null;
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

        static void WaitForClose(Stream s, int timeoutMs)
        {
            var b = new byte[1];
            try
            {
                IAsyncResult ar = s.BeginRead(b, 0, 1, null, null);
                if (ar.AsyncWaitHandle.WaitOne(timeoutMs)) s.EndRead(ar);
            }
            catch (Exception) { }
        }

        /// <summary>
        /// 被控端报平安："PING display"、"PING shade" 只续那一边，"PING" 不带参数两边都续。
        /// 它要求开着的虚拟屏、隐私屏，在 DisplayLeaseMs 里收不到下一次就由看门狗收拾（DisplayWatchdog、ShadeWatchdog）。
        /// 不碰 displayGate、shadeGate：开关时那两把锁可能要占几秒，报平安不能跟着排队、占住槽位。
        /// 回应带上两边现在的状态，被控端据此发现被看门狗关了（被控端卡了 15 秒以上）、或者电脑前有人按了 Ctrl+Alt+Del
        /// </summary>
        string Ping(string args, uint console)
        {
            bool display = false, shade = false;
            foreach (string word in args.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (word == "display") display = true;
                else if (word == "shade") shade = true;
                else return "ERR failed";
            }
            if (!display && !shade) display = shade = true;
            long now = Stopwatch.GetTimestamp();
            if (display) Interlocked.Exchange(ref lastDisplayPingTicks, now);
            if (shade) Interlocked.Exchange(ref lastShadePingTicks, now);
            return "OK display=" + VirtualDisplay.State() + " shade=" + ShadeState(console);
        }

        /// <summary>
        /// 隐私屏开着没有：1 黑幕程序在控制台会话里运行，0 没有。不抢 shadeGate（开、关要好几秒）。
        /// 切换了用户、黑幕还在原来的会话里，算 0：它盖的不是现在显示器上的桌面
        /// </summary>
        static int ShadeState(uint console)
        {
            return ShadeHost.RunningIn(console) ? 1 : 0;
        }

        /// <summary>
        /// 被控端要求开隐私屏（ON）、撤掉（OFF）、先锁屏再撤（END，控制结束时）。ON 在控制台会话的普通桌面上启动黑幕程序，
        /// 等它盖好、钩子装好才回 OK（被控端据此才开始输密码）；已经开着就不再开。
        /// 黑幕程序之后由看门狗盯着：被控端 DisplayLeaseMs 没报平安就按 END 收尾
        /// </summary>
        string ShadeCommand(string what, uint console)
        {
            if (!asService) return "ERR no-service";
            if (!Monitor.TryEnter(shadeGate, 500)) return "ERR busy";
            try
            {
                if (what == "ON")
                {
                    if (ShadeHost.Running() && !ShadeHost.RunningIn(console))
                    {
                        // 切换了用户：原来那个会话已经不在显示器上了（接回它要输密码），只撤黑幕，不锁屏
                        Log.Write("控制台换了会话，撤了原来会话里的隐私屏：" + ShadeHost.Describe(ShadeHost.Stop(false)));
                    }
                    if (!ShadeHost.Running())
                    {
                        ShadeHost.Reap();
                        shadeStarts.RemoveAll(t => MsSince(t) > 60000);
                        if (shadeStarts.Count >= MaxShadeStarts)
                        {
                            Log.Throttled("shade-rate", "一分钟里开隐私屏太多次，拒绝");
                            return "ERR busy";
                        }
                        shadeStarts.Add(Stopwatch.GetTimestamp());
                        string err;
                        bool ready;
                        try
                        {
                            ready = ShadeHost.Start(console, Session.IsLocked(console), out err);
                        }
                        catch (Exception e)
                        {
                            ready = false;
                            err = e.Message;
                        }
                        if (!ready)
                        {
                            Log.Throttled("shade", "开隐私屏失败：" + err);
                            return "ERR failed";
                        }
                        Log.Write("被控端要求开隐私屏，已盖上黑幕");
                    }
                    Interlocked.Exchange(ref lastShadePingTicks, Stopwatch.GetTimestamp());
                    return "OK";
                }
                if (!ShadeHost.Running())
                {
                    ShadeHost.Reap();
                    return "OK";
                }
                int code = ShadeHost.Stop(what == "END");
                Log.Write((what == "END" ? "控制结束，撤了隐私屏：" : "被控端要求关隐私屏，撤了黑幕：") + ShadeHost.Describe(code));
                return "OK";
            }
            finally
            {
                Monitor.Exit(shadeGate);
            }
        }

        /// <summary>看门狗里看一眼隐私屏：黑幕程序自己退出了就收拾、记下原因；被控端太久没报平安就先锁屏再撤</summary>
        void ShadeWatchdog()
        {
            if (!Monitor.TryEnter(shadeGate)) return; // 正在开、关，下一秒再看
            try
            {
                int exited = ShadeHost.Reap();
                if (exited >= 0)
                {
                    Log.Write("隐私屏的黑幕程序自己退出了（电脑前有人按了 Ctrl+Alt+Del，或者弹了管理员确认框）：" + ShadeHost.Describe(exited));
                    return;
                }
                if (!ShadeHost.Running() || MsSince(Interlocked.Read(ref lastShadePingTicks)) < DisplayLeaseMs) return;
                int code = ShadeHost.Stop(true);
                Log.Write("被控端 " + DisplayLeaseMs / 1000 + " 秒没报平安，撤了隐私屏：" + ShadeHost.Describe(code));
            }
            finally
            {
                Monitor.Exit(shadeGate);
            }
        }

        /// <summary>服务停止时撤隐私屏，先锁屏：之后没有看门狗了，黑幕程序读到标准输入断开也会锁屏退出，这里只是不等它自己发现</summary>
        public void ShutdownShade()
        {
            if (!asService || !Monitor.TryEnter(shadeGate, 3000)) return;
            try
            {
                if (ShadeHost.Running()) Log.Write("服务停止，撤了隐私屏：" + ShadeHost.Describe(ShadeHost.Stop(true)));
            }
            finally
            {
                Monitor.Exit(shadeGate);
            }
        }

        static double MsSince(long ticks)
        {
            return (Stopwatch.GetTimestamp() - ticks) * 1000.0 / Stopwatch.Frequency;
        }

        /// <summary>
        /// 被控端要求开、关虚拟屏。已经是要的状态就不再动设备（重复启用会让它闪一下）。
        /// 控制台会话里任何程序都能连管道，所以一分钟最多切换 MaxDisplaySwitches 次：反复开关会让窗口被挪来挪去
        /// </summary>
        string Display(bool on)
        {
            // 控制台测试模式没有管理员权限，动不了设备
            if (!asService) return "ERR no-service";
            if (!Monitor.TryEnter(displayGate, 500)) return "ERR busy";
            try
            {
                int state = VirtualDisplay.State();
                if (state < 0) return "ERR no-display";
                if (state == VirtualDisplay.Broken && on)
                {
                    Log.Throttled("display-broken", "虚拟屏设备启用了但没能启动（设备有问题），没法开虚拟屏");
                    return "ERR failed";
                }
                bool change = (state == VirtualDisplay.Enabled) != on;
                if (change)
                {
                    displaySwitches.RemoveAll(t => MsSince(t) > 60000);
                    if (displaySwitches.Count >= MaxDisplaySwitches)
                    {
                        Log.Throttled("display-rate", "一分钟里开关虚拟屏太多次，拒绝");
                        return "ERR busy";
                    }
                    string err;
                    if (!VirtualDisplay.SetEnabled(on, out err))
                    {
                        Log.Throttled("display", (on ? "启用" : "停用") + "虚拟屏失败：" + err);
                        return "ERR failed";
                    }
                    displaySwitches.Add(Stopwatch.GetTimestamp());
                    Log.Write(on ? "被控端要求开虚拟屏，已启用" : "被控端要求关虚拟屏，已停用");
                }
                displayRequested = on;
                pendingOff = false;
                Interlocked.Exchange(ref lastDisplayPingTicks, Stopwatch.GetTimestamp());
                return "OK";
            }
            finally
            {
                Monitor.Exit(displayGate);
            }
        }

        /// <summary>
        /// 被控端要求开着虚拟屏、却 DisplayLeaseMs 没报平安（崩了、被结束了、用户注销了），就把虚拟屏关掉。
        /// 关不掉（设备忙）就每秒再试
        /// </summary>
        void DisplayWatchdog()
        {
            while (!stopped.WaitOne(1000))
            {
                // 隐私屏这边出了什么异常都不能让这个线程停下：虚拟屏的租约也靠它看
                try
                {
                    ShadeWatchdog();
                }
                catch (Exception e)
                {
                    Log.Throttled("shade-watchdog", "隐私屏的看门狗出错：" + e.Message);
                }
                lock (displayGate)
                {
                    if (displayRequested && MsSince(Interlocked.Read(ref lastDisplayPingTicks)) >= DisplayLeaseMs)
                    {
                        displayRequested = false;
                        pendingOff = true;
                        Log.Write("被控端 " + DisplayLeaseMs / 1000 + " 秒没报平安，停用虚拟屏");
                    }
                    if (!pendingOff) continue;
                    string err;
                    if (VirtualDisplay.SetEnabled(false, out err)) pendingOff = false;
                    else Log.Throttled("display-off", "停用虚拟屏失败，过一秒再试：" + err);
                }
            }
        }

        /// <summary>服务停止时把虚拟屏关掉：之后没有看门狗了，开着的设备会一直开到下次服务启动</summary>
        public void ShutdownDisplay()
        {
            if (!asService || !Monitor.TryEnter(displayGate, 3000)) return;
            try
            {
                string err;
                if ((displayRequested || pendingOff) && !VirtualDisplay.SetEnabled(false, out err)) Log.Write("服务停止时停用虚拟屏失败：" + err);
                displayRequested = false;
                pendingOff = false;
            }
            finally
            {
                Monitor.Exit(displayGate);
            }
        }

        /// <summary>clientSession：发请求的程序所在的会话，接受连接时它是控制台会话；输入前再确认它仍是控制台</summary>
        string Unlock(uint clientSession, string b64)
        {
            string password = Password.Decode(b64);
            if (password == null)
            {
                // 空、过长、不是 Base64、不是合法 UTF-8，或含控制字符（Tab、回车、退格等会变成安全桌面上的真实按键）
                Log.Throttled("bad-request", "解锁请求的密码格式不对，已拒绝，什么都没输入");
                return "ERR failed";
            }
            // 同一时间只做一次解锁；限流的检查和记录也都在这把锁里，并发时不会多试
            if (!Monitor.TryEnter(unlockGate))
            {
                Log.Throttled("busy", "上一次解锁还没结束，拒绝新的解锁请求");
                return "ERR busy";
            }
            try
            {
                return UnlockLocked(password, clientSession, FailureKey(clientSession), false);
            }
            finally
            {
                Monitor.Exit(unlockGate);
            }
        }

        /// <summary>
        /// 把发请求的程序所在的会话（远程桌面断开后没有画面）接回控制台。先核对 Windows 密码，
        /// 接回后会话仍是锁着的，再按 UNLOCK 的流程输入密码。发请求的程序已经在控制台时，等同 UNLOCK
        /// </summary>
        string Attach(uint clientSession, string b64)
        {
            string password = Password.Decode(b64);
            if (password == null)
            {
                Log.Throttled("bad-request", "接回请求的密码格式不对，已拒绝，什么都没做");
                return "ERR failed";
            }
            // 和解锁共用一把锁：同一时间只做一件，限流的检查和记录也在锁里
            if (!Monitor.TryEnter(unlockGate))
            {
                Log.Throttled("busy", "上一次解锁或接回还没结束，拒绝新的接回请求");
                return "ERR busy";
            }
            try
            {
                if (clientSession == Session.Console()) return UnlockLocked(password, clientSession, FailureKey(clientSession), false);
                return AttachLocked(clientSession, password);
            }
            finally
            {
                Monitor.Exit(unlockGate);
            }
        }

        string AttachLocked(uint session, string password)
        {
            string key = FailureKey(session);
            if (RateLimited(key)) return "ERR rate-limited";
            lock (attaches)
            {
                attaches.RemoveAll(t => DateTime.UtcNow - t > FailureWindow);
                if (attaches.Count >= MaxAttaches)
                {
                    Log.Throttled("rate-limited", "接回控制台的次数太多，拒绝接回请求");
                    return "ERR rate-limited";
                }
            }
            string why;
            if (!RemoteSession.CanAttach(session, Session.Console(), out why))
            {
                Log.Write("拒绝把会话 " + session + " 接回控制台：" + why);
                return "ERR failed";
            }
            // 控制台测试模式没有 SYSTEM 身份，核对不了密码、也接不回会话
            if (!asService) return "ERR no-service";

            string refused = VerifyBeforeAttach(session, password, key);
            if (refused != null) return refused;
            // 核对密码要一两秒（最多 15 秒），期间情况可能变了：再查一次
            uint console = Session.Console();
            if (!RemoteSession.CanAttach(session, console, out why))
            {
                Log.Write("拒绝把会话 " + session + " 接回控制台：" + why);
                return "ERR failed";
            }
            lock (attaches) attaches.Add(DateTime.UtcNow);
            Log.Write("密码核对通过，把会话 " + session + " 接回控制台（原控制台会话 " + console + "）");
            // 成没成只看会话是否真的到了控制台（RemoteSession.Connect 里轮询），细节它自己记日志
            if (!RemoteSession.Connect(session, console, password)) return "ERR failed";
            return AfterAttach(session, password, key);
        }

        /// <summary>
        /// 接回前核对 Windows 密码：光有手机上的账号（比如手机丢了）不能把桌面亮到电脑跟前、也不能借此远程看到画面。
        /// 在单独的线程里核对，最多等 PasswordCheckTimeoutMs（见 RemoteSession.CheckPasswordWithin）。
        /// 通过返回 null，否则返回给被控端的回应
        /// </summary>
        string VerifyBeforeAttach(uint session, string password, string key)
        {
            bool timedOut;
            int err = RemoteSession.CheckPasswordWithin(session, password, PasswordCheckTimeoutMs, out timedOut);
            if (timedOut)
            {
                AddFailure(key);
                Log.Write("核对会话 " + session + " 的 Windows 密码 " + PasswordCheckTimeoutMs / 1000 +
                    " 秒没有结果，按一次失败算，没有接回（核对线程自己跑完、自己清理）");
                return "ERR failed";
            }
            if (err == 0) return null;
            AddFailure(key);
            Log.Write("接回会话 " + session + " 前核对 Windows 密码没通过（错误 " + err + "），没有接回");
            // 密码不对（1326），和密码对了但账户受限（1330 密码过期、1907 必须改密码、1909 账户已锁定、1331 账户停用、
            // 1385 没有本地登录权限……）以及登录之后比对账户出错，一律回同一个码：回应不能透露密码对没对。准确的错误码只在日志里
            return "ERR still-locked";
        }

        /// <summary>
        /// 会话已经到了控制台：锁着就照常输入密码，没锁回 OK。
        /// 不靠锁屏事件：Session.IsLocked 要求服务收到过这个会话的 SessionLock 事件，可远程桌面断开、接回时 Windows 不一定发，
        /// 服务重启后也不记得非控制台会话锁过屏。这里以会话里有没有登录界面（LogonUI）为准，宁可多输一次密码也不早早回 OK。
        /// 接回路径上不清零失败记录（只有控制台上的 UNLOCK 成功才清）
        /// </summary>
        string AfterAttach(uint session, string password, string key)
        {
            // 登录界面可能过一会儿才出来：锁屏事件和 LogonUI 都有（可靠）就不再等；否则等满 5 秒，那时还有 LogonUI 就当锁着
            bool locked = false;
            for (int waited = 0; waited < AttachSettleMs && !locked; waited += AttachSettlePollMs)
            {
                Thread.Sleep(AttachSettlePollMs);
                locked = Session.IsLocked(session);
            }
            if (!locked) locked = Session.LogonUiRunning(session);
            if (!locked)
            {
                Log.Write("会话 " + session + " 已接回控制台，" + AttachSettleMs / 1000 + " 秒内没有登录界面，没有锁屏");
                return "OK";
            }
            Log.Write("会话 " + session + " 已接回控制台，但是锁着（有登录界面），接着输入密码");
            string reply = UnlockLocked(password, session, key, true);
            if (reply == "ERR not-locked")
            {
                // 输入前登录界面已经关了：会话接回了，也没锁
                Log.Write("会话 " + session + " 的登录界面已经关了，没有输入，接回完成");
                return "OK";
            }
            return reply;
        }

        /// <summary>失败记录的键：会话用户的 SID。查不到时用共用的桶</summary>
        static string FailureKey(uint session)
        {
            return Session.UserSid(session) ?? UnknownAccount;
        }

        bool RateLimited(string key)
        {
            lock (failures)
            {
                PruneFailures();
                List<DateTime> list;
                if (!failures.TryGetValue(key, out list) || list.Count < MaxFailures) return false;
            }
            Log.Throttled("rate-limited", "失败次数太多，拒绝请求");
            return true;
        }

        void AddFailure(string key)
        {
            lock (failures)
            {
                PruneFailures();
                List<DateTime> list;
                if (!failures.TryGetValue(key, out list))
                {
                    list = new List<DateTime>();
                    failures[key] = list;
                }
                list.Add(DateTime.UtcNow);
            }
        }

        void ClearFailures(string key)
        {
            lock (failures) failures.Remove(key);
        }

        /// <summary>去掉过期的失败记录和空桶。调用方持有 failures 的锁</summary>
        void PruneFailures()
        {
            DateTime now = DateTime.UtcNow;
            var empty = new List<string>();
            foreach (KeyValuePair<string, List<DateTime>> pair in failures)
            {
                pair.Value.RemoveAll(t => now - t > FailureWindow);
                if (pair.Value.Count == 0) empty.Add(pair.Key);
            }
            foreach (string k in empty) failures.Remove(k);
        }

        /// <summary>
        /// 往控制台会话的登录界面输入密码。expectedSession 是请求方所在的会话：控制台此刻已经换成别的会话
        /// （比如有人在电脑前切换了用户），就不输入，免得把这个用户的密码打进别人的登录界面。
        /// failureKey 是记失败的桶（请求方会话的用户）。afterAttach 为 true 表示刚从远程桌面接回控制台：
        /// 这时锁没锁只看 LogonUI（锁屏事件不一定有，见 AfterAttach），成功了也不清零失败记录
        /// </summary>
        string UnlockLocked(string password, uint expectedSession, string failureKey, bool afterAttach)
        {
            if (RateLimited(failureKey)) return "ERR rate-limited";
            Func<uint, bool> isLocked = afterAttach ? (Func<uint, bool>)Session.LogonUiRunning : (Func<uint, bool>)Session.IsLocked;
            uint session = Session.Console();
            if (session != expectedSession)
            {
                Log.Write("控制台会话已经不是发请求的会话（" + expectedSession + " → " + session + "），没有输入");
                return "ERR failed";
            }
            if (!isLocked(session))
            {
                Log.Throttled("not-locked", "收到解锁请求，但电脑没锁屏，什么都没做");
                return "ERR not-locked";
            }
            // 控制台测试模式没有 SYSTEM 身份，进不了安全桌面
            if (!asService) return "ERR no-service";

            Log.Write("收到解锁请求，开始输入");
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
            if (code == Spawn.TimedOut)
            {
                // 超时被强行结束时密码可能已经输进去、提交了，算一次失败，免得绕过次数限制
                AddFailure(failureKey);
                Log.Write("注入进程超时，已结束");
                return "ERR failed";
            }
            if (code == Injector.BadInput) return "ERR failed"; // 注入进程拒收，一个键都没按
            if (code != 0)
            {
                // 别的退出码（比如输入到一半出错）不能确定没输进去，按一次失败算，免得绕过次数限制
                AddFailure(failureKey);
                Log.Write("注入进程退出码 " + code);
                return "ERR failed";
            }

            for (int i = 0; i < 20; i++)
            {
                Thread.Sleep(500);
                if (!isLocked(session))
                {
                    if (!afterAttach) ClearFailures(failureKey);
                    Log.Write("解锁成功");
                    return "OK";
                }
            }
            AddFailure(failureKey);
            Log.Write("已输入，但电脑仍然锁着");
            return "ERR still-locked";
        }
    }

    /// <summary>
    /// 虚拟屏（docs/11）：VirtualDrivers/Virtual-Display-Driver（MIT，SignPath 签名），硬件 ID Root\MttVDD。
    /// 安装脚本以管理员身份调用 --install-display：建好根设备（和 devcon install 一样）、装驱动，装完停用。
    /// 之后设备一直留着，被控端要用时服务启用、用完停用（启用、停用各约 0.3 秒）。
    /// 设备开着时直接删，要重启才完全消失（驱动还在它的 WUDFHost 里跑），所以卸载时先停用再删
    /// </summary>
    static class VirtualDisplay
    {
        public const string HardwareId = @"Root\MttVDD";
        static readonly Guid DisplayClass = new Guid("4d36e968-e325-11ce-bfc1-08002be10318");
        // 安装时把我们建的设备的实例 ID 记在这里（只有管理员能改），之后只认它：
        // 电脑上别的程序、用户自己装的同一个驱动（硬件 ID 一样），不启用、不停用、不删
        const string RecordKey = @"SOFTWARE\RemoteClaude";
        const string RecordValue = "DisplayDevice";

        static string Recorded()
        {
            using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(RecordKey))
            {
                return key == null ? null : key.GetValue(RecordValue) as string;
            }
        }

        // 设备状态（STATUS、PING 回应里的 display=）
        public const int Missing = -1;
        public const int Disabled = 0;
        public const int Enabled = 1;
        public const int Broken = 2; // 启用了但没能启动（设备管理器里的错误代码 10、43 之类）

        /// <summary>设备状态：Missing 没装，Disabled 停用，Enabled 启用并在运行，Broken 启用了但有问题</summary>
        public static int State()
        {
            IntPtr set;
            Native.SP_DEVINFO_DATA data;
            if (!Find(out set, out data)) return Missing;
            try
            {
                uint status, problem;
                if (Native.CM_Get_DevNode_Status(out status, out problem, data.DevInst, 0) != 0) return Broken;
                if ((status & Native.DN_HAS_PROBLEM) == 0) return Enabled;
                return problem == Native.CM_PROB_DISABLED ? Disabled : Broken;
            }
            finally
            {
                Native.SetupDiDestroyDeviceInfoList(set);
            }
        }

        /// <summary>启用或停用设备（DIF_PROPERTYCHANGE，DICS_FLAG_GLOBAL：重启后也保持）。失败时 error 是原因</summary>
        public static bool SetEnabled(bool on, out string error)
        {
            IntPtr set;
            Native.SP_DEVINFO_DATA data;
            if (!Find(out set, out data))
            {
                error = "没装虚拟屏驱动";
                return false;
            }
            try
            {
                var p = new Native.SP_PROPCHANGE_PARAMS();
                p.ClassInstallHeader.cbSize = (uint)Marshal.SizeOf(typeof(Native.SP_CLASSINSTALL_HEADER));
                p.ClassInstallHeader.InstallFunction = Native.DIF_PROPERTYCHANGE;
                p.StateChange = on ? Native.DICS_ENABLE : Native.DICS_DISABLE;
                p.Scope = Native.DICS_FLAG_GLOBAL;
                if (!Native.SetupDiSetClassInstallParamsW(set, ref data, ref p, (uint)Marshal.SizeOf(typeof(Native.SP_PROPCHANGE_PARAMS))) ||
                    !Native.SetupDiCallClassInstaller(Native.DIF_PROPERTYCHANGE, set, ref data))
                {
                    error = "错误 " + Marshal.GetLastWin32Error();
                    return false;
                }
                error = null;
                return true;
            }
            finally
            {
                Native.SetupDiDestroyDeviceInfoList(set);
            }
        }

        /// <summary>
        /// --install-display：没有我们的设备就建一个并记下实例 ID，装上 inf 里的驱动，最后停用。
        /// 电脑上已经有别人装的同一个驱动时什么都不做，退出码 2。返回进程退出码
        /// </summary>
        public static int InstallCommand(string inf)
        {
            try
            {
                if (string.IsNullOrEmpty(inf) || !File.Exists(inf)) throw new Exception("找不到驱动的 inf 文件：" + inf);
                string ours = Recorded();
                string other = FindInstance(delegate (string id) { return !string.Equals(id, ours, StringComparison.OrdinalIgnoreCase); });
                if (other != null)
                {
                    System.Console.WriteLine("电脑上已经装了别的 Virtual Display Driver（设备 " + other + "），虚拟屏功能不启用，也不动它");
                    return 2;
                }
                if (FindInstance(delegate (string id) { return string.Equals(id, ours, StringComparison.OrdinalIgnoreCase); }) == null)
                {
                    string created = CreateRootDevice();
                    try
                    {
                        using (var key = Microsoft.Win32.Registry.LocalMachine.CreateSubKey(RecordKey))
                        {
                            key.SetValue(RecordValue, created);
                        }
                    }
                    catch (Exception)
                    {
                        // 没记下来的设备下次会被当成别人的，再也装不上：删掉刚建的
                        RemoveInstance(created);
                        throw;
                    }
                }
                bool reboot;
                if (!Native.UpdateDriverForPlugAndPlayDevicesW(IntPtr.Zero, HardwareId, inf, Native.INSTALLFLAG_FORCE, out reboot))
                    throw new Win32Exception();
                string err;
                if (!SetEnabled(false, out err)) throw new Exception("驱动装好了，但停用设备失败：" + err);
                System.Console.WriteLine(reboot ? "虚拟屏驱动已安装，要重启电脑才能用" : "虚拟屏驱动已安装（设备平时停用）");
                return 0;
            }
            catch (Exception e)
            {
                System.Console.WriteLine("安装虚拟屏驱动失败：" + e.Message);
                return 1;
            }
        }

        /// <summary>--uninstall-display：先停用（开着删要重启），再删设备。驱动包由安装脚本用 pnputil 删。返回进程退出码</summary>
        public static int UninstallCommand()
        {
            try
            {
                string err;
                IntPtr set;
                Native.SP_DEVINFO_DATA data;
                if (!Find(out set, out data))
                {
                    System.Console.WriteLine("没有虚拟屏设备");
                    return 0;
                }
                string id = InstanceId(set, ref data);
                Native.SetupDiDestroyDeviceInfoList(set);
                if (!SetEnabled(false, out err)) throw new Exception("停用设备失败：" + err);
                RemoveInstance(id);
                using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(RecordKey, true))
                {
                    if (key != null) key.DeleteValue(RecordValue, false);
                }
                System.Console.WriteLine("虚拟屏设备已删除");
                return 0;
            }
            catch (Exception e)
            {
                System.Console.WriteLine("删除虚拟屏设备失败：" + e.Message);
                return 1;
            }
        }

        /// <summary>删掉这个实例 ID 的 Root\MttVDD 设备（DIF_REMOVE）。调用方先停用它：开着删要重启才完全消失</summary>
        static void RemoveInstance(string instanceId)
        {
            IntPtr set;
            Native.SP_DEVINFO_DATA data;
            if (!Scan(delegate (string id) { return string.Equals(id, instanceId, StringComparison.OrdinalIgnoreCase); }, out set, out data)) return;
            try
            {
                var p = new Native.SP_REMOVEDEVICE_PARAMS();
                p.ClassInstallHeader.cbSize = (uint)Marshal.SizeOf(typeof(Native.SP_CLASSINSTALL_HEADER));
                p.ClassInstallHeader.InstallFunction = Native.DIF_REMOVE;
                p.Scope = Native.DI_REMOVEDEVICE_GLOBAL;
                if (!Native.SetupDiSetClassInstallParamsW(set, ref data, ref p, (uint)Marshal.SizeOf(typeof(Native.SP_REMOVEDEVICE_PARAMS))) ||
                    !Native.SetupDiCallClassInstaller(Native.DIF_REMOVE, set, ref data))
                    throw new Win32Exception();
            }
            finally
            {
                Native.SetupDiDestroyDeviceInfoList(set);
            }
        }

        /// <summary>建一个硬件 ID 为 Root\MttVDD 的根设备节点（驱动随后由 UpdateDriverForPlugAndPlayDevices 装上），返回实例 ID</summary>
        static string CreateRootDevice()
        {
            Guid cls = DisplayClass;
            IntPtr set = Native.SetupDiCreateDeviceInfoList(ref cls, IntPtr.Zero);
            if (set == Native.INVALID_HANDLE_VALUE) throw new Win32Exception();
            try
            {
                var data = new Native.SP_DEVINFO_DATA();
                data.cbSize = (uint)Marshal.SizeOf(typeof(Native.SP_DEVINFO_DATA));
                if (!Native.SetupDiCreateDeviceInfoW(set, "Display", ref cls, null, IntPtr.Zero, Native.DICD_GENERATE_ID, ref data))
                    throw new Win32Exception();
                byte[] ids = Encoding.Unicode.GetBytes(HardwareId + "\0\0");
                if (!Native.SetupDiSetDeviceRegistryPropertyW(set, ref data, Native.SPDRP_HARDWAREID, ids, (uint)ids.Length))
                    throw new Win32Exception();
                if (!Native.SetupDiCallClassInstaller(Native.DIF_REGISTERDEVICE, set, ref data)) throw new Win32Exception();
                return InstanceId(set, ref data);
            }
            finally
            {
                Native.SetupDiDestroyDeviceInfoList(set);
            }
        }

        /// <summary>我们建的那个设备（实例 ID 和安装时记下的一样）。找到时 set 由调用方用 SetupDiDestroyDeviceInfoList 释放</summary>
        static bool Find(out IntPtr set, out Native.SP_DEVINFO_DATA data)
        {
            string ours = Recorded();
            if (ours == null)
            {
                set = IntPtr.Zero;
                data = new Native.SP_DEVINFO_DATA();
                return false;
            }
            return Scan(delegate (string id) { return string.Equals(id, ours, StringComparison.OrdinalIgnoreCase); }, out set, out data);
        }

        /// <summary>硬件 ID 是 Root\MttVDD、实例 ID 让 accept 认可的第一个设备的实例 ID，没有返回 null</summary>
        static string FindInstance(Func<string, bool> accept)
        {
            IntPtr set;
            Native.SP_DEVINFO_DATA data;
            if (!Scan(accept, out set, out data)) return null;
            try
            {
                return InstanceId(set, ref data);
            }
            finally
            {
                Native.SetupDiDestroyDeviceInfoList(set);
            }
        }

        /// <summary>在显示类设备里找硬件 ID 是 Root\MttVDD、实例 ID 让 accept 认可的那一个。找到时 set 由调用方释放</summary>
        static bool Scan(Func<string, bool> accept, out IntPtr set, out Native.SP_DEVINFO_DATA data)
        {
            Guid cls = DisplayClass;
            data = new Native.SP_DEVINFO_DATA();
            data.cbSize = (uint)Marshal.SizeOf(typeof(Native.SP_DEVINFO_DATA));
            set = Native.SetupDiGetClassDevsW(ref cls, null, IntPtr.Zero, Native.DIGCF_PRESENT);
            if (set == Native.INVALID_HANDLE_VALUE)
            {
                set = IntPtr.Zero;
                return false;
            }
            var buf = new byte[2048];
            for (uint i = 0; Native.SetupDiEnumDeviceInfo(set, i, ref data); i++)
            {
                uint type, needed;
                if (!Native.SetupDiGetDeviceRegistryPropertyW(set, ref data, Native.SPDRP_HARDWAREID, out type, buf, (uint)buf.Length, out needed)) continue;
                string ids = Encoding.Unicode.GetString(buf, 0, (int)Math.Min(needed, (uint)buf.Length));
                bool match = false;
                foreach (string id in ids.Split('\0'))
                {
                    if (string.Equals(id, HardwareId, StringComparison.OrdinalIgnoreCase)) match = true;
                }
                if (match && accept(InstanceId(set, ref data))) return true;
            }
            Native.SetupDiDestroyDeviceInfoList(set);
            set = IntPtr.Zero;
            return false;
        }

        static string InstanceId(IntPtr set, ref Native.SP_DEVINFO_DATA data)
        {
            var sb = new StringBuilder(260);
            int needed;
            return Native.SetupDiGetDeviceInstanceIdW(set, ref data, sb, sb.Capacity, out needed) ? sb.ToString() : "";
        }
    }

    /// <summary>密码的解码和检查，服务和注入进程用同一套</summary>
    static class Password
    {
        public const int MaxLength = 256;

        /// <summary>
        /// Base64 → 严格 UTF-8 → 检查。不合格返回 null。
        /// 控制字符（U+0000–001F、U+007F、U+0080–009F）一律拒绝：它们会变成安全桌面上的真实按键，
        /// 比如 Tab 切换焦点、回车提交、退格删字，密码就不再"只是密码"了
        /// </summary>
        public static string Decode(string b64)
        {
            if (b64 == null) return null;
            byte[] raw;
            try
            {
                raw = Convert.FromBase64String(b64.Trim());
            }
            catch (FormatException)
            {
                return null;
            }
            try
            {
                string p = new UTF8Encoding(false, true).GetString(raw);
                if (p.Length == 0 || p.Length > MaxLength || HasControlChar(p)) return null;
                return p;
            }
            catch (ArgumentException)
            {
                return null; // 不是合法的 UTF-8
            }
            finally
            {
                Array.Clear(raw, 0, raw.Length);
            }
        }

        public static bool HasControlChar(string s)
        {
            foreach (char c in s)
            {
                if (char.IsControl(c)) return true;
            }
            return false;
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
        static volatile bool useEvents;

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

        /// <summary>会话里登录用户的 SID（字符串）。查不到返回 null：会话没有用户，或者没有 SYSTEM 身份（控制台测试模式）</summary>
        public static string UserSid(uint session)
        {
            IntPtr token;
            if (!Native.WTSQueryUserToken(session, out token)) return null;
            try
            {
                using (var id = new WindowsIdentity(token))
                {
                    return id.User == null ? null : id.User.Value;
                }
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                Native.CloseHandle(token);
            }
        }
    }

    /// <summary>
    /// 远程桌面断开后把会话接回控制台（docs/06"远程桌面断开后从手机接回"）。
    /// 只接这样的会话：它就是发请求的程序所在的会话（会话号由管道给出）；处于断开状态（不是有人正连着的远程桌面）；
    /// 有登录用户；控制台上此刻没有别的用户的会话（只有登录界面，或者就是同一个用户）
    /// </summary>
    static class RemoteSession
    {
        public const int ErrorLogonFailure = 1326; // ERROR_LOGON_FAILURE：用户名或密码不对
        const int NoSuchUser = 1317;               // ERROR_NO_SUCH_USER
        const int WTSUserName = 5;
        const int WTSDomainName = 7;
        const int WTSConnectState = 8;
        const int WTSDisconnected = 4;
        const int Logon32LogonInteractive = 2;
        const int Logon32ProviderDefault = 0;
        const uint NoConsole = 0xFFFFFFFF;
        // 接回：不带密码的请求发出后等多久看会话到没到控制台；没到就带上密码再试一次，再等多久
        const int FirstTryWaitMs = 5000;
        const int RetryWaitMs = 10000;
        const int ConsolePollMs = 250;
        const int NotTried = int.MinValue;

        public static bool CanAttach(uint session, uint console, out string why)
        {
            why = null;
            if (console == 0xFFFFFFFF) { why = "控制台此刻没有会话（正在切换）"; return false; }
            if (session == console) { why = "已经在控制台上"; return false; }
            if (session == 0) { why = "会话 0 是服务用的"; return false; }
            int state;
            if (!ConnectState(session, out state)) { why = "查不到连接状态"; return false; }
            if (state != WTSDisconnected) { why = "不是断开状态（状态 " + state + "），可能正有人连着远程桌面"; return false; }
            string user = Text(session, WTSUserName), domain = Text(session, WTSDomainName);
            if (string.IsNullOrEmpty(user)) { why = "没有登录用户"; return false; }
            string consoleUser = Text(console, WTSUserName), consoleDomain = Text(console, WTSDomainName);
            if (consoleUser == null) { why = "查不到控制台会话的用户"; return false; }
            if (consoleUser.Length > 0)
            {
                if (!(SameName(consoleUser, user) && SameName(consoleDomain, domain)))
                {
                    why = "控制台上是别的用户的会话";
                    return false;
                }
                // 同一用户的另一个会话（只有允许一人多会话的系统才会有）：没锁着就说明有人正在用，不抢
                if (!Session.IsLocked(console))
                {
                    why = "控制台上同一用户的另一个会话正在使用";
                    return false;
                }
            }
            return true;
        }

        /// <summary>
        /// 在单独的线程里调 CheckPassword，最多等 timeoutMs。LogonUserW 碰上连不上的域控、慢的 Microsoft 账户登录可能卡很久，
        /// 不能让它一直占着解锁的锁（那期间所有解锁都回 busy）。超时就不等了，timedOut 为 true
        /// </summary>
        public static int CheckPasswordWithin(uint session, string password, int timeoutMs, out bool timedOut)
        {
            return RunWithin(() => CheckPassword(session, password), timeoutMs, out timedOut);
        }

        /// <summary>
        /// 在新线程里跑 work，最多等 timeoutMs。超时返回 -1、timedOut 为 true，线程不管它，让它自己跑完：
        /// 它申请的令牌、密码缓冲区都在它自己的 finally 里关掉、清零；它只往这一次调用自己的 Outcome 里写结果，
        /// 超时以后没人再读，碰不到别的状态。线程是后台线程，服务停止时不等它。work 抛异常记日志、返回 -1
        /// </summary>
        public static int RunWithin(Func<int> work, int timeoutMs, out bool timedOut)
        {
            var outcome = new Outcome(work);
            var worker = new Thread(outcome.Run);
            worker.IsBackground = true;
            worker.Name = "password-check";
            worker.Start();
            timedOut = !worker.Join(timeoutMs);
            return timedOut ? -1 : outcome.Result; // Join 返回后读结果，看得到线程写的值
        }

        sealed class Outcome
        {
            readonly Func<int> work;
            int result = -1;

            public Outcome(Func<int> work)
            {
                this.work = work;
            }

            public int Result { get { return result; } }

            public void Run()
            {
                try
                {
                    result = work();
                }
                catch (Exception e)
                {
                    // 后台线程里的异常没人接会让整个服务崩掉
                    Log.Write("核对密码出错: " + e.Message);
                    result = -1;
                }
            }
        }

        /// <summary>
        /// 用会话自己的用户名、域名和给的密码做一次交互式登录（LogonUserW），再确认登录出来的账户和会话的账户是同一个（比 SID）。
        /// 通过返回 0，否则返回错误码（密码不对是 1326）。只认账户密码，Windows Hello 的 PIN 核对不了
        /// </summary>
        public static int CheckPassword(uint session, string password)
        {
            string user = Text(session, WTSUserName), domain = Text(session, WTSDomainName);
            if (string.IsNullOrEmpty(user)) return 87; // ERROR_INVALID_PARAMETER
            IntPtr logon = IntPtr.Zero, owner = IntPtr.Zero, pw = IntPtr.Zero;
            try
            {
                pw = Marshal.StringToCoTaskMemUni(password);
                if (!Native.LogonUserW(user, domain, pw, Logon32LogonInteractive, Logon32ProviderDefault, out logon))
                {
                    int e = Marshal.GetLastWin32Error();
                    return e != 0 ? e : ErrorLogonFailure;
                }
                if (!Native.WTSQueryUserToken(session, out owner))
                {
                    int e = Marshal.GetLastWin32Error();
                    return e != 0 ? e : NoSuchUser;
                }
                try
                {
                    using (var a = new WindowsIdentity(logon))
                    using (var b = new WindowsIdentity(owner))
                    {
                        if (a.User == null || a.User != b.User) return NoSuchUser; // 不是会话的那个账户
                    }
                }
                catch (Exception e)
                {
                    Log.Write("比对账户出错: " + e.Message);
                    return NoSuchUser;
                }
                return 0;
            }
            finally
            {
                if (pw != IntPtr.Zero) Marshal.ZeroFreeCoTaskMemUnicode(pw);
                if (logon != IntPtr.Zero) Native.CloseHandle(logon);
                if (owner != IntPtr.Zero) Native.CloseHandle(owner);
            }
        }

        /// <summary>
        /// WTSConnectSessionW：把 session 的画面接到 console 上（LogonId = session，TargetLogonId = console，同 tscon session /dest:console）。
        /// 用 bWait = FALSE，发出请求就返回，不在持锁时干等会话切换（切换卡住的话，那期间所有解锁都会回 busy）；
        /// 成没成只看之后轮询到的控制台会话号是不是 session，不看调用的返回值。
        /// 文档只写了"调用者和会话是同一个用户时密码可以为空"，没写 SYSTEM 调用时怎样（tscon 以 SYSTEM 运行时不要密码）。
        /// 所以先不带密码，FirstTryWaitMs 内没到控制台，就重新检查接回条件、带上已核对过的密码再试一次，最多再等 RetryWaitMs：
        /// 能不带就不把明文交出去；两次都只在核对通过之后。返回会话是否到了控制台
        /// </summary>
        public static bool Connect(uint session, uint console, string password)
        {
            int first = ConnectWith(session, console, "");
            if (first == 0 && WaitOnConsole(session, FirstTryWaitMs))
            {
                Log.Write("会话 " + session + " 已接回控制台（不带密码）");
                return true;
            }
            // 控制台正在切换（可能就是刚才那次请求）、或者已经到了：不再发请求，只接着等。
            // 第一次请求可能只是慢：这时两次请求会同时在途，是有意的，成没成照样只看轮询。
            // 带密码的请求只在重新检查过接回条件之后发（CanAttach 要求会话仍是断开状态、控制台上没有别的用户）
            uint now = Session.Console();
            string why = null;
            int second = NotTried;
            if (now != session && now != NoConsole && CanAttach(session, now, out why))
                second = ConnectWith(session, now, password);
            bool inFlight = first == 0 || second == 0 || now == NoConsole || now == session;
            bool arrived = inFlight && WaitOnConsole(session, RetryWaitMs);
            // 这行日志说明 SYSTEM 调用 WTSConnectSessionW 要不要密码（docs/06 实测第 3 步）
            Log.Write("会话 " + session + (arrived ? " 已接回控制台" : " 没能接回控制台") +
                "（不带密码：" + Describe(first) + "，" + FirstTryWaitMs / 1000 + " 秒内没到；带密码：" +
                (second == NotTried ? "没有再试，" + (why ?? "控制台正在切换或已经是这个会话") : Describe(second)) + "）");
            return arrived;
        }

        static string Describe(int error)
        {
            return error == 0 ? "请求已受理" : "错误 " + error;
        }

        /// <summary>每 ConsolePollMs 看一次控制台会话是不是 session，最多等 timeoutMs</summary>
        static bool WaitOnConsole(uint session, int timeoutMs)
        {
            for (int waited = 0; ; waited += ConsolePollMs)
            {
                if (Session.Console() == session) return true;
                if (waited >= timeoutMs) return false;
                Thread.Sleep(ConsolePollMs);
            }
        }

        /// <summary>发出接回请求（不等它完成）。请求被受理返回 0，否则返回错误码</summary>
        static int ConnectWith(uint session, uint console, string password)
        {
            IntPtr pw = Marshal.StringToCoTaskMemUni(password);
            try
            {
                if (Native.WTSConnectSessionW(session, console, pw, false)) return 0;
                int e = Marshal.GetLastWin32Error();
                return e != 0 ? e : -1;
            }
            finally
            {
                Marshal.ZeroFreeCoTaskMemUnicode(pw);
            }
        }

        static bool SameName(string a, string b)
        {
            return string.Equals(a ?? "", b ?? "", StringComparison.OrdinalIgnoreCase);
        }

        static bool ConnectState(uint session, out int state)
        {
            state = -1;
            IntPtr buf;
            uint bytes;
            if (!Native.WTSQuerySessionInformationW(IntPtr.Zero, session, WTSConnectState, out buf, out bytes)) return false;
            try
            {
                if (buf == IntPtr.Zero || bytes < 4) return false;
                state = Marshal.ReadInt32(buf);
                return true;
            }
            finally
            {
                if (buf != IntPtr.Zero) Native.WTSFreeMemory(buf);
            }
        }

        /// <summary>会话的文字信息（用户名、域名）。查询失败返回 null，没有（比如登录界面的会话没有用户）返回空串</summary>
        static string Text(uint session, int infoClass)
        {
            IntPtr buf;
            uint bytes;
            if (!Native.WTSQuerySessionInformationW(IntPtr.Zero, session, infoClass, out buf, out bytes)) return null;
            try
            {
                return buf == IntPtr.Zero ? "" : (Marshal.PtrToStringUni(buf) ?? "");
            }
            finally
            {
                if (buf != IntPtr.Zero) Native.WTSFreeMemory(buf);
            }
        }
    }

    /// <summary>
    /// 让本机交互登录的用户能以 PROCESS_QUERY_LIMITED_INFORMATION 打开服务进程（只能查路径、时间这类信息），
    /// 被控端靠它确认管道对面的进程路径。SYSTEM 进程默认的权限不给普通用户这一项
    /// </summary>
    static class ProcessAccess
    {
        const int QueryLimited = 0x1000; // PROCESS_QUERY_LIMITED_INFORMATION
        const uint DaclInfo = 4;         // DACL_SECURITY_INFORMATION

        public static void AllowQueryByInteractiveUsers()
        {
            try
            {
                IntPtr self = Native.GetCurrentProcess();
                uint needed;
                Native.GetKernelObjectSecurity(self, DaclInfo, null, 0, out needed);
                if (needed == 0) throw new Win32Exception();
                var sd = new byte[needed];
                if (!Native.GetKernelObjectSecurity(self, DaclInfo, sd, needed, out needed)) throw new Win32Exception();
                var raw = new RawSecurityDescriptor(sd, 0);
                RawAcl dacl = raw.DiscretionaryAcl;
                if (dacl == null) return; // 没有 DACL 等于谁都能访问，不用加
                var who = new SecurityIdentifier(WellKnownSidType.InteractiveSid, null);
                foreach (GenericAce ace in dacl)
                {
                    var common = ace as CommonAce;
                    if (common != null && common.AceQualifier == AceQualifier.AccessAllowed &&
                        common.SecurityIdentifier == who && (common.AccessMask & QueryLimited) != 0) return;
                }
                dacl.InsertAce(dacl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, QueryLimited, who, false, null));
                raw.DiscretionaryAcl = dacl;
                var updated = new byte[raw.BinaryLength];
                raw.GetBinaryForm(updated, 0);
                if (!Native.SetKernelObjectSecurity(self, DaclInfo, updated)) throw new Win32Exception();
            }
            catch (Exception e)
            {
                // 失败了服务照常工作，只是被控端核实不了路径、会当作没装服务
                Log.Write("设置进程权限失败，被控端将无法核实本服务: " + e.Message);
            }
        }
    }

    static class PipeNative
    {
        const uint PIPE_ACCESS_DUPLEX = 0x3;
        const uint FILE_FLAG_OVERLAPPED = 0x40000000;
        const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
        const uint PIPE_TYPE_BYTE = 0x0;
        const uint PIPE_REJECT_REMOTE_CLIENTS = 0x8;
        const uint BufferSize = 4096;

        /// <summary>CreateNamedPipeW；first 为 true 时带 FILE_FLAG_FIRST_PIPE_INSTANCE，名字已存在就失败</summary>
        public static SafePipeHandle Create(string name, bool first, int maxInstances, byte[] securityDescriptor, out int error)
        {
            GCHandle pin = GCHandle.Alloc(securityDescriptor, GCHandleType.Pinned);
            try
            {
                var sa = new Native.SECURITY_ATTRIBUTES();
                sa.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
                sa.lpSecurityDescriptor = pin.AddrOfPinnedObject();
                sa.bInheritHandle = 0;
                uint openMode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0u);
                SafePipeHandle h = Native.CreateNamedPipeW(name, openMode, PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,
                    (uint)maxInstances, BufferSize, BufferSize, 0, ref sa);
                error = h.IsInvalid ? Marshal.GetLastWin32Error() : 0;
                return h;
            }
            finally
            {
                pin.Free();
            }
        }
    }

    /// <summary>以 SYSTEM 身份在用户会话的安全桌面上启动注入进程</summary>
    static class Launcher
    {
        /// <summary>复制服务自己的 SYSTEM 令牌、改成这个会话号，用来在用户会话里启动子进程。调用方用完要 CloseHandle</summary>
        public static IntPtr SessionToken(uint session)
        {
            IntPtr token = IntPtr.Zero, dup = IntPtr.Zero;
            try
            {
                if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out token)) throw new Win32Exception();
                if (!Native.DuplicateTokenEx(token, Native.MAXIMUM_ALLOWED, IntPtr.Zero, 2 /* SecurityImpersonation */, 1 /* TokenPrimary */, out dup)) throw new Win32Exception();
                uint sid = session;
                if (!Native.SetTokenInformation(dup, 12 /* TokenSessionId */, ref sid, 4)) throw new Win32Exception();
                IntPtr result = dup;
                dup = IntPtr.Zero;
                return result;
            }
            finally
            {
                if (dup != IntPtr.Zero) Native.CloseHandle(dup);
                if (token != IntPtr.Zero) Native.CloseHandle(token);
            }
        }

        /// <summary>服务自己的 exe 路径：子进程（注入、黑幕）都是它换个参数启动的</summary>
        public static string SelfPath()
        {
            using (Process self = Process.GetCurrentProcess()) return self.MainModule.FileName;
        }

        public static int RunInjector(uint session, string password)
        {
            IntPtr dup = IntPtr.Zero;
            byte[] data = null;
            try
            {
                dup = SessionToken(session);
                string exe = SelfPath();
                // 密码走匿名管道，不出现在命令行里
                data = Encoding.ASCII.GetBytes(Convert.ToBase64String(Encoding.UTF8.GetBytes(password)) + "\n");
                return Spawn.Run(dup, exe, "--inject", @"winsta0\winlogon", data, 20000);
            }
            finally
            {
                if (data != null) Array.Clear(data, 0, data.Length);
                if (dup != IntPtr.Zero) Native.CloseHandle(dup);
            }
        }
    }

    /// <summary>
    /// 在指定桌面上启动子进程，标准输入接一个匿名管道。用 PROC_THREAD_ATTRIBUTE_HANDLE_LIST 只让子进程继承这一个标准输入句柄，
    /// 别的可继承句柄一个也不带过去。token 为 IntPtr.Zero 时以当前身份用 CreateProcessW 启动，只给测试用；服务里总是传 SYSTEM 令牌
    /// </summary>
    static class Spawn
    {
        public const int TimedOut = 98;

        /// <summary>
        /// 启动子进程，不等它退出。stdin 是写给它标准输入的那一头，调用方用完要 Dispose（子进程读到 EOF）；
        /// 返回的进程、线程句柄调用方负责关
        /// </summary>
        public static Native.PROCESS_INFORMATION Start(IntPtr token, string exe, string args, string desktop, out AnonymousPipeServerStream stdin)
        {
            var pi = new Native.PROCESS_INFORMATION();
            var pipe = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
            try
            {
                IntPtr child = pipe.ClientSafePipeHandle.DangerousGetHandle();
                IntPtr attrList = IntPtr.Zero, handleBuf = IntPtr.Zero;
                try
                {
                    IntPtr size = IntPtr.Zero;
                    Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                    if (size == IntPtr.Zero) throw new Win32Exception();
                    attrList = Marshal.AllocHGlobal(size);
                    if (!Native.InitializeProcThreadAttributeList(attrList, 1, 0, ref size))
                    {
                        Marshal.FreeHGlobal(attrList);
                        attrList = IntPtr.Zero;
                        throw new Win32Exception();
                    }
                    handleBuf = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.WriteIntPtr(handleBuf, child);
                    if (!Native.UpdateProcThreadAttribute(attrList, 0, (IntPtr)Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                        handleBuf, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();

                    var si = new Native.STARTUPINFOEX();
                    si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
                    si.StartupInfo.lpDesktop = desktop;
                    si.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
                    si.StartupInfo.hStdInput = child;
                    si.lpAttributeList = attrList;
                    string cmd = "\"" + exe + "\" " + args;
                    uint flags = Native.CREATE_NO_WINDOW | Native.EXTENDED_STARTUPINFO_PRESENT;
                    string dir = Path.GetDirectoryName(exe);
                    bool ok = token == IntPtr.Zero
                        ? Native.CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, dir, ref si, out pi)
                        : Native.CreateProcessAsUserW(token, exe, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, dir, ref si, out pi);
                    if (!ok) throw new Win32Exception();
                }
                finally
                {
                    if (attrList != IntPtr.Zero)
                    {
                        Native.DeleteProcThreadAttributeList(attrList);
                        Marshal.FreeHGlobal(attrList);
                    }
                    if (handleBuf != IntPtr.Zero) Marshal.FreeHGlobal(handleBuf);
                }
                pipe.DisposeLocalCopyOfClientHandle();
                stdin = pipe;
                return pi;
            }
            catch
            {
                pipe.Dispose();
                throw;
            }
        }

        /// <summary>启动子进程，把 stdinData 从它的标准输入交过去，等它退出，返回退出码（超时返回 98）</summary>
        public static int Run(IntPtr token, string exe, string args, string desktop, byte[] stdinData, uint timeoutMs)
        {
            var pi = new Native.PROCESS_INFORMATION();
            try
            {
                AnonymousPipeServerStream stdin;
                pi = Start(token, exe, args, desktop, out stdin);
                using (stdin)
                {
                    try
                    {
                        stdin.Write(stdinData, 0, stdinData.Length);
                        stdin.Flush();
                    }
                    catch
                    {
                        // 写到一半失败：先结束注入进程，别让它拿着半截密码继续输
                        Native.TerminateProcess(pi.hProcess, 99);
                        throw;
                    }
                }

                if (Native.WaitForSingleObject(pi.hProcess, timeoutMs) != 0)
                {
                    Native.TerminateProcess(pi.hProcess, 99);
                    return TimedOut;
                }
                uint exit;
                Native.GetExitCodeProcess(pi.hProcess, out exit);
                return (int)exit;
            }
            finally
            {
                if (pi.hProcess != IntPtr.Zero) Native.CloseHandle(pi.hProcess);
                if (pi.hThread != IntPtr.Zero) Native.CloseHandle(pi.hThread);
            }
        }
    }

    /// <summary>
    /// 服务这边的隐私屏（docs/11 第 4.4 节）：以 SYSTEM 身份在控制台会话的普通桌面上启动、停止黑幕程序（--shade）。
    /// Start、Stop、Reap 只在 PipeServer 的 shadeGate 锁里调用；Running、RunningIn 别的线程（PING、STATUS）也会调，
    /// 进程句柄和会话号由 handleGate 护着，关句柄前先清字段，不会拿一个已经关掉的句柄去问
    /// </summary>
    static class ShadeHost
    {
        const int StopWaitMs = 8000; // 黑幕程序锁屏最多等 4 秒，再留些余量
        // 等黑幕程序把黑幕盖好、钩子装好（它设上就绪事件）最多等多久。实测几百毫秒
        const int ReadyWaitMs = 5000;
        const int ReadyPollMs = 100;
        // Stop 等不到黑幕程序退出、断开会话也失败，只好直接结束它（不是黑幕程序自己的退出码）
        const int KilledUnlocked = 97;
        const uint WAIT_TIMEOUT = 0x102;
        static readonly object handleGate = new object();
        static IntPtr process = IntPtr.Zero;
        static uint session;
        static AnonymousPipeServerStream stdin;
        // 这一个黑幕程序就绪过（盖好过黑幕）：没就绪就退出的，桌面本来就没盖，不用断开会话
        static bool wasReady;

        public static bool Running()
        {
            lock (handleGate) return process != IntPtr.Zero && Native.WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
        }

        /// <summary>黑幕程序在这个会话里运行着。会话换了（切换了用户）的黑幕不算：它盖的不是现在显示器上的桌面</summary>
        public static bool RunningIn(uint consoleSession)
        {
            lock (handleGate) return process != IntPtr.Zero && session == consoleSession && Native.WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
        }

        /// <summary>
        /// 黑幕程序自己退出了（电脑前的人按了 Ctrl+Alt+Del、锁了屏，或者它出了错）：收拾句柄，返回它的退出码。
        /// 还在运行或者没有，返回 -1。就绪过、退出码又不正常（崩了、被人结束了）就断开它的会话，见 AfterAbnormalExit
        /// </summary>
        public static int Reap()
        {
            IntPtr p;
            uint s;
            lock (handleGate)
            {
                p = process;
                s = session;
            }
            if (p == IntPtr.Zero || Native.WaitForSingleObject(p, 0) == WAIT_TIMEOUT) return -1;
            uint exit;
            Native.GetExitCodeProcess(p, out exit);
            bool ready = wasReady;
            Close();
            if (ready) AfterAbnormalExit((int)exit, s);
            return (int)exit;
        }

        /// <summary>
        /// 在这个会话里启动黑幕程序，等它就绪（黑幕盖好、钩子装好）才返回 true。locked：会话现在是不是锁着。
        /// ReadyWaitMs 里没就绪，就让它撤掉（不锁屏：开之前桌面本来就露着，或者会话锁着），返回 false
        /// </summary>
        public static bool Start(uint consoleSession, bool locked, out string err)
        {
            // 就绪事件只有 SYSTEM 能打开：会话里的普通程序设不上它，冒充不了"盖好了"
            string name = @"Global\RemoteClaudeShadeReady-" + Guid.NewGuid().ToString("N");
            var security = new EventWaitHandleSecurity();
            security.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                EventWaitHandleRights.FullControl, AccessControlType.Allow));
            bool created;
            using (var ready = new EventWaitHandle(false, EventResetMode.ManualReset, name, out created, security))
            {
                if (!created)
                {
                    err = "就绪事件的名字被占了";
                    return false;
                }
                IntPtr token = Launcher.SessionToken(consoleSession);
                try
                {
                    AnonymousPipeServerStream pipe;
                    Native.PROCESS_INFORMATION pi = Spawn.Start(token, Launcher.SelfPath(), "--shade " + (locked ? "locked" : "unlocked") + " " + name, @"winsta0\default", out pipe);
                    Native.CloseHandle(pi.hThread);
                    lock (handleGate)
                    {
                        process = pi.hProcess;
                        session = consoleSession;
                        stdin = pipe;
                        wasReady = false;
                    }
                }
                finally
                {
                    Native.CloseHandle(token);
                }
                var clock = Stopwatch.StartNew();
                while (!ready.WaitOne(ReadyPollMs))
                {
                    if (!Running())
                    {
                        err = "黑幕程序没就绪就退出了：" + Describe(Reap());
                        return false;
                    }
                    if (clock.ElapsedMilliseconds >= ReadyWaitMs)
                    {
                        err = "黑幕程序 " + ReadyWaitMs / 1000 + " 秒内没就绪，撤掉了：" + Describe(Stop(false));
                        return false;
                    }
                }
                wasReady = true;
            }
            err = null;
            return true;
        }

        /// <summary>
        /// 让黑幕程序撤掉，end 为 true 时先锁屏。等它退出，返回退出码（Shade.Exit*）。
        /// 等不到：end 时先断开它所在的会话（屏幕回到登录界面，同样要输密码）再结束它，桌面一刻也不露出来；
        /// 断开也不成功只能记下来照样结束（不然电脑前的键盘鼠标一直被挡着），返回 KilledUnlocked
        /// </summary>
        public static int Stop(bool end)
        {
            IntPtr p;
            uint s;
            AnonymousPipeServerStream pipe;
            lock (handleGate)
            {
                p = process;
                s = session;
                pipe = stdin;
            }
            if (p == IntPtr.Zero) return -1;
            try
            {
                byte[] line = Encoding.ASCII.GetBytes(end ? "END\n" : "OFF\n");
                pipe.Write(line, 0, line.Length);
                pipe.Flush();
            }
            catch (Exception) { } // 它已经退出了（管道断了、已关）：下面照常收拾
            bool ready = wasReady;
            int code;
            if (Native.WaitForSingleObject(p, StopWaitMs) == 0)
            {
                uint exit;
                Native.GetExitCodeProcess(p, out exit);
                code = (int)exit;
                Close();
                if (end && ready) AfterAbnormalExit(code, s);
                return code;
            }
            code = Shade.ExitRemoved;
            if (end)
            {
                if (Native.WTSDisconnectSession(IntPtr.Zero, s, true)) code = Shade.ExitDisconnected;
                else
                {
                    Log.Write("黑幕程序没在 " + StopWaitMs / 1000 + " 秒里锁屏退出，断开会话 " + s + " 也失败了（错误 " + Marshal.GetLastWin32Error() + "），只能结束它");
                    code = KilledUnlocked;
                }
            }
            Native.TerminateProcess(p, 99);
            Native.WaitForSingleObject(p, 2000);
            Close();
            return code;
        }

        /// <summary>
        /// 黑幕程序不是正常退出的（崩了、被人结束了），桌面可能露出来了：会话没锁着就断开它。
        /// 正常的退出码：锁了屏（0）、只撤了黑幕（6，被控端要的）、断开了会话（7）、出了错但自己先锁了屏或断开了会话（8）
        /// </summary>
        static void AfterAbnormalExit(int code, uint s)
        {
            if (code == Shade.ExitLocked || code == Shade.ExitRemoved || code == Shade.ExitDisconnected || code == Shade.ExitFailed) return;
            if (Session.IsLocked(s)) return;
            bool ok = Native.WTSDisconnectSession(IntPtr.Zero, s, true);
            Log.Write("隐私屏的黑幕程序非正常退出（" + Describe(code) + "），" + (ok ? "已断开会话 " + s + "（回到登录界面）" : "断开会话 " + s + " 失败（错误 " + Marshal.GetLastWin32Error() + "）"));
        }

        /// <summary>先把字段清掉再关：别的线程看到的要么是还开着的句柄，要么是 IntPtr.Zero</summary>
        static void Close()
        {
            IntPtr p;
            AnonymousPipeServerStream pipe;
            lock (handleGate)
            {
                p = process;
                pipe = stdin;
                process = IntPtr.Zero;
                stdin = null;
                wasReady = false;
                if (p != IntPtr.Zero) Native.CloseHandle(p);
            }
            try { if (pipe != null) pipe.Dispose(); } catch (Exception) { }
        }

        /// <summary>日志里怎么说黑幕程序的退出码</summary>
        public static string Describe(int code)
        {
            if (code == Shade.ExitLocked) return "已锁屏";
            if (code == Shade.ExitRemoved) return "没有锁屏";
            if (code == Shade.ExitDisconnected) return "锁屏没成功，断开了会话（回到登录界面）";
            if (code == Shade.ExitFailed) return "出了错，先锁了屏或断开了会话";
            if (code == Shade.ExitUnexpected) return "不知怎么退出了，没有锁屏";
            if (code == KilledUnlocked) return "没退出，锁屏、断开会话都没成功，直接结束了它";
            return "退出码 " + code;
        }
    }

    /// <summary>
    /// 隐私屏的黑幕程序（docs/11 第 4.4 节）。服务以 SYSTEM 身份在用户会话的普通桌面（winsta0\default）上启动它：
    /// RemoteClaudeUnlock.exe --shade locked|unlocked &lt;就绪事件名&gt;（启动时会话是不是锁着）。
    ///   - 每块屏一块黑幕：WS_POPUP，TOPMOST|TRANSPARENT|TOOLWINDOW|LAYERED|NOACTIVATE，不透明，不让截屏。
    ///     Chromium 不把这种窗口算作遮挡，Claude 照常绘制；点击会穿过去，被控端的点击落在 Claude 上（docs/11 第 3.1 节）；
    ///   - 低级键盘、鼠标钩子挡掉不带 InjectMark 的输入：电脑前的人动不了，被控端（带着标记注入）照常操作。
    ///     钩子在专门的线程上（回调慢了 Windows 会悄悄摘掉钩子），每 2 秒发一个不带标记的空键码和一下鼠标移动，看两个钩子还在不在：
    ///     没收到就重装一次，再没收到（或者重装不上）就锁屏退出；
    ///   - 黑幕和钩子都就绪了才把就绪事件设上，服务等到它才回 OK（被控端据此才开始输密码）；
    ///   - 没锁屏时输入桌面切到了安全桌面（电脑前的人按了 Ctrl+Alt+Del，或者弹了管理员确认框）：黑幕先留着，
    ///     等它回到普通桌面就锁屏（在安全桌面上锁不了）；这期间会话被锁了（点了"锁定"）也退出；
    ///   - 标准输入读到 OFF：撤黑幕退出（手机上关了隐私屏）；读到 END、或者标准输入断了（服务没了）：先锁屏再撤；
    ///   - 锁屏没成功：断开这个会话（屏幕回到登录界面，同样要输密码才能进），断开也不成功就留着黑幕、过一会儿再试；
    ///   - 出了任何没接住的异常：先锁屏、等锁屏画面出来（不行就断开会话）再退出，不让桌面露出来。
    /// 锁着的时候黑幕在锁屏界面下面，电脑前看到的还是锁屏画面；解锁那一刻直接是黑幕（docs/11 第 3.3 节）
    /// </summary>
    static class Shade
    {
        /// <summary>被控端、注入进程 SendInput 时带在 dwExtraInfo 里的标记（"RCLD"），黑幕程序只放行带它的输入</summary>
        public const uint InjectMark = 0x52434C44;
        public const int ExitLocked = 0;       // 锁了屏才退出
        public const int ExitRemoved = 6;      // 只撤了黑幕（OFF）
        public const int ExitDisconnected = 7; // 锁屏没成功，断开了会话
        public const int ExitFailed = 8;       // 出了错（钩子装不上、异常）：锁了屏或断开了会话才退出
        public const int ExitUnexpected = 9;   // 消息循环不知怎么结束了，没走到上面任何一个退出点：服务按非正常退出处理
        const string Notice = "这台电脑正在被远程操作";
        // 电脑前的人怎么退出隐私屏：Ctrl+Alt+Del 拦不住，回到桌面时黑幕会先锁屏再撤（见类的说明），之后用自己的密码登录
        const string ExitHint =
            "要在这台电脑上使用：按 Ctrl+Alt+Del，再选“锁定”或按 Esc，电脑会锁屏，输入密码登录即可\n" +
            "远程操作的人也可以在 RemoteClaude App 的菜单里关掉隐私屏";
        // 自检用的键：没分配的虚拟键码（0x97～0x9F 未分配），键盘上没有，也不会有程序拿它当热键；被钩子挡下，到不了任何程序
        const ushort CanaryKey = 0x9F;
        const int CanaryEveryTicks = 8; // 每 8 次计时器（2 秒）自检一次
        const int SyncEveryTicks = 4;   // 每 4 次计时器（1 秒）核对一次锁屏状态
        const int WM_APP_REHOOK = 0x8001;
        // KBDLLHOOKSTRUCT、MSLLHOOKSTRUCT 里 dwExtraInfo 的偏移（x64 上 16、24）：回调里只读这一个字段，越快越好
        static readonly int KeyboardExtraOffset = (int)Marshal.OffsetOf(typeof(Native.KBDLLHOOKSTRUCT), "dwExtraInfo");
        static readonly int MouseExtraOffset = (int)Marshal.OffsetOf(typeof(Native.MSLLHOOKSTRUCT), "dwExtraInfo");

        static readonly List<ShadeForm> shades = new List<ShadeForm>();
        // 钩子回调要一直有人引用着，不然被回收以后系统调到的是野指针
        static readonly Native.LowLevelProc keyboardProc = KeyboardHook;
        static readonly Native.LowLevelProc mouseProc = MouseHook;
        static IntPtr keyboardHook, mouseHook;
        static uint hookThreadId;
        static volatile bool hooksOk;
        // 两个钩子最近一次挡下输入的时间（Stopwatch）：自检看它们还在不在。电脑前的人动了键鼠也算
        static long keyboardSeen, mouseSeen;
        static long canarySent;
        static int canaryMisses, ticks, staleLockTicks;
        static uint ownSession;
        static SessionWatcher watcher;
        static System.Windows.Forms.Timer timer;
        // 会话现在锁着没有：启动参数给初值，之后跟着锁屏、解锁通知走，每秒再核对一次（SyncLockState）
        static volatile bool sessionLocked;
        // 没锁屏时进过安全桌面（Ctrl+Alt+Del、管理员确认框）：回到普通桌面就锁屏
        static bool secureSeen;
        // 解锁以后已经看到过普通桌面。远程解锁那一刻，解锁通知可能比输入桌面切回普通桌面先到：
        // 那时看到的安全桌面是解锁的余波，不是有人按了 Ctrl+Alt+Del，所以先看到一次普通桌面才开始盯
        static volatile bool defaultSeen;
        static volatile bool rebuildPending;
        static volatile string command; // 标准输入读到的 OFF / END；null 是还没有
        static bool quitting;
        static int exitCode = ExitUnexpected;

        public static int Run(string initial, string readyEvent)
        {
            // 没接住的异常一律先锁屏：黑幕一没，桌面就露出来了
            AppDomain.CurrentDomain.UnhandledException += delegate
            {
                EmergencyLock();
                Environment.Exit(ExitFailed);
            };
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            try
            {
                return RunShade(initial, readyEvent);
            }
            catch (Exception)
            {
                EmergencyLock();
                return ExitFailed;
            }
        }

        static int RunShade(string initial, string readyEvent)
        {
            Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); // 每个屏按自己的缩放，拿到的坐标是物理像素
            using (Process self = Process.GetCurrentProcess()) ownSession = (uint)self.SessionId;
            sessionLocked = initial != "unlocked";
            var stdinThread = new Thread(ReadCommands);
            stdinThread.IsBackground = true;
            stdinThread.Start();

            // 先登记锁屏通知，再按现在的情况核对一次：服务给的初值是启动前看的，中间可能已经变了
            watcher = new SessionWatcher();
            SyncLockState(true);
            if (!sessionLocked)
            {
                // 没锁屏时启动：看一眼输入桌面，启动那一刻正弹着 Ctrl+Alt+Del、管理员确认框的，回来就锁
                if (InputDesktopName() == "Default") defaultSeen = true;
                else secureSeen = true;
            }
            // 这个事件在 SystemEvents 自己的线程上来：只做个记号，计时器里（界面线程）重铺。先登记再铺，铺的时候变了也不漏
            Microsoft.Win32.SystemEvents.DisplaySettingsChanged += delegate { rebuildPending = true; };
            Build();
            if (!StartHooks())
            {
                EmergencyLock();
                return ExitFailed;
            }
            try
            {
                using (var ready = EventWaitHandle.OpenExisting(readyEvent)) ready.Set();
            }
            catch (Exception) { } // 服务等不到就当没盖上，会把这里撤掉

            timer = new System.Windows.Forms.Timer();
            timer.Interval = 250;
            timer.Tick += delegate { Tick(); };
            timer.Start();
            Application.Run();
            Native.PostThreadMessageW(hookThreadId, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
            return exitCode;
        }

        /// <summary>在专门的线程上装钩子、跑消息循环（低级钩子靠装它的线程收消息）。返回两个钩子是不是都装上了</summary>
        static bool StartHooks()
        {
            System.Runtime.CompilerServices.RuntimeHelpers.PrepareDelegate(keyboardProc);
            System.Runtime.CompilerServices.RuntimeHelpers.PrepareDelegate(mouseProc);
            var installed = new ManualResetEvent(false);
            var thread = new Thread(delegate ()
            {
                hookThreadId = Native.GetCurrentThreadId();
                Install();
                installed.Set();
                Native.MSG msg;
                while (Native.GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0)
                {
                    if (msg.message == WM_APP_REHOOK) Install();
                }
                Uninstall();
            });
            thread.IsBackground = true;
            thread.Start();
            installed.WaitOne(5000);
            return hooksOk;
        }

        /// <summary>
        /// 装钩子。重装时先装上新的再摘旧的，中间不留没有钩子的空档；新的装不上就留着旧的、记下 hooksOk 为 false，
        /// 计时器看到就锁屏退出
        /// </summary>
        static void Install()
        {
            IntPtr module = Native.GetModuleHandleW(null);
            IntPtr k = Native.SetWindowsHookExW(Native.WH_KEYBOARD_LL, keyboardProc, module, 0);
            IntPtr m = Native.SetWindowsHookExW(Native.WH_MOUSE_LL, mouseProc, module, 0);
            if (k == IntPtr.Zero || m == IntPtr.Zero)
            {
                if (k != IntPtr.Zero) Native.UnhookWindowsHookEx(k);
                if (m != IntPtr.Zero) Native.UnhookWindowsHookEx(m);
                hooksOk = false;
                return;
            }
            Uninstall();
            keyboardHook = k;
            mouseHook = m;
            hooksOk = true;
        }

        static void Uninstall()
        {
            if (keyboardHook != IntPtr.Zero) Native.UnhookWindowsHookEx(keyboardHook);
            if (mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(mouseHook);
            keyboardHook = mouseHook = IntPtr.Zero;
        }

        /// <summary>服务通过标准输入发 OFF、END；读到头（服务没了、管道断了）按 END 算</summary>
        static void ReadCommands()
        {
            try
            {
                using (var reader = new StreamReader(System.Console.OpenStandardInput(), Encoding.ASCII))
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        line = line.Trim();
                        if (line == "OFF" || line == "END")
                        {
                            command = line;
                            return;
                        }
                    }
                }
            }
            catch (Exception) { }
            command = "END";
        }

        static void Tick()
        {
            if (quitting) return;
            if (command == "OFF")
            {
                Quit(ExitRemoved);
                return;
            }
            if (rebuildPending)
            {
                rebuildPending = false;
                Rebuild();
            }
            ticks++;
            if (ticks % SyncEveryTicks == 0) SyncLockState(false);
            // 控制结束、服务没了：不管停在哪个桌面上都先锁屏再撤（锁不上就断开会话）
            if (command == "END")
            {
                LockAndQuit("控制结束了，或者服务没了");
                return;
            }
            if (!sessionLocked)
            {
                string desk = InputDesktopName();
                if (desk == "")
                {
                    // 读不出输入桌面：这一轮不判断，不能当成有人按了 Ctrl+Alt+Del
                    KeepOnTop();
                    return;
                }
                if (desk == "Default") defaultSeen = true;
                else if (defaultSeen)
                {
                    // 没锁屏、输入桌面却切到了安全桌面：电脑前的人按了 Ctrl+Alt+Del（拦不住的组合键），或者弹了管理员确认框。
                    // 在那里锁不了屏，黑幕先留着，等回到普通桌面再锁
                    if (!secureSeen) Log.Write("隐私屏：输入桌面切到了「" + desk + "」（有人按了 Ctrl+Alt+Del，或者弹了管理员确认框），回到普通桌面时锁屏");
                    secureSeen = true;
                    return;
                }
                else return; // 刚解锁、还没回到普通桌面
                if (!hooksOk)
                {
                    LockAndQuit("重装钩子没装上，挡不住电脑前的键鼠了");
                    return;
                }
                CheckHooks();
            }
            if (secureSeen)
            {
                LockAndQuit("电脑前有人按了 Ctrl+Alt+Del，或者弹了管理员确认框");
                return;
            }
            KeepOnTop();
        }

        /// <summary>别的置顶窗口可能盖到上面来：把黑幕再提到最前（不抢焦点）</summary>
        static void KeepOnTop()
        {
            foreach (ShadeForm f in shades)
                Native.SetWindowPos(f.Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
        }

        /// <summary>
        /// 核对锁屏状态，补上漏掉的通知：以为锁着、输入桌面却一直是普通桌面、也没有登录界面（LogonUI）在跑，就是已经解开了
        /// （连着 2 秒这样才算，刚锁上时锁屏画面还在普通桌面上）。start 时只看有没有登录界面，不用等
        /// </summary>
        static void SyncLockState(bool start)
        {
            if (!sessionLocked)
            {
                staleLockTicks = 0;
                return;
            }
            bool looksUnlocked = !Session.LogonUiRunning(ownSession) && (start || InputDesktopName() == "Default");
            if (!looksUnlocked)
            {
                staleLockTicks = 0;
                return;
            }
            if (!start && ++staleLockTicks < 2) return;
            staleLockTicks = 0;
            sessionLocked = false;
        }

        /// <summary>
        /// 两个钩子还在不在：每 2 秒发一个不带标记的空键码和一下鼠标移动（会被钩子挡下，光标不动），下一次看两个钩子都收到了没有。
        /// 没收到就重装钩子、记日志，不锁屏：2026-11-24 真机上开隐私屏 8 秒后被锁了屏，正好是"连着两次没收到就锁屏"的时间，
        /// 疑似误报，原因还没查清（日志里记着没收到的是哪个钩子）。重装不上（hooksOk 为 false）时 Tick 照样锁屏。
        /// 只在没锁屏、普通桌面上做（别的桌面上的输入钩子本来就收不到）
        /// </summary>
        static void CheckHooks()
        {
            if (ticks % CanaryEveryTicks != 0) return;
            if (canarySent != 0)
            {
                bool keyboardOk = Interlocked.Read(ref keyboardSeen) >= canarySent;
                bool mouseOk = Interlocked.Read(ref mouseSeen) >= canarySent;
                if (keyboardOk && mouseOk) canaryMisses = 0;
                else
                {
                    canaryMisses++;
                    Log.Throttled("shade-canary", "隐私屏的钩子自检没收到（键盘" + (keyboardOk ? "收到了" : "没收到") + "，鼠标" + (mouseOk ? "收到了" : "没收到") +
                        "，连着第 " + canaryMisses + " 次），重装钩子");
                    Native.PostThreadMessageW(hookThreadId, WM_APP_REHOOK, IntPtr.Zero, IntPtr.Zero);
                }
            }
            long sent = Stopwatch.GetTimestamp();
            var key = new Native.INPUT();
            key.type = Native.INPUT_KEYBOARD;
            key.u.ki.wVk = CanaryKey;
            var keyUp = key;
            keyUp.u.ki.dwFlags = Native.KEYEVENTF_KEYUP;
            // 一下右、一下左：钩子在的话都被挡下，光标不动；钩子不在了也只是来回动一个像素
            var right = new Native.INPUT();
            right.type = Native.INPUT_MOUSE;
            right.u.mi.dx = 1;
            right.u.mi.dwFlags = Native.MOUSEEVENTF_MOVE;
            var left = right;
            left.u.mi.dx = -1;
            var inputs = new[] { key, keyUp, right, left };
            // 没发出去（桌面正好在切换）不算钩子的错：这一轮不算数
            uint n = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
            if (n == inputs.Length) canarySent = sent;
            else
            {
                canarySent = 0;
                Log.Throttled("shade-sendinput", "隐私屏的钩子自检发不出去（SendInput 发出 " + n + " 个，错误 " + Marshal.GetLastWin32Error() + "）");
            }
        }

        /// <summary>
        /// 先锁屏再撤黑幕，桌面一刻也不露出来。锁没锁上看锁屏通知（刚锁上时锁屏画面还在普通桌面上，看桌面名字不准）；
        /// 锁上以后再盖一会儿，等锁屏画面出来
        /// </summary>
        static void LockAndQuit(string why)
        {
            // 锁不上、断开也不成功时会每次计时器都再来一次：一分钟只记一条
            Log.Throttled("shade-lock", "隐私屏的黑幕程序要锁屏退出：" + why);
            quitting = true;
            if (timer != null) timer.Stop();
            if (!sessionLocked && Native.LockWorkStation()) Pump(4000, delegate { return sessionLocked; });
            if (sessionLocked)
            {
                Pump(800, delegate { return false; });
                Quit(ExitLocked);
                return;
            }
            // 锁不上：断开这个会话，屏幕回到登录界面，同样要输密码才能进；断开也不成功就留着黑幕，过一会儿再试
            if (Native.WTSDisconnectSession(IntPtr.Zero, Native.WTS_CURRENT_SESSION, true))
            {
                Quit(ExitDisconnected);
                return;
            }
            quitting = false;
            timer.Start();
        }

        /// <summary>最多等 ms 毫秒，直到 done 为真；等的时候照常处理消息（锁屏通知要进得来），黑幕一直提在最前</summary>
        static void Pump(int ms, Func<bool> done)
        {
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < ms && !done())
            {
                Application.DoEvents();
                KeepOnTop();
                Thread.Sleep(50);
            }
        }

        /// <summary>
        /// 出了没接住的异常：锁屏，等登录界面（锁屏画面）出来、再等 0.8 秒才退出，免得黑幕没了、锁屏画面还没出来那一下露出桌面；
        /// 锁不上、等不到就断开会话。这时界面线程可能已经不行了，不靠消息，直接看有没有登录界面在跑
        /// </summary>
        static void EmergencyLock()
        {
            try
            {
                if (Native.LockWorkStation())
                {
                    var clock = Stopwatch.StartNew();
                    while (clock.ElapsedMilliseconds < 4000)
                    {
                        if (Session.LogonUiRunning(ownSession))
                        {
                            Thread.Sleep(800);
                            return;
                        }
                        Thread.Sleep(100);
                    }
                }
                Native.WTSDisconnectSession(IntPtr.Zero, Native.WTS_CURRENT_SESSION, true);
            }
            catch (Exception) { }
        }

        static void Quit(int code)
        {
            quitting = true;
            exitCode = code;
            if (timer != null) timer.Stop();
            foreach (ShadeForm f in shades) f.Close();
            shades.Clear();
            Application.ExitThread();
        }

        /// <summary>当前接收输入的桌面的名字：Default（普通桌面）、Winlogon（锁屏、Ctrl+Alt+Del、管理员确认框）；打不开时是空串</summary>
        static string InputDesktopName()
        {
            IntPtr desk = Native.OpenInputDesktop(0, false, 0x0001 /* DESKTOP_READOBJECTS */);
            if (desk == IntPtr.Zero) return "";
            try
            {
                var buf = new byte[256];
                uint needed;
                if (!Native.GetUserObjectInformationW(desk, Native.UOI_NAME, buf, (uint)buf.Length, out needed)) return "";
                int len = (int)Math.Min(needed, (uint)buf.Length);
                return Encoding.Unicode.GetString(buf, 0, len).TrimEnd('\0');
            }
            finally
            {
                Native.CloseDesktop(desk);
            }
        }

        static void Build()
        {
            foreach (Screen s in Screen.AllScreens)
            {
                var f = new ShadeForm(s.Bounds);
                f.Show();
                Native.SetLayeredWindowAttributes(f.Handle, 0, 255, Native.LWA_ALPHA);
                // 被控端按窗口截图，黑幕本来就截不进去；这一条防的是整屏截图。Win10 2004 以前没有这个选项，只记一笔
                if (!Native.SetWindowDisplayAffinity(f.Handle, Native.WDA_EXCLUDEFROMCAPTURE))
                    Log.Throttled("shade-affinity", "隐私屏的黑幕没能设成不让截屏（错误 " + Marshal.GetLastWin32Error() + "），整屏截图会截到黑幕");
                f.Cover();
                shades.Add(f);
            }
        }

        /// <summary>插拔了显示器、改了分辨率：先按现在的屏铺好新的，再撤旧的，中间不留空档</summary>
        static void Rebuild()
        {
            var old = new List<ShadeForm>(shades);
            shades.Clear();
            Build();
            foreach (ShadeForm f in old) f.Close();
        }

        static IntPtr KeyboardHook(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && Marshal.ReadIntPtr(lParam, KeyboardExtraOffset) != (IntPtr)InjectMark)
            {
                Interlocked.Exchange(ref keyboardSeen, Stopwatch.GetTimestamp());
                return (IntPtr)1;
            }
            return Native.CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && Marshal.ReadIntPtr(lParam, MouseExtraOffset) != (IntPtr)InjectMark)
            {
                Interlocked.Exchange(ref mouseSeen, Stopwatch.GetTimestamp());
                return (IntPtr)1;
            }
            return Native.CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        /// <summary>一块黑幕：样式见类的说明。上半屏是标题，下半屏是怎么退出</summary>
        class ShadeForm : Form
        {
            readonly Rectangle bounds;

            public ShadeForm(Rectangle screenBounds)
            {
                bounds = screenBounds;
                BackColor = Color.Black;
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                var layout = new TableLayoutPanel();
                layout.Dock = DockStyle.Fill;
                layout.BackColor = Color.Black;
                layout.ColumnCount = 1;
                layout.RowCount = 2;
                layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
                layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
                layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
                layout.Controls.Add(MakeLabel(Notice, 24, Color.FromArgb(160, 160, 160), ContentAlignment.BottomCenter), 0, 0);
                Label hint = MakeLabel(ExitHint, 14, Color.FromArgb(120, 120, 120), ContentAlignment.TopCenter);
                hint.Padding = new Padding(0, 24, 0, 0);
                layout.Controls.Add(hint, 0, 1);
                Controls.Add(layout);
            }

            static Label MakeLabel(string text, float size, Color color, ContentAlignment align)
            {
                var label = new Label();
                label.Text = text;
                label.ForeColor = color;
                label.Font = new Font("Microsoft YaHei", size);
                label.Dock = DockStyle.Fill;
                label.TextAlign = align;
                return label;
            }

            /// <summary>铺满这块屏（物理像素）</summary>
            public void Cover()
            {
                Native.SetWindowPos(Handle, Native.HWND_TOPMOST, bounds.X, bounds.Y, bounds.Width, bounds.Height, Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams cp = base.CreateParams;
                    cp.Style = unchecked((int)Native.WS_POPUP);
                    cp.ExStyle = (int)(Native.WS_EX_TOPMOST | Native.WS_EX_TRANSPARENT | Native.WS_EX_TOOLWINDOW | Native.WS_EX_LAYERED | Native.WS_EX_NOACTIVATE);
                    return cp;
                }
            }

            protected override bool ShowWithoutActivation { get { return true; } }

            protected override void WndProc(ref Message m)
            {
                base.WndProc(ref m);
                // 挪到缩放不同的屏上时，系统会按它建议的大小改窗口：改回铺满这块屏
                if (m.Msg == 0x02E0 /* WM_DPICHANGED */) Cover();
            }
        }

        /// <summary>不显示的窗口，收这个会话的锁屏、解锁通知。登记不上时只靠每秒核对（SyncLockState）</summary>
        class SessionWatcher : NativeWindow
        {
            public SessionWatcher()
            {
                CreateHandle(new CreateParams());
                if (!Native.WTSRegisterSessionNotification(Handle, 0 /* NOTIFY_FOR_THIS_SESSION */))
                    Log.Throttled("shade-notify", "隐私屏的黑幕程序收不到锁屏通知（错误 " + Marshal.GetLastWin32Error() + "），只能每秒核对一次");
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == Native.WM_WTSSESSION_CHANGE)
                {
                    int reason = m.WParam.ToInt32();
                    if (reason == Native.WTS_SESSION_LOCK)
                    {
                        sessionLocked = true;
                        defaultSeen = false;
                    }
                    else if (reason == Native.WTS_SESSION_UNLOCK) sessionLocked = false;
                }
                base.WndProc(ref m);
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
            // 和服务用同一套检查：含控制字符等不合格的密码一个键都不按
            string password = Password.Decode(line);
            if (password == null) return BadInput;

            uint session = Session.Console();
            // 服务把注入进程放进请求的那个会话；控制台在这期间换了会话，就不是要解锁的那个了
            using (Process self = Process.GetCurrentProcess())
            {
                if ((uint)self.SessionId != session) return NoLogonScreen;
            }
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
        /// 控制字符一律不按（VkKeyScan 会把 \t \r \b 映射成 Tab、回车、退格键）；上游已经拒绝，这里再兜一层
        /// </summary>
        public static void Type(char c)
        {
            if (char.IsControl(c)) return;
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
            // 带上标记：隐私屏开着时黑幕程序只放行带标记的输入（Shade.InjectMark）
            for (int i = 0; i < inputs.Length; i++)
            {
                if (inputs[i].type == Native.INPUT_KEYBOARD) inputs[i].u.ki.dwExtraInfo = (IntPtr)Shade.InjectMark;
                else inputs[i].u.mi.dwExtraInfo = (IntPtr)Shade.InjectMark;
            }
            Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
        }
    }

    /// <summary>
    /// 日志：只记事件，绝不记密码。写在 C:\ProgramData\RemoteClaude\unlock.log，超过 512 KB 轮换成 unlock.log.1。
    /// 目录或日志文件是重解析点（符号链接、目录联接）、或目录所有者不可信时一概不写，
    /// 免得普通用户把 SYSTEM 的写入引到别的文件上
    /// </summary>
    static class Log
    {
        const long MaxBytes = 512 * 1024;
        static readonly TimeSpan ThrottleWindow = TimeSpan.FromMinutes(1);
        static readonly object gate = new object();
        static readonly object throttleGate = new object();
        static readonly Dictionary<string, DateTime> lastByKey = new Dictionary<string, DateTime>();
        static readonly Dictionary<string, int> suppressedByKey = new Dictionary<string, int>();
        static readonly SecurityIdentifier self = WindowsIdentity.GetCurrent().User;

        /// <summary>日志目录。只有测试会改它</summary>
        public static string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "RemoteClaude");

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
                lock (gate) Append(line);
            }
            catch (Exception) { }
        }

        /// <summary>同一类消息一分钟最多记一条，其余只计数，下次记的时候带上省略了多少条。挡住刷请求把日志刷满</summary>
        public static void Throttled(string key, string msg)
        {
            int skipped;
            lock (throttleGate)
            {
                DateTime last;
                DateTime now = DateTime.UtcNow;
                if (lastByKey.TryGetValue(key, out last) && now - last < ThrottleWindow)
                {
                    int n;
                    suppressedByKey.TryGetValue(key, out n);
                    suppressedByKey[key] = n + 1;
                    return;
                }
                lastByKey[key] = now;
                suppressedByKey.TryGetValue(key, out skipped);
                suppressedByKey[key] = 0;
            }
            Write(skipped > 0 ? msg + "（此前同类 " + skipped + " 条未记录）" : msg);
        }

        static void Append(string line)
        {
            if (!DirIsSafe()) return;
            string file = Path.Combine(Dir, "unlock.log");
            if (IsReparsePoint(file)) return;
            var info = new FileInfo(file);
            if (info.Exists && info.Length > MaxBytes)
            {
                string old = file + ".1";
                if (IsReparsePoint(old)) return;
                if (File.Exists(old)) File.Delete(old);
                File.Move(file, old);
            }
            using (var fs = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.Read))
            {
                // 硬链接：普通用户若能在目录里建文件，就能让 unlock.log 和别的文件是同一个文件。打开后按句柄查，不写
                Native.BY_HANDLE_FILE_INFORMATION fi;
                if (!Native.GetFileInformationByHandle(fs.SafeFileHandle, out fi) || fi.nNumberOfLinks != 1) return;
                byte[] bytes = Encoding.UTF8.GetBytes(line + Environment.NewLine);
                fs.Write(bytes, 0, bytes.Length);
            }
        }

        static bool DirIsSafe()
        {
            if (IsReparsePoint(Dir)) return false; // 包括指向不存在目标的链接
            if (!Directory.Exists(Dir)) CreateDir();
            if (IsReparsePoint(Dir)) return false;
            var owner = Directory.GetAccessControl(Dir, AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            return owner != null && (owner.IsWellKnown(WellKnownSidType.LocalSystemSid) ||
                owner.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid) || owner == self);
        }

        /// <summary>目录不在时自己建，权限同 install.ps1：SYSTEM、管理员完全控制，普通用户只读</summary>
        static void CreateDir()
        {
            var ds = new DirectorySecurity();
            ds.SetAccessRuleProtection(true, false);
            const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
                FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
            // 服务里 self 就是 SYSTEM；只在测试时以普通身份运行才多出这一条
            ds.AddAccessRule(new FileSystemAccessRule(self, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.CreateDirectory(Dir, ds);
        }

        /// <summary>路径本身（不跟随链接）是不是重解析点；不存在返回 false</summary>
        static bool IsReparsePoint(string path)
        {
            uint attrs = Native.GetFileAttributesW(path);
            if (attrs == Native.INVALID_FILE_ATTRIBUTES) return false;
            return (attrs & (uint)FileAttributes.ReparsePoint) != 0;
        }
    }

    static class Native
    {
        public const uint TOKEN_ALL_ACCESS = 0xF01FF;
        public const uint MAXIMUM_ALLOWED = 0x02000000;
        public const uint GENERIC_ALL = 0x10000000;
        public const int STARTF_USESTDHANDLES = 0x100;
        public const uint CREATE_NO_WINDOW = 0x08000000;
        public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        public const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002;
        public const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
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
        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern bool WTSQuerySessionInformationW(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer, out uint bytes);
        [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr memory);
        // 密码参数用 IntPtr：调用方自己分配、用完清零（Marshal.ZeroFreeCoTaskMemUnicode）
        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern bool WTSConnectSessionW(uint logonId, uint targetLogonId, IntPtr password, bool wait);
        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool LogonUserW(string user, string domain, IntPtr password, int logonType, int provider, out IntPtr token);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern uint GetFileAttributesW(string path);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances,
            uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SECURITY_ATTRIBUTES sa);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint sessionId);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandle(SafeFileHandle file, out BY_HANDLE_FILE_INFORMATION info);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetKernelObjectSecurity(IntPtr handle, uint info, byte[] sd, uint length, out uint needed);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool SetKernelObjectSecurity(IntPtr handle, uint info, byte[] sd);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr newToken);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, uint length);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessAsUserW(IntPtr token, string app, string cmd, IntPtr processAttrs, IntPtr threadAttrs,
            bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessW(string app, string cmd, IntPtr processAttrs, IntPtr threadAttrs,
            bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size,
            IntPtr previousValue, IntPtr returnSize);
        [DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
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

        // ---- 隐私屏的黑幕（Shade）----
        public const int WH_KEYBOARD_LL = 13;
        public const int WH_MOUSE_LL = 14;
        public const uint WS_POPUP = 0x80000000;
        public const uint WS_EX_TOPMOST = 0x00000008;
        public const uint WS_EX_TRANSPARENT = 0x00000020;
        public const uint WS_EX_TOOLWINDOW = 0x00000080;
        public const uint WS_EX_LAYERED = 0x00080000;
        public const uint WS_EX_NOACTIVATE = 0x08000000;
        public const uint LWA_ALPHA = 0x2;
        public const uint WDA_EXCLUDEFROMCAPTURE = 0x11; // Win10 2004 起
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOSIZE = 0x1;
        public const uint SWP_NOMOVE = 0x2;
        public const uint SWP_NOACTIVATE = 0x10;
        public const uint SWP_SHOWWINDOW = 0x40;
        public const int WM_WTSSESSION_CHANGE = 0x2B1;
        public const int WTS_SESSION_LOCK = 0x7;
        public const int WTS_SESSION_UNLOCK = 0x8;
        public const uint WTS_CURRENT_SESSION = 0xFFFFFFFF;

        public delegate IntPtr LowLevelProc(int code, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT
        {
            public uint vkCode, scanCode, flags, time;
            public UIntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public int x, y;
            public uint mouseData, flags, time;
            public UIntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookExW(int id, LowLevelProc proc, IntPtr module, uint threadId);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string name);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
        [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern bool LockWorkStation();
        [DllImport("wtsapi32.dll")] public static extern bool WTSRegisterSessionNotification(IntPtr hwnd, uint flags);
        [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSDisconnectSession(IntPtr server, uint session, bool wait);

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam, lParam;
            public uint time;
            public int x, y;
            public uint lPrivate;
        }

        [DllImport("user32.dll")] public static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] public static extern bool PostThreadMessageW(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

        // ---- 设备管理（虚拟屏，VirtualDisplay）----
        public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
        public const uint DIGCF_PRESENT = 0x2;
        public const uint DICD_GENERATE_ID = 0x1;
        public const uint SPDRP_HARDWAREID = 0x1;
        public const uint DIF_REMOVE = 0x05;
        public const uint DIF_PROPERTYCHANGE = 0x12;
        public const uint DIF_REGISTERDEVICE = 0x19;
        public const uint DICS_ENABLE = 1;
        public const uint DICS_DISABLE = 2;
        public const uint DICS_FLAG_GLOBAL = 1;
        public const uint DI_REMOVEDEVICE_GLOBAL = 1;
        public const uint INSTALLFLAG_FORCE = 0x1;
        public const uint DN_HAS_PROBLEM = 0x400;
        public const uint CM_PROB_DISABLED = 22;

        [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr SetupDiGetClassDevsW(ref Guid cls, string enumerator, IntPtr hwnd, uint flags);
        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid cls, IntPtr hwnd);
        [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool SetupDiCreateDeviceInfoW(IntPtr set, string name, ref Guid cls, string description, IntPtr hwnd, uint flags,
            ref SP_DEVINFO_DATA data);
        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiEnumDeviceInfo(IntPtr set, uint index, ref SP_DEVINFO_DATA data);
        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiGetDeviceRegistryPropertyW(IntPtr set, ref SP_DEVINFO_DATA data, uint property, out uint type,
            byte[] buffer, uint size, out uint needed);
        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr set, ref SP_DEVINFO_DATA data, uint property, byte[] buffer, uint size);
        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiSetClassInstallParamsW(IntPtr set, ref SP_DEVINFO_DATA data, ref SP_PROPCHANGE_PARAMS p, uint size);
        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiSetClassInstallParamsW(IntPtr set, ref SP_DEVINFO_DATA data, ref SP_REMOVEDEVICE_PARAMS p, uint size);
        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiCallClassInstaller(uint function, IntPtr set, ref SP_DEVINFO_DATA data);
        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
        [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool SetupDiGetDeviceInstanceIdW(IntPtr set, ref SP_DEVINFO_DATA data, StringBuilder id, int size, out int needed);
        [DllImport("newdev.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr hwnd, string hardwareId, string inf, uint flags, out bool reboot);
        [DllImport("cfgmgr32.dll")]
        public static extern uint CM_Get_DevNode_Status(out uint status, out uint problem, uint devInst, uint flags);

        [StructLayout(LayoutKind.Sequential)]
        public struct SP_DEVINFO_DATA
        {
            public uint cbSize;
            public Guid ClassGuid;
            public uint DevInst;
            public IntPtr Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SP_CLASSINSTALL_HEADER
        {
            public uint cbSize;
            public uint InstallFunction;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SP_PROPCHANGE_PARAMS
        {
            public SP_CLASSINSTALL_HEADER ClassInstallHeader;
            public uint StateChange, Scope, HwProfile;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SP_REMOVEDEVICE_PARAMS
        {
            public SP_CLASSINSTALL_HEADER ClassInstallHeader;
            public uint Scope, HwProfile;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BY_HANDLE_FILE_INFORMATION
        {
            public uint dwFileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
            public uint dwVolumeSerialNumber, nFileSizeHigh, nFileSizeLow, nNumberOfLinks, nFileIndexHigh, nFileIndexLow;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public int bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
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
