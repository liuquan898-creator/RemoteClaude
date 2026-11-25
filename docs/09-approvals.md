# 09 在手机上审批和回答 Claude

用户常不在电脑前。Claude Code 要审批一次工具调用（审批弹窗），或者用 AskUserQuestion 问用户问题时，手机 App 收到通知，在 App 里或直接在通知上作答，答案像在电脑上点了一样送回 Claude Code。做它的起因是替代作者之前用的飞书远程回复插件（feishu-remote），第 7 节说两个怎么共存。

## 1. 组成

```
Claude Code 会话 ──PermissionRequest 钩子──▶ %LOCALAPPDATA%\RemoteClaude\approvals\<id>.pending.json
                                                  │ 被控端每秒扫一遍
                                                  ▼
                       手机 App ◀──信令 approvals──  电脑被控端
                       （作答）  ──approval-answer─▶  （写 <id>.done.json，先到的答案生效）
                                                  │
Claude Code 会话 ◀── 钩子读到 done，输出决定 ─────────┘
```

| 部分 | 位置 | 作用 |
|---|---|---|
| Claude Code 插件 | `claude-plugin/remoteclaude/` | 审批钩子（PermissionRequest）、会话开头注入规则（SessionStart）、把桌面端自己画的、手机收不到的卡片（带提问的阻塞"下一步"框、"要在单独的会话中启动吗？"）改成 AskUserQuestion（PreToolUse，`scripts/redirect.js`）、"下一步"框里不阻塞的提问等这一轮结束后叫醒会话、改用 AskUserQuestion 再问（PostToolUse，后台运行，`scripts/nextstep.js`）、提问答了以后电脑上的"下一步"框还是旧的就提醒 Claude 换掉（Stop，`scripts/stalebox.js`） |
| 被控端 | `host/approvals/` | 盯着审批目录，把等待中的审批推给手机，收到答案写回去 |
| 服务器 | `server/lib/hub.js`、`server/lib/push.js` | 白名单里放行 `approvals`、`approval-answer`、`approval-result`；有新审批时给鸿蒙手机发华为推送（第 10 节） |
| App | `android/.../approvals/` 等 | 审批列表、作答；后台常驻保持连接、系统通知 |

插件和被控端之间只靠审批目录里的文件交接，谁先启动、谁重启都不要紧。被控端没在运行时（心跳文件超过 20 秒没更新），钩子什么都不做，Claude Code 照常在电脑上弹窗。

## 2. 审批目录（插件 ⇄ 被控端）

`%LOCALAPPDATA%\RemoteClaude\approvals\`（环境变量 `RC_APPROVALS_DIR` 可改，测试用）。Claude 桌面端会把它里面启动的程序写 `%APPDATA%`（Roaming）的操作转到自己的目录（见 08 第 3 节），`%LOCALAPPDATA%` 不受影响，所以用它。

| 文件 | 谁写 | 内容 |
|---|---|---|
| `host.json` | 被控端，每 5 秒 | `{ "pid", "at" }`，修改时间就是心跳 |
| `<id>.pending.json` | 钩子 | 一个等待中的审批（下表）；钩子每 2 秒更新修改时间当心跳 |
| `<id>.done.json` | 先作答的一方 | 结果。用硬链接发布，已存在就失败，所以只有第一个生效 |
| `redirect-<会话>.json` | 改道钩子 | 上次把哪个工具的哪个问题改了道（"下一步"问题或新会话标题），免得来回改 |
| `nextstep-<会话>.json` | `nextstep.js` | `{ "at", "ask" }`：为哪个"下一步"提问把会话叫醒了、什么时候。这个会话再有"下一步"框就删掉；`stalebox.js` 看过一次也删（第 4 节） |

`<id>` 是 16 位十六进制。pending 的字段：

| 字段 | 说明 |
|---|---|
| `id`、`kind` | `kind` 是 `permission`（审批弹窗）或 `ask`（AskUserQuestion） |
| `sessionId`、`transcriptPath`、`cwd` | 来自钩子输入；被控端用 `sessionId` 对上 Claude 桌面端的会话标题 |
| `title` | 钩子从会话记录里取的标题（取不到为空），被控端优先用桌面端的标题 |
| `agent` | 子代理类型；不是子代理为空。子代理的审批只等 5 分钟 |
| `tool`、`description` | 工具名；Bash 一类工具的 `description` 是 Claude 自己写的说明 |
| `params` | `[{ "key", "value" }]`，每个参数的完整文字；太长的截头尾，`complete` 为 false |
| `questions` | `kind` 为 `ask` 时：`[{ "question", "header", "multiSelect", "options": [{ "label", "description" }] }]` |
| `createdAt`、`waiterPid` | 毫秒时间戳；钩子进程号 |

done 的内容：`{ "kind": "answer", "choice": "allow"|"deny", "text": "拒绝时的说明", "answers": { "<问题原文>": "选项" 或 ["选项", …] 或 "自己填的文字" }, "via": "app", "at" }`，或钩子自己结束时的 `{ "kind": "closed", "reason": "answered_on_computer"|"waiter_gone"|"timeout"|"subagent_timeout" }`。

## 3. 审批钩子

`claude-plugin/remoteclaude/scripts/approval.js`，Node.js 写的（电脑上要装 Node.js），超时 605100 秒（7 天多 5 分钟；Claude Code 2.1.326 把钩子超时截到 2^31-1 毫秒，约 24.8 天）。

1. 工具是 `mcp__ccd_turn__wrap_up` 时不管（"下一步"框由改道钩子和后台钩子处理，见第 4 节）。被控端没在运行时不管。
   计划审批 `ExitPlanMode`（插件 1.0.3 起）照普通审批推到手机：工具显示成"计划"，说明写"批准后开始动手，要改就拒绝并说明"，计划全文按 7900 字一段放进参数（被控端每段最多收 8000 字，最多 3 段，再长的标为不完整）。批准时把输入原样放进 `updatedInput`（文档要求，光给 allow 不够）；拒绝时消息里加一句"这是计划审批，请留在计划模式按意见修改后再提交"。
   批准后的权限模式（2026-11-19 实测三次）：回到进计划模式之前的模式，从自动模式进计划模式的回到自动模式，一开始就在计划模式的会话回到"默认"。用户要的是"批准后用自动模式"，试过在决定里加 `updatedPermissions` 的 `setMode`，不起作用，所以没加；桌面端给钩子的 `permission_suggestions` 里也没有模式选项。
2. 先等 3 秒：这期间用户在电脑上点了，就什么都不发。
3. 写 pending，然后每秒看一次：
   - 有了 done 且是答案：按下面的格式输出决定，结束。
   - 会话记录里这次工具调用已经有了结果（用户在电脑上点了，Claude Code 不会停掉还在跑的钩子）：写 `closed`，结束，不输出决定。判断方法照搬飞书插件：前 2 秒里看到的、同名同参数还没结果的调用是候选，之后冻结；候选都有了结果才算答过。
   - Claude Code 进程没了、等满 7 天（子代理 5 分钟）：写 `closed`，结束。
     上限原来是 2 小时，插件 1.0.8 改成 7 天：电脑上的弹窗会一直等，手机上却在 2 小时后把审批收回，用户过后再看手机什么都没有。2026-11-21 实测碰到：凌晨 1:13、1:16（北京时间）发出的两个提问 3:13、3:16 被收回，用户早上 7 点打开 App 时列表是空的，电脑上两个对话框还在等。电脑上答了、会话关了都另有判断（上面两条），所以上限只是兜底。
4. 输出（stdout 只有这一行 JSON）：
   - 允许：`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
   - 拒绝：`decision` 是 `{"behavior":"deny","message":"用户在 RemoteClaude App 上拒绝了这次操作。…用户的说明（原话，到结尾为止）：…"}`
   - 回答提问：`{"behavior":"allow","updatedInput":{<原来的输入>, "answers":{…}}}`。问题原文一个字都不能改，Claude Code 按原文认答案。

