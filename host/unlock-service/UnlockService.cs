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
            //   - 控制台会话里的程序：STATUS、UNLOCK、ATTACH（ATTACH 这时等同 UNLOCK）；
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
                // 旧版被控端只看开头是不是 OK，后面多出的字段不影响它
                reply = atConsole
                    ? "OK locked=" + (Session.IsLocked(console) ? "1" : "0") + " attach=0"
                    : "OK locked=1 attach=1";
            }
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
        public static int RunInjector(uint session, string password)
        {
            IntPtr token = IntPtr.Zero, dup = IntPtr.Zero;
            byte[] data = null;
            try
            {
                if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out token)) throw new Win32Exception();
                if (!Native.DuplicateTokenEx(token, Native.MAXIMUM_ALLOWED, IntPtr.Zero, 2 /* SecurityImpersonation */, 1 /* TokenPrimary */, out dup)) throw new Win32Exception();
                uint sid = session;
                if (!Native.SetTokenInformation(dup, 12 /* TokenSessionId */, ref sid, 4)) throw new Win32Exception();

                string exe = Process.GetCurrentProcess().MainModule.FileName;
                // 密码走匿名管道，不出现在命令行里
                data = Encoding.ASCII.GetBytes(Convert.ToBase64String(Encoding.UTF8.GetBytes(password)) + "\n");
                return Spawn.Run(dup, exe, "--inject", @"winsta0\winlogon", data, 20000);
            }
            finally
            {
                if (data != null) Array.Clear(data, 0, data.Length);
                if (dup != IntPtr.Zero) Native.CloseHandle(dup);
                if (token != IntPtr.Zero) Native.CloseHandle(token);
            }
        }
    }

    /// <summary>
    /// 启动子进程，把 stdinData 从它的标准输入交过去，等它退出，返回退出码（超时返回 98）。
    /// 用 PROC_THREAD_ATTRIBUTE_HANDLE_LIST 只让子进程继承这一个标准输入句柄，别的可继承句柄一个也不带过去。
    /// token 为 IntPtr.Zero 时以当前身份用 CreateProcessW 启动，只给测试用；服务里总是传 SYSTEM 令牌
    /// </summary>
    static class Spawn
    {
        public const int TimedOut = 98;

        public static int Run(IntPtr token, string exe, string args, string desktop, byte[] stdinData, uint timeoutMs)
        {
            var pi = new Native.PROCESS_INFORMATION();
            try
            {
                using (var stdin = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable))
                {
                    IntPtr child = stdin.ClientSafePipeHandle.DangerousGetHandle();
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
                    stdin.DisposeLocalCopyOfClientHandle();
                    try
                    {
                        stdin.Write(stdinData, 0, stdinData.Length);
                        stdin.Flush();
                    }
                    catch
                    {
                        // 写到一半失败：先结束注入进程，别让它拿着半截密码继续输
                        if (pi.hProcess != IntPtr.Zero) Native.TerminateProcess(pi.hProcess, 99);
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
