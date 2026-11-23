# RemoteClaude：Claude 升级后自动修复

> 这是 Claude 桌面端定时任务 `remoteclaude-claude-upgrade-fix` 的提示词副本（每 3 小时运行一次，说明见 [07](07-claude-sessions.md) 第 8 节）。真正生效的那份在 `%USERPROFILE%\.claude\scheduled-tasks\remoteclaude-claude-upgrade-fix\SKILL.md`，改这里以后要同步过去。下面这条线以下是提示词原文。
>
> **2026-11-22 起这个定时任务停用了**（每次运行新开一个会话，攒得太多；[07](07-claude-sessions.md) 第 8 节）。任务和提示词都留着，没有删。

---

你在一台 Windows 电脑上，仓库在 `<仓库目录>`（RemoteClaude：用手机远程查看和操作这台电脑上的 Claude 桌面端会话窗口）。这是一个每 3 小时自动运行一次的任务，每次都是全新的会话，没有之前的记忆。全程用中文。

背景：RemoteClaude 的被控端（`host/`）靠 Windows 界面自动化在 Claude 桌面端里点菜单来新建、打开会话，Claude 桌面端一升级，按钮的文字或按法就可能变，这些功能随之失效。被控端发现 Claude 升级后会在电脑空闲时自动自检，结果写进 `%LOCALAPPDATA%\RemoteClaude\selfcheck.json`。你的任务：自检没通过时，把它修好、发版、装到这台电脑上。用户已经明确授权这件事全自动做（2026-11-21 选的"全自动，发版也不问"），发版和安装不用征求同意，事后通知。

## 第 1 步：看要不要动

用 **Read 工具**（读文件的那个工具）读 `C:\Users\<用户名>\AppData\Local\RemoteClaude\selfcheck.json`。**这一步不要用 PowerShell、Bash 或别的命令**：仓库的本机设置里给这两个文件开了只读的免审批许可，用 Read 工具读不用任何人批；换成命令就要用户在手机上批，没人批的话 49 分钟后这次运行就白跑了。

- 文件不存在（Read 工具报找不到文件），或者 `ok` 是 `true`：没有要修的。**只回复一句"自检通过，无需处理"就结束**。不要读别的文件、不要运行别的命令、不要提问、不要用"下一步"框提问。
- `ok` 是 `false`：再用 Read 工具读 `C:\Users\<用户名>\AppData\Local\RemoteClaude\selfcheck-fix.json`（可能不存在）。它记着上一次处理的情况。如果它的 `claude`、`host` 和 selfcheck.json 里的一样，并且是下面任一种，就回复一句原因然后结束：
  - `result` 是 `fixed`：已经修过并装了新被控端，新被控端要等电脑空闲才重新自检，结果还没更新；
  - `result` 是 `gave-up`，`at` 距现在不到 24 小时：已经试过修不了，也通知过用户了；
  - `result` 是 `passed-on-retry`，`at` 距现在不到 12 小时：上次用源码重试是通过的，等被控端自己再试。
- 其余情况进第 2 步。

## 第 2 步：确认能动、复现

1. `git -C <仓库目录> status --short` 的输出必须是空的。不是空的说明别的会话正在改代码：这次不动，回复一句原因就结束，下次运行再看。
2. 读 `docs/07-claude-sessions.md` 的第 5、6、8 节，`docs/08-release-and-update.md` 第 1 节，`docs/05-handoff-tasks.md` 的 2.28 和 2.29（上一次同类问题从发现到发布的完整经过，照着做）。
3. 在仓库根目录运行 `node scripts/claude-selfcheck.js`，用工作目录里的源码复现。屏幕上会闪两下窗口，是正常的。
   - 退出码 2（电脑锁屏了等）：这次做不了，回复一句就结束。
   - 退出码 0（源码是通过的）：看 `host/package.json` 的版本和 selfcheck.json 里的 `host`。一样，说明是一时的毛病：把 selfcheck-fix.json 写成 `result: "passed-on-retry"`（格式见第 4 步第 9 条），回复一句就结束。源码的版本更新，说明修复已经在仓库里、只是没装：跳到第 4 步第 3 条，直接发版安装（版本号用再加一的）。
   - 退出码 1：进第 3 步。

## 第 3 步：修

- 照 `docs/07` 第 6 节查：先确认 Claude 是不是升级了，再只读地看 Claude 窗口里的按钮、菜单项和它们支持的按法。要看菜单里面有什么，直接跑一次真的新建比手工展开菜单干净（第 5 节末尾）。
- **只允许改**：`host/sessions/` 下的文件、`host/test/` 下对应的测试、`docs/`。问题不在这个范围（要改 App、服务器、协议、被控端别的模块）就不要动，按"修不了"处理。
- 改完两样都要过才算修好：`host` 目录下 `npm test` 全部通过；仓库根目录 `node scripts/claude-selfcheck.js` 退出码 0。最多试 3 轮，还不行按"修不了"处理。