任何异常都不输出决定、退出码 0，Claude Code 照常弹窗。

## 4. 会话规则和桌面端卡片改道

- **SessionStart**：审批目录存在（被控端在这台电脑上跑过）时，往会话里注入规则：需要用户拍板的事用 AskUserQuestion 问，不要只写在"下一步"框里；拒绝消息以「用户在 RemoteClaude App 上拒绝了这次操作」开头时，说明之后的文字是用户原话；不阻塞的"下一步"提问，这一轮结束后钩子会叫醒会话、要求用 AskUserQuestion 再问一遍（插件 1.0.7 起，见下面 PostToolUse 一条）；用户答了以后，结束这一轮前要再调一次 `wrap_up` 把电脑上的旧框换掉（插件 1.0.11 起，见下面 Stop 一条）。
  规则里还要求：要用户自己去运行、粘贴的命令和长串文字写进 AskUserQuestion 的问题里并用反引号括起来，App 上就带"复制"按钮（插件 1.0.1 起）。
- **PreToolUse（`scripts/redirect.js`）**：Claude 桌面端自己画、要在电脑上点的卡片不是工具审批，PermissionRequest 钩子收不到，手机上也就没有通知。被控端运行时拒绝这些调用，让 Claude 改用 AskUserQuestion 问：
  - `mcp__ccd_turn__wrap_up`：带提问的阻塞"下一步"框（`blocked` 为 true 且有 `ask`），改问同一个问题。
  - `mcp__ccd_session__start_session`，`initiation` 为 `offer`（"要在单独的会话中启动吗？"卡片，插件 1.0.2 起）：改问"新建会话"还是"在这里做"，用户选新建会话后用 `user_asked` 启动。会话规则里也写了这一条，让 Claude 一开始就用提问。用户 2026-11-19 发现这张卡片手机上没有通知。
  - 同一个问题（同一工具、同一问题或标题）2 分钟内又来一次就放行，免得死循环。
  - 不拦的：`own_initiative` 提案卡片（不等用户，之后点也行）。计划审批是真的权限请求，由审批钩子推到手机（第 3 节）。不阻塞的"下一步"提问也不拦，见下一条。
- **PostToolUse（`scripts/nextstep.js`，插件 1.0.7 起）**："下一步"框里不阻塞的提问（有 `ask`、没标 `blocked`，一轮做完后问"要不要接着做什么"）照常显示在电脑上；这一轮结束后，钩子把会话叫醒，让 Claude 用 AskUserQuestion 把同一个问题再问一遍，手机上就有通知、能作答。用户 2026-11-21 发现这种提问手机上没有通知；查日志，两天里阻塞的提问只出现过 1 次，Claude 平时用的几乎都是不阻塞的。
  - 不在调用前就改成 AskUserQuestion 的原因：这时结尾的答复还没写（桌面端要求答复写在 `wrap_up` 之后），先问的话用户还没看到答复就被问。
  - 钩子配置里带 `"async": true` 和 `"asyncRewake": true`：Claude Code 把它放到后台跑，不挡这一轮（单写 `asyncRewake` 在没有流式输入的非交互会话里会变成同步执行，所以两个都写）；它以退出码 2 结束时，stderr 的内容作为钩子消息交给 Claude，会话空闲时也会被叫醒（Claude Code 2.1.326 的钩子配置里有这个字段，官方钩子文档"Run hooks in the background"一节有说明）。超时 900 秒。
  - 流程：顺着会话记录等这一轮结束（出现 `stop_reason` 不是 `tool_use` 的助手消息，或 Stop 钩子的摘要；最多等 10 分钟，等不到就不管），再等 8 秒（让 Stop 钩子跑完；用户在电脑上马上点了框里的按钮也就不用问了），然后退出码 2，stderr 以「RemoteClaude 插件提醒」开头，写明问题原文和选项（框里的按钮；应用按钮没有文字，写成"提交""创建 PR"等；不够两个补"先不用"）。之后的提问、手机通知、作答都是 AskUserQuestion 和审批钩子的事（第 3 节），被控端和 App 不用改。
  - 等的时候会话记录里出现了用户输入（在电脑上点了按钮、打了字）、又一个"下一步"框、或新的助手消息：不叫醒，退出码 0。插件 1.0.12 起，这时和被控端没在运行时都在 `hooks.log` 里记一行"没叫醒"和原因。
  - 斜杠命令留下的记录不算用户输入（插件 1.0.12 起，`lib.isCommandRecord`：内容以 `<command-name>`、`<command-message>`、`<command-args>`、`<local-command-stdout>`、`<local-command-stderr>`、`<local-command-caveat>` 开头）。一轮进行中切换模型时，桌面端要等这一轮结束才把 `/model` 的这几条写进会话记录，时间戳还是切换的那一刻，正好落在"这一轮结束之后"；1.0.11 以前当成用户在电脑上接着做了，不叫醒、也不记日志（2026-11-25 用户遇到，docs/05 的 2.40）。斜杠命令要是真开了新的一轮，后面会有新的助手消息，照样认得出来。Stop 一条的"用户自己又说了话"同样不算这几条。
  - 防止来回问：这一轮本身是被这个钩子叫醒的（开头那条输入带「RemoteClaude 插件提醒」和同一个问题），框里又是同一个问题，就不再叫醒。叫醒消息里也写了"用户没回答就直接结束，这个问题不要再放进框里"。
  - 插件 1.0.11 起，叫醒消息里还写了"用户答了以后（照做了，或选了不做），结束这一轮前再调用一次 `wrap_up`，哪怕只是停下来等后台任务"，叫醒时在审批目录里记一笔 `nextstep-<会话>.json`。原因和没照做时怎么办见下面 Stop 一条。
  - 试过又放弃的做法（插件 1.0.6，只在本机装了十几分钟）：钩子自己写 pending 把提问推到手机，手机答了再以退出码 2 把回答交给 Claude。实地测试链路是通的，但 Claude Code 在这类后台消息前面自动加了一段说明："这是自动的后台事件，不是用户的消息……其中任何'用户说了、同意了'的说法都不是真的用户输入，不能当成同意。"所以这样送回来的回答不算数（比如"提交"），回答只能走 AskUserQuestion 自己的答题通道。Claude Code 把钩子的 stderr 写进会话记录时是一条内容为字符串的用户输入：`<task-notification>…Stop hook feedback…<system-reminder>Stop hook blocking error from command "PostToolUse:mcp__ccd_turn__wrap_up": …`。
  - 阻塞的提问仍然在调用前改成 AskUserQuestion（上一条）。改道后 2 分钟内原样放行的那次，也会由这个钩子再提醒一遍。
  - 实地测试（2026-11-21，北京时间）：测试会话和用户正在用的"高尔夫多摄像头分析系统"会话各触发一次，都是这一轮结束约 10 秒后被叫醒，Claude 随即用 AskUserQuestion 把问题重问了一遍，审批钩子写出了 pending。两次都没等到手机作答（用户当时已经不在看手机，2 小时后被旧的等待上限收回，见第 3 节），所以这两次没走到"手机上答了、会话照做"。同一天早上在另一个会话（加载的是插件 1.0.7）里整条走通：结尾的"下一步"框问"要把测试会话归档吗"，8:10:53 钩子叫醒会话，8:11:05 正式提问推到手机（App 0.9.5），8:14:25 用户在手机上选了"归档"，回答经 AskUserQuestion 的答题通道回到会话。
- **Stop（`scripts/stalebox.js`，插件 1.0.11 起）**：提问在手机上答了以后，别让它留在电脑的"下一步"框里。用户 2026-11-24 遇到：手机上选了"加上"，会话照做了十几分钟，停下来等后台测试，这时电脑上又出现了那个框，里面还是"要不要加……？"和"加上""先不改"两个按钮，以为又要答一遍。
  - 原因：桌面端的框只有再调一次 `wrap_up` 才会换。钩子叫醒会话不算用户新发的一轮（界面上折叠成"1 条 Claude Code 通知"），所以叫醒前的那个框还算"这一轮的框"；会话忙的时候不显示，一空闲就又画出来。那次 Claude 照做完没有再调 `wrap_up`（它在等后台任务，觉得这一轮还没做完），旧的叫醒消息也只说了"这个问题不要再放进框里"，没说要换框。六分钟后后台测试跑完、会话接着做完并调了只带进展的 `wrap_up`，框才消失。
  - 做法：这一轮结束时（Stop 钩子），这个会话有 `nextstep-<会话>.json` 才往下看；有，说明叫醒以后还没有新的"下一步"框。从头逐行读会话记录（那次的记录 18 MB，连 node 启动在内约 0.1 秒；没有这一笔时不读），找到那次叫醒（内容带「RemoteClaude 插件提醒」和同一个问题的用户输入，同一个问题叫醒过几次就取最后一次），看之后的情况：
    - AskUserQuestion 有了结果、而且不是"没有回答"：退出码 2，stderr 让 Claude 现在调一次 `wrap_up`（recap 写现在的情况、不带这个问题；另有新的事要用户决定才带新提问），然后一句话收尾。Claude Code 不让这一轮结束，把这段话交给 Claude。
    - 用户没有回答（结果里有"没有回答这个问题""did not answer"、在电脑上按了 Esc 的那两句英文）、Claude 被叫醒了但没问、之后用户自己又说了话（新的一轮，旧框不会再画出来；后台任务结束的 `<task-notification>` 不算用户说话）：不管。
    - 这一笔看过一次就删，所以一次叫醒最多提醒一次，不会来回拦。会话记录里还找不到那次叫醒（叫醒还没送到）时先留着，过 10 分钟还没有就删。
  - 提醒的话也以「RemoteClaude 插件提醒」开头、带"问题：……"那一行：Claude 要是又把同一个问题放进框里，`nextstep.js` 靠这两样认得出来，不再叫醒。
  - 只带 `recap`、不带 `ask` 的 `wrap_up`，桌面端不画框（工具的返回里写着"Nothing is pending, so the app draws no box"），旧框就没了。
  - 没验证的：钩子在真实会话里拦下结束、Claude 照着调 `wrap_up` 这一段没有实地走过（要装上新版插件、新开会话、在手机上答一次才走得到）。用那次出事会话的记录副本试过：截到出事的那个结束点，退出码 2；截到更早那次"用户发了条消息没选"的结束点，退出码 0。