## 第 4 步：提交、发版、安装

1. 文档：在 `docs/05-handoff-tasks.md` 的"## 3. 任务清单"之前加一节验证记录（仿照 2.28：现象、原因、怎么查到的、改法、测试、实测）；`docs/07` 第 5 节的表里补上这个 Claude 版本的变化。
2. 提交：`git add` 只加你这次改的文件，提交说明用中文，写法仿照 `git log -3`。**不要推送**。
3. 版本号是 `host/package.json` 里的版本最后一段加一（比如 0.9.11 → 0.9.12）。运行（要几分钟）：
   ```powershell
   node scripts/release.js <新版本> --only host --no-upload
   ```
4. 核对打好的包（任何一项不对都不要装，按"修不了"处理）：
   - `host/sessions/claude-ui.ps1` 和 `host/dist/win-unpacked/resources/app.asar.unpacked/sessions/claude-ui.ps1` 逐字节一样；
   - `host/dist/win-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node` 存在。
5. 试运行：设环境变量 `RC_HOST_PROFILE`（一个临时目录）、`RC_HOST_NO_TILER=1`、`RC_APPROVALS_DIR`（另一个临时目录），启动 `host\dist\win-unpacked\RemoteClaude Host.exe`（用 `Start-Process -PassThru` 记下它的进程号），等 10 秒再结束它。**只按这个进程号结束**（`taskkill /PID <进程号> /T /F`），绝不要按程序名结束（`taskkill /IM`、`Stop-Process -Name`）：用户正在用的被控端也叫这个名字，按名字会把它一起结束，电脑就掉线了。它的输出里要有"被控端 <新版本> 启动"，不能有 `Cannot find`、`Error:`。
6. 安装。要经 WMI 启动安装程序（在 Claude 会话里直接启动的程序读写 `%APPDATA%` 会被转到别处）：
   ```powershell
   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"<仓库目录>\dist\RemoteClaude-Host-Setup-<新版本>.exe" /S --force-run' }
   ```
   然后每 2 秒看一次，最多等 2 分钟，三样都满足才算装好：
   - `(Get-Item "$env:LOCALAPPDATA\Programs\remote-claude-host\RemoteClaude Host.exe").VersionInfo.ProductVersion` 是新版本；
   - `Get-Process 'RemoteClaude Host'` 有进程；
   - `"$env:APPDATA\remote-claude-host\logs\host.log"` 末尾有"被控端 <新版本> 启动"，之后没有报错。
   
   **起不来就装回去**：用同样的命令装 `dist\RemoteClaude-Host-Setup-<旧版本>.exe`（旧版本就是 selfcheck.json 里的 `host`），确认它起来了，然后按"修不了"处理，说明里写清楚新包哪里不对。坏的包不要上传。
7. 上传安装包：
   ```powershell
   node scripts/release.js <新版本> --only host --upload-only
   ```
8. 提交版本号和发布记录：`docs/05` 你加的那一节末尾补一张"提交和发布"表，第 1 节状态表里"被控端"那一行补一句。**不要推送**。
9. 写 `%LOCALAPPDATA%\RemoteClaude\selfcheck-fix.json`（UTF-8）：
   ```json
   { "claude": "<selfcheck.json 里的 claude>", "host": "<selfcheck.json 里的 host，也就是旧版本>", "result": "fixed", "newHost": "<新版本>", "at": <现在的毫秒时间戳>, "note": "一句话：哪里坏了、怎么修的" }
   ```

## 第 5 步：通知用户

用 AskUserQuestion 把结果告诉用户（用户常不在电脑前，只有它能让手机上出通知）。问题里写清楚：Claude 升级到了哪个版本、哪个功能坏了、原因、改了什么、装的被控端版本、有几个提交还没推送。

- 修好了：选项「推送到 GitHub」「先不推」。用户选推送就运行 `git push origin main`。
- 修不了：选项「知道了」「我来看」。

用户没回答就结束，不用再问。

## 修不了的时候

1. 你这次没提交的改动撤掉（开工时工作目录是干净的，所以没提交的都是你这次改的：`git checkout -- .`，新建的文件删掉）。已经提交的不要动。
2. 写 selfcheck-fix.json，`result` 是 `gave-up`，`note` 里写查到了什么、卡在哪、你认为该怎么改。
3. 按第 5 步通知。

## 规矩

- 会话的起始目录不一定是仓库：命令都先 `cd <仓库目录>` 再运行（第 1 步只用 Read 工具读文件，不运行命令）。
- 只做这一件事：不要顺手改别的，不要升级依赖，不要改配置。
- 生产服务器只通过 `release.js` 的上传步骤接触，不要登录上去做别的。
- 不要代用户输入任何密码。电脑锁屏了就等下次运行。
- 第 1 步以后的工具调用可能要用户在手机上审批，等着就行（49 分钟没人批，Claude 会按拒绝处理、这次运行结束，下次运行再来）。
- 不要推送，除非用户在第 5 步里选了推送。