- **工具内部弹的确认框（被控端 0.9.12 起由被控端提醒，`host/dialogwatch.js`）**：还有一类框既不是工具审批、也拦不住改道：工具调用本身已经放行，然后**在工具内部**等用户点 Claude 桌面端画的确认框。典型的是自带浏览器的"允许 Claude 操作 https://xxx？"（站点授权）和"允许 Claude 在 xxx 上执行 JavaScript？"（网站关了站点级权限时每次操作都问）。用户 2026-11-21 发现这种框手机上没有通知；查那个会话的记录，浏览器调用的权限决定都是自动模式直接放行（`permissionDecision` 是 `accept / config`），随后在工具内部等用户点框，最长的一次等了两个小时，`hooks.log` 里那段时间一条审批都没有。
  - **靠的是 Claude 桌面端自己的日志** `%LOCALAPPDATA%\Claude\logs\main.log`（安装包版在 `%APPDATA%\Claude\logs`，取最近写过的那个；配置项 `claudeLogFile` 可以指定）。桌面端每弹一个确认框记一行，用户点了、框被撤回也各有一行：
    ```
    2026-11-21 02:56:23 [info] [Preview] cat3 per-action approval requested {
      origin: 'https://uland.taobao.com',
      toolName: 'javascript_tool',
      action: undefined
    }
    2026-11-21 02:56:23 [info] Emitted tool permission request 9fd1bd10-… for browser:javascript_tool in session local_b460b9ec-…
    2026-11-21 02:55:52 [info] Received permission response for 9b3c17e9-…: once (tool: browser:javascript_tool)
    2026-11-21 01:27:08 [info] Permission request 4b83b83e-… for AskUserQuestion aborted
    ```
    浏览器的框工具名是 `browser:<工具>`，前面紧挨着一段带网址的说明（`open_site` 没有这段，网址不知道）。普通的工具审批和提问（PowerShell、AskUserQuestion、ExitPlanMode……）也记这一行，手机上答了的那些以 `aborted` 结束。`Starting app {` 是桌面端重新启动。

    还有一种结束没有上面那两行：**定时任务的框没人答，桌面端等 2922 秒（约 49 分钟）就自己按拒绝处理**，这次定时任务算失败（`[CCDScheduledTasks] A run failed; not retried`），会话进程留着。日志里只有按会话记的一行，没有框的编号：
    ```
    2026-11-21 10:10:51 [warn] [CCD] Session local_6cd0adc1-…: denied 1 permission prompt(s) unanswered for 2922s on a scheduled-task run (process untouched)
    ```
    被控端 0.9.17 起认这一行：这个会话还在等的框都算结束了。
  - 被控端每秒读日志新增的部分（日志 10 MB 一轮换，`main.log` 改名成 `main1.log`，两个都读到）。浏览器的框出现 3 秒还在，就用下面"被控端自己发的提醒"发一条：会话标题、"电脑上弹出了确认框：允许 Claude 在 uland.taobao.com 上执行 JavaScript？已经等了 N 秒。……"。手机上有通知和铃声。
  - **在手机上直接答**（被控端 0.9.13 起，0.9.14 才好用，0.9.15 起认第一次打开网站的那种框，0.9.16 起那种框还能选"始终允许"；只限浏览器的框）：提醒有三个选项"允许一次""拒绝""知道了"。选了前两个，被控端就替用户去按电脑上那个框的按钮：
    1. `sessions.answerDialog(会话, allow|deny, 网站名)`：会话已经有单独的窗口就用它，没有就照"打开会话"的办法先开一个（框只画在显示这个会话的窗口里）。
    2. `claude-ui.ps1 -Action dialog`：在窗口里找名字是"允许一次"和同一行的"拒绝"的两个按钮（不要求在屏幕上，框可能被滚出去了）；从"允许一次"往上数，第一层带文字的就是这个框自己的文字，里面要有日志里记的那个网站名，对不上就不按（`mismatch`）；然后**先把键盘焦点放到选中的按钮上，等 0.4 秒，再调用它**。只在文字很少的那几层里核对，是因为再往上是整段对话，别处也会出现网站名。
    3. 按完不算数，要等桌面端日志里出现这个框的结果（`Received permission response for <编号>: once`）。两秒还没有就再按一次（一共最多按两次）；再过 6 秒还没有，或者第 1、2 步失败，就马上再提醒一次，开头写明"刚才选的"允许一次"没按成：<原因>"，用户可以再选一次，或者点开画面自己点。再按之前这一轮刚读过日志、这个框确实还在等，所以不会按到同一个会话紧接着弹出来的下一个框上。
    
    **焦点不在按钮上时，"调用"只是把焦点移过来，框没有反应**（Claude 6.28899）。0.9.13 是直接调用的，用户 2026-11-21 在手机上连着答了 3 个框，每个都是第一次"按了按钮，但 Claude 那边没有反应"、第二次才成（第一次已经把焦点留在按钮上了）。0.9.14 改成先放焦点再调用，装上后的第一个框一次就成：选了以后 1 秒，`host.log` 里是 `替手机按了…（按之前焦点不在按钮上）`、`…的确认框按好了：允许一次（once）`。自动再按一次是留着兜底的。
    
    **确认框有两种样子**（Claude 6.28899），脚本都认，取窗口里最靠下的那一个：

    | | 每次操作都问的 | 第一次打开某个网站的 |
    |---|---|---|
    | 日志里的工具名 | `browser:javascript_tool`、`browser:get_page_text`…… | `browser:open_site` |
    | 标题 | 允许 Claude 在 uland.taobao.com 上执行 JavaScript？ | 允许 Claude 操作 https://item.taobao.com？ |
    | 一行里的按钮 | "拒绝""允许一次" | "拒绝""始终允许""更多允许选项" |
    | "允许一次"在哪 | 就是按钮 | 收在"更多允许选项"的下拉里：先展开，再按里面的那一项 |
    | 日志里有没有网址 | 有（前面那段 `[Preview] … approval requested`） | 没有 |

    第二种是 0.9.15 加的：0.9.14 只认第一种，用户在手机上对一个 `open_site` 的框选了三次"允许一次"，都是"没在这个会话的窗口里找到确认框的按钮"。日志里没有网址，所以提醒之前先只读地看一眼（`sessions.peekDialog`：会话有开着的窗口才看，不为它开新窗口），从框上的文字里找出网址写进提醒，按的时候也拿它核对；读不到就照实写"是哪个网站，这里看不到，要点开这个会话的画面才知道"。下拉里的"允许一次"找的时候不挑控件类型（名字对、可用、能调用就行）；没找到就把下拉收起来，把下拉里实际有哪几项带回来写进 `host.log`，手机上的提醒写"展开了"更多允许选项"，但没按到里面的"允许一次""。

    手机上只看得到网站和操作的种类（执行 JavaScript、读取页面内容、截图……），看不到 Claude 要发送的具体内容，提醒里写了"想先看具体内容就点开这个会话的画面"。别的框（插件没管的普通审批）不能在手机上答，选项还是"知道了""过 5 分钟再提醒"。

    **"始终允许"**（0.9.16，用户要的）：只有第二种框有这个按钮，所以只有 `open_site` 的提醒多出这个选项，顺序是"允许一次""始终允许""拒绝""知道了"。它是长期授权（以后 Claude 操作这个网站不再问，在 Claude 的设置里撤销），所以要同时满足两条才给：读窗口时看到框上确实有"始终允许"按钮（`peekDialog` 返回 `always`），而且读出了是哪个网站；选项的说明里写着网站名。选了以后脚本按 `-Choice always`：找和"拒绝"同一行、名字是"始终允许"的按钮，核对网站名，先放焦点再调用；桌面端日志里的结果是 `…: always`。第一种框（每次操作都问）桌面端自己就不给长期授权（日志里那段说明带 `offerAlwaysGrant: false`，框上写着"此网站的站点级权限已禁用"），所以淘宝上反复弹的"执行 JavaScript"那种框，加了这个选项也省不掉。

    **只有用户在手机上选了，被控端才去按**。开发时别从 Claude 会话里直接跑 `-Action dialog` 去按真的确认框（哪怕用户在手机上已经选过）：那是让一个 Claude 会话替人批准另一个会话的操作，Claude Code 自动模式的安全检查会拦下来（2026-11-21 拦过一次，没有绕过）。要在真窗口里试，用 `-Probe 1`（只找、只核对、不按）；真的按，等用户在手机上选。
  - 收回：日志里出现这个框的结果（点了、撤回了、定时任务的框没人答被桌面端按拒绝处理）、会话进程不在了、桌面端重启了，手机上的卡片随之消失。手机上点"知道了"（或不回答）就收起、这个框不再提醒；点"过 5 分钟再提醒"，到时候框还在再发一条。
  - 普通的工具审批和提问由插件推到手机，被控端看到同一个会话有插件的审批挂着就不提醒。插件没管的（会话没加载插件等）等 10 秒也提醒，文字里说明"手机上没有收到对应的审批，多半是这个会话没有加载 RemoteClaude 插件"。等 10 秒是因为插件的审批比桌面端的框晚：实测桌面端 01:26:48 记了框，钩子 01:26:51 才写出审批。
  - **插件推到过手机的框，之后不再发这种提醒**（0.9.17）。提醒说的是"手机上没有收到对应的审批"，对它不成立。认法：框挂着的时候，同一个会话出现过一条插件的审批，创建时间在框出现前 3 秒到后 60 秒之间（同一个会话早就挂着的别的审批不算）。这样的框，手机上那条没了、日志里却没有它的结果时，被控端只在 `host.log` 里记一行"手机上的审批已经没了，Claude 的日志里却没有它的结果，当它已经结束，不提醒"。起因是 2026-11-21 的误报：定时任务每 3 小时问一次"读取自检结果"的 PowerShell 审批，手机上有这条审批、没有人答，49 分钟后桌面端按拒绝处理（上面那一行，当时不认），插件的审批随之消失，被控端以为框还在，10 秒后发了"电脑上有确认框在等你……多半是这个会话没有加载 RemoteClaude 插件"，一天里发了三次。这条规则也兜住以后桌面端日志换写法的情况：框的结果认不出来时，手机上每答一条审批都会跟一条误报。代价是插件的钩子中途死掉、框还留在电脑上的那种情况不再提醒（没遇到过）；被控端重启后会重新判断，钩子因为被控端退出而不再等手机的那些框，重启后照样提醒。
  - 会话是哪个、还在不在：Claude Code 给每个正在运行的会话进程记一个登记文件 `%USERPROFILE%\.claude\sessions\<进程号>.json`，里面有桌面端的会话编号（`hostSessionId`，就是日志里的 `local_…`）、Claude Code 的会话编号（`sessionId`，插件的审批里是它）、标题（`name`）、进程启动时间（`startedAt`）、是不是桌面端的会话（`entrypoint` 是 `claude-desktop`）。登记里没有时退回桌面端的会话记录（`claude-code-sessions`）找标题和编号；两边都找不到的会话只提醒浏览器的框（分不清插件管没管）。
  - 被控端启动时往回读 2 MB 日志，找出已经在等的框：要登记里确认会话进程还在，而且进程的启动时间不晚于弹框的时间（进程重启过，框就不在了），才提醒。所以被控端重启、升级后，还在等的框会再提醒一次。
  - **自己验证**：这靠的是桌面端日志的写法，Claude 升级后可能变。插件每推一条审批，日志里都应该有对应的一行（同一个会话、前后 60 秒内）；连着 5 条桌面端会话的审批都对不上，被控端在 `host.log` 里记一行，并给手机发一条"确认框提醒可能失效了"（每次运行只发一次）。终端里的 Claude Code 会话不算（日志里本来就没有）。
  - 排查：`node scripts/dialog-watch.js` 照被控端的办法读日志，打印现在还在等的确认框和会发的提醒，只读、不发到手机。被控端的 `host.log` 里带 `[确认框]` 的行是实际发出和收回的提醒。
  - 试过又换掉的做法（插件 1.0.9 的 `scripts/stalled.js`，只用了半天）：在插件里挂一个后台运行的 PreToolUse 钩子，浏览器这类调用过了 12 秒还没有结果就猜"多半弹了框"，往审批目录写一条提醒。换掉的原因有三个。一是钩子在会话进程启动时加载，插件更新前就开着的会话不生效：用户更新插件后第二次遇到这种框，那个会话的进程是更新前一小时启动的，照样没有提醒。二是"超过 12 秒"分不出弹框和本来就慢：翻历史记录，672 次浏览器调用里有一百多次正常就要十几秒到一分多钟（一批操作里连着打开几个网页）。三是后台钩子在真实会话里从没验证过。被控端 0.9.12 起不再把这种提醒（pending 里带 `notice: true`）转给手机，还开着的 1.0.9 会话写出来的会被忽略；插件 1.0.10 删掉了这个钩子。
  - 没做的：在手机的提醒里显示 Claude 要发送的具体内容（框里"Claude 发送的内容"那一块，可以在发提醒时用界面自动化读出来）。`mcp__claude-in-chrome__*` 的授权框在 Chrome 里，不在 Claude 的窗口里，日志里有没有记没查过。

**被控端自己发的提醒**（被控端 0.9.11 起）：`host/approvals` 的 `notify(key, { title, text, header, tool, options, onAnswer })` 往列表里加一条提问（不给 `options` 就只有"知道了"），`clearNotice(key)` 收回，手机上点了也收起；`onAnswer` 收到手机上选的那个选项（0.9.12 起）。不写文件，被控端重启就没了。用它的有两处：Claude 升级后自检没通过（[07](07-claude-sessions.md) 第 8 节）、上面说的电脑上弹了确认框。

## 5. 信令消息（协议文档 2.7）

| 方向 | 消息 | 内容 |
|---|---|---|
| 被控端 → 控制端 | `approvals` | `{ "list": [ {id, kind, title, cwd, tool, description, params, complete, questions, agent, createdAt} ] }`，这台电脑上全部等待中的审批。有变化时、控制端连上时推送 |
| 控制端 → 被控端 | `approval-answer` | `{ "id", "req", "choice": "allow"|"deny", "text", "answers" }` |
| 被控端 → 控制端 | `approval-result` | `{ "id", "req", "ok", "code" }`；`code` 为 `gone`（已经被别处答了或结束了）、`bad`（答案格式不对） |

被控端把 `approvals` 推给账号下所有连着的控制端（不只是在看画面的）。一个账号多台电脑时，每台电脑推自己的。账号登记了推送令牌时，服务器让电脑以为多连着一个控制端 `push`，好在手机 App 关着时也收到 `approvals`、发推送（第 10 节、协议文档 2.10）。

## 6. App

- **审批列表**：会话列表页标题栏有"审批"按钮，有等待中的审批时带数字；画面页顶部也会出现"有 N 个审批"的提示条。点开是审批面板：
  - 审批：会话名、目录、工具、说明、全部参数（等宽字体，可展开，每个参数旁有"复制"），按钮"允许""拒绝""拒绝并说明"。
  - 提问：每个问题的选项（单选或多选），可以自己填文字，"提交"。问题原文里用反引号括起来的部分（`命令` 或 ```代码块```，代码块第一行的语言名不算）单独显示成等宽字体的一块，旁边有"复制"按钮（0.8.2 起）。原因：用户在手机上看到的是电脑画面，没法从画面上复制文字，照着截图转写长串（比如公钥）容易认错字。
- **后台常驻**（设置里"后台接收审批"，默认开）：App 切到后台时停止看画面，但保持和服务器的连接，系统要求这时通知栏常驻一条"正在接收审批"。手机重启后自动恢复。国产手机还要在系统设置里允许自启动、不限制后台（设置里有按钮直达"忽略电池优化"）。
  后台连接会被手机掐断：2026-11-21 服务器日志里，用户的小米手机（App 0.9.3）凌晨 1:06 最后一次作答，1:51 连接断开，直到 7:00 用户打开 App 才重新连上，中间 5 个小时收不到任何通知。是系统杀了进程还是休眠断了网，从服务器这边分不出来；App 没有走厂商推送，进程不在或断网时没有别的通道。
- **通知**：App 不在前台时，每个新审批弹一条系统通知；审批类的通知上有"允许""拒绝"两个按钮，按了要先解锁手机；提问类的点通知打开 App 作答。审批在别处答了或结束了，通知自动消失。
- **提示音**（App 0.9.3 起交给系统）：通知渠道"审批和提问"（`approvals_ring`）的默认铃声是布谷鸟叫（`res/raw/cuckoo.ogg`，由 `tools/make-cuckoo-sound.py` 合成）。换铃声、关声音都在手机的通知设置里改，App 设置里"通知铃声"旁边的"去设置"直接打开这一页；静音、震动、勿扰都由系统处理。一次发出几条新通知时只有第一条响铃、震动、弹横幅，其余静默进通知栏；断线重连后同一个审批重发通知也静默（`setSilent`）。审批通知归在 App 自己的一组里（`approvals`，带一条不响的汇总"Claude 在等你 · N 个审批或提问"，由单条通知负责响）：不分组的话，Android 16 在已有一条通知时会把新来的和它自动归成一组，新来的那条就不响了。App 在前台时不发通知，也不响。渠道的声音建好后 App 改不了，所以每换一次做法就换一个渠道编号，旧的删掉：0.8.x 是 `approvals`（系统默认铃声），0.9.0～0.9.2 是 `approvals_quiet`（渠道无声，App 自己用 MediaPlayer 放布谷鸟，设置里有开关和"试听"）。改回系统管的原因：用户发现手机设置里本来就能选铃声，两处都能设会一次响两声。
- 连着多台电脑时，审批前面标上电脑名。

## 7. 和飞书插件

两个插件都装着时，同一个审批会有两个钩子在等，Claude Code 怎么合并两个钩子的决定，官方文档没写。所以 App 跑通后，把飞书插件停用（`claude plugin disable feishu-remote@feishu-remote-local`），需要时再启用。

## 8. 安装

```powershell
claude plugin marketplace add <仓库所在目录>\claude-plugin
```

```powershell
claude plugin install remoteclaude@remoteclaude-local
```

新开的 Claude Code 会话才会加载插件。被控端 0.8.0 起带审批转发。

插件改了以后，要在 `claude-plugin/remoteclaude/.claude-plugin/plugin.json` 里把版本号加一，再运行一次：

```powershell
claude plugin update remoteclaude@remoteclaude-local
```

## 9. 测试

```powershell
node --test --test-timeout=20000 claude-plugin/remoteclaude/test/approval.test.js
```

电脑上弹确认框的提醒在被控端的 `host/test/dialogwatch.test.js`：往一份临时的日志文件里写桌面端那几种行，时钟、会话登记、插件的审批都是假的，看提醒什么时候发、什么时候收回、日志轮换时读不读得全、自己验证什么时候报"可能失效"；定时任务的框被桌面端按拒绝处理、插件推到过手机的框审批没了都不提醒；手机上选了"允许一次""拒绝"以后去不去按、按成和没按成各怎么收场。"先开窗口再按、带上要核对的网站名"在 `host/test/sessions-wake.test.js`。真窗口里只探测不按：`claude-ui.ps1 -Action dialog -Hwnd <会话窗口> -Choice allow -Probe 1 [-Expect <网站名的 base64>]`，返回找没找到按钮、网站名对不对得上、框里的文字。

"下一步"提问的用例也在这个文件里：用一份假的会话记录喂 `nextstep.js`，往记录里追加结尾答复、用户输入来模拟会话往下走，看它的退出码和 stderr。`stalebox.js` 的用例同样：假的会话记录加一笔 `nextstep-<会话>.json`，看答了、没答、没问、用户又说了话、叫醒还没到这几种情况下的退出码，和这一笔删没删。

被控端的审批目录监听在 `host/test/approvals.test.js`，其中一个用例直接跑插件的钩子脚本。手动联调时，把被控端和钩子的环境变量 `RC_APPROVALS_DIR` 指到同一个临时目录，用 stdin 给 `approval.js` 喂一份和 Claude Code 一样的输入（`session_id`、`cwd`、`tool_name`、`tool_input`），就能在 App 上看到这条审批，作答后钩子把决定打印到 stdout。

## 10. 鸿蒙手机的系统推送（华为 Push Kit）

鸿蒙 App（HarmonyOS NEXT 原生版 `harmony-native/`，包名 `com.remoteclaude.mobile`）切到后台就会被冻结，保持不了信令连接，不能像 Android App 那样自己弹通知。所以由服务器在有新审批、提问时调华为推送服务（Push Kit）的服务端接口发一条系统通知，App 没开着也能收到；点通知打开 App 的审批面板。消息格式见协议文档 2.10。

### 10.1 怎么工作

```
鸿蒙 App ──push-register（推送令牌）──▶ 服务器（存进 push_tokens 表）
电脑被控端 ──approvals（发给虚拟控制端 push）──▶ 服务器 ──新审批──▶ 华为 Push Kit ──▶ 手机通知栏
```

1. App 每次连上信令都用 `pushService.getToken()` 拿到的令牌发 `push-register`。令牌挂在这次登录上：退出登录、重置密码、同一设备重新登录、登录过期时一起删。
2. 被控端只把 `approvals` 发给连着的控制端。账号有推送令牌时，服务器对电脑报一个编号为 `push` 的虚拟控制端，电脑就会一直把审批列表发过来，被控端不用改。
3. 服务器比对列表，对没推送过的审批，每条给账号下所有令牌发一条通知。推送过的记在数据库的 `push_notified` 表（留 8 天），电脑重连、重发、服务器重启都不会重推。同一台电脑连着发来的同一份列表（对每个控制端各一份）只处理一次；为了不让恶意账号占住服务器、把库写大，每个账号每分钟最多处理 60 份列表，推送记录每个账号最多留 5000 条（多了删最旧的），一份列表的记录在一个事务里写完。
4. 对方服务器出错（5xx、81000001）、流控（429、80300029）、网络不通、超时时，服务器自己隔 30 秒、2 分钟、10 分钟各重推一次（被控端只在审批有变化时才重发列表，指望不上）。重推前这条已经不在电脑最近的列表里（处理掉了）就不推；电脑下线时它等着的重推一并取消，重连后发来的列表里还有这条会重新推；每小时上限照样算；3 次都没成就等电脑下次发列表。等着重推时数据库里没有这条的记录，服务器这时重启了也不会漏推。
5. 华为说令牌无效时删掉令牌：部分成功 80100000 里 `illegalTokens` 的 `tokenFormatError`、`noRight` 照删；全部无效 80300007 只在这台服务器 24 小时内推成功过（说明配置是对的）时才删——项目 ID、密钥文件和应用对不上时华为也回这个码，照删会把所有账号的令牌删光，所以这时只在日志里提示核对 `projectId`、密钥文件和 App 包名。卸载 App 造成的失效在发送时不报错，只出现在消息回执里，现在没接回执，失效的令牌会留到那次登录作废为止。

实现：`server/lib/push.js`（登记、比对、通知内容）、`server/lib/huawei-push.js`（签 JWT、调接口、解读结果），测试 `server/test/push.test.js`（本机假的华为接口）。

### 10.2 配置

`server/config.json`：

```json
"push": {
  "huawei": {
    "projectId": "AppGallery Connect 的项目 ID",
    "serviceAccountFile": "/etc/remoteclaude/agc-push-key.json",
    "category": "MARKETING",
    "testMessage": true
  }
}
```

| 字段 | 说明 |
|---|---|
| `projectId` | AGC「项目设置」里的项目 ID。不填就用密钥文件里的 `project_id`；两者不一致时启动日志里有警告（华为会回 80300002） |
| `serviceAccountFile` | 服务账号密钥 JSON 的路径（相对配置文件所在目录）。**放在仓库外**，别提交。环境变量 `RC_PUSH_HUAWEI_KEY_FILE` 优先，`RC_PUSH_HUAWEI_PROJECT_ID` 同理（容器里把密钥文件只读挂进去用） |
| `category` | 通知类别，默认 `MARKETING`。申请到自分类权益后改成批下来的类别，比如 `WORK` |
| `testMessage` | 默认 `true`，发测试消息（见 10.3）。拿到自分类权益后改成 `false` |
| `ttl` | 手机离线时华为保留多久，秒，默认 86400 |
| `maxPerHour` | 每个账号每小时最多推几条，默认 60（重推也算）。推满以后新来的审批先不推，这个小时过去后电脑再发列表时补推 |
| `showDetail` | 默认 `false`：通知只说有一条审批（标题按种类是"Claude 要你审批""Claude 要你审批计划""Claude 有问题要问你"，正文"打开 App 查看"），工具名、会话名、命令、路径、问题原文都不经过华为服务器，也不显示在锁屏上。`true` 时带这些细节（正文截到 100 字）。这是服务器级的开关，用户在手机上关不了，只建议自用的服务器打开 |
| `enabled` | `false` 时不推送（`config.example.json` 里是 `false`） |

没有 `push.huawei` 时不推送，`push-register` 回 `push-not-configured`。配了推送但密钥文件读不出来（不存在、不是 JSON、缺字段、私钥坏了）时服务器起不来，和配置写错一样，报错里写着是哪个文件；暂时不用推送就把 `enabled` 设为 `false`。

鉴权：用密钥文件里的 `private_key` 签 JWT（`alg` 为 PS256，`kid` 为 `key_id`；`iss` 为 `sub_account`，`aud` 为 `https://oauth-login.cloud.huawei.com/oauth2/v3/token`，有效 3600 秒），直接当 `Authorization: Bearer` 用，不用换 OAuth 令牌（HarmonyOS 5 起不支持 OAuth）。JWT 缓存到过期前 5 分钟；华为说过期（80200005）时重签再试一次。日志里推送令牌只留前 6 位，不出现密钥和 JWT。

### 10.3 限制（2026-11 查的官方文档）

| 情况 | 能发多少 | 怎么显示 |
|---|---|---|
| 没有自分类权益，`category` 为 `MARKETING`，不是测试消息 | 每个应用每台设备每天 **2 条**，多的丢弃 | 静默：只进通知中心，没有横幅、铃声、振动 |
| 测试消息（`testMessage: true`） | 每个项目每天 **1000 条**（所有设备合计，按成功的请求数算），不受分类频控；每次最多 10 个令牌（超了 80300030），太频繁回 80300029 | 官方没写；按分类规则推断 `MARKETING` 仍是静默的 |
| 申请到自分类权益（比如 `WORK`、`IM`） | 没有固定条数上限，由系统按场景频控 | 锁屏、铃声、振动（以手机的通知设置为准） |

所以现在用 `MARKETING` 加测试消息：自用每天几条到几十条够用，但大概率只进通知栏、不响。想要横幅和铃声，在 AGC 申请自分类权益（「开发与服务 → 项目 → 增长 → 推送服务 → 配置 → 自分类权益 → 申请」，选消息类型、给不含营销内容的示例，审核约 3 个工作日，通过后约 5 分钟生效），审批提醒最贴近 `WORK`（工作事项提醒），备选 `IM`；批下来后把 `category` 改成它、`testMessage` 改成 `false`。官方写"所有应用可申请"，个人开发者、未上架的应用能不能批下来没法确认。另外华为的通知内容规范要求不给最终用户推测试消息，自用可以接受。

消息体不超过 4096 字节（通知正文截到 100 个字符，远够）。

官方文档：

- 基于服务账号生成鉴权令牌：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-jwt-token
- 请求结构、参数、响应和错误码：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-request-struct 、…/push-scenariozed-api-request-param 、…/push-scenariozed-api-response
- 发送通知消息：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-send-alert
- 申请推送场景化消息权益（分类、每天 2 条）：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-apply-right
- 测试消息每天 1000 条：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-faq-5
- 开通推送服务：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-config-setting
- 获取推送令牌：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-get-token

### 10.4 在 AppGallery Connect 里要做的

1. 在 AGC 创建项目，项目下创建 HarmonyOS 应用，包名 `com.remoteclaude.mobile`（AppGallery Connect 不允许包名里带 harmony）。项目没设数据处理位置的先设（推送只支持中国境内）。
2. 开通推送服务：「开发与服务 → 选项目 → 选应用 → 增长 → 推送服务 → 立即开通」。
3. 签名：DevEco Studio「Project Structure → Signing」登录华为账号自动签名（能力里勾上 Push Kit），或手动申请调试证书和 Profile、注册调试设备。签名必须关联 AGC 里这个应用，否则 `getToken` 失败（1000900010）。HarmonyOS NEXT 不用再配公钥指纹和 Client ID。
4. 下载服务账号密钥：在 API Console（AGC 的「项目设置 → 服务账号密钥」一类入口，新版界面的菜单名没核实）为这个项目创建"服务账号密钥"，下载 JSON。核对里面的 `project_id` 和项目设置里的项目 ID 一致。
5. 把密钥文件放到服务器上仓库外的地方（权限只给运行服务器的用户读），在 `config.json` 填 `push.huawei`，或设 `RC_PUSH_HUAWEI_KEY_FILE`。重启服务器，日志里应有"华为推送已启用"。
6. App 侧：`onWindowStageCreate` 里 `loadContent` 成功后调 `notificationManager.requestEnableNotification()` 请求通知权限；每次启动 `pushService.getToken()`，连上信令后 `push-register`。
7. 想要横幅和铃声时申请自分类权益（10.3），批下来后改配置。
8. （可选）在「推送服务 → 配置」里配消息回执，能知道卸载、令牌失效、被频控丢弃；服务器现在没有接收回执的接口。
